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

/// A contributing surrogate cell is below the configured confidence threshold.
pub const FLAG_LOW_CONFIDENCE: u32 = 4;

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
    /// Confidence shape/range or threshold is invalid.
    Confidence,
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
    confidence: Option<(&'a [f64], f64)>,
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

/// Most Reynolds nodes a prepared lookup holds; the bound-rotor ABI allows 32.
/// A table with more nodes uses the reference lookup.
pub const MAX_REYNOLDS_NODES: usize = 32;

/// The bracket of `bracket` for an `x` already clamped into a strictly
/// increasing `axis` of at least two nodes, found from `guess` (an estimate of
/// the index) and corrected against the neighbours: the result is the largest
/// `i <= n - 2` with `axis[i] <= x`, the same index the binary search returns.
fn guessed_index(axis: &[f64], x: f64, guess: f64) -> usize {
    let last = axis.len() - 2;
    // A NaN or negative guess starts at 0; `as` saturates large guesses.
    let mut i = if guess > 0.0 { (guess as usize).min(last) } else { 0 };
    while i > 0 && axis[i] > x {
        i -= 1;
    }
    while i < last && axis[i + 1] <= x {
        i += 1;
    }
    i
}

/// Per-evaluation lookup of a `PolarTable` (TASK-091). Brackets come from an
/// O(1) guess that is exact on uniform axes (uniform in ln Re for Reynolds)
/// and corrected on others; the Reynolds logarithms, the guess scales and the
/// corner strides are computed once per evaluation; and one pass reads the
/// CL, CD and confidence corners. Every result is bit-identical to
/// `PolarTable::lookup`: the brackets are the same indices and each value is
/// the same expression of the same operands.
#[derive(Clone, Copy, Debug)]
pub struct PreparedPolar<'a> {
    table: PolarTable<'a>,
    ln_re: [f64; MAX_REYNOLDS_NODES],
    prepared: bool,
    /// Guess scales (n - 1) / (last - first), on ln Re for the Reynolds axis.
    alpha_scale: f64,
    re_scale: f64,
    mach_scale: f64,
    /// Flat-index strides to the next alpha, Re and Mach node; 0 on a single-node axis.
    stride_alpha: usize,
    stride_re: usize,
    stride_mach: usize,
}

/// (n - 1) / (last - first) of an axis, or 0 for a single node.
fn guess_scale(first: f64, last: f64, n: usize) -> f64 {
    if n < 2 { 0.0 } else { (n - 1) as f64 / (last - first) }
}

