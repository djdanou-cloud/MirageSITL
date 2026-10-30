import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { componentRatings, resolveComponents } from '@mirage/aircraft/resolve-components';
import { PowerTelemetry, parseLimitRatings, type LimitEvent } from '@mirage/physics/limit-monitor';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2, type SessionRecordSample } from '../packages/physics/src/session-v2.ts';
import {
  POWER_BYTES_V1, POWER_MAGIC_V1, POWER_MOTOR_CAPACITY_V1, PowerReaderV1, PowerWriterV1, SHARED_BYTES_V2, StateReaderV2,
  createPowerChannelV1, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, newPowerSnapshotV1, validatePowerChannelV1,
  type CommandResultV2,
} from '@mirage/protocol';

// TASK-146 power telemetry v1: byte layout (SPECS_SHARED_MEMORY.md), round trip,
// and publication by the physics session next to an unchanged ABI v2 state.

describe('power telemetry v1 channel', () => {
  it('has the documented header and size, and rejects other buffers', () => {
    const buffer = createPowerChannelV1(), view = new DataView(buffer);
    expect(POWER_BYTES_V1).toBe(672);
    expect(buffer.byteLength).toBe(672);
    expect([0, 4, 8, 12, 16, 20].map(at => view.getUint32(at, true))).toEqual([POWER_MAGIC_V1, 1, 64, 608, 16, 0]);
    expect(POWER_MAGIC_V1).toBe(0x4d505752);
    for (let at = 24; at < 672; at += 4) expect(view.getUint32(at, true)).toBe(0);
    expect(() => validatePowerChannelV1(new SharedArrayBuffer(672))).toThrow('power telemetry v1');
    expect(() => validatePowerChannelV1(new SharedArrayBuffer(676))).toThrow('power telemetry v1');
    expect(() => validatePowerChannelV1(new ArrayBuffer(672))).toThrow('power telemetry v1');
    // ABI v2 keeps its size: the channel is a separate buffer.
    expect(SHARED_BYTES_V2).toBe(49280);
  });
  it('writes every field at its documented byte offset and reads it back', () => {
    const buffer = createPowerChannelV1(), writer = new PowerWriterV1(buffer), reader = new PowerReaderV1(buffer);
    const out = newPowerSnapshotV1();
    expect(reader.latest(out)).toBe(false);
    const t = new PowerTelemetry(16);
    for (let i = 0; i < 16; i++) {
      t.motors.set([1000 + i, 10.25 + i, 5.5 + i, 120.125 + i, i / 16], i * 5);
      t.motorWarning[i] = i % 32; t.motorLimited[i] = i % 2;
    }
    t.battery.set([0.75, 15.5, 42.25, 15.5 * 42.25, 3.75, 5]); t.batteryMasks.set([1, 3]);
    writer.publish(t, 0x89abcdef, 7, 3, 144, 5);
    const view = new DataView(buffer), at = 64;
    expect(view.getUint32(20, true)).toBe(1);
    expect(view.getUint32(at, true)).toBe(2); // seqlock even after one publication
    expect([4, 8, 12, 16, 20, 24, 28, 32, 36].map(o => view.getUint32(at + o, true))).toEqual([1, 0x89abcdef, 7, 3, 144, 16, 1, 3, 5]);
    expect([40, 48, 56, 64, 72, 80].map(o => view.getFloat64(at + o, true))).toEqual([0.75, 15.5, 42.25, 15.5 * 42.25, 3.75, 5]);
    for (let i = 0; i < 16; i++) {
      const m = at + 96 + i * 32;
      expect([0, 4, 8, 12, 16].map(o => view.getFloat32(m + o, true))).toEqual([1000 + i, 10.25 + i, 5.5 + i, 120.125 + i, i / 16]);
      expect([20, 24, 28].map(o => view.getUint32(m + o, true))).toEqual([i % 32, i % 2, 0]);
    }
    expect(reader.latest(out)).toBe(true);
    expect(out).toMatchObject({ sampleId: 1, tickLo: 0x89abcdef, tickHi: 7, epoch: 3, modelId: 144, motorCount: 16, batteryWarning: 1,
      batteryLimited: 3, droppedEvents: 5, stateOfCharge: 0.75, voltageV: 15.5, currentA: 42.25, remainingAh: 3.75, capacityAh: 5 });
    expect(Array.from(out.motors.subarray(5, 10))).toEqual([1001, 11.25, 6.5, 121.125, 1 / 16]);
    // A model without an electrical drive publishes no motors and a zeroed battery.
    writer.publish(null, 9, 0, 3, 1, 0);
    expect(reader.latest(out)).toBe(true);
    expect(out).toMatchObject({ sampleId: 2, motorCount: 0, voltageV: 0, batteryLimited: 0 });
    expect(Array.from(out.motorWarning)).toEqual(new Array(POWER_MOTOR_CAPACITY_V1).fill(0));
  });
  it('refuses a torn record and leaves the snapshot unchanged', () => {
    const buffer = createPowerChannelV1(), writer = new PowerWriterV1(buffer), reader = new PowerReaderV1(buffer), out = newPowerSnapshotV1();
    writer.publish(null, 1, 0, 1, 1, 0);
    const words = new Int32Array(buffer);
    Atomics.store(words, 16, Atomics.load(words, 16) + 1); // odd seqlock: a write in progress
    out.sampleId = 99;
    expect(reader.latest(out)).toBe(false);
    expect(out.sampleId).toBe(99);
    // An even sequence but a sample ID that is not the published count: a record from another publication.
    Atomics.store(words, 16, Atomics.load(words, 16) + 1);
    Atomics.store(words, 17, 7);
    expect(reader.latest(out)).toBe(false);
    expect(out.sampleId).toBe(99);
  });
});

