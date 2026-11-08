import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, bodyLiftFractionsInto, groundEffectCorrectionsInto, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { BOUND_V2, BOUND_V2_OUTPUT_SLOTS } from '@mirage/wasm-bet/rotor-v2';
import { validateModelManifest } from '@mirage/physics/model-manifest';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import {
  ActuatorFlagV2, createSharedMemoryV2, createSpscQueue, newActuatorFrameV2, newFlightStateV2, newHeaderSnapshotV2, newInput, newPilotInputV2, PilotFlagV2, PilotWriterV2, StateReaderV2, tickToNumber, type CommandResultV2,
} from '@mirage/protocol';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { flightConfiguration } from './bet-runtime-fixture.ts';

// TASK-100: the effect through the flight dynamics and the session's switch. The oracles are Sanchez-Cuevas et al. 2017's
// quadrotor expression, written out here, and a run without the effect.

const MOTOR = 'a'.repeat(64), PROPELLER = 'b'.repeat(64), ESC = 'c'.repeat(64), BATTERY = 'd'.repeat(64);
const HZ = 800;
let module: WebAssembly.Module;
let quad: BetFlightConfiguration;
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
function card(type: string): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error('Invalid card');
  return validateComponentCard({ ...base, provenance: Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example'])) });
}
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY }, motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
    [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
  const resolved = resolveComponents(profile, new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]));
  if (!resolved.components) throw new Error(resolved.missing.join('; '));
  quad = buildProfileDynamics((await deriveVehicleManifest(profile, resolved.components, { modelId: 100 })).manifest, { initialStateOfCharge: 1, syntheticPad: true }).configuration;
}, 300000);

/** The vehicle held still by a huge mass at a height, gravity off, at one duty: returns its thrust from its acceleration, and the run's numbers. */
function held(configuration: BetFlightConfiguration, heightM: number, intensity: number | null, seconds = 2) {
  const scale = 1e5, manifest = validateModelManifest(configuration.manifest);
  const heavy: BetFlightConfiguration = { ...configuration, gravityMps2: 0, syntheticGroundDownM: undefined,
    manifest: { ...structuredClone(configuration.manifest as object), massKg: manifest.massKg * scale, inertiaBodyKgM2: manifest.inertiaBodyKgM2.map(v => v * scale) },
    initialBody: { ...configuration.initialBody, positionNedM: new Float64Array([0, 0, -heightM]) } };
  const d = new BetFlightDynamics(module, heavy, HZ);
  try {
    if (intensity !== null) d.setGroundEffect?.(intensity);
    const frame = newActuatorFrameV2(), pilot = newInput(), trace: number[] = [];
    frame.motorMapId = heavy.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
    frame.actuatorCount = Math.max(...manifest.rotors.map(rotor => rotor.motorChannel)) + 1;
    for (const rotor of manifest.rotors) frame.normalizedActuators[rotor.motorChannel] = 0.6;
    const ticks = Math.round(seconds * HZ);
    let start = 0, flags = 0;
    for (let tick = 0; tick < ticks; tick++) {
      d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / HZ; d.stepNow(pilot);
      if (d.fault !== '') throw new Error(d.fault);
      if (tick === ticks - HZ / 2 - 1) start = d.state.vd;
      flags = d.validityFlags;
      trace.push(d.state.vd, d.state.vn, d.state.ve, d.state.batteryVoltage);
    }
    return { thrustN: (start - d.state.vd) / 0.5 * manifest.massKg * scale, flags, trace };
  } finally { d.dispose(); }
}

