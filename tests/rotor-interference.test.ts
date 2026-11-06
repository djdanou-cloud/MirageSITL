import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, CONFIGURATION_FLAG_WAKE_UNMODELED, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { validateModelManifest } from '@mirage/physics/model-manifest';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { RotorWakeCoupler, WAKE_SPREAD_SLOPE, rotorWashedDragAreasM2, wakeCoverage, wakeMomentumRoot } from '@mirage/physics/rotor-wake';
import { thrustCapacity } from '@mirage/physics/thrust-capacity';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';
import { holdHover, trimHover } from './support/hover-trim.ts';

// TASK-101. The oracles are closed forms written out here (momentum, kinetic power, the area of two circles), the registered fixture of
// native/bet/src/coaxial.rs, a 3D quadrature of the same top hat over the receiver's disk, and runs with the coupling off.

const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const RHO = 1.225;
/** Hub z up in body FRD: half a turn about body x. */
const UP = [1, 0, 0, 0, -1, 0, 0, 0, -1] as const;

function pairOf(offsetUpM: readonly [number, number, number], radius = 0.127, receiverRadius = radius, options: { spreadSlope?: number; washedDragAreaM2?: readonly number[] } = {}) {
  // Rotor 0 at the origin, rotor 1 at `offset`, in the common hub axes (x, y, up).
  return new RotorWakeCoupler({
    hubPositionsBodyM: Float64Array.from([0, 0, 0, offsetUpM[0], -offsetUpM[1], -offsetUpM[2]]),
    hubToBody: Float64Array.from([...UP, ...UP]), radiiM: Float64Array.from([radius, receiverRadius]),
  }, { pairs: [[0, 1]], ...options });
}
function run(coupler: RotorWakeCoupler, thrustN: number, air: readonly [number, number, number] = [0, 0, 0]) {
  coupler.thrustN[0] = thrustN;
  coupler.densityKgM3.fill(RHO);
  coupler.airHubMps.set(air, 0);
  coupler.step();
  return coupler;
}

describe('one rotor\'s wake', () => {
  it('solves the momentum balance', () => {
    for (const load of [1e-3, 0.5, 10, 80, 900]) for (const axial of [0, 1, 7, 30]) for (const across of [0, 0.5, 5, 40, 120]) {
      const e = wakeMomentumRoot(load, axial, across);
      expect(Math.abs(e * Math.hypot(across, axial + e) / load - 1)).toBeLessThanOrEqual(1e-10);
    }
    expect(wakeMomentumRoot(0, 3, 4)).toBe(0);
    expect(wakeMomentumRoot(-1, 3, 4)).toBe(0);
  });

  it('reproduces the registered coaxial fixture', () => {
    const f = json('./fixtures/rotors/coaxial.json') as Record<string, number>;
    const number = (key: string): number => { const value = f[key]; if (typeof value !== 'number') throw new Error(key); return value; };
    const coupler = pairOf([0, 0, -number('separationM')], number('sourceRadiusM'), number('receiverRadiusM'), { spreadSlope: Math.tan(number('spreadHalfAngleRad')) });
    run(coupler, number('thrustN'));
    const s = number('separationM'), launch = 2 * (coupler.inducedMps[0] ?? NaN), wake = coupler.wakeSpeedMps(0, s);
    expect(Math.abs(launch - number('launchSpeedMps'))).toBeLessThan(1e-9);
    expect(Math.abs(wake - number('wakeSpeedMps'))).toBeLessThan(1e-9);
    // The fixture's disks overlap by 0.75 of what they could; here they are aligned, so all of it.
    expect(Math.abs((coupler.wakeHubMps[5] ?? NaN) - number('receiverDeltaZMps') / number('overlap'))).toBeLessThan(1e-9);
    expect(Math.abs(0.5 * number('thrustN') * launch - number('sourcePowerW'))).toBeLessThan(1e-9);
    const launchRadius = coupler.wakeRadiusM(0, 0), tube = coupler.wakeRadiusM(0, s);
    expect(Math.abs(number('sourcePowerW') * (1 - launchRadius / tube) - number('mixingLossW'))).toBeLessThan(1e-9);
  });

  it('closes its momentum and energy budgets, climbing, in transverse flow and spreading', () => {
    const area = Math.PI * 0.127 * 0.127;
    for (const thrust of [1, 10, 40]) for (const axial of [0, 2, 12]) for (const across of [0, 3, 15]) {
      const coupler = pairOf([0, 0, -0.5]);
      run(coupler, thrust, [across, 0, -axial]);
      const v = coupler.inducedMps[0] ?? NaN, near = Math.hypot(across, axial + v), far = Math.hypot(across, axial + 2 * v);
      // The disk's own balance: T = 2 rho A v U (Glauert).
      expect(Math.abs(2 * RHO * area * v * near / thrust - 1)).toBeLessThanOrEqual(1e-9);
      // The far wake leaves carrying the disk's mass flow, with twice its induced velocity.
      const launchRadius = coupler.wakeRadiusM(0, 0);
      expect(Math.abs(launchRadius * launchRadius * far / (0.127 * 0.127 * near) - 1)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(coupler.wakeSpeedMps(0, 0) / (2 * v) - 1)).toBeLessThanOrEqual(1e-9);
      // Kinetic power of the excess at the far wake equals the disk's induced power, and only falls along the tube.
      const kinetic = (s: number): number => {
        const radius = coupler.wakeRadiusM(0, s), e = coupler.wakeSpeedMps(0, s), along = Math.hypot(across, axial + e);
        return 0.5 * RHO * Math.PI * radius * radius * along * ((axial + e) * (axial + e) - axial * axial);
      };
      expect(Math.abs(kinetic(0) / (thrust * (axial + v)) - 1)).toBeLessThanOrEqual(1e-9);
      let last = kinetic(0);
      for (const s of [0.05, 0.2, 0.5, 1, 3, 10]) {
        const radius = coupler.wakeRadiusM(0, s), e = coupler.wakeSpeedMps(0, s);
        // Momentum flux is conserved at every distance.
        expect(Math.abs(RHO * Math.PI * radius * radius * Math.hypot(across, axial + e) * e / thrust - 1)).toBeLessThanOrEqual(1e-9);
        const now = kinetic(s);
        expect(now).toBeLessThanOrEqual(last * (1 + 1e-12));
        last = now;
      }
    }
  });
});

