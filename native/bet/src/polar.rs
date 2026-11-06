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
    // A NaN or negative guess starts at 0; `as` saturates large guesses.
    corrected_index(axis, x, if guess > 0.0 { guess as usize } else { 0 })
}

/// `guessed_index` from an index that is already a number.
#[inline(always)]
fn corrected_index(axis: &[f64], x: f64, start: usize) -> usize {
    let last = axis.len() - 2;
    let mut i = start.min(last);
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
                        // A low value first (most cells are confident), then the reference's weight
                        // product in its order: a zero weight never flags.
                        if values.get(base + dm * sm + dr * sr + da * sa).is_some_and(|v| *v < threshold)
                            && wm[dm] * wr[dr] * wa[da] > 0.0 {
                            flags |= FLAG_LOW_CONFIDENCE;
                            break 'corners;
                        }
                    }
                }
            }
        }
        // `trilinear`'s nested interpolation (alpha, then Re, then Mach) with precomputed strides,
        // read through one window holding the cell's corners; outside the table it is NaN, as there.
        let span = sa + sr + sm;
        let interpolate = |table: &[f64]| {
            let Some(cell) = table.get(base..=base + span) else { return f64::NAN };
            let at = |k: usize| cell[k - base];
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

/// ln 2 split so that `k * LN2_HI` is exact for |k| < 2^20: LN2_HI keeps the
/// leading 21 significant bits of ln 2 (0x3FE62E42FEE00000) and LN2_LO is
/// ln 2 - LN2_HI rounded to double.
const LN2_HI: f64 = 6.931_471_803_691_238_164_90e-1;
const LN2_LO: f64 = 1.908_214_929_270_587_700_02e-10;

/// Natural logarithm of the TASK-091 production kernel, written without
/// branches or calls so that the strip pass vectorizes. For a positive normal
/// finite `x = 2^e m`, with m scaled into [sqrt(1/2), sqrt(2)),
/// `ln x = e ln 2 + 2 atanh(s)`, `s = (m - 1)/(m + 1)`, |s| <= 0.1716, and
/// atanh is its Taylor series `s + s^3/3 + ... + s^17/17` (exact rational
/// coefficients; the omitted terms sum to below 1.6e-16 absolute in ln x). The
/// exponent is read with the 2^52 bias trick (exact for e in [-1022, 1023]).
/// Declared accuracy (TASK-091): within 2e-15 x max(1, |ln x|) of `f64::ln`.
/// Zero, subnormal, negative and non-finite arguments are outside its domain;
/// callers clamp onto a validated positive normal axis first.
#[inline(always)]
pub fn ln_kernel(x: f64) -> f64 {
    const SQRT2: f64 = std::f64::consts::SQRT_2;
    const BIAS: u64 = 0x4330_0000_0000_0000; // 2^52 as f64 bits
    let bits = x.to_bits();
    let mantissa = f64::from_bits((bits & 0x000F_FFFF_FFFF_FFFF) | 0x3FF0_0000_0000_0000);
    let exponent = f64::from_bits(BIAS | (bits >> 52)) - (4_503_599_627_370_496.0 + 1023.0);
    let high = mantissa > SQRT2;
    let m = if high { mantissa * 0.5 } else { mantissa };
    let e = if high { exponent + 1.0 } else { exponent };
    let s = (m - 1.0) / (m + 1.0);
    let z = s * s;
    // Estrin's scheme: the same polynomial with a shorter chain of dependent operations.
    let z2 = z * z;
    let z4 = z2 * z2;
    let series = (1.0 / 3.0 + z * (1.0 / 5.0)) + z2 * (1.0 / 7.0 + z * (1.0 / 9.0))
        + z4 * ((1.0 / 11.0 + z * (1.0 / 13.0)) + z2 * (1.0 / 15.0 + z * (1.0 / 17.0)));
    let atanh2 = 2.0 * s + 2.0 * s * (z * series);
    e * LN2_HI + (atanh2 + e * LN2_LO)
}

/// The polar lookup of the TASK-091 production kernel. It keeps the
/// reference semantics (clamping and its flag, the bracket indices, the
/// clamped weights, the low-confidence rule and the trilinear order) but takes
/// the Reynolds logarithms from `ln_kernel`, both for the axis and for the
/// query, so its results agree with `PolarTable::lookup` within the declared
/// tolerance T1 rather than bitwise. Axis bounds, scales and strides are read
/// once per evaluation, and each query reads its corners as two-node windows.
#[derive(Clone, Copy, Debug)]
pub struct KernelPolar<'a> {
    alpha: &'a [f64],
    reynolds: &'a [f64],
    mach: &'a [f64],
    cl: &'a [f64],
    cd: &'a [f64],
    /// Confidence values and threshold; an empty slice without confidence.
    confidence: &'a [f64],
    threshold: f64,
    /// The Reynolds logarithms and the reciprocal widths of their intervals.
    logs: &'a ReynoldsLogs,
    usable: bool,
    alpha_first: f64,
    alpha_last: f64,
    alpha_scale: f64,
    re_first: f64,
    re_last: f64,
    re_scale: f64,
    mach_first: f64,
    mach_last: f64,
    mach_scale: f64,
    /// 1 / (mach[1] - mach[0]) for a two-node Mach axis.
    inverse_mach_width: f64,
    n_alpha: usize,
    n_re: usize,
    n_mach: usize,
    /// Flat-index strides to the next Re and Mach node; 0 on a single-node axis.
    stride_re: usize,
    stride_mach: usize,
}