describe('the neighbours of a rotor near the ground', () => {
  it('reproduce the quadrotor expression within 1e-9', () => {
    const R = 0.127, d = 0.3;
    const lateral = new Float64Array(16).fill(-1);
    // Rotors at the corners of a square of side d: two adjacent, one diagonal.
    const at = [[0, 0], [d, 0], [d, d], [0, d]] as const;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) lateral[i * 4 + j] = (at[i]![0] - at[j]![0]) ** 2 + (at[i]![1] - at[j]![1]) ** 2;
    const radius = new Float64Array(4).fill(R);
    for (const z of [0.1, 0.2, 0.5, 1, 3]) {
      const expression = (R / (4 * z)) ** 2 + R * R * z / Math.sqrt((d * d + 4 * z * z) ** 3) + (R * R / 2) * z / Math.sqrt((2 * d * d + 4 * z * z) ** 3);
      const heights = new Float64Array(4).fill(z), out = new Float64Array(4);
      groundEffectCorrectionsInto(4, radius, heights, lateral, out);
      for (const term of out) expect(Math.abs(term - expression)).toBeLessThanOrEqual(1e-9);
      // A rotor marked as no neighbour adds nothing.
      groundEffectCorrectionsInto(4, radius, heights, new Float64Array(16).fill(-1), out);
      expect(out[0]).toBe((R / (4 * z)) ** 2);
    }
  });
});

describe('the rotor ground effect in a flight', () => {
  it('gives more thrust nearer the ground, about nothing far from it, and the flag below half a radius', () => {
    const off = held(quad, 5, null), far = held(quad, 50, 1), mid = held(quad, 0.4, 1), low = held(quad, 0.2, 1), below = held(quad, 0.03, 1);
    expect(off.thrustN).toBeGreaterThan(1);
    expect(Math.abs(far.thrustN - off.thrustN) / off.thrustN).toBeLessThan(0.002);
    expect(mid.thrustN).toBeGreaterThan(off.thrustN);
    expect(low.thrustN).toBeGreaterThan(mid.thrustN);
    expect(low.flags & 8).toBe(0);
    expect(below.flags & 8).toBe(8);
    expect(off.flags & 8).toBe(0);
  });

  it('is bitwise a run without it when off or at intensity 0, and off again after being on', () => {
    const absent = held(quad, 0.3, null, 1);
    expect(held(quad, 0.3, 0, 1).trace).toEqual(absent.trace);
    const on = held(quad, 0.3, 1, 1);
    expect(on.trace).not.toEqual(absent.trace);
    // Half intensity gives a part of the gain.
    const half = held(quad, 0.3, 0.5, 1);
    expect(half.thrustN).toBeGreaterThan(absent.thrustN);
    expect(half.thrustN).toBeLessThan(on.thrustN);
    const d = new BetFlightDynamics(module, quad, HZ);
    d.setGroundEffect?.(1);
    expect(d.groundEffectIntensity).toBe(1);
    d.setGroundEffect?.(0);
    expect(d.groundEffectIntensity).toBe(0);
    d.setGroundEffect?.(1);
    d.reset();
    expect(d.groundEffectIntensity).toBe(0);
    d.dispose();
  });

  it('takes a plane from its source, with no ground meaning no effect', () => {
    const missing = held({ ...quad, groundPlanes: { planeInto: (_position, out) => { out[0] = NaN; out[1] = NaN; out[2] = NaN; out[3] = NaN; } } }, 0.2, 1, 1);
    expect(missing.trace).toEqual(held(quad, 0.2, null, 1).trace);
    // A plane raised to under the hubs gives the same result as lowering the vehicle.
    const raised = held({ ...quad, groundPlanes: { planeInto: (_position, out) => { out[0] = 0; out[1] = 0; out[2] = -1; out[3] = 4.8; } } }, 5, 1, 1);
    const lowered = held(quad, 0.2, 1, 1);
    expect(Math.abs(raised.thrustN - lowered.thrustN) / lowered.thrustN).toBeLessThan(1e-3);
  });
});

