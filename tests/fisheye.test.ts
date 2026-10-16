// TASK-067: FPV lens model and mounted camera pose. Oracles: closed-form
// equidistant values, three.js's own perspective projection matrix for the
// pinhole source, and hand-derived frame rotations.
import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { fisheyeParams, fisheyeSourceUvInto, projectRayToUv, type LensConfig } from "../packages/cameras/src/fisheye.ts";
import { FpvCamera, type CameraConfig } from "../packages/cameras/src/fpv-camera.ts";
import { newRenderPoseV2 } from "../packages/protocol/src/interpolation.ts";

const deg = Math.PI / 180;
const KB: LensConfig = { fovHorizontalRad: 120 * deg, distortion: { model: "kannala-brandt", k: [0, 0, 0, 0] } };
const KB_DISTORTED: LensConfig = { fovHorizontalRad: 110 * deg, distortion: { model: "kannala-brandt", k: [0.08, -0.015, 0.002, -0.0003] } };
const out = new Float64Array(2);

/** Source UV of a camera-frame ray through a three.js PerspectiveCamera with the source FOV/aspect. */
function pinholeUv(sourceFovYDeg: number, aspect: number, theta: number, phi: number): [number, number] {
  const camera = new PerspectiveCamera(sourceFovYDeg, aspect, 0.1, 100);
  camera.updateMatrixWorld();
  const p = new Vector3(Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), -Math.cos(theta)).project(camera);
  return [(p.x + 1) / 2, (p.y + 1) / 2];
}