describe('the session publishes power telemetry next to ABI v2', () => {
  const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32);
  let module: WebAssembly.Module;
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  }, 600000);
  const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  function card(type: string): ComponentCard {
    const base = json(`./fixtures/components/${type}-example.json`);
    if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error('Invalid card');
    const provenance = Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example']));
    return validateComponentCard({ ...base, provenance });
  }

  it('publishes per-motor values, hands them to the recording hook and drains limit events', async () => {
    const cards = new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]);
    const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
    const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
      motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
    [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
    const resolved = resolveComponents(profile, cards);
    if (!resolved.components) throw new Error(resolved.missing.join('; '));
    const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 146 });
    const registry = new VehicleRegistry();
    await registry.register(derived.bytes, derived.sha256);
    // The card ratings, with an empty voltage above the full pack so the first step warns of under-voltage.
    const ratings = parseLimitRatings({ ...componentRatings(profile, cards), battery: { emptyVoltageV: 17 } }, 4);
    let now = 0;
    const stateBuffer = createSharedMemoryV2();
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'),
      actuatorBuffer: createSpscQueue('actuator') }, { monotonicMs: () => now, wallMs: () => 1_790_000_000_000 + now }, undefined, null,
    profileModelPort(registry, () => module, {}, sha256 => (sha256 === derived.sha256 ? ratings : null)));
    const power = createPowerChannelV1(), reader = new PowerReaderV1(power), snapshot = newPowerSnapshotV1();
    const header = newHeaderSnapshotV2(), state = new StateReaderV2(stateBuffer), results: CommandResultV2[] = [];
    let requestId = 0;
    const command = async (type: string, extra: Record<string, unknown> = {}) => {
      state.readHeader(header);
      session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
      await session.settled();
      session.drain(result => results.push(result));
      return results.at(-1);
    };
    // Before a model with a drive is loaded, the demo publishes a record without motors.
    session.attachPowerChannel(power);
    expect(reader.latest(snapshot)).toBe(true);
    expect(snapshot.motorCount).toBe(0);
    expect(await command('model.load', { modelId: 146, manifestSha256: derived.sha256 })).toMatchObject({ type: 'ack-v2', status: 'applied' });
    const samples: { power: number; rpm: number }[] = [];
    session.setRecorder((sample: SessionRecordSample) => {
      samples.push({ power: sample.power?.motorCount ?? -1, rpm: sample.power?.motors[0] ?? NaN });
    });
    expect(await command('sim.start')).toMatchObject({ type: 'ack-v2', status: 'applied' });
    for (let k = 0; k < 40; k++) { now += 2.5; session.pump(); }
    expect(reader.latest(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({ modelId: 146, motorCount: 4, batteryWarning: 1, capacityAh: 5, stateOfCharge: 1 });
    expect(snapshot.voltageV).toBeCloseTo(16.8, 9);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(s => s.power === 4 && Number.isFinite(s.rpm))).toBe(true);
    const events: LimitEvent[] = [];
    expect(session.drainLimitEvents(e => events.push(e))).toBe(1);
    expect(events[0]).toMatchObject({ subject: 'battery', quantity: 'battery-voltage', kind: 'warning', edge: 'start', limit: 17 });
    expect(session.limitEventsDropped).toBe(0);
    // ABI v2 carries the same pack voltage it always did.
    const flight = (await import('@mirage/protocol')).newFlightStateV2();
    expect(state.latest(flight)).toBe(true);
    expect(flight.batteryVoltage).toBeCloseTo(snapshot.voltageV, 5);
    session.dispose();
  }, 300000);
  it('rejects ratings whose motor count differs from the model at model.load', async () => {
    const cards = new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]);
    const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
    const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
      motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
    [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
    const resolved = resolveComponents(profile, cards);
    if (!resolved.components) throw new Error(resolved.missing.join('; '));
    const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 146 });
    const registry = new VehicleRegistry();
    await registry.register(derived.bytes, derived.sha256);
    const one = parseLimitRatings({ schemaVersion: 1, battery: { emptyVoltageV: null },
      motors: [{ motorCurrentA: null, motorPowerW: null, escCurrentA: null, escVoltageV: null, rpm: null }] });
    const port = profileModelPort(registry, () => module, {}, () => one);
    await expect(port.prepare(146, derived.sha256)).rejects.toThrow('limit ratings list 1 motors');
  }, 300000);
});