// TASK-100, the fountain's lift on the body (SPECS_SIMULATION_ENGINES "Body lift, the fountain"), declared before the implementation.
describe("the fountain's lift on the body", () => {
  it('follows equation (4) of Sanchez-Cuevas et al. within 1e-12, held at half a radius, and nothing without ground', () => {
    const R = 0.0445, b = 0.153, kb = 2, n = 3;
    const radius = new Float64Array(n).fill(R), opposite = new Float64Array(n).fill(b * b), out = new Float64Array(n);
    bodyLiftFractionsInto(n, radius, new Float64Array([0.15, 0.3, Infinity]), opposite, kb, out);
    const expression = (z: number) => kb * 2 * R * R * z / Math.sqrt((b * b + 4 * z * z) ** 3);
    expect(Math.abs(out[0]! - expression(0.15)) / expression(0.15)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(out[1]! - expression(0.3)) / expression(0.3)).toBeLessThanOrEqual(1e-12);
    expect(out[2]).toBe(0);
    bodyLiftFractionsInto(1, radius, new Float64Array([0.01]), opposite, kb, out);
    expect(out[0]).toBe(expression(0.5 * R));
  });

  /** The held vehicle (as `held`), returning its thrust from its acceleration, the last step's lift and rotor thrusts, and its rates. */
  function heldLift(configuration: BetFlightConfiguration, heightM: number) {
    const scale = 1e5, manifest = validateModelManifest(configuration.manifest);
    const heavy: BetFlightConfiguration = { ...configuration, gravityMps2: 0, syntheticGroundDownM: undefined,
      manifest: { ...structuredClone(configuration.manifest as object), massKg: manifest.massKg * scale, inertiaBodyKgM2: manifest.inertiaBodyKgM2.map(v => v * scale) },
      initialBody: { ...configuration.initialBody, positionNedM: new Float64Array([0, 0, -heightM]) } };
    const d = new BetFlightDynamics(module, heavy, HZ);
    try {
      d.setGroundEffect?.(1);
      const frame = newActuatorFrameV2(), pilot = newInput(), rates: number[] = [];
      frame.motorMapId = heavy.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
      frame.actuatorCount = Math.max(...manifest.rotors.map(rotor => rotor.motorChannel)) + 1;
      for (const rotor of manifest.rotors) frame.normalizedActuators[rotor.motorChannel] = 0.6;
      const ticks = 2 * HZ;
      let start = 0, lastDown = 0, lastQ = [1, 0, 0, 0];
      for (let tick = 0; tick < ticks; tick++) {
        // The pose the last step's ground query starts from: the vehicle drifts up a little under its thrust, and the fixture's CG
        // offset pitches it by a fraction of a milliradian.
        lastDown = d.state.down; lastQ = [d.state.qw, d.state.qx, d.state.qy, d.state.qz];
        d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / HZ; d.stepNow(pilot);
        if (d.fault !== '') throw new Error(d.fault);
        if (tick === ticks - HZ / 2 - 1) start = d.state.vd;
        rates.push(d.state.p, d.state.q, d.state.r);
      }
      const out = d.escEngine?.output;
      if (!out) throw new Error('The ESC drive is required');
      const thrusts = manifest.rotors.map((_, i) => out[i * BOUND_V2_OUTPUT_SLOTS + BOUND_V2.output.forceHub / 8 + 2]!);
      return { thrustN: (start - d.state.vd) / 0.5 * manifest.massKg * scale, upN: -d.state.ad * manifest.massKg * scale, lift: Array.from(d.bodyLiftBodyN), thrusts, rates, manifest, heightM: -lastDown, q: lastQ, heights: Array.from(d.groundHeightsM) };
    } finally { d.dispose(); }
  }

  it('lifts the held quad by its share of the rotors\' thrust, along the ground normal, with no moment', () => {
    const z = 0.2, on = heldLift(quad, z), none = heldLift({ ...quad, groundBodyLiftCoefficient: 0 }, z);
    expect(none.lift).toEqual([0, 0, 0]);
    // The share by the expression from the manifest's own geometry, at the heights the step queried; those heights are checked
    // against the body's pose before the last step (each hub turned into NED by its attitude) within a micrometre.
    const [qw, qx, qy, qz] = on.q as [number, number, number, number];
    const downOf = (v: readonly number[]) => 2 * (qx * qz - qw * qy) * v[0]! + 2 * (qy * qz + qw * qx) * v[1]! + (1 - 2 * (qx * qx + qy * qy)) * v[2]!;
    const rotors = on.manifest.rotors, cx = rotors.reduce((a, r) => a + r.hubPositionBodyM[0]! / rotors.length, 0), cy = rotors.reduce((a, r) => a + r.hubPositionBodyM[1]! / rotors.length, 0);
    let expected = 0;
    rotors.forEach((rotor, i) => {
      // Level within a milliradian, so the hub axis stays vertical to 1e-7 and the axial height is the vertical one to that order.
      expect(Math.abs(on.heights[i]! - (on.heightM - downOf(rotor.hubPositionBodyM)))).toBeLessThanOrEqual(1e-6);
      const R = rotor.radiusM, h = Math.max(on.heights[i]!, 0.5 * R), b2 = 4 * ((rotor.hubPositionBodyM[0]! - cx) ** 2 + (rotor.hubPositionBodyM[1]! - cy) ** 2);
      expected += Math.max(on.thrusts[i]!, 0) * 2 * 2 * R * R * h / Math.sqrt((b2 + 4 * h * h) ** 3);
    });
    // Its size exactly; its direction along the ground normal, up, in body axes (minus NED down turned into the body, the row
    // `downOf` uses) within a microradian: the step takes the normal at its midpoint attitude, the published state is its start,
    // and the quad pitches at about 1.6e-4 rad/s (corrected after the first run from an exact component check).
    const up = [-2 * (qx * qz - qw * qy), -2 * (qy * qz + qw * qx), -(1 - 2 * (qx * qx + qy * qy))];
    const size = Math.hypot(on.lift[0]!, on.lift[1]!, on.lift[2]!);
    expect(Math.abs(size - expected) / expected).toBeLessThanOrEqual(1e-12);
    const cross = Math.hypot(on.lift[1]! * up[2]! - on.lift[2]! * up[1]!, on.lift[2]! * up[0]! - on.lift[0]! * up[2]!, on.lift[0]! * up[1]! - on.lift[1]! * up[0]!);
    expect(Math.asin(cross / size)).toBeLessThanOrEqual(1e-6);
    // The body's motion carries it: the last step's upward force with the term against the run without it, less the rotors' own
    // difference (the lifted quad sits about 22 µm higher, so they give 0.24 mN less), is the lift within 1e-4 of it. Corrected after
    // the first run from the thrust averaged over the last 0.5 s, whose lift was larger than the last step's as the quad rose.
    const rotorDiff = on.thrusts.reduce((x, t) => x + t, 0) - none.thrusts.reduce((x, t) => x + t, 0);
    expect(Math.abs((on.upN - none.upN) - rotorDiff - expected) / expected).toBeLessThanOrEqual(1e-4);
    for (let k = 0; k < on.rates.length; k++) expect(Math.abs(on.rates[k]! - none.rates[k]!)).toBeLessThanOrEqual(1e-9);
  });

  it('falls off as the inverse square of the height, and is bitwise absent when off, at intensity 0 or with K_b 0', () => {
    // Corrected after the first run: the declared "no more than 1e-5 of thrust above 20 radii" ignored that the term falls only as
    // K_b R^2 / (4 z^2) far from the ground, 1.25e-3 at 20 radii with K_b 2; the far field is checked against that asymptote instead,
    // within 5 % for the frame's own b at 20 radii.
    const R = validateModelManifest(quad.manifest).rotors[0]!.radiusM;
    for (const radii of [20, 80]) {
      const high = heldLift(quad, radii * R), share = -high.lift[2]! / high.thrusts.reduce((a, t) => a + t, 0), asymptote = 2 * R * R / (4 * (radii * R) ** 2);
      expect(Math.abs(share / asymptote - 1)).toBeLessThanOrEqual(0.05);
    }
    const absent = held(quad, 0.3, null, 1);
    expect(held({ ...quad, groundBodyLiftCoefficient: 0 }, 0.3, null, 1).trace).toEqual(absent.trace);
    expect(held(quad, 0.3, 0, 1).trace).toEqual(absent.trace);
    expect(() => new BetFlightDynamics(module, { ...quad, groundBodyLiftCoefficient: -1 }, HZ)).toThrow('Invalid ground body lift coefficient');
  });
});