impl PreparedPolar<'_> {
    /// `PolarTable::lookup` with the same clamping, flags and arithmetic.
    pub fn lookup(&self, alpha_rad: f64, reynolds: f64, mach: f64) -> PolarSample {
        let t = &self.table;
        if !self.prepared {
            return t.lookup(alpha_rad, reynolds, mach);
        }
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
        let (a, r, m) = (clamp_to(t.alpha_rad, alpha_rad), clamp_to(t.reynolds, reynolds), clamp_to(t.mach, mach));
        let linear = |axis: &[f64], x: f64, scale: f64| -> (usize, f64) {
            if axis.len() < 2 {
                return (0, 0.0);
            }
            let i = guessed_index(axis, x, (x - axis[0]) * scale);
            let (x0, x1) = (axis[i], axis[i + 1]);
            (i, ((x - x0) / (x1 - x0)).clamp(0.0, 1.0))
        };
        let (ia, ta) = linear(t.alpha_rad, a, self.alpha_scale);
        let (im, tm) = linear(t.mach, m, self.mach_scale);
        let (ir, tr) = if t.reynolds.len() < 2 {
            (0, 0.0)
        } else {
            let lr = r.ln();
            let i = guessed_index(t.reynolds, r, (lr - self.ln_re[0]) * self.re_scale);
            let (x0, x1) = (self.ln_re[i], self.ln_re[i + 1]);
            (i, ((lr - x0) / (x1 - x0)).clamp(0.0, 1.0))
        };
        let base = (im * t.reynolds.len() + ir) * t.alpha_rad.len() + ia;
        let (sa, sr, sm) = (self.stride_alpha, self.stride_re, self.stride_mach);
        if let Some((values, threshold)) = t.confidence {
            let (wm, wr, wa) = ([1.0 - tm, tm], [1.0 - tr, tr], [1.0 - ta, ta]);
            'corners: for dm in 0..2 {
                for dr in 0..2 {
                    for da in 0..2 {
                        // The reference's weight product, in its order; a zero weight never flags.
                        if wm[dm] * wr[dr] * wa[da] > 0.0
                            && values.get(base + dm * sm + dr * sr + da * sa).is_some_and(|v| *v < threshold) {
                            flags |= FLAG_LOW_CONFIDENCE;
                            break 'corners;
                        }
                    }
                }
            }
        }
        // `trilinear`'s nested interpolation (alpha, then Re, then Mach) with precomputed strides.
        let interpolate = |table: &[f64]| {
            let at = |k: usize| table.get(k).copied().unwrap_or(f64::NAN);
            let along_alpha = |k: usize| {
                let v0 = at(k);
                v0 + ta * (at(k + sa) - v0)
            };
            let along_re = |k: usize| {
                let v0 = along_alpha(k);
                v0 + tr * (along_alpha(k + sr) - v0)
            };
            let v0 = along_re(base);
            v0 + tm * (along_re(base + sm) - v0)
        };
        PolarSample { cl: interpolate(t.cl), cd: interpolate(t.cd), flags }
    }
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
        Ok(Self { alpha_rad, reynolds, mach, cl, cd, confidence: None })
    }

    /// Attaches bounded surrogate confidence; exact nodes ignore zero-weight neighbors.
    pub fn with_confidence(mut self, values: &'a [f64], threshold: f64) -> Result<Self, PolarError> {
        if values.len() != self.cl.len() || !threshold.is_finite() || !(0.0..=1.0).contains(&threshold)
            || values.iter().any(|v| !v.is_finite() || !(0.0..=1.0).contains(v)) {
            return Err(PolarError::Confidence);
        }
        self.confidence = Some((values, threshold));
        Ok(self)
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
        flags |= self.confidence_flags(ia, ta, ir, tr, im, tm);
        PolarSample { cl: self.trilinear(self.cl, ia, ta, ir, tr, im, tm), cd: self.trilinear(self.cd, ia, ta, ir, tr, im, tm), flags }
    }

    /// `FLAG_LOW_CONFIDENCE` when a corner with positive weight is below the threshold.
    #[allow(clippy::too_many_arguments)]
    fn confidence_flags(&self, ia: usize, ta: f64, ir: usize, tr: f64, im: usize, tm: f64) -> u32 {
        let mut flags = 0;
        if let Some((values, threshold)) = self.confidence {
            for dm in 0..2 {
                for dr in 0..2 {
                    for da in 0..2 {
                        let weight = (if dm == 0 { 1.0 - tm } else { tm })
                            * (if dr == 0 { 1.0 - tr } else { tr })
                            * (if da == 0 { 1.0 - ta } else { ta });
                        if weight > 0.0 {
                            let cm = (im + dm).min(self.mach.len() - 1);
                            let cr = (ir + dr).min(self.reynolds.len() - 1);
                            let ca = (ia + da).min(self.alpha_rad.len() - 1);
                            // An index outside a table that was never validated reads as confident, never panics.
                            if values.get((cm * self.reynolds.len() + cr) * self.alpha_rad.len() + ca).is_some_and(|v| *v < threshold) {
                                flags |= FLAG_LOW_CONFIDENCE;
                            }
                        }
                    }
                }
            }
        }
        flags
    }

    /// A table whose axes and values the caller has already validated with
    /// `new(...).with_confidence(...)` on these exact slices (TASK-091: the
    /// bound-rotor configuration is validated at initialization and immutable
    /// afterwards, so steps do not rescan it). Lookups stay bounds-checked: a
    /// table that was not validated can give wrong or NaN values, never a panic.
    pub(crate) fn validated(alpha_rad: &'a [f64], reynolds: &'a [f64], mach: &'a [f64], cl: &'a [f64], cd: &'a [f64],
        confidence: &'a [f64], threshold: f64) -> Self {
        Self { alpha_rad, reynolds, mach, cl, cd, confidence: Some((confidence, threshold)) }
    }

    /// Per-evaluation lookup state (TASK-091): the natural logarithms of the
    /// Reynolds axis, taken once instead of twice per query.
    pub fn prepare(&self) -> PreparedPolar<'a> {
        let mut ln_re = [0.0; MAX_REYNOLDS_NODES];
        let n = self.reynolds.len().min(MAX_REYNOLDS_NODES);
        for (slot, re) in ln_re.iter_mut().zip(self.reynolds.iter()).take(n) {
            *slot = re.ln();
        }
        let (na, nr, nm) = (self.alpha_rad.len(), self.reynolds.len(), self.mach.len());
        let (alpha_first, alpha_last) = (self.alpha_rad.first().copied().unwrap_or(0.0), self.alpha_rad.last().copied().unwrap_or(0.0));
        let (mach_first, mach_last) = (self.mach.first().copied().unwrap_or(0.0), self.mach.last().copied().unwrap_or(0.0));
        PreparedPolar {
            table: *self, ln_re, prepared: n == nr,
            alpha_scale: guess_scale(alpha_first, alpha_last, na),
            re_scale: if n == nr && n >= 2 { guess_scale(ln_re[0], ln_re[n - 1], n) } else { 0.0 },
            mach_scale: guess_scale(mach_first, mach_last, nm),
            stride_alpha: usize::from(na >= 2), stride_re: if nr >= 2 { na } else { 0 }, stride_mach: if nm >= 2 { nr * na } else { 0 },
        }
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