/// The Reynolds logarithms of the TASK-091 production kernel, formed once and
/// reused while the axis keeps the same bits, so that a step does not take them
/// again for each evaluation. Reuse cannot change a result: the values depend on
/// those bits alone.
#[derive(Clone, Copy, Debug)]
pub struct ReynoldsLogs {
    /// The bits of the axis these values were formed from.
    axis_bits: [u64; MAX_REYNOLDS_NODES],
    nodes: usize,
    usable: bool,
    ln_re: [f64; MAX_REYNOLDS_NODES],
    /// 1 / (ln_re[i + 1] - ln_re[i]) for each Reynolds interval.
    inverse_ln_width: [f64; MAX_REYNOLDS_NODES],
}

impl ReynoldsLogs {
    /// No axis yet: the first `refresh` of any axis with nodes forms the values.
    pub const fn new() -> Self {
        Self {
            axis_bits: [0; MAX_REYNOLDS_NODES],
            nodes: 0,
            usable: false,
            ln_re: [0.0; MAX_REYNOLDS_NODES],
            inverse_ln_width: [0.0; MAX_REYNOLDS_NODES],
        }
    }

    /// Makes the values those of `axis`; false when `KernelPolar` cannot serve
    /// it (more than `MAX_REYNOLDS_NODES` nodes, or a node that is not a positive
    /// normal number).
    fn refresh(&mut self, axis: &[f64]) -> bool {
        if axis.len() > MAX_REYNOLDS_NODES {
            self.nodes = 0;
            self.usable = false;
            return false;
        }
        if axis.len() == self.nodes && axis.iter().zip(self.axis_bits.iter()).all(|(node, bits)| node.to_bits() == *bits) {
            return self.usable;
        }
        self.nodes = axis.len();
        self.usable = axis.iter().all(|re| re.is_normal() && *re > 0.0);
        self.ln_re = [0.0; MAX_REYNOLDS_NODES];
        self.inverse_ln_width = [0.0; MAX_REYNOLDS_NODES];
        for (k, re) in axis.iter().enumerate() {
            self.axis_bits[k] = re.to_bits();
            if self.usable {
                self.ln_re[k] = ln_kernel(*re);
                if k > 0 {
                    self.inverse_ln_width[k - 1] = 1.0 / (self.ln_re[k] - self.ln_re[k - 1]);
                }
            }
        }
        self.usable
    }
}