describe('its control through a session', () => {
  type Control = { atTick: number; enabled: boolean; intensity: number };
  /** A real session flying the quad off its pad on the pilot's throttle: every published number at every tick, and the replies. */
  function flight(configuration: BetFlightConfiguration, controls: readonly Control[], ticks: number) {
    const time = { mono: 0, wall: 1_790_000_000_000 };
    const stateBuffer = createSharedMemoryV2(), results: CommandResultV2[] = [];
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') },
      { monotonicMs: () => time.mono, wallMs: () => time.wall + time.mono }, hz => new BetFlightDynamics(module, configuration, hz));
    const reader = new StateReaderV2(stateBuffer), writer = new PilotWriterV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2(), pilot = newPilotInputV2();
    let id = 0;
    const raw = (message: Record<string, unknown>) => {
      reader.readHeader(header);
      session.handle({ requestId: ++id, expectedEpoch: header.sessionEpoch, ...message });
      session.drain(result => results.push(result));
    };
    raw({ protocolVersion: 2, type: 'sim.start' });
    for (const control of controls) raw({ protocolVersion: 3, type: 'effect.set', atTick: { lo: control.atTick, hi: 0 }, recovery: 'hold-offset',
      control: { schemaVersion: 1, id: 'ground', effect: 'rotor.ground-effect', enabled: control.enabled, intensity: control.intensity, parameters: {} } });
    const rows: number[] = [];
    let last = -1;
    for (let guard = 0; last < ticks; guard++) {
      if (guard > 1_000_000) throw new Error('The session did not advance');
      reader.readHeader(header);
      pilot.expectedEpoch = header.sessionEpoch;
      pilot.throttle = last < 40 ? 0 : 0.75;
      pilot.flags = PilotFlagV2.Connected | PilotFlagV2.Armed;
      pilot.sampledWallTimeMs = time.wall + time.mono;
      writer.publish(pilot);
      time.mono += 0.25;
      session.pump();
      if (reader.latest(state) && tickToNumber(state.tickId) !== last) {
        last = tickToNumber(state.tickId);
        rows.push(state.northM, state.eastM, state.downM, state.vnMps, state.veMps, state.vdMps, state.qw, state.qx, state.qy, state.qz, state.pRadS, state.qRadS, state.rRadS, state.referenceRotorRpm, state.vehicleFlags);
      }
    }
    session.drain(result => results.push(result));
    session.dispose();
    return { rows: Float64Array.from(rows), results, downM: state.downM };
  }
  const bytes = (values: Float64Array) => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  const TICKS = 1200;

  it('is refused without the ESC drive, by name', () => {
    const { results } = flight(flightConfiguration(), [{ atTick: 5, enabled: true, intensity: 1 }], 10);
    const reply = results.find(result => result.type === 'reject-v2');
    expect(reply).toBeDefined();
    expect(JSON.stringify(reply)).toContain('rotor ground effect');
  });

  it('leaves a climb off the pad bitwise alone when off, at zero, or sent and removed, and changes it when on', () => {
    const absent = flight(quad, [], TICKS);
    expect(absent.results.filter(result => result.type === 'reject-v2')).toEqual([]);
    expect(absent.downM).toBeLessThan(-0.2);
    for (const controls of [[{ atTick: 5, enabled: false, intensity: 1 }], [{ atTick: 5, enabled: true, intensity: 0 }],
      [{ atTick: 20, enabled: true, intensity: 1 }, { atTick: 20, enabled: false, intensity: 1 }]]) {
      const run = flight(quad, controls, TICKS);
      expect(run.results.filter(result => result.type === 'reject-v2')).toEqual([]);
      expect(bytes(run.rows).equals(bytes(absent.rows)), JSON.stringify(controls)).toBe(true);
    }
    const on = flight(quad, [{ atTick: 5, enabled: true, intensity: 1 }], TICKS);
    expect(on.results.filter(result => result.type === 'reject-v2')).toEqual([]);
    expect(bytes(on.rows).equals(bytes(absent.rows))).toBe(false);
    // The same throttle takes it higher: more thrust near the ground.
    expect(on.downM).toBeLessThan(absent.downM);
  }, 120000);
});
