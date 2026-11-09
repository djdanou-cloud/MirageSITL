import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, type BetFlightConfiguration, type EscShapingValues } from '@mirage/physics/bet-dynamics';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { BOUND_V2, BOUND_V2_OUTPUT_SLOTS } from '@mirage/wasm-bet/rotor-v2';
import { SeededRandom } from '@mirage/test-support/prng';
import {
  createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2, newPilotInputV2, PilotFlagV2, PilotWriterV2, StateReaderV2, tickToNumber, type CommandResultV2,
} from '@mirage/protocol';
import { MotorColumn } from '../packages/physics/src/limit-monitor.ts';
import { validateModelManifest } from '../packages/physics/src/model-manifest.ts';
import { ESC_DESYNC_STREAM_BASE, EscDesync, EscDesyncSlot } from '../packages/physics/src/esc-desync.ts';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { flightConfiguration } from './bet-runtime-fixture.ts';
import { PARITY_ESC_MOTOR, parityAircraft, parityEscDrive } from './support/autopilot-parity.ts';

// TASK-105: ESC desynchronization, by the checks declared before the implementation (SPECS_SIMULATION_ENGINES "ESC desynchronization").
// The oracles are a run with no control (compared bit for bit), the hazard law written out here with the repository's SeededRandom, the
// geometric law of the wait, and the declared tick count of a desynchronization. Every number of the model is an engineering choice;
// these checks hold the implementation to the design, not the design to any measured ESC.

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
  const [MOTOR, PROPELLER, ESC, BATTERY] = ['a', 'b', 'c', 'd'].map(c => c.repeat(64)) as [string, string, string, string];
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY }, motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
    [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
  const resolved = resolveComponents(profile, new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]));
  if (!resolved.components) throw new Error(resolved.missing.join('; '));
  quad = buildProfileDynamics((await deriveVehicleManifest(profile, resolved.components, { modelId: 100 })).manifest, { initialStateOfCharge: 1, syntheticPad: true }).configuration;
}, 600_000);

/** The parity quad on a million-kilogram body without gravity, as tests/motor-v2-flight.test.ts holds it: the rotors turn, the body stays. */
function heldAircraft(shaping?: EscShapingValues): BetFlightConfiguration {
  const c = parityAircraft(), model = validateModelManifest(c.manifest);
  c.manifest = { ...model, massKg: 1e6, inertiaBodyKgM2: model.inertiaBodyKgM2.map(v => v * 1e8) };
  c.gravityMps2 = 0;
  const drive = parityEscDrive(0.9, 3);
  c.drive = { ...drive, motors: drive.motors.map(m => ({ ...m, updatePeriodS: PARITY_ESC_MOTOR.updatePeriodS, ...(shaping ? { shaping } : {}) })) };
  return c;
}
interface Desync { active?: number; marginThreshold?: number; ratePerS?: number; intensity?: number; recoveryS?: number; seed?: number }
/** The control's slots, the catalog's initial values unless given. */
function slots(v: Desync = {}): Float64Array {
  const s = new Float64Array(EscDesyncSlot.Count);
  s[EscDesyncSlot.Active] = v.active ?? 1; s[EscDesyncSlot.MarginThreshold] = v.marginThreshold ?? 0.5; s[EscDesyncSlot.RatePerS] = v.ratePerS ?? 20;
  s[EscDesyncSlot.Intensity] = v.intensity ?? 1; s[EscDesyncSlot.RecoveryS] = v.recoveryS ?? 0.2; s[EscDesyncSlot.Seed] = v.seed ?? 1;
  return s;
}
const pilot = { flags: 3, throttle: 0, roll: 0, pitch: 0, yaw: 0, wallTimeMs: 0 };
function step(d: BetFlightDynamics, tick: number, throttle: number): void {
  d.nowMs = (tick + 0.5) * 1000 / d.hz; pilot.wallTimeMs = d.nowMs; pilot.throttle = throttle;
  d.stepNow(pilot);
  if (d.fault !== '') throw new Error(d.fault);
}
const omega = (d: BetFlightDynamics, rotor: number) => d.escEngine!.output[rotor * BOUND_V2_OUTPUT_SLOTS + 9]!;
const bytes = (values: Float64Array) => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
const SHAPING: EscShapingValues = { latencyFrames: 1, rampPerS: 0, startDuty: 0, throttleSteps: 2000 };