describe("lens model", () => {
  it("zero distortion is the identity", () => {
    const p = fisheyeParams({ fovHorizontalRad: 90 * deg, distortion: { model: "none" } }, 640, 480);
    expect(p.model).toBe(0);
    expect(p.sourceAspect).toBeCloseTo(640 / 480, 12);
    expect(p.sourceFovYDeg).toBeCloseTo((2 * Math.atan(Math.tan(45 * deg) * 480 / 640)) / deg, 10);
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
      expect(fisheyeSourceUvInto(p, i / 10, j / 10, out)).toBe(true);
      expect([out[0], out[1]]).toEqual([i / 10, j / 10]);
    }
    expect(() => fisheyeParams({ ...KB, distortion: { model: "none" }, principalPointOffsetPx: [3, 0] }, 640, 480)).toThrow();
  });

  it("matches the closed-form equidistant projection (k = 0)", () => {
    const p = fisheyeParams(KB, 640, 480);
    // r_d = theta: the 60 deg horizontal edge is u = 1, so 30 deg is u = 0.75 exactly.
    const [u, v] = projectRayToUv(p, 30 * deg, 0);
    expect(u).toBeCloseTo(0.75, 12);
    expect(v).toBeCloseTo(0.5, 12);
    // Vertical: same focal in pixels, so 30 deg up is 0.25 * (640/480) above centre.
    expect(projectRayToUv(p, 30 * deg, 90 * deg)[1]).toBeCloseTo(0.5 + 0.25 * (640 / 480), 12);
    expect(projectRayToUv(p, 60 * deg, 180 * deg)[0]).toBeCloseTo(0, 12);
  });

  it("inverts each ray onto the pinhole source exactly where three.js projects it", () => {
    for (const lens of [KB, KB_DISTORTED]) {
      const p = fisheyeParams(lens, 640, 480);
      for (const thetaDeg of [0.5, 5, 20, 35, 50, 60]) for (const phiDeg of [0, 37, 90, 145, 230, 300]) {
        const [u, v] = projectRayToUv(p, thetaDeg * deg, phiDeg * deg);
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        expect(fisheyeSourceUvInto(p, u, v, out), `${thetaDeg}/${phiDeg}`).toBe(true);
        const [su, sv] = pinholeUv(p.sourceFovYDeg, p.sourceAspect, thetaDeg * deg, phiDeg * deg);
        expect(Math.abs(out[0]! - su), `u ${thetaDeg}/${phiDeg}`).toBeLessThan(1e-9);
        expect(Math.abs(out[1]! - sv), `v ${thetaDeg}/${phiDeg}`).toBeLessThan(1e-9);
      }
    }
  });

  it("puts the optical axis at the shifted principal point", () => {
    const p = fisheyeParams({ ...KB_DISTORTED, principalPointOffsetPx: [20, -10] }, 640, 480);
    expect(p.outCenter[0]).toBeCloseTo(0.5 + 20 / 640, 15);
    expect(p.outCenter[1]).toBeCloseTo(0.5 - 10 / 480, 15);
    expect(projectRayToUv(p, 0, 0)).toEqual(p.outCenter);
    expect(fisheyeSourceUvInto(p, p.outCenter[0], p.outCenter[1], out)).toBe(true);
    expect([out[0], out[1]]).toEqual([0.5, 0.5]);
    // Radial symmetry about the shifted centre: equal angles give equal pixel radii.
    const [ux] = projectRayToUv(p, 25 * deg, 0), [, vy] = projectRayToUv(p, 25 * deg, 90 * deg);
    expect((ux - p.outCenter[0]) * 640).toBeCloseTo((vy - p.outCenter[1]) * 480, 9);
  });

  it("keeps the horizontal field of view on resize", () => {
    const a = fisheyeParams(KB, 640, 480), b = fisheyeParams(KB, 1280, 720);
    expect(projectRayToUv(b, 30 * deg, 0)[0]).toBeCloseTo(projectRayToUv(a, 30 * deg, 0)[0], 12);
    expect(projectRayToUv(b, 20 * deg, 90 * deg)[1] - 0.5).toBeCloseTo((projectRayToUv(a, 20 * deg, 90 * deg)[1] - 0.5) * (1280 / 720) / (640 / 480), 12);
  });

  it("stays finite at and beyond the frame edges, flagging pixels outside the source", () => {
    for (const lens of [KB, KB_DISTORTED, { fovHorizontalRad: 100 * deg, distortion: { model: "none" } } as LensConfig]) {
      const p = fisheyeParams(lens, 640, 480);
      let inside = 0;
      for (let i = -10; i <= 110; i++) for (let j = -10; j <= 110; j++) {
        const ok = fisheyeSourceUvInto(p, i / 100, j / 100, out);
        expect(Number.isFinite(out[0]) && Number.isFinite(out[1])).toBe(true);
        if (ok) { inside++; expect(out[0]).toBeGreaterThanOrEqual(0); expect(out[1]).toBeLessThanOrEqual(1); }
        if (i >= 0 && i <= 100 && j >= 0 && j <= 100) expect(ok, `${i},${j}`).toBe(true); // the whole frame is covered
      }
      expect(inside).toBeGreaterThan(101 * 101 - 1);
    }
  });

  it("rejects non-monotonic lenses, over-wide fields and invalid sizes", () => {
    expect(() => fisheyeParams({ ...KB, distortion: { model: "kannala-brandt", k: [-0.5, 0, 0, 0] } }, 640, 480)).toThrow("monotonic");
    expect(() => fisheyeParams({ ...KB, fovHorizontalRad: 170 * deg }, 640, 480)).toThrow("cubemap");
    expect(() => fisheyeParams(KB, 0, 480)).toThrow();
    expect(() => fisheyeParams({ ...KB, distortion: { model: "kannala-brandt", k: [Number.NaN, 0, 0, 0] } }, 640, 480)).toThrow();
  });
});

