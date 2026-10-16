// FPV lens model (TASK-067): Kannala-Brandt fisheye (the OpenCV fisheye
// model) with a principal point, applied as a post-process remap of a pinhole
// render. Setup-time math lives here; shaders/fisheye.glsl evaluates the same
// mapping per pixel and fisheyeSourceUvInto is its CPU mirror for tests.
//
//   theta_d = theta (1 + k1 theta^2 + k2 theta^4 + k3 theta^6 + k4 theta^8)
//   output normalized radius r_d = theta_d;   pinhole source radius = tan(theta)
//
// UV convention: u right, v up (three.js), centre (0.5, 0.5) unless shifted
// by the principal-point offset. Square pixels: one focal length in pixels,
// expressed per axis in UV units.

export type LensDistortion =
  | { model: "none" }
  | { model: "kannala-brandt"; k: readonly [number, number, number, number] };

export interface LensConfig {
  /** Horizontal field of view of the output image across its full width, rad. */
  fovHorizontalRad: number;
  distortion: LensDistortion;
  /** Principal-point offset from the image centre, output pixels (+x right, +y up). */
  principalPointOffsetPx?: readonly [number, number];
}

/** Uniform values for shaders/fisheye.glsl plus the pinhole source camera to render. */
export interface FisheyeParams {
  model: 0 | 1;
  outCenter: [number, number];
  outFocal: [number, number];
  srcCenter: [number, number];
  srcFocal: [number, number];
  k: [number, number, number, number];
  maxTheta: number;
  /** Pinhole source camera: vertical FOV (deg, three.js convention) and aspect. */
  sourceFovYDeg: number;
  sourceAspect: number;
}

/** Largest incidence angle a single pinhole source can cover with usable sampling (80 deg off-axis). */
export const MAX_SOURCE_THETA_RAD = (80 * Math.PI) / 180;
const NEWTON_STEPS = 10;
const INSIDE_TOLERANCE = 1e-4;

function thetaD(k: readonly number[], t: number): number {
  const t2 = t * t;
  return t * (1 + t2 * (k[0]! + t2 * (k[1]! + t2 * (k[2]! + t2 * k[3]!)))); // k has length 4
}
function thetaDPrime(k: readonly number[], t: number): number {
  const t2 = t * t;
  return 1 + t2 * (3 * k[0]! + t2 * (5 * k[1]! + t2 * (7 * k[2]! + t2 * 9 * k[3]!)));
}
/** Newton inverse of theta_d over [0, maxTheta], fixed step count (as in the shader). */
function invertThetaD(k: readonly number[], rd: number, maxTheta: number): number {
  let theta = rd;
  for (let i = 0; i < NEWTON_STEPS; i++) theta = Math.min(maxTheta, Math.max(0, theta - (thetaD(k, theta) - rd) / thetaDPrime(k, theta)));
  return theta;
}