impl Default for ReynoldsLogs {
    fn default() -> Self {
        Self::new()
    }
}

/// Most strips of a rotor, the length of the lanes of a strip-wise lookup.
pub const MAX_STRIPS: usize = 64;

/// The lanes of `KernelPolar::sample_strips`, one element per strip. The caller
/// fills `speed`, `alpha`, `reynolds`, `ln_reynolds` and `mach`, keeps `hint`
/// between queries of one evaluation, and reads `cl` and `cd`. Only elements at
/// or above the minimum speed hold results; the others keep what they held.
#[derive(Clone, Copy, Debug)]
pub struct StripLanes {
    /// Relative speed of the strip's element, m/s.
    pub speed: [f64; MAX_STRIPS],
    /// Angle of attack, rad.
    pub alpha: [f64; MAX_STRIPS],
    /// Reynolds number, finite or +inf.
    pub reynolds: [f64; MAX_STRIPS],
    /// `reynolds` clamped onto the table's axis.
    pub clamped_reynolds: [f64; MAX_STRIPS],
    /// `ln_kernel` of `clamped_reynolds`.
    pub ln_reynolds: [f64; MAX_STRIPS],
    /// Mach number, finite or +inf.
    pub mach: [f64; MAX_STRIPS],
    /// The strip's last Reynolds bracket, `usize::MAX` before its first query.
    pub hint: [usize; MAX_STRIPS],
    /// Lift coefficient.
    pub cl: [f64; MAX_STRIPS],
    /// Drag coefficient.
    pub cd: [f64; MAX_STRIPS],
    clamped_alpha: [f64; MAX_STRIPS],
    alpha_guess: [f64; MAX_STRIPS],
    alpha_low: [f64; MAX_STRIPS],
    alpha_high: [f64; MAX_STRIPS],
    ln_low: [f64; MAX_STRIPS],
    inverse_ln: [f64; MAX_STRIPS],
    alpha_weight: [f64; MAX_STRIPS],
    re_weight: [f64; MAX_STRIPS],
    mach_weight: [f64; MAX_STRIPS],
    corner: [usize; MAX_STRIPS],
}

impl StripLanes {
    /// Zeroed lanes with no hints.
    pub const fn new() -> Self {
        const ZERO: [f64; MAX_STRIPS] = [0.0; MAX_STRIPS];
        Self {
            speed: ZERO, alpha: ZERO, reynolds: ZERO, clamped_reynolds: ZERO, ln_reynolds: ZERO, mach: ZERO, hint: [usize::MAX; MAX_STRIPS], cl: ZERO, cd: ZERO,
            clamped_alpha: ZERO, alpha_guess: ZERO, alpha_low: ZERO, alpha_high: ZERO, ln_low: ZERO, inverse_ln: ZERO,
            alpha_weight: ZERO, re_weight: ZERO, mach_weight: ZERO, corner: [0; MAX_STRIPS],
        }
    }
}

impl Default for StripLanes {
    fn default() -> Self {
        Self::new()
    }
}

/// `x` clamped onto `[first, last]` by comparisons, which compile to selects;
/// equal to `x.clamp(first, last)` for finite `x` and `first <= last`.
/// (`f64::max` and `f64::min` lower to library calls on wasm32.)
#[inline(always)]
pub fn clamp_select(x: f64, first: f64, last: f64) -> f64 {
    let low = if x < first { first } else { x };
    if low > last { last } else { low }
}

/// The two values at `at` and `at + 1`, or `None` past the end.
#[inline(always)]
fn pair(values: &[f64], at: usize) -> Option<(f64, f64)> {
    match values.get(at..at.wrapping_add(2)) {
        Some(&[v0, v1]) => Some((v0, v1)),
        _ => None,
    }
}

