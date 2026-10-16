import { describe, expect, it } from "vitest";
import { VelocityDrift, type DriftPreset } from "@mirage/ew/velocity-drift";
import type { GpsSample } from "../packages/mavlink/src/samples";

// TASK-055. Oracle: closed-form constant-acceleration and piecewise speed-cap
// kinematics, independent of the step size.
const preset = (accel: [number, number, number], maxSpeedMps: number, recovery: DriftPreset["recovery"] = "hold-offset", decelMps2 = 0.5): DriftPreset =>
  ({ accelNedMps2: accel, maxSpeedMps, decelMps2, recovery });
function run(d: VelocityDrift, hz: number, seconds: number): void {
  const steps = Math.round(hz * seconds);
  for (let i = 0; i < steps; i++) expect(d.advance(1 / hz)).toBe(true);
}
const close = (actual: ArrayLike<number>, expected: number[], tol: number) =>
  expected.forEach((e, i) => expect(Math.abs(actual[i]! - e), `axis ${i}: ${actual[i]} vs ${e}`).toBeLessThan(tol));

describe("coherent drift kinematics", () => {
  for (const hz of [400, 800, 1200]) {
    it(`matches b = a t^2/2 and v = a t at ${hz} Hz`, () => {
      const a: [number, number, number] = [0.2, -0.1, 0.05], d = new VelocityDrift();
      expect(d.enable(preset(a, 50))).toBe(true);
      run(d, hz, 30);
      close(d.offsetNedM, a.map(x => 0.5 * x * 900), 1e-8);
      close(d.velocityNedMps, a.map(x => x * 30), 1e-10);
    });

    it(`caps speed piecewise at the exact cap time at ${hz} Hz`, () => {
      // |a| = 0.3, cap 2 m/s: t_c = 6.666... s falls inside a step at every rate.
      const d = new VelocityDrift(), dir = [0.6, 0.8, 0], aMag = 0.3, cap = 2, t = 20, tc = cap / aMag;
      d.enable(preset([dir[0]! * aMag, dir[1]! * aMag, 0], cap));
      run(d, hz, t);
      const expected = 0.5 * aMag * tc * tc + cap * (t - tc);
      close(d.offsetNedM, dir.map(x => x * expected), 1e-8);
      close(d.velocityNedMps, dir.map(x => x * cap), 1e-12);
    });
  }

  it("keeps position consistent with velocity across the cap (b is the integral of v)", () => {
    const d = new VelocityDrift(), hz = 400, dt = 1 / hz;
    d.enable(preset([0.25, 0, 0], 1.0));
    let previousB = 0, previousV = 0;
    for (let i = 0; i < 4000; i++) {
      d.advance(dt);
      const b = d.offsetNedM[0]!, v = d.velocityNedMps[0]!;
      // Over one step, b advances by between dt*v_start and dt*v_end (monotone v).
      expect(b - previousB).toBeGreaterThanOrEqual(previousV * dt - 1e-12);
      expect(b - previousB).toBeLessThanOrEqual(v * dt + 1e-12);
      previousB = b; previousV = v;
    }
    expect(previousV).toBe(1.0);
  });

  it("hold-offset decelerates within limits, integrates b, then holds", () => {
    const d = new VelocityDrift(), v0 = 1.5, decel = 0.5;
    d.enable(preset([0.3, 0, 0], v0, "hold-offset", decel));
    run(d, 400, 10); // at the cap
    const b0 = d.offsetNedM[0]!;
    d.disable();
    expect(d.mode).toBe("decelerating");
    run(d, 400, 2);
    expect(d.velocityNedMps[0]).toBeCloseTo(v0 - decel * 2, 9);
    run(d, 400, 2);
    expect([d.mode, d.velocityNedMps[0]]).toEqual(["holding", 0]);
    expect(d.offsetNedM[0]).toBeCloseTo(b0 + (v0 * v0) / (2 * decel), 8); // stopping distance v^2/(2a)
    const held = d.offsetNedM[0];
    run(d, 400, 5);
    expect(d.offsetNedM[0]).toBe(held);
  });

  it("step-to-truth resets b and v_d as a counted discontinuity", () => {
    const d = new VelocityDrift();
    d.enable(preset([0.2, 0, 0], 3, "step-to-truth"));
    run(d, 400, 5);
    d.disable();
    expect([d.mode, d.discontinuities, ...d.offsetNedM, ...d.velocityNedMps]).toEqual(["off", 1, 0, 0, 0, 0, 0, 0]);
    d.reset();
    expect(d.discontinuities).toBe(0);
  });

  it("evolves only on the physics clock: GPS and render sampling never change the state", () => {
    const sampleAt = (gpsEvery: number, renderCalls: number) => {
      const d = new VelocityDrift(), src = gps(), out = gps();
      d.enable(preset([0.1, 0.2, -0.05], 4));
      for (let i = 1; i <= 8000; i++) {
        d.advance(1 / 400);
        if (i % gpsEvery === 0) d.distortGpsInto(src, out);
        for (let r = 0; r < renderCalls; r++) d.distortGpsInto(src, out);
      }
      return [...d.offsetNedM, ...d.velocityNedMps];
    };
    expect(sampleAt(40, 0)).toEqual(sampleAt(80, 3)); // bit-identical
  });

  it("corrupts GPS position and velocity coherently and recomputes course", () => {
    const d = new VelocityDrift(), src = gps(), out = gps();
    d.enable(preset([0, 0.25, 0], 1));
    run(d, 400, 4); // v_d = (0, 1, 0) at the cap
    expect(d.distortGpsInto(src, out)).toBe(true);
    close([out.vnMps, out.veMps, out.vdMps], [1, 1, 0], 1e-12);
    expect(out.courseRad).toBeCloseTo(Math.PI / 4, 12);
    expect(out.longitudeRad).toBeGreaterThan(src.longitudeRad); // drifted east
    const slow = { ...gps(), vnMps: 0, veMps: -1 };
    d.distortGpsInto(slow, out);
    expect(out.courseValid).toBe(false); // corrupted horizontal speed 0 < 0.05 m/s
  });

  it("rejects invalid presets and steps, and stops at the 10 km envelope", () => {
    const d = new VelocityDrift();
    for (const p of [preset([NaN, 0, 0], 1), preset([0.1, 0, 0], 0), preset([0.1, 0, 0], 60), preset([0.1, 0, 0], 1, "hold-offset", 0)]) {
      expect(d.enable(p)).toBe(false);
    }
    expect(d.advance(0)).toBe(false);
    expect(d.advance(0.02)).toBe(false);
    d.enable(preset([5, 0, 0], 50));
    for (let i = 0; i < 400 * 300 && d.mode === "drifting"; i++) d.advance(1 / 400);
    expect(d.mode).toBe("holding");
    expect(d.offsetNedM[0]).toBeLessThanOrEqual(10_000 + 50 / 400);
  });
});

function gps(): GpsSample {
  return { timeLoUs: 0, timeHiUs: 0, latitudeRad: 0.8, longitudeRad: 0.2, altitudeMslM: 200, vnMps: 1, veMps: 0, vdMps: 0,
    hdop: 1, vdop: 1, hdopValid: true, vdopValid: true, fixType: 3, satellites: 10, satellitesValid: true,
    velocityValid: true, courseRad: 0, courseValid: true };
}