describe('ESC desynchronization in the flight', () => {
  it('1. is bitwise absent when off, at intensity 0, or switched on and off before the first step', () => {
    const run = (prepare: (d: BetFlightDynamics) => void) => {
      const d = new BetFlightDynamics(module, heldAircraft(SHAPING), 800), rows: number[] = [];
      prepare(d);
      for (let k = 0; k < 4000; k++) {
        step(d, k, Math.floor(k / 200) % 2 === 1 ? 1 : 0.2);
        for (let r = 0; r < 4; r++) rows.push(omega(d, r), d.escEngine!.driveFlags[r]!);
      }
      const events = d.escDesync!.events.reduce((a, b) => a + b, 0);
      d.dispose();
      return { rows: Float64Array.from(rows), events };
    };
    const absent = run(() => undefined);
    expect(absent.events).toBe(0);
    for (const prepare of [(d: BetFlightDynamics) => { expect(d.setEscDesync!(slots({ active: 0 }))).toBe(true); },
      (d: BetFlightDynamics) => { expect(d.setEscDesync!(slots({ intensity: 0 }))).toBe(true); },
      (d: BetFlightDynamics) => { expect(d.setEscDesync!(slots())).toBe(true); expect(d.setEscDesync!(slots({ active: 0 }))).toBe(true); }]) {
      const off = run(prepare);
      expect(off.events).toBe(0);
      expect(bytes(off.rows).equals(bytes(absent.rows))).toBe(true);
    }
    // Not vacuous: on, the same steps start desynchronizations and change the run.
    const on = run(d => { expect(d.setEscDesync!(slots())).toBe(true); });
    expect(on.events).toBeGreaterThan(0);
    expect(bytes(on.rows).equals(bytes(absent.rows))).toBe(false);
  }, 120_000);

  it('3. cuts the drive for exactly round(t_r·f) ticks, the rotor coasting, and restarts it', () => {
    for (const hz of [400, 800, 1200] as const) {
      const d = new BetFlightDynamics(module, heldAircraft(), hz), n = Math.round(0.05 * hz);
      expect(d.setEscDesync!(slots({ marginThreshold: 0, ratePerS: 1000, recoveryS: 0.05, seed: 3 }))).toBe(true);
      const events = d.escDesync!.events, flags = d.escEngine!.driveFlags, power = d.power!.motors;
      for (let k = 0; k < 100; k++) step(d, k, 0);
      expect(Array.from(events)).toEqual([0, 0, 0, 0]);
      // Per rotor: the tick its running desynchronization started, or −1.
      const started = [-1, -1, -1, -1], complete = [0, 0, 0, 0], last = [0, 0, 0, 0], before = [0, 0, 0, 0];
      for (let k = 100; k < 100 + hz; k++) {
        for (let r = 0; r < 4; r++) { last[r] = events[r]!; before[r] = omega(d, r); }
        step(d, k, 1);
        for (let r = 0; r < 4; r++) {
          const begun = events[r]! !== last[r]!, cut = flags[r] === BOUND_V2.drivePowerCut;
          if (started[r]! >= 0 && k - started[r]! === n) {
            // The tick after the last: clear, unless a new one starts on it.
            expect(cut === begun, `${hz} Hz rotor ${r} tick ${k}`).toBe(true);
            complete[r] = complete[r]! + 1; started[r] = -1;
          }
          if (begun) { expect(started[r]).toBe(-1); started[r] = k; }
          if (started[r]! >= 0) {
            expect(k - started[r]! < n).toBe(true);
            expect(cut, `${hz} Hz rotor ${r} tick ${k}`).toBe(true);
            expect(power[r * MotorColumn.stride + MotorColumn.ElectricalPowerW]).toBe(0);
            expect(omega(d, r)).toBeLessThanOrEqual(before[r]!);
            if (!begun) expect(events[r]).toBe(last[r]);
          } else expect(cut).toBe(false);
        }
      }
      expect(Math.min(...complete), `${hz} Hz`).toBeGreaterThan(0);
      d.dispose();
    }
  }, 120_000);

  it('4. starts none while the margin stays below the threshold, and some on steep steps', () => {
    const held = new BetFlightDynamics(module, heldAircraft(), 800);
    expect(held.setEscDesync!(slots())).toBe(true);
    for (let k = 0; k < 60 * 800; k++) step(held, k, 0.5);
    expect(Array.from(held.escDesync!.events)).toEqual([0, 0, 0, 0]);
    held.dispose();
    const stepped = new BetFlightDynamics(module, heldAircraft(), 800);
    expect(stepped.setEscDesync!(slots())).toBe(true);
    for (let k = 0; k < 60 * 800; k++) step(stepped, k, Math.floor(k / 800) % 2 === 1 ? 1 : 0.2);
    expect(stepped.escDesync!.events.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    stepped.dispose();
  }, 120_000);

  it('5. replays a seed bit for bit, and another seed gives other ticks', () => {
    const run = (seed: number) => {
      const d = new BetFlightDynamics(module, heldAircraft(SHAPING), 800), rows: number[] = [], onsets: number[] = [];
      expect(d.setEscDesync!(slots({ marginThreshold: 0.2, ratePerS: 50, recoveryS: 0.05, seed }))).toBe(true);
      let previous = 0;
      for (let k = 0; k < 8000; k++) {
        step(d, k, Math.floor(k / 400) % 2 === 1 ? 1 : 0.2);
        for (let r = 0; r < 4; r++) rows.push(omega(d, r));
        const total = d.escDesync!.events.reduce((a, b) => a + b, 0);
        if (total !== previous) onsets.push(k);
        previous = total;
      }
      d.dispose();
      return { rows: Float64Array.from(rows), onsets };
    };
    const first = run(1), again = run(1), other = run(2);
    expect(first.onsets.length).toBeGreaterThan(3);
    expect(bytes(again.rows).equals(bytes(first.rows))).toBe(true);
    expect(other.onsets).not.toEqual(first.onsets);
  }, 120_000);
});

describe('the hazard law', () => {
  it('2. starts N·p in N ticks, waits dt/p on average, within a tick of 1/λ, and none at or below the threshold', () => {
    for (const hz of [400, 1200]) {
      const dt = 1 / hz;
      for (const m of [0.25, 0.5, 0.75, 1]) {
        const e = new EscDesync(1, hz);
        expect(e.set(slots({ marginThreshold: 0.2, ratePerS: 50, recoveryS: 0.005, seed: 11 }))).toBe(true);
        e.margin[0] = m;
        const lambda = 50 * Math.min(1, (m - 0.2) / 0.8), p = -Math.expm1(-lambda * dt);
        let armed = 0, started = 0, wait = 0, waitSum = 0;
        while (armed < 2000 * hz) {
          const armable = e.remaining[0] === 0, previous = e.events[0]!;
          e.step();
          if (!armable) continue;
          armed++; wait++;
          if (e.events[0] !== previous) { started++; waitSum += wait; wait = 0; }
        }
        const mu = armed * p, meanWaitS = waitSum / started * dt, standardError = Math.sqrt(1 - p) / p * dt / Math.sqrt(started);
        expect(Math.abs(started - mu), `${hz} Hz m ${m}`).toBeLessThanOrEqual(4 * Math.sqrt(mu));
        expect(Math.abs(meanWaitS - dt / p), `${hz} Hz m ${m}`).toBeLessThanOrEqual(4 * standardError);
        expect(Math.abs(meanWaitS - 1 / lambda), `${hz} Hz m ${m}`).toBeLessThanOrEqual(dt + 4 * standardError);
      }
      for (const m of [0.2, 0.1, -0.5]) {
        const e = new EscDesync(1, hz);
        e.set(slots({ marginThreshold: 0.2, ratePerS: 50, recoveryS: 0.005, seed: 11 }));
        e.margin[0] = m;
        for (let k = 0; k < 1_000_000; k++) e.step();
        expect(e.events[0]).toBe(0);
      }
    }
  });

  it('2. scales its rate by the intensity exactly: intensity 2 at 25 /s starts on the ticks intensity 1 at 50 /s does', () => {
    const one = new EscDesync(3, 800), two = new EscDesync(3, 800);
    one.set(slots({ marginThreshold: 0.2, ratePerS: 50, recoveryS: 0.02, seed: 5 }));
    two.set(slots({ marginThreshold: 0.2, ratePerS: 25, intensity: 2, recoveryS: 0.02, seed: 5 }));
    one.margin.set([0.3, 0.6, 0.9]); two.margin.set([0.3, 0.6, 0.9]);
    for (let k = 0; k < 200_000; k++) {
      one.step(); two.step();
      for (let r = 0; r < 3; r++) if (one.cut[r] !== two.cut[r]) throw new Error(`tick ${k} rotor ${r}`);
    }
    expect(Array.from(two.events)).toEqual(Array.from(one.events));
    expect(Math.min(...one.events)).toBeGreaterThan(100);
  });

  it('draws from SeededRandom streams 0x00105001 + rotor by the declared rule, written out independently', () => {
    const hz = 1200, n = Math.round(0.03 * hz), margins = [0.35, 0.7, 1.2, -0.1], e = new EscDesync(4, hz);
    expect(e.set(slots({ marginThreshold: 0.3, ratePerS: 80, recoveryS: 0.03, seed: 0xfffffffe }))).toBe(true);
    e.margin.set(margins);
    const streams = margins.map((_, r) => new SeededRandom(0xfffffffe, ESC_DESYNC_STREAM_BASE + r)), left = [0, 0, 0, 0];
    for (let k = 0; k < 100_000; k++) {
      e.step();
      for (let r = 0; r < 4; r++) {
        const u = streams[r]!.nextFloat();
        let cut: boolean;
        if (left[r]! > 0) { left[r] = left[r]! - 1; cut = true; } else {
          const lambda = 80 * Math.min(1, Math.max(0, (margins[r]! - 0.3) / 0.7));
          cut = u < 1 - Math.exp(-lambda / hz);
          if (cut) left[r] = n - 1;
        }
        if ((e.cut[r] === 1) !== cut) throw new Error(`tick ${k} rotor ${r}`);
      }
    }
    expect(e.events[3]).toBe(0);
    expect(Math.min(e.events[0]!, e.events[1]!, e.events[2]!)).toBeGreaterThan(10);
  });

  it('refuses values outside the effect\'s ranges and changes nothing', () => {
    const e = new EscDesync(2, 400);
    for (const bad of [{ marginThreshold: 0.96 }, { ratePerS: 600, intensity: 2 }, { recoveryS: 0.001 }, { recoveryS: 3 }, { seed: 1.5 }, { seed: -1 }, { active: 2 }])
      expect(e.set(slots(bad)), JSON.stringify(bad)).toBe(false);
    expect(e.active).toBe(false);
  });
});

describe('ESC desynchronization through a session', () => {
  type Control = { atTick: number; enabled: boolean; intensity: number };
  /** A real session flying the quad off its pad on the pilot's throttle: every published number at every tick, and the replies. */
  function flight(configuration: BetFlightConfiguration, controls: readonly Control[], ticks: number) {
    const time = { mono: 0, wall: 1_790_000_000_000 };
    const stateBuffer = createSharedMemoryV2(), results: CommandResultV2[] = [];
    let dynamics: BetFlightDynamics | null = null;
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') },
      { monotonicMs: () => time.mono, wallMs: () => time.wall + time.mono }, hz => (dynamics = new BetFlightDynamics(module, configuration, hz)));
    const reader = new StateReaderV2(stateBuffer), writer = new PilotWriterV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2(), pilotV2 = newPilotInputV2();
    let id = 0;
    const raw = (message: Record<string, unknown>) => {
      reader.readHeader(header);
      session.handle({ requestId: ++id, expectedEpoch: header.sessionEpoch, ...message });
      session.drain(result => results.push(result));
    };
    raw({ protocolVersion: 2, type: 'sim.start' });
    for (const control of controls) raw({ protocolVersion: 3, type: 'effect.set', atTick: { lo: control.atTick, hi: 0 }, recovery: 'hold-offset',
      control: { schemaVersion: 1, id: 'desync', effect: 'esc.desync', enabled: control.enabled, intensity: control.intensity,
        parameters: { marginThreshold: 0.2, ratePerS: 200, recoveryS: 0.05, seed: 9 } } });
    const rows: number[] = [];
    let last = -1;
    for (let guard = 0; last < ticks; guard++) {
      if (guard > 1_000_000) throw new Error('The session did not advance');
      reader.readHeader(header);
      pilotV2.expectedEpoch = header.sessionEpoch;
      pilotV2.throttle = last < 40 ? 0 : 0.75;
      pilotV2.flags = PilotFlagV2.Connected | PilotFlagV2.Armed;
      pilotV2.sampledWallTimeMs = time.wall + time.mono;
      writer.publish(pilotV2);
      time.mono += 0.25;
      session.pump();
      if (reader.latest(state) && tickToNumber(state.tickId) !== last) {
        last = tickToNumber(state.tickId);
        rows.push(state.northM, state.eastM, state.downM, state.vnMps, state.veMps, state.vdMps, state.qw, state.qx, state.qy, state.qz, state.pRadS, state.qRadS, state.rRadS, state.referenceRotorRpm, state.vehicleFlags);
      }
    }
    session.drain(result => results.push(result));
    const events = (dynamics as BetFlightDynamics | null)?.escDesync?.events.reduce((a, b) => a + b, 0) ?? 0;
    session.dispose();
    return { rows: Float64Array.from(rows), results, events };
  }
  const TICKS = 1200;

  it('6. is refused without the ESC drive, by name', () => {
    const { results } = flight(flightConfiguration(), [{ atTick: 5, enabled: true, intensity: 1 }], 10);
    const reply = results.find(result => result.type === 'reject-v2');
    expect(reply).toBeDefined();
    expect(JSON.stringify(reply)).toContain('ESC desynchronization');
  });

  it('6. leaves a climb bitwise alone when off or at zero, and starts desynchronizations when on', () => {
    const absent = flight(quad, [], TICKS);
    expect(absent.results.filter(result => result.type === 'reject-v2')).toEqual([]);
    for (const controls of [[{ atTick: 5, enabled: false, intensity: 1 }], [{ atTick: 5, enabled: true, intensity: 0 }]]) {
      const run = flight(quad, controls, TICKS);
      expect(run.results.filter(result => result.type === 'reject-v2')).toEqual([]);
      expect(run.events).toBe(0);
      expect(bytes(run.rows).equals(bytes(absent.rows)), JSON.stringify(controls)).toBe(true);
    }
    const on = flight(quad, [{ atTick: 5, enabled: true, intensity: 1 }], TICKS);
    expect(on.results.filter(result => result.type === 'reject-v2')).toEqual([]);
    expect(on.events).toBeGreaterThan(0);
    expect(bytes(on.rows).equals(bytes(absent.rows))).toBe(false);
  }, 120_000);
});