/** The area of two circles' overlap, written out independently of the chords. */
function lens(a: number, b: number, d: number): number {
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return Math.PI * Math.min(a, b) ** 2;
  return a * a * Math.acos((d * d + a * a - b * b) / (2 * d * a)) + b * b * Math.acos((d * d + b * b - a * a) / (2 * d * b))
    - 0.5 * Math.sqrt((-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b));
}

describe('the fraction of a disk in the tube', () => {
  it('matches the lens area for a level disk, to rounding when one holds the other', () => {
    const R = 0.127;
    for (const circle of [0.5, 1 / Math.SQRT2, 0.9, 1, 1.2, 1.6, 2.5]) for (const offset of [0, 0.05, 0.2, 0.5, 0.7, 0.9, 1, 1.1, 1.3, 1.6, 2, 3]) {
      const c = circle * R, d = offset * R, want = lens(c, R, d) / (Math.PI * R * R);
      // Along either axis, since a level disk's axes are arbitrary.
      for (const got of [wakeCoverage(c, R, R, 0, d), wakeCoverage(c, R, R, d, 0)]) {
        const held = d <= Math.abs(c - R);
        expect(Math.abs(got - want), `${circle} ${offset}`).toBeLessThanOrEqual(held ? 1e-12 : 5e-3);
      }
    }
  });

  it('matches a grid for a tilted disk, at any offset direction', () => {
    const R = 1, n = 800;
    for (const facing of [0.9, 0.6, 0.3, 0.1]) for (const circle of [0.4, 0.8, 1.3]) for (const [major, minor] of [[0, 0], [0.5, 0], [0, 0.5], [0.8, 0.6], [1.2, 0.1], [0.3, 1.2]] as const) {
      let inside = 0, total = 0;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        const x = (a + 0.5) / n * 2 - 1, y = (b + 0.5) / n * 2 - 1;
        if (x * x + y * y > 1) continue;
        total++;
        if ((major + R * x) ** 2 + (minor + R * facing * y) ** 2 <= circle * circle) inside++;
      }
      expect(Math.abs(wakeCoverage(circle, R, R * facing, major, minor) - inside / total), `${facing} ${circle} ${major} ${minor}`).toBeLessThanOrEqual(5e-3);
    }
  });

  it('is nothing out of reach, and never above one', () => {
    expect(wakeCoverage(1, 1, 1, 3, 0)).toBe(0);
    expect(wakeCoverage(1, 1, 0.5, 0, 2)).toBe(0);
    expect(wakeCoverage(5, 1, 1, 0, 0)).toBeLessThanOrEqual(1);
    expect(Math.abs(wakeCoverage(5, 1, 1, 0, 0) - 1)).toBeLessThanOrEqual(1e-12);
  });
});

