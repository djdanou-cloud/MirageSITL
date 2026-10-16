//! Validated airfoil polar lookup (TASK-019), docs/SPECS_SIMULATION_ENGINES.md
//! sections 2 and 3.
//!
//! A `PolarTable` borrows flattened CL/CD tables over strictly increasing
//! `(Mach, Re, alpha)` axes, index `(iMach * nRe + iRe) * nAlpha + iAlpha`.
//! Lookup is trilinear in `(Ma, ln Re, alpha)` with a fixed evaluation order
//! (alpha, then ln Re, then Mach). A query outside any axis is clamped to the
//! table boundary and flagged with `FLAG_OUTSIDE_POLAR_VALIDITY`; nothing is
//! extrapolated. Construction validates once; lookup never allocates or panics.
use crate::abi::FLAG_OUTSIDE_POLAR_VALIDITY;

/// Why a table was rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolarError {
    /// An axis is empty or a table length differs from `nMach * nRe * nAlpha`.
    Shape,
    /// An axis value is non-finite, or the axes are not strictly increasing (ambiguous ordering).
    AxisOrder,
    /// A Reynolds number is not positive or a Mach number is negative.
    AxisRange,
    /// A coefficient is non-finite.
    NonFinite,
    /// A drag coefficient is negative.
    NegativeDrag,
}

/// Interpolated coefficients and validity flags for one query.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PolarSample {
    /// Lift coefficient.
    pub cl: f64,
    /// Drag coefficient (>= 0 for a valid table and finite query).
    pub cd: f64,
    /// `FLAG_OUTSIDE_POLAR_VALIDITY` when the query was clamped or non-finite; otherwise 0.
    pub flags: u32,
}

/// A validated polar table borrowing caller-owned storage.
#[derive(Clone, Copy, Debug)]
pub struct PolarTable<'a> {
    alpha_rad: &'a [f64],
    reynolds: &'a [f64],
    mach: &'a [f64],
    cl: &'a [f64],
    cd: &'a [f64],
}

fn strictly_increasing(axis: &[f64]) -> bool {
    axis.iter().all(|v| v.is_finite()) && axis.windows(2).all(|pair| pair[0] < pair[1])
}

/// Bracket `[i, i + 1]` and weight in `[0, 1]` for `x` already clamped into `axis`.
/// A single-node axis returns `(0, 0.0)`. `key` maps axis values (identity or ln).
fn bracket(axis: &[f64], x: f64, key: fn(f64) -> f64) -> (usize, f64) {
    let n = axis.len();
    if n < 2 {
        return (0, 0.0);
    }
    // Largest i <= n - 2 with axis[i] <= x (binary search; axis strictly increasing).
    let (mut lo, mut hi) = (0usize, n - 1);
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if axis[mid] <= x {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (x0, x1) = (key(axis[lo]), key(axis[lo + 1]));
    let t = (key(x) - x0) / (x1 - x0);
    (lo, t.clamp(0.0, 1.0))
}
fn identity(x: f64) -> f64 {
    x
}
fn ln(x: f64) -> f64 {
    x.ln()
}

impl<'a> PolarTable<'a> {
    /// Validates and borrows a table. Rejects empty axes, mismatched lengths,
    /// non-finite or non-increasing axes, Re <= 0, Mach < 0, non-finite
    /// coefficients, and negative CD.
    pub fn new(alpha_rad: &'a [f64], reynolds: &'a [f64], mach: &'a [f64], cl: &'a [f64], cd: &'a [f64])
        -> Result<Self, PolarError> {
        let len = mach.len().checked_mul(reynolds.len()).and_then(|n| n.checked_mul(alpha_rad.len()));
        if alpha_rad.is_empty() || reynolds.is_empty() || mach.is_empty() || len != Some(cl.len()) || cl.len() != cd.len() {
            return Err(PolarError::Shape);
        }
        if !strictly_increasing(alpha_rad) || !strictly_increasing(reynolds) || !strictly_increasing(mach) {
            return Err(PolarError::AxisOrder);
        }
        if !(reynolds[0] > 0.0) || !(mach[0] >= 0.0) {
            return Err(PolarError::AxisRange);
        }
        if !cl.iter().chain(cd.iter()).all(|v| v.is_finite()) {
            return Err(PolarError::NonFinite);
        }
        if cd.iter().any(|v| *v < 0.0) {
            return Err(PolarError::NegativeDrag);
        }
        Ok(Self { alpha_rad, reynolds, mach, cl, cd })
    }

    /// `(nMach, nRe, nAlpha)`.
    pub fn shape(&self) -> (usize, usize, usize) {
        (self.mach.len(), self.reynolds.len(), self.alpha_rad.len())
    }

    /// Coefficients at `(alpha, Re, Ma)`. The caller wraps alpha into
    /// `[-pi, pi)` (section 3); any coordinate outside the table is clamped to
    /// its boundary and the result flagged. A non-finite query returns NaN
    /// coefficients, flagged.
    pub fn lookup(&self, alpha_rad: f64, reynolds: f64, mach: f64) -> PolarSample {
        if !(alpha_rad.is_finite() && reynolds.is_finite() && mach.is_finite()) {
            return PolarSample { cl: f64::NAN, cd: f64::NAN, flags: FLAG_OUTSIDE_POLAR_VALIDITY };
        }
        let mut flags = 0;
        let mut clamp_to = |axis: &[f64], x: f64| {
            let (first, last) = (axis.first().copied().unwrap_or(x), axis.last().copied().unwrap_or(x)); // non-empty by construction
            if x < first || x > last {
                flags = FLAG_OUTSIDE_POLAR_VALIDITY;
            }
            x.clamp(first, last)
        };
        let (a, r, m) = (clamp_to(self.alpha_rad, alpha_rad), clamp_to(self.reynolds, reynolds), clamp_to(self.mach, mach));
        let (ia, ta) = bracket(self.alpha_rad, a, identity);
        let (ir, tr) = bracket(self.reynolds, r, ln);
        let (im, tm) = bracket(self.mach, m, identity);
        PolarSample { cl: self.trilinear(self.cl, ia, ta, ir, tr, im, tm), cd: self.trilinear(self.cd, ia, ta, ir, tr, im, tm), flags }
    }

    #[allow(clippy::too_many_arguments)]
    fn trilinear(&self, table: &[f64], ia: usize, ta: f64, ir: usize, tr: f64, im: usize, tm: f64) -> f64 {
        let (n_mach, n_re, n_alpha) = self.shape();
        let next = |i: usize, n: usize| if i + 1 < n { i + 1 } else { i };
        let at = |m: usize, r: usize, a: usize| table.get((m * n_re + r) * n_alpha + a).copied().unwrap_or(f64::NAN);
        let along_alpha = |m: usize, r: usize| {
            let v0 = at(m, r, ia);
            v0 + ta * (at(m, r, next(ia, n_alpha)) - v0)
        };
        let along_re = |m: usize| {
            let v0 = along_alpha(m, ir);
            v0 + tr * (along_alpha(m, next(ir, n_re)) - v0)
        };
        let v0 = along_re(im);
        v0 + tm * (along_re(next(im, n_mach)) - v0)
    }
}
