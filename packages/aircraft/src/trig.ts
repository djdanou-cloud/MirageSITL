// Engine-independent sine, cosine and tangent for configuration-time geometry
// (TASK-138). `Math.sin`, `Math.cos` and `Math.tan` are implementation-
// approximated: Node 24.22.2 and Chromium 153 disagree in the last bit for
// about 3–4% of arguments. These functions use only addition, subtraction,
// multiplication, division, `Math.abs` and `Math.round`, which IEEE 754 and
// ECMAScript define exactly, so every engine returns the same bits. Against V8's Math on
// 400,001 points, sine and cosine are within 1 ulp and tangent within 3 ulp;
// the tests allow 2 and 4 ulp.

/**
 * π/2 split into two 33-bit parts and a 53-bit tail. Together they reproduce
 * π/2 to 1.0e-37 (2^-123), and n times either 33-bit part is exact for |n| ≤ 3.
 */
export const PIO2_PARTS = [1.5707963267341256, 6.077100506303966e-11, 2.0222662487959506e-21] as const;
const [PIO2_1, PIO2_2, PIO2_3] = PIO2_PARTS;
const TWO_OVER_PI = 0.6366197723675814;
/** Largest |x| accepted: azimuths lie in (-π, π] and tilts in (-π/2, π/2). */
export const MAX_ARGUMENT_RAD = 4;

// Taylor coefficients, each rounded once by its division. On |y| ≤ π/4 the
// first omitted terms are below 1.1e-19·|y| (sine) and 3.3e-21 (cosine),
// three decades under the rounding of the result.
const S3 = -1 / 6, S5 = 1 / 120, S7 = -1 / 5040, S9 = 1 / 362880, S11 = -1 / 39916800, S13 = 1 / 6227020800,
  S15 = -1 / 1307674368000, S17 = 1 / 355687428096000;
const C4 = 1 / 24, C6 = -1 / 720, C8 = 1 / 40320, C10 = -1 / 3628800, C12 = 1 / 479001600, C14 = -1 / 87178291200,
  C16 = 1 / 20922789888000, C18 = -1 / 6402373705728000;

function sineKernel(y: number): number {
  const z = y * y;
  return y + y * z * (S3 + z * (S5 + z * (S7 + z * (S9 + z * (S11 + z * (S13 + z * (S15 + z * S17)))))));
}
/** cos y = 1 - z/2 + z²·Q(z); the rounding error of w = 1 - z/2 is recovered exactly and added back. */
function cosineKernel(y: number): number {
  const z = y * y, half = 0.5 * z, w = 1 - half;
  const tail = z * z * (C4 + z * (C6 + z * (C8 + z * (C10 + z * (C12 + z * (C14 + z * (C16 + z * C18)))))));
  return w + (((1 - w) - half) + tail);
}

/** Sine and cosine of x radians, |x| ≤ MAX_ARGUMENT_RAD. Odd and even symmetry hold exactly. */
export function sinCos(xRad: number): { sin: number; cos: number } {
  if (!(Math.abs(xRad) <= MAX_ARGUMENT_RAD)) throw new RangeError(`Angle ${xRad} rad is outside ±${MAX_ARGUMENT_RAD} rad`);
  const a = Math.abs(xRad);
  // Cody–Waite reduction: a = n·π/2 + y with |y| ≤ π/4. a - n·PIO2_1 is exact by Sterbenz's lemma.
  const n = Math.round(a * TWO_OVER_PI);
  const y = ((a - n * PIO2_1) - n * PIO2_2) - n * PIO2_3;
  const s = sineKernel(y), c = cosineKernel(y);
  let sin: number, cos: number;
  switch (n) {
    case 0: sin = s; cos = c; break;
    case 1: sin = c; cos = -s; break;
    case 2: sin = -s; cos = -c; break;
    default: sin = -c; cos = s; break;
  }
  return { sin: xRad < 0 ? -sin : sin, cos };
}

/** Tangent of x radians, |x| ≤ MAX_ARGUMENT_RAD. */
export function tan(xRad: number): number {
  const { sin, cos } = sinCos(xRad);
  return sin / cos;
}