describe('a receiver', () => {
  /** The same top hat over the receiver's disk, point by point: where each point is along the tube sets the radius and the speed there. */
  function quadrature(coupler: RotorWakeCoupler, offset: readonly [number, number, number], radius: number, across: number, n = 240): number {
    const v = coupler.inducedMps[0] ?? NaN, through = 2 * v, tube = Math.hypot(across, through), w = [across / tube, 0, -through / tube] as const;
    let sum = 0, count = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const x = (a + 0.5) / n * 2 - 1, y = (b + 0.5) / n * 2 - 1;
      if (x * x + y * y > 1) continue;
      count++;
      const q = [offset[0] + radius * x, offset[1] + radius * y, offset[2]] as const, s = q[0] * w[0] + q[1] * w[1] + q[2] * w[2];
      if (s <= 0) continue;
      const d2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] - s * s, r = coupler.wakeRadiusM(0, s);
      if (d2 <= r * r) sum += coupler.wakeSpeedMps(0, s);
    }
    return sum / count;
  }

  it('in forward flight takes what the 3D quadrature does, within the declared budget', () => {
    let worst = 0, total = 0, cases = 0, washed = 0;
    for (const thrust of [5, 10, 20]) for (const distance of [0.3, 0.45, 0.6]) for (const down of [0, -0.05, -0.1, 0.03]) for (const across of [1, 3, 5, 10, 15, 20, 30, 40]) {
      const offset = [distance, 0, down] as const, coupler = pairOf(offset);
      run(coupler, thrust, [across, 0, 0]);
      const got = -(coupler.wakeHubMps[5] ?? NaN);
      const v = coupler.inducedMps[0] ?? NaN, tube = Math.hypot(across, 2 * v), s = (distance * across - down * 2 * v) / tube;
      if (!(s > 0)) { expect(Math.abs(got)).toBe(0); continue; }
      const error = Math.abs(got - quadrature(coupler, offset, 0.127, across)) / coupler.wakeSpeedMps(0, s);
      worst = Math.max(worst, error); total += error; cases++;
      if (got > 0) washed++;
    }
    expect(washed).toBeGreaterThan(30);
    expect(worst).toBeLessThanOrEqual(0.2);
    expect(total / cases).toBeLessThanOrEqual(0.02);
  }, 120000);

  it('on the same plane has none at hover, and a front rotor\'s reaches the rear, never the other way', () => {
    expect(run(pairOf([0.3, 0, 0]), 10).wakeHubMps[5]).toBe(0);
    const rear = run(pairOf([0.3, 0, 0]), 10, [30, 0, 0]), front = run(pairOf([-0.3, 0, 0]), 10, [30, 0, 0]);
    expect(rear.wakeHubMps[5]).toBeLessThan(-0.5);
    expect(front.wakeHubMps[5]).toBe(0);
    // Off to the side there is nothing to reach, and the lower rotor never blows on the upper.
    expect(run(pairOf([0, 0.3, 0]), 10, [30, 0, 0]).wakeHubMps[5]).toBe(0);
    expect(run(pairOf([0, 0, 0.05]), 10).wakeHubMps[5]).toBe(0);
  });

  it('adds each source once, sums them, and does not depend on the order of the pairs', () => {
    const geometry = { hubPositionsBodyM: Float64Array.from([0, 0, 0, 0, 0, 0.02, 0, 0, 0.1]), hubToBody: Float64Array.from([...UP, ...UP, ...UP]), radiiM: Float64Array.from([0.127, 0.127, 0.127]) };
    const stack = (pairs: readonly (readonly [number, number])[]) => {
      const coupler = new RotorWakeCoupler(geometry, { pairs });
      coupler.densityKgM3.fill(RHO); coupler.thrustN.set([10, 7, 4]);
      coupler.step();
      return Array.from(coupler.wakeHubMps);
    };
    const each = [stack([[0, 2]])[8] ?? NaN, stack([[1, 2]])[8] ?? NaN];
    expect(each[0]).toBeLessThan(-1);
    expect(each[1]).toBeLessThan(-1);
    const all = stack([[0, 1], [0, 2], [1, 2]]);
    expect(all[8]).toBe((each[0] ?? NaN) + (each[1] ?? NaN));
    expect(stack([[1, 2], [0, 2], [0, 1]])).toEqual(all);
    expect(() => stack([[0, 1], [0, 1]])).toThrow('Duplicate');
    expect(() => stack([[0, 0]])).toThrow('no two rotors');
    expect(() => stack([[0, 3]])).toThrow('no two rotors');
  });

  it('turns a wake into the receiver\'s own hub axes', () => {
    const sourceToBody = [0, 0, 1, 0, 1, 0, -1, 0, 0] as const; // Hub z along body x: the wake runs towards -x.
    const receiver = (tilt: number): RotorWakeCoupler => {
      const c = Math.cos(tilt), s = Math.sin(tilt);
      const coupler = new RotorWakeCoupler({
        hubPositionsBodyM: Float64Array.from([0, 0, 0, -0.3, 0, 0]),
        // The receiver's hub turned about body y from the source's.
        hubToBody: Float64Array.from([...sourceToBody, s, 0, c, 0, 1, 0, -c, 0, s]), radiiM: Float64Array.from([0.127, 0.127]),
      }, { pairs: [[0, 1]] });
      coupler.densityKgM3.fill(RHO); coupler.thrustN[0] = 10;
      coupler.step();
      return coupler;
    };
    // Square on: all along its own axis.
    const square = receiver(0);
    expect(square.wakeHubMps[5]).toBeLessThan(-1);
    expect(Math.abs(square.wakeHubMps[3] ?? NaN)).toBeLessThan(1e-12);
    // Turned: seen from body axes the velocity still runs along the wake, and it has an in-plane part in the hub's.
    const tilt = 0.5, turned = receiver(tilt), [hx = NaN, hy = NaN, hz = NaN] = turned.wakeHubMps.subarray(3, 6), c = Math.cos(tilt), s = Math.sin(tilt);
    expect(Math.abs(hx)).toBeGreaterThan(0.5);
    const body = [s * hx + c * hz, hy, -c * hx + s * hz] as const;
    expect(body[0]).toBeLessThan(-1);
    expect(Math.abs(body[1])).toBeLessThan(1e-12);
    expect(Math.abs(body[2])).toBeLessThan(1e-12);
    // Edge on: nothing at all.
    expect(Array.from(receiver(Math.PI / 2).wakeHubMps.subarray(3, 6)).map(Math.abs)).toEqual([0, 0, 0]);
  });

  it('says when a source descends through its disk, where the balance does not hold', () => {
    // A hover's millimetres per second of descent are inside it.
    expect(run(pairOf([0, 0, -0.1]), 10, [0, 0, 0.01]).outsideValidity).toBe(false);
    const slow = run(pairOf([0, 0, -0.1]), 10, [0, 0, 3]);
    expect(slow.outsideValidity).toBe(true);
    expect(slow.wakeHubMps[5]).toBeLessThan(0);
    // Faster than its far wake: nothing leaves below it.
    expect(run(pairOf([0, 0, -0.1]), 10, [0, 0, 40]).wakeHubMps[5]).toBe(0);
    expect(run(pairOf([0, 0, -0.1]), 10).outsideValidity).toBe(false);
  });

  it('is calm when the source gives no thrust', () => {
    for (const t of [0, -3]) expect(Array.from(run(pairOf([0, 0, -0.1]), t).wakeHubMps)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('refuses geometry it cannot use', () => {
    const base = { hubPositionsBodyM: Float64Array.from([0, 0, 0]), hubToBody: Float64Array.from(UP), radiiM: Float64Array.from([0.1]) };
    expect(() => new RotorWakeCoupler({ ...base, radiiM: Float64Array.from([0]) }, { pairs: 'all' })).toThrow('radius');
    expect(() => new RotorWakeCoupler({ ...base, hubToBody: new Float64Array(3) }, { pairs: 'all' })).toThrow('geometry');
    expect(() => new RotorWakeCoupler(base, { pairs: 'all', spreadSlope: -1 })).toThrow('spread');
    expect(() => new RotorWakeCoupler(base, { pairs: 'all', washedDragAreaM2: [1] })).toThrow('washed');
    expect(() => new RotorWakeCoupler(base, { pairs: 'all', washedDragAreaM2: [] })).toThrow('washed');
  });
});

describe('the download on the airframe', () => {
  it('is the closed form at hover, leaves the wake with the rest, and adds nothing to the free stream\'s drag', () => {
    const R = 0.127, area = Math.PI * R * R, cda = 0.03 * area;
    const coupler = pairOf([0, 0, -0.1], R, R, { washedDragAreaM2: [cda, 0] });
    run(coupler, 10);
    expect(Math.abs((coupler.downloadN[0] ?? NaN) / 10 - cda / area)).toBeLessThanOrEqual(1e-9);
    const plain = run(pairOf([0, 0, -0.1], R, R), 10);
    // What the arm took, the wake below no longer carries: the speed follows from T - F.
    const r = coupler.wakeRadiusM(0, 0.1);
    expect(Math.abs((coupler.wakeSpeedMps(0, 0.1) ** 2) * RHO * Math.PI * r * r / (10 - (coupler.downloadN[0] ?? NaN)) - 1)).toBeLessThanOrEqual(1e-9);
    expect(coupler.wakeSpeedMps(0, 0.1)).toBeLessThan(plain.wakeSpeedMps(0, 0.1));
    // In a climb the free stream's own part is the airframe drag's: F = 1/2 rho ((V+2v)^2 - V^2) C_D A.
    run(coupler, 10, [0, 0, -5]);
    const v = coupler.inducedMps[0] ?? NaN;
    expect(Math.abs((coupler.downloadN[0] ?? NaN) - 0.5 * RHO * ((5 + 2 * v) ** 2 - 25) * cda)).toBeLessThanOrEqual(1e-9);
  });

  it('comes from the hull: an arm under its rotor, a shape above the disk not at all', () => {
    const R = 0.127, width = 2 * 0.05 * R, arm = { kind: 'capsule', startBodyM: [0, 0, 0], endBodyM: [0.225, 0, 0], radiusM: 0.05 * R } as const;
    const body = { kind: 'cylinder', centerBodyM: [0, 0, 0], axisBody: [0, 0, 1], radiusM: 0.056, halfHeightM: 0.02 } as const;
    const up = [0, 0, -1];
    const [single, far, lower, upper] = rotorWashedDragAreasM2([
      { hubBodyM: [0.225, 0, 0], axisBody: up, radiusM: R }, { hubBodyM: [5, 5, 0], axisBody: up, radiusM: R },
      { hubBodyM: [0.225, 0, 0.05], axisBody: up, radiusM: R }, { hubBodyM: [0.225, 0, -0.05], axisBody: up, radiusM: R },
    ], [body, arm]);
    expect(Math.abs((single ?? NaN) - 1.2 * width * R / Math.SQRT2)).toBeLessThanOrEqual(1e-12);
    expect(far).toBe(0);
    // The lower rotor of a pair has the arm above it, in air that has not reached it; the upper rotor washes it.
    expect(lower).toBe(0);
    expect(Math.abs((upper ?? NaN) - (single ?? NaN))).toBeLessThanOrEqual(1e-12);
    // A rotor right over the body washes its plan area, end-on: inside the wake's circle.
    const [over] = rotorWashedDragAreasM2([{ hubBodyM: [0, 0, -0.05], axisBody: up, radiusM: R }], [body]);
    expect(Math.abs((over ?? NaN) - 1.17 * Math.PI * 0.056 * 0.056)).toBeLessThanOrEqual(1e-12);
  });
});

describe('in flight', () => {
  const MOTOR = 'a'.repeat(64), PROPELLER = 'b'.repeat(64), ESC = 'c'.repeat(64), BATTERY = 'd'.repeat(64), HZ = 800;
  let module: WebAssembly.Module;
  function card(type: string): ComponentCard {
    const base = json(`./fixtures/components/${type}-example.json`);
    if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error('Invalid card');
    return validateComponentCard({ ...base, provenance: Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example'])) });
  }
  async function manifestOf(fixture: string) {
    const base = validateAircraftProfile(json(`./fixtures/aircraft/${fixture}.json`));
    const profile = withPropellerPolars(validateAircraftProfile({ ...base, battery: { card: BATTERY }, motors: base.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
      [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
    const resolved = resolveComponents(profile, new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]));
    if (!resolved.components) throw new Error(resolved.missing.join('; '));
    return (await deriveVehicleManifest(profile, resolved.components, { modelId: 101 })).manifest;
  }
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  }, 300000);

  /** Held still by a huge mass, gravity off, every motor at one duty, flying level forward at a steady speed. */
  function held(configuration: BetFlightConfiguration, seconds = 2, forwardMps = 0) {
    const scale = 1e5, model = validateModelManifest(configuration.manifest);
    const heavy: BetFlightConfiguration = { ...configuration, gravityMps2: 0, syntheticGroundDownM: undefined, contact: undefined,
      manifest: { ...structuredClone(configuration.manifest as object), massKg: model.massKg * scale, inertiaBodyKgM2: model.inertiaBodyKgM2.map(v => v * scale) },
      initialBody: { ...configuration.initialBody, positionNedM: new Float64Array([0, 0, -50]), velocityNedMps: new Float64Array([forwardMps, 0, 0]) } };
    const d = new BetFlightDynamics(module, heavy, HZ);
    try {
      const frame = newActuatorFrameV2(), pilot = newInput(), trace: number[] = [];
      frame.motorMapId = heavy.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
      frame.actuatorCount = Math.max(...model.rotors.map(rotor => rotor.motorChannel)) + 1;
      for (const rotor of model.rotors) frame.normalizedActuators[rotor.motorChannel] = 0.6;
      for (let tick = 0; tick < Math.round(seconds * HZ); tick++) {
        d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / HZ; d.stepNow(pilot);
        if (d.fault !== '') throw new Error(d.fault);
        trace.push(d.state.vd, d.state.vn, d.state.ve, d.state.batteryVoltage);
      }
      const thrust = model.rotors.map((_, i) => d.rotorThrustN(i));
      const download = d.rotorWakes ? Array.from(d.rotorWakes.downloadN) : [];
      // From the change of the heavy body's speed over its last 0.1 s: what the body actually felt, upward.
      const span = Math.round(0.1 * HZ), lastAt = trace.length - 4;
      const netUpN = -((trace[lastAt] ?? NaN) - (trace[lastAt - 4 * span] ?? NaN)) / 0.1 * model.massKg * scale;
      const omega = model.rotors.map((_, i) => d.rotorSpeedRadS(i));
      return { thrust, omega, trace, download, netUpN, rotors: model.rotors, wake: d.rotorWakes ? Array.from(d.rotorWakes.wakeHubMps) : [], flags: d.validityFlags };
    } finally { d.dispose(); }
  }

  it('a coaxial pair is not twice one rotor: the lower rotor gives less, and nothing changes for the upper', async () => {
    const manifest = await manifestOf('octa-coaxial-16');
    const on = held(buildProfileDynamics(manifest, { initialStateOfCharge: 1, syntheticPad: true }).configuration, 1.5);
    const off = held(buildProfileDynamics(manifest, { initialStateOfCharge: 1, syntheticPad: true, rotorWake: 'off' }).configuration, 1.5);
    const levels = manifest.rotorWakePairs;
    expect(levels.length).toBe(8);
    const index = (id: number) => manifest.rotors.findIndex(rotor => rotor.id === id);
    for (const pair of levels) {
      const upper = index(pair.upstreamRotorId), lower = index(pair.downstreamRotorId);
      expect(on.thrust[lower]).toBeLessThan((on.thrust[upper] ?? NaN) * 0.95);
      expect(on.wake[lower * 3 + 2]).toBeLessThan(-0.5);
      expect(Array.from(on.wake.slice(upper * 3, upper * 3 + 3)).map(Math.abs).every(value => value === 0)).toBe(true);
      expect(off.thrust[lower]).toBeGreaterThan(on.thrust[lower] ?? NaN);
    }
    const sumOn = on.thrust.reduce((a, b) => a + b, 0), sumOff = off.thrust.reduce((a, b) => a + b, 0);
    expect(sumOn).toBeLessThan(sumOff);
  }, 120000);

  it('the download comes off what the body feels, by the disk\'s share', async () => {
    const quad = await manifestOf('quad-x');
    const configuration = buildProfileDynamics(quad, { initialStateOfCharge: 1, syntheticPad: true }).configuration;
    const areas = configuration.rotorWake?.washedDragAreaM2 ?? [];
    const on = held(configuration, 2);
    const off = held({ ...configuration, rotorWake: { pairs: 'all' } }, 2);
    const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
    const R = quad.rotors[0]?.radiusM ?? NaN, share = (areas[0] ?? NaN) / (Math.PI * R * R);
    expect(share).toBeGreaterThan(0.01);
    expect(Math.abs(sum(on.download) / sum(on.thrust) - share)).toBeLessThan(2e-3);
    expect(Math.abs(on.netUpN - (sum(on.thrust) - sum(on.download))) / sum(on.thrust)).toBeLessThan(2e-3);
    expect(Math.abs(off.netUpN - sum(off.thrust)) / sum(off.thrust)).toBeLessThan(2e-3);
    expect(sum(off.download)).toBe(0);
    expect(on.netUpN).toBeLessThan(off.netUpN);
  }, 120000);

  it('off is bitwise a configuration without it, and flagged for a declared pair', async () => {
    const manifest = await manifestOf('octa-coaxial-16');
    const off = buildProfileDynamics(manifest, { initialStateOfCharge: 1, syntheticPad: true, rotorWake: 'off' });
    expect(off.configuration.rotorWake).toBeUndefined();
    expect((off.configuration.configurationFlags ?? 0) & CONFIGURATION_FLAG_WAKE_UNMODELED).toBe(CONFIGURATION_FLAG_WAKE_UNMODELED);
    expect(off.limitations.some(text => text.includes('switched off'))).toBe(true);
    const on = buildProfileDynamics(manifest, { initialStateOfCharge: 1, syntheticPad: true });
    expect((on.configuration.configurationFlags ?? 0) & CONFIGURATION_FLAG_WAKE_UNMODELED).toBe(0);
    expect(on.limitations.some(text => text.includes('synthetic one-way'))).toBe(true);
    // A quad on the same plane at hover meets no wake: every pair is checked and none reaches, and without a washed area nothing differs.
    const quad = await manifestOf('quad-x');
    const quadOff = held(buildProfileDynamics(quad, { initialStateOfCharge: 1, syntheticPad: true, rotorWake: 'off' }).configuration, 0.5);
    const noDownload = buildProfileDynamics(quad, { initialStateOfCharge: 1, syntheticPad: true });
    const quadOn = held({ ...noDownload.configuration, rotorWake: { pairs: 'all' } }, 0.5);
    expect(quadOn.trace).toEqual(quadOff.trace);
    expect(Math.max(...quadOn.wake.map(Math.abs))).toBe(0);
    const again = held(buildProfileDynamics(quad, { initialStateOfCharge: 1, syntheticPad: true, rotorWake: 'off' }).configuration, 0.5);
    expect(again.trace).toEqual(quadOff.trace);
  }, 120000);

  it('the order the manifest declares its pairs in changes nothing, and a reset starts it over', async () => {
    const manifest = await manifestOf('octa-coaxial-16');
    const build = buildProfileDynamics(manifest, { initialStateOfCharge: 1, syntheticPad: true, rotorWake: 'declared' }).configuration;
    const wake = build.rotorWake;
    if (!wake || wake.pairs === 'all') throw new Error('Declared pairs expected');
    const shuffled = { ...build, rotorWake: { ...wake, pairs: [...wake.pairs].reverse() } };
    expect(held(shuffled, 0.5).trace).toEqual(held(build, 0.5).trace);
    const d = new BetFlightDynamics(module, build, HZ), frame = newActuatorFrameV2(), pilot = newInput();
    frame.motorMapId = build.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed; frame.actuatorCount = manifest.rotorCount;
    for (const rotor of validateModelManifest(build.manifest).rotors) frame.normalizedActuators[rotor.motorChannel] = 0.3;
    const flown = () => {
      const trace: number[] = [];
      for (let tick = 0; tick < 400; tick++) { d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / HZ; d.stepNow(pilot); trace.push(d.rotorSpeedRadS(0), d.rotorSpeedRadS(1), d.state.batteryVoltage); }
      return trace;
    };
    const first = flown();
    d.reset();
    expect(flown()).toEqual(first);
    d.dispose();
  }, 120000);

  it('in fast forward flight the rear rotors give less than the front ones, which they do not without it', async () => {
    const quad = await manifestOf('quad-x');
    const on = held(buildProfileDynamics(quad, { initialStateOfCharge: 1, syntheticPad: true }).configuration, 1, 25);
    const off = held(buildProfileDynamics(quad, { initialStateOfCharge: 1, syntheticPad: true, rotorWake: 'off' }).configuration, 1, 25);
    const { rotors } = on;
    const front = rotors.flatMap((rotor, i) => rotor.hubPositionBodyM[0]! > 0 ? [i] : []), rear = rotors.flatMap((rotor, i) => rotor.hubPositionBodyM[0]! < 0 ? [i] : []);
    expect(front.length).toBe(2);
    const mean = (values: readonly number[], at: readonly number[]) => at.reduce((sum, i) => sum + (values[i] ?? NaN), 0) / at.length;
    expect(mean(on.thrust, rear)).toBeLessThan(mean(on.thrust, front) * 0.97);
    expect(Math.abs(mean(off.thrust, rear) / mean(off.thrust, front) - 1)).toBeLessThan(0.02);
  }, 120000);

  for (const fixture of ['quad-x', 'hexa-x', 'octa-x', 'coaxial-x8', 'octa-coaxial-16']) {
    it(`${fixture} holds a steady hover with its wakes, on the power they ask for`, async () => {
      const manifest = await manifestOf(fixture);
      const flown = buildProfileDynamics(manifest, { initialStateOfCharge: 1 }).configuration;
      const free: BetFlightConfiguration = { ...flown, rotorWake: undefined };
      const trim = trimHover(module, free);
      // The rotor tables know no wake: the loop finds what it adds, and that becomes the feed-forward.
      let u = [...trim.u], hold = holdHover(module, flown, trim);
      const asked = () => Math.max(...u.map((value, i) => value / (trim.u[i] ?? NaN)));
      for (let round = 0; round < 8 && hold.correctionRelative >= 0.001; round++) {
        u = u.map((value, i) => value + (hold.correctionV[i] ?? NaN));
        hold = holdHover(module, flown, { ...trim, u });
      }
      expect(hold.correctionRelative, fixture).toBeLessThan(0.002);
      expect(hold.verticalSpeedMps, fixture).toBeLessThan(0.02);
      expect(hold.bodyRateRadS, fixture).toBeLessThan(0.01);
      expect(hold.attitudeErrorRad, fixture).toBeLessThan(0.01);
      // More power than the free-stream trim: the download at least, and the wake on a lower rotor.
      expect(asked(), fixture).toBeGreaterThan(1.005);
      expect(asked(), fixture).toBeLessThan(manifest.rotorWakePairs.length > 0 ? 1.4 : 1.1);
    }, 300000);
  }

  it('the thrust at full command feels them too', async () => {
    const manifest = await manifestOf('octa-coaxial-16');
    const on = thrustCapacity(module, buildProfileDynamics(manifest, { initialStateOfCharge: 1, syntheticPad: true }).configuration);
    const off = thrustCapacity(module, buildProfileDynamics(manifest, { initialStateOfCharge: 1, syntheticPad: true, rotorWake: 'off' }).configuration);
    expect(on.thrustN).toBeLessThan(off.thrustN);
    expect(on.thrustN).toBeGreaterThan(0.5 * off.thrustN);
  }, 180000);

  it('its default spread is the top hat of a round jet', () => {
    expect(Math.abs(WAKE_SPREAD_SLOPE - 0.1 * Math.sqrt(2 / Math.LN2))).toBeLessThan(1e-15);
    expect(WAKE_SPREAD_SLOPE).toBeGreaterThan(0.16);
    expect(WAKE_SPREAD_SLOPE).toBeLessThan(0.18);
  });
});