impl KernelPolar<'_> {
    /// False when the table cannot use this lookup (fewer than two alpha
    /// nodes, more than `MAX_REYNOLDS_NODES` Reynolds nodes, or a Reynolds node
    /// that is not a positive normal number); the caller then uses the
    /// reference lookup.
    pub fn usable(&self) -> bool {
        self.usable
    }

    /// The Reynolds axis bounds `(first, last)`, positive normal numbers when `usable`.
    pub fn reynolds_bounds(&self) -> (f64, f64) {
        (self.re_first, self.re_last)
    }

    /// The Reynolds bracket guess for `ln_reynolds`, used to seed `sample`'s hint.
    pub fn reynolds_guess(&self, ln_reynolds: f64) -> usize {
        let last = self.n_re.saturating_sub(2);
        let guess = (ln_reynolds - self.logs.ln_re[0]) * self.re_scale;
        if guess > 0.0 { (guess as usize).min(last) } else { 0 }
    }

    /// One query for finite `alpha_rad`, `reynolds` and `mach` on a usable
    /// table, where `ln_reynolds` is `ln_kernel` of `reynolds` clamped onto
    /// its axis and `hint` the strip's last Reynolds bracket, updated here. The
    /// result is the reference lookup's within T1: equal clamping, flags and
    /// brackets, and weights that differ only through the logarithm.
    /// `known_flags` are the flags the caller has already collected for its
    /// output: when they hold `FLAG_LOW_CONFIDENCE`, this query skips the
    /// corner scan, which could only set that flag again (and leaves it out of
    /// the returned flags).
    #[inline(always)]
    pub fn sample(&self, alpha_rad: f64, reynolds: f64, ln_reynolds: f64, mach: f64, hint: &mut usize, known_flags: u32) -> PolarSample {
        const MISSING: PolarSample = PolarSample { cl: f64::NAN, cd: f64::NAN, flags: FLAG_OUTSIDE_POLAR_VALIDITY };
        let inside = alpha_rad >= self.alpha_first && alpha_rad <= self.alpha_last
            && reynolds >= self.re_first && reynolds <= self.re_last
            && mach >= self.mach_first && mach <= self.mach_last;
        let mut flags = if inside { 0 } else { FLAG_OUTSIDE_POLAR_VALIDITY };
        let a = clamp_select(alpha_rad, self.alpha_first, self.alpha_last);
        let r = clamp_select(reynolds, self.re_first, self.re_last);
        let m = clamp_select(mach, self.mach_first, self.mach_last);
        // Brackets and weights as `bracket`: the largest i <= n - 2 with axis[i] <= x, t clamped to [0, 1].
        let ia = guessed_index(self.alpha, a, (a - self.alpha_first) * self.alpha_scale);
        let Some((a0, a1)) = pair(self.alpha, ia) else { return MISSING };
        let ta = ((a - a0) / (a1 - a0)).clamp(0.0, 1.0);
        let (im, tm) = match self.n_mach {
            1 => (0, 0.0),
            // Two nodes: the bracket is 0 without a search, and the weight takes the interval's
            // reciprocal; a query clamped onto the last node keeps the reference weight 1 exactly.
            2 => (0, if m >= self.mach_last { 1.0 } else { ((m - self.mach_first) * self.inverse_mach_width).clamp(0.0, 1.0) }),
            _ => {
                let i = guessed_index(self.mach, m, (m - self.mach_first) * self.mach_scale);
                let Some((m0, m1)) = pair(self.mach, i) else { return MISSING };
                (i, ((m - m0) / (m1 - m0)).clamp(0.0, 1.0))
            }
        };
        let (ir, tr) = if self.n_re < 2 {
            (0, 0.0)
        } else {
            let i = guessed_index(self.reynolds, r, *hint as f64 + 0.5);
            *hint = i;
            let (Some(&l0), Some(&inverse)) = (self.logs.ln_re.get(i), self.logs.inverse_ln_width.get(i)) else { return MISSING };
            // The interval's reciprocal; a query clamped onto the last node keeps the reference weight 1 exactly.
            (i, if r >= self.re_last { 1.0 } else { ((ln_reynolds - l0) * inverse).clamp(0.0, 1.0) })
        };
        let base = (im * self.n_re + ir) * self.n_alpha + ia;
        if known_flags & FLAG_LOW_CONFIDENCE == 0 && !self.confidence.is_empty() && self.low_confidence(base, ta, tr, tm) {
            flags |= FLAG_LOW_CONFIDENCE;
        }
        // The trilinear interpolation with Re and Mach first, on both alpha nodes at once (they are
        // adjacent, so the two lanes vectorize), and alpha last: the same weights as `trilinear`,
        // whose order (alpha, Re, Mach) differs from it in rounding only.
        PolarSample { cl: self.corners(self.cl, base, ta, tr, tm), cd: self.corners(self.cd, base, ta, tr, tm), flags }
    }

    /// As the reference: a corner flags when it is low and its weight product is positive.
    #[inline(always)]
    fn low_confidence(&self, base: usize, ta: f64, tr: f64, tm: f64) -> bool {
        let (sr, sm) = (self.stride_re, self.stride_mach);
        let th = self.threshold;
        let Some(window) = self.confidence.get(base..base.wrapping_add(sm + sr + 2)) else { return false };
        // SAFETY: `window` holds sm + sr + 2 values, so the largest offset read, sm + sr + 1, is inside it.
        let rows = unsafe {[
            (*window.get_unchecked(0), *window.get_unchecked(1), 1.0 - tm, 1.0 - tr),
            (*window.get_unchecked(sr), *window.get_unchecked(sr + 1), 1.0 - tm, tr),
            (*window.get_unchecked(sm), *window.get_unchecked(sm + 1), tm, 1.0 - tr),
            (*window.get_unchecked(sm + sr), *window.get_unchecked(sm + sr + 1), tm, tr),
        ]};
        // All eight high is the usual case, and then no weight matters; `&` so that the comparisons take lanes.
        let [r0, r1, r2, r3] = rows;
        if (r0.0 >= th) & (r0.1 >= th) & (r1.0 >= th) & (r1.1 >= th) & (r2.0 >= th) & (r2.1 >= th) & (r3.0 >= th) & (r3.1 >= th) {
            return false;
        }
        rows.iter().any(|&(c0, c1, wm, wr)| (c0 < th && wm * wr * (1.0 - ta) > 0.0) || (c1 < th && wm * wr * ta > 0.0))
    }

    /// One coefficient from the corners at `base`, or NaN if the table is too
    /// short for them.
    #[inline(always)]
    fn corners(&self, table: &[f64], base: usize, ta: f64, tr: f64, tm: f64) -> f64 {
        let (sr, sm) = (self.stride_re, self.stride_mach);
        let Some(window) = table.get(base..base.wrapping_add(sm + sr + 2)) else { return f64::NAN };
        // SAFETY: `window` holds sm + sr + 2 values, so the largest offset read, sm + sr + 1, is inside it.
        let (r00, r01, r10, r11) = unsafe {(
            (*window.get_unchecked(0), *window.get_unchecked(1)),
            (*window.get_unchecked(sr), *window.get_unchecked(sr + 1)),
            (*window.get_unchecked(sm), *window.get_unchecked(sm + 1)),
            (*window.get_unchecked(sm + sr), *window.get_unchecked(sm + sr + 1)),
        )};
        let (low0, low1) = (r00.0 + tr * (r01.0 - r00.0), r00.1 + tr * (r01.1 - r00.1));
        let (high0, high1) = (r10.0 + tr * (r11.0 - r10.0), r10.1 + tr * (r11.1 - r10.1));
        let (v0, v1) = (low0 + tm * (high0 - low0), low1 + tm * (high1 - low1));
        v0 + ta * (v1 - v0)
    }

    /// True when `sample_strips` serves this table: at most two Mach nodes.
    pub fn strip_wise(&self) -> bool {
        self.n_mach <= 2
    }

    /// `sample` for the first `n` strips of `s` at or above `min_speed`, in
    /// passes across strips so that the clamps and the weights, the alpha
    /// division among them, take vector lanes. A usable, `strip_wise` table only.
    /// Each strip's result has the bits of `sample` with the same `known_flags`,
    /// and the flags returned are the union of `sample`'s. A hint is only a start
    /// for its bracket, so a wrong hint cannot change a result.
    pub fn sample_strips(&self, s: &mut StripLanes, n: usize, min_speed: f64, known_flags: u32) -> u32 {
        let n = n.min(MAX_STRIPS);
        let (alpha_first, alpha_last, alpha_scale) = (self.alpha_first, self.alpha_last, self.alpha_scale);
        let (re_last, mach_first, mach_last) = (self.re_last, self.mach_first, self.mach_last);
        let inverse_mach = self.inverse_mach_width;
        // A query clamped onto the last node keeps the reference weight 1 exactly; a single-node axis keeps weight 0.
        let mach_full = if self.n_mach == 2 { mach_last } else { f64::INFINITY };
        let mut outside = false;
        for k in 0..n {
            let (alpha, mach) = (s.alpha[k], s.mach[k]);
            let a = clamp_select(alpha, alpha_first, alpha_last);
            let m = clamp_select(mach, mach_first, mach_last);
            // A clamp changes a query outside its axis and nothing else; these queries are never NaN.
            let inside = (a == alpha) & (s.clamped_reynolds[k] == s.reynolds[k]) & (m == mach);
            outside |= !inside & (s.speed[k] >= min_speed);
            s.clamped_alpha[k] = a;
            s.alpha_guess[k] = (a - alpha_first) * alpha_scale;
            s.mach_weight[k] = if m >= mach_full { 1.0 } else { clamp_select((m - mach_first) * inverse_mach, 0.0, 1.0) };
        }
        // The brackets, against the axes: scalar, and well predicted because the guesses are nearly always right.
        let (alpha_axis, re_axis, n_alpha) = (self.alpha, self.reynolds, self.n_alpha);
        let several_re = self.n_re >= 2;
        let last_alpha = alpha_axis.len() - 2;
        let last_re = re_axis.len().saturating_sub(2);
        for k in 0..n {
            if !(s.speed[k] >= min_speed) {
                continue;
            }
            let a = s.clamped_alpha[k];
            // `as` sends a negative guess to 0.
            let mut ia = (s.alpha_guess[k] as usize).min(last_alpha);
            // SAFETY: ia <= last_alpha = len - 2, here and after `corrected_index`, on a usable table's axis of at least two nodes.
            let (mut a0, mut a1) = unsafe { (*alpha_axis.get_unchecked(ia), *alpha_axis.get_unchecked(ia + 1)) };
            if a0 > a || (a1 <= a && ia < last_alpha) {
                ia = corrected_index(alpha_axis, a, ia);
                (a0, a1) = unsafe { (*alpha_axis.get_unchecked(ia), *alpha_axis.get_unchecked(ia + 1)) };
            }
            s.alpha_low[k] = a0;
            s.alpha_high[k] = a1;
            let ir = if several_re {
                let r = s.clamped_reynolds[k];
                let mut i = if s.hint[k] == usize::MAX { self.reynolds_guess(s.ln_reynolds[k]) } else { s.hint[k].min(last_re) };
                // SAFETY: i <= last_re = len - 2 on an axis of at least two nodes.
                let (r0, r1) = unsafe { (*re_axis.get_unchecked(i), *re_axis.get_unchecked(i + 1)) };
                if r0 > r || (r1 <= r && i < last_re) {
                    i = corrected_index(re_axis, r, i);
                }
                s.hint[k] = i;
                i
            } else {
                0
            };
            // ir < MAX_REYNOLDS_NODES on a usable table; the mask keeps this read free of a panic path.
            let at = ir & (MAX_REYNOLDS_NODES - 1);
            s.ln_low[k] = self.logs.ln_re[at];
            s.inverse_ln[k] = self.logs.inverse_ln_width[at];
            s.corner[k] = ir * n_alpha + ia;
        }
        // A single-node Reynolds axis keeps weight 0: its width's reciprocal is 0 and this limit is never reached.
        let re_full = if several_re { re_last } else { f64::INFINITY };
        for k in 0..n {
            let span = s.alpha_high[k] - s.alpha_low[k];
            s.alpha_weight[k] = clamp_select((s.clamped_alpha[k] - s.alpha_low[k]) / span, 0.0, 1.0);
            let weight = clamp_select((s.ln_reynolds[k] - s.ln_low[k]) * s.inverse_ln[k], 0.0, 1.0);
            s.re_weight[k] = if s.clamped_reynolds[k] >= re_full { 1.0 } else { weight };
        }
        // The corners. Once a corner flags, the rest could only flag again, as with `known_flags`.
        let mut low = known_flags & FLAG_LOW_CONFIDENCE != 0 || self.confidence.is_empty();
        let mut flags = if outside { FLAG_OUTSIDE_POLAR_VALIDITY } else { 0 };
        for k in 0..n {
            if !(s.speed[k] >= min_speed) {
                continue;
            }
            let (base, ta, tr, tm) = (s.corner[k], s.alpha_weight[k], s.re_weight[k], s.mach_weight[k]);
            if !low && self.low_confidence(base, ta, tr, tm) {
                low = true;
                flags |= FLAG_LOW_CONFIDENCE;
            }
            s.cl[k] = self.corners(self.cl, base, ta, tr, tm);
            s.cd[k] = self.corners(self.cd, base, ta, tr, tm);
        }
        flags
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

    /// The lookup state of the TASK-091 production kernel (`KernelPolar`), on
    /// `logs`, which it brings up to date with this table's Reynolds axis.
    pub fn prepare_kernel<'b>(&self, logs: &'b mut ReynoldsLogs) -> KernelPolar<'b>
    where
        'a: 'b,
    {
        let (na, nr, nm) = (self.alpha_rad.len(), self.reynolds.len(), self.mach.len());
        let usable = logs.refresh(self.reynolds) && na >= 2;
        let logs = &*logs;
        let bounds = |axis: &[f64]| (axis.first().copied().unwrap_or(0.0), axis.last().copied().unwrap_or(0.0));
        let ((alpha_first, alpha_last), (re_first, re_last), (mach_first, mach_last)) = (bounds(self.alpha_rad), bounds(self.reynolds), bounds(self.mach));
        let (confidence, threshold) = self.confidence.unwrap_or((&[], 0.0));
        KernelPolar {
            alpha: self.alpha_rad, reynolds: self.reynolds, mach: self.mach, cl: self.cl, cd: self.cd, confidence, threshold,
            logs, usable,
            alpha_first, alpha_last, alpha_scale: guess_scale(alpha_first, alpha_last, na),
            re_first, re_last, re_scale: if usable && nr >= 2 { guess_scale(logs.ln_re[0], logs.ln_re[nr - 1], nr) } else { 0.0 },
            mach_first, mach_last, mach_scale: guess_scale(mach_first, mach_last, nm),
            inverse_mach_width: if nm == 2 { 1.0 / (mach_last - mach_first) } else { 0.0 },
            n_alpha: na, n_re: nr, n_mach: nm,
            stride_re: if nr >= 2 { na } else { 0 }, stride_mach: if nm >= 2 { nr * na } else { 0 },
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