/** Validates the lens and computes shader uniforms and the source camera for a width x height output. */
export function fisheyeParams(config: LensConfig, widthPx: number, heightPx: number): FisheyeParams {
  if (!(Number.isInteger(widthPx) && widthPx > 0 && Number.isInteger(heightPx) && heightPx > 0)) throw new Error("Invalid output size");
  const fov = config.fovHorizontalRad;
  if (!(fov > 0 && fov < Math.PI * 1.5)) throw new Error("Invalid horizontal field of view");
  const [dxPx, dyPx] = config.principalPointOffsetPx ?? [0, 0];
  if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx) || Math.abs(dxPx) > widthPx / 4 || Math.abs(dyPx) > heightPx / 4) throw new Error("Invalid principal point offset");
  const aspect = widthPx / heightPx;
  const outCenter: [number, number] = [0.5 + dxPx / widthPx, 0.5 + dyPx / heightPx];
  const d = config.distortion;
  if (d.model === "none") {
    if (dxPx !== 0 || dyPx !== 0) throw new Error("A principal-point offset needs a lens model; 'none' is the identity");
    if (!(fov < (160 * Math.PI) / 180)) throw new Error("A pinhole field of view must be below 160 deg");
    const halfX = Math.tan(fov / 2);
    // Identity: the source camera is the output camera, so the shader passes texels through.
    return { model: 0, outCenter: [0.5, 0.5], outFocal: [0.5 / halfX, (0.5 / halfX) * aspect], srcCenter: [0.5, 0.5],
      srcFocal: [0.5 / halfX, (0.5 / halfX) * aspect], k: [0, 0, 0, 0], maxTheta: Math.atan(halfX * Math.hypot(1, 1 / aspect)),
      sourceFovYDeg: (2 * Math.atan(halfX / aspect) * 180) / Math.PI, sourceAspect: aspect };
  }
  if (d.model !== "kannala-brandt") throw new Error("Unknown lens model");
  const k: [number, number, number, number] = [d.k[0], d.k[1], d.k[2], d.k[3]];
  if (!k.every(Number.isFinite)) throw new Error("Invalid distortion coefficients");
  // theta_d must be strictly increasing up to the largest angle in use.
  const scanMax = Math.PI / 2;
  for (let i = 0; i <= 256; i++) if (!(thetaDPrime(k, (scanMax * i) / 256) > 0)) throw new Error("Lens model is not monotonic below 90 deg");
  const halfTheta = fov / 2;
  if (halfTheta >= scanMax) throw new Error("Field of view must stay below 180 deg");
  // Focal in UV units: the horizontal edge (u = 0 or 1 from the nominal centre) is at theta = fov / 2.
  const fx = 0.5 / thetaD(k, halfTheta);
  const outFocal: [number, number] = [fx, fx * aspect];
  // Largest pinhole coordinates any in-frame output pixel needs (scan the frame boundary).
  let maxXp = 0, maxYp = 0, maxTheta = 0;
  const steps = 128;
  for (let i = 0; i <= steps; i++) {
    for (const [u, v] of [[i / steps, 0], [i / steps, 1], [0, i / steps], [1, i / steps]] as const) {
      const mx = (u - outCenter[0]) / outFocal[0], my = (v - outCenter[1]) / outFocal[1], rd = Math.hypot(mx, my);
      const theta = invertThetaD(k, rd, scanMax);
      if (Math.abs(thetaD(k, theta) - rd) > INSIDE_TOLERANCE) continue; // outside the image circle
      maxTheta = Math.max(maxTheta, theta);
      if (rd > 0) { const s = Math.tan(theta) / rd; maxXp = Math.max(maxXp, Math.abs(mx * s)); maxYp = Math.max(maxYp, Math.abs(my * s)); }
    }
  }
  if (maxTheta > MAX_SOURCE_THETA_RAD) throw new Error("Lens covers more than 80 deg off-axis; a single pinhole source cannot sample it (cubemap source not implemented)");
  return { model: 1, outCenter, outFocal, srcCenter: [0.5, 0.5], srcFocal: [0.5 / maxXp, 0.5 / maxYp], k, maxTheta,
    sourceFovYDeg: (2 * Math.atan(maxYp) * 180) / Math.PI, sourceAspect: maxXp / maxYp };
}

/**
 * CPU mirror of the shader: writes the source UV for output (u, v) into
 * `out` and returns true, or returns false (out = -1, -1, the shader's black)
 * when the pixel is outside the lens image circle or the source frame.
 * Outputs stay finite for any finite input.
 */
export function fisheyeSourceUvInto(p: FisheyeParams, u: number, v: number, out: Float64Array): boolean {
  if (p.model === 0) { out[0] = u; out[1] = v; return u >= 0 && u <= 1 && v >= 0 && v <= 1; }
  const mx = (u - p.outCenter[0]) / p.outFocal[0], my = (v - p.outCenter[1]) / p.outFocal[1], rd = Math.hypot(mx, my);
  if (rd === 0) { out[0] = p.srcCenter[0]; out[1] = p.srcCenter[1]; return true; }
  const theta = invertThetaD(p.k, rd, p.maxTheta);
  const su = p.srcCenter[0] + mx * (Math.tan(theta) / rd) * p.srcFocal[0], sv = p.srcCenter[1] + my * (Math.tan(theta) / rd) * p.srcFocal[1];
  if (Math.abs(thetaD(p.k, theta) - rd) > INSIDE_TOLERANCE || !(su >= 0 && su <= 1 && sv >= 0 && sv <= 1)) { out[0] = -1; out[1] = -1; return false; }
  out[0] = su; out[1] = sv;
  return true;
}

/** Forward model: output UV of a ray at incidence `thetaRad` and azimuth `phiRad` (0 = +u, counter-clockwise). */
export function projectRayToUv(p: FisheyeParams, thetaRad: number, phiRad: number): [number, number] {
  const rd = p.model === 0 ? Math.tan(thetaRad) : thetaD(p.k, thetaRad);
  return [p.outCenter[0] + rd * Math.cos(phiRad) * p.outFocal[0], p.outCenter[1] + rd * Math.sin(phiRad) * p.outFocal[1]];
}