describe("mounted FPV camera", () => {
  const config: CameraConfig = { lens: KB, mount: { offsetFrdM: [0, 0, 0], uptiltRad: 0 } };
  function forward(camera: PerspectiveCamera): Vector3 { return new Vector3(0, 0, -1).applyQuaternion(camera.quaternion); }
  function right(camera: PerspectiveCamera): Vector3 { return new Vector3(1, 0, 0).applyQuaternion(camera.quaternion); }
  function pose(yawRad: number, pitchRad = 0, rollRad = 0, sign = 1) {
    // ZYX body-to-NED quaternion (yaw, pitch, roll).
    const cy = Math.cos(yawRad / 2), sy = Math.sin(yawRad / 2), cp = Math.cos(pitchRad / 2), sp = Math.sin(pitchRad / 2), cr = Math.cos(rollRad / 2), sr = Math.sin(rollRad / 2);
    const p = newRenderPoseV2();
    p.qw = sign * (cr * cp * cy + sr * sp * sy); p.qx = sign * (sr * cp * cy - cr * sp * sy);
    p.qy = sign * (cr * sp * cy + sr * cp * sy); p.qz = sign * (cr * cp * sy - sr * sp * cy);
    return p;
  }
  const near = (a: Vector3, b: readonly number[]) => { expect(a.x).toBeCloseTo(b[0]!, 12); expect(a.y).toBeCloseTo(b[1]!, 12); expect(a.z).toBeCloseTo(b[2]!, 12); };

  it("looks along body forward: north is render -z, east is render +x", () => {
    const fpv = new FpvCamera(config, 640, 480);
    fpv.update(pose(0));
    near(forward(fpv.camera), [0, 0, -1]);
    near(right(fpv.camera), [1, 0, 0]);
    fpv.update(pose(90 * deg));
    near(forward(fpv.camera), [1, 0, 0]);
    // A point 10 m north at camera height projects to the source image centre when heading north.
    fpv.update(pose(0));
    const ndc = new Vector3(0, 0, -10).project(fpv.camera);
    expect(Math.abs(ndc.x) + Math.abs(ndc.y)).toBeLessThan(1e-12);
  });

  it("applies uptilt, body roll and the mount offset; q and -q agree", () => {
    const tilted = new FpvCamera({ ...config, mount: { offsetFrdM: [0.1, 0, -0.05], uptiltRad: 30 * deg } }, 640, 480);
    tilted.update(pose(0));
    near(forward(tilted.camera), [0, Math.sin(30 * deg), -Math.cos(30 * deg)]);
    const body = pose(90 * deg);
    body.northM = 5; body.eastM = -2; body.downM = -10;
    tilted.update(body);
    near(tilted.camera.position, [-2 + 0.1, 10 + 0.05, -5]); // offset forward = east, -down = up
    const flipped = pose(90 * deg, 0, 0, -1);
    flipped.northM = 5; flipped.eastM = -2; flipped.downM = -10;
    const before = tilted.camera.quaternion.clone();
    tilted.update(flipped);
    expect(Math.abs(tilted.camera.quaternion.dot(before))).toBeCloseTo(1, 12);
    // Right wing down (roll +90 deg): camera right points down in the world.
    const level = new FpvCamera(config, 640, 480);
    level.update(pose(0, 0, 90 * deg));
    near(right(level.camera), [0, -1, 0]);
    near(forward(level.camera), [0, 0, -1]);
  });

  it("never mutates the pose (truth) and ignores an invalid quaternion", () => {
    const fpv = new FpvCamera(config, 640, 480);
    const p = Object.freeze({ ...pose(0.3, 0.1, -0.2), northM: 1, eastM: 2, downM: -3 });
    const snapshot = JSON.stringify(p);
    fpv.update(p);
    expect(JSON.stringify(p)).toBe(snapshot);
    const placed = fpv.camera.position.clone();
    fpv.update({ ...newRenderPoseV2(), qw: 0, northM: 100 });
    near(fpv.camera.position, [placed.x, placed.y, placed.z]);
  });

  it("resizes the source projection with the lens", () => {
    const fpv = new FpvCamera(config, 640, 480);
    const fovY = fpv.camera.fov;
    fpv.resize(1280, 720);
    expect(fpv.camera.aspect).toBeCloseTo(fpv.params.sourceAspect, 12);
    expect(fpv.camera.fov).not.toBeCloseTo(fovY, 3);
    expect(() => new FpvCamera({ ...config, mount: { offsetFrdM: [0, 0, 0], uptiltRad: 2 } }, 640, 480)).toThrow();
  });
});
