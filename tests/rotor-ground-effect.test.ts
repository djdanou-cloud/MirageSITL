import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, groundEffectCorrectionsInto, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
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
