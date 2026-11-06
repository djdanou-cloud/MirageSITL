import { describe, expect, it } from 'vitest';
import { newActuatorFrameV2, newFlightStateV2, type PowerTelemetrySource } from '../packages/protocol/src/index.ts';
import { CHUNK_BYTES, CHUNK_HEADER_BYTES, headerFromPlan, recordKey } from '../packages/aar/src/format-v2.ts';
import {
  createRecordingQueueV2, producerPlan, RecordingConsumerV2, RecordingProducerV2, RecordingQueueReaderV2, TelemetryDecimator, valueRow,
  type ProducerSample,
} from '../packages/aar/src/recorder-v2.ts';
import { planRates, SignalId, type RatePlan } from '../packages/aar/src/signal-catalog.ts';
import { MemoryRecordingBackend, StreamWriter } from '../packages/aar/src/stream-storage.ts';
import { chunkedBytes, estimatedBytes, estimateRecording, RUN_TAB_SOURCES } from '../apps/web/src/logging/size-estimate.ts';

// TASK-163: the size estimate against the bytes recorder v2 stores. Declared
// before the runs: for a run whose sources deliver every sample the plan
// keeps, the estimate is within 0.5 % of the stored bytes, and each physics
// signal's row count is exact.

const TOLERANCE = 0.005;
const TELEMETRY = [SignalId.AutopilotAttitude, SignalId.AutopilotLocalPosition, SignalId.AutopilotGlobalPosition, SignalId.AutopilotGps, SignalId.AutopilotEkf];

/** A Run-tab-like source: truth, pilot, actuators every tick, four motors with an electrical drive, no MirageSITL sensor frames. */
function session(hz: number) {
  const state = newFlightStateV2(), actuator = newActuatorFrameV2(), pilot = new Float64Array(4);
  const power: PowerTelemetrySource = { motorCount: 4, motors: new Float64Array(80), motorWarning: new Uint32Array(16), motorLimited: new Uint32Array(16),
    battery: new Float64Array([0.9, 16.4, 20, 328, 4.5, 5]), batteryMasks: new Uint32Array(2) };
  state.epoch = actuator.epoch = 1;
  actuator.actuatorCount = 4;
  const sample: ProducerSample = { state, pilot, actuator, sensor: null, power, contact: { count: 4, normalN: new Float64Array(4) } };
  return (tick: number): ProducerSample => {
    state.tickId.lo = tick; state.tickId.hi = 0; state.simTimeS = tick / hz;
    return sample;
  };
}

/** Records `seconds` of simulated time as the recorder Worker would, with autopilot telemetry arriving at 10 Hz; returns the stored bytes and rows. */
async function record(plan: RatePlan, seconds: number) {
  const hz = plan.physicsHz, queue = createRecordingQueueV2(), producer = new RecordingProducerV2(queue, producerPlan(plan));
  const reader = new RecordingQueueReaderV2(queue), backend = new MemoryRecordingBackend(), recordId = 'e'.repeat(32);
  const writer = await StreamWriter.start(backend, headerFromPlan(plan, { recordId, experimentId: 'task-163', startedAt: '2026-11-02T00:00:00.000Z',
    modelSha256: null, firmware: null }));
  writer.bindCounters(reader);
  const consumer = new RecordingConsumerV2(reader, recordKey(recordId), writer), next = session(hz), decimator = new TelemetryDecimator(plan);
  for (let t = 1; t <= seconds * hz; t++) {
    producer.record(next(t));
    if (t % (hz / 10) === 0) {
      for (const id of TELEMETRY) if (decimator.keep(id, t / hz)) consumer.appendRow(valueRow(id, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], t, t / hz, 1));
    }
    // The recorder Worker drains every 10 ms; here every 32 ticks, so the 2048-slot queue never fills and no row is lost.
    if (t % 32 === 0) consumer.drain(Number.MAX_SAFE_INTEGER);
    // The recorder Worker seals a chunk at least once per wall second; here once per simulated second.
    if (t % hz === 0) { consumer.drain(Number.MAX_SAFE_INTEGER); consumer.flush(); await writer.settled(); }
  }
  consumer.finish();
  return writer.close();
}

describe('recording size estimate', () => {
  it('matches the stored bytes of the default plan (50 Hz, A-09) within 0.5 %, with exact physics row counts', async () => {
    const plan = planRates({}, { physicsHz: 800, telemetryHz: 10 }), estimate = estimateRecording(plan, RUN_TAB_SOURCES);
    const entry = await record(plan, 120);
    expect(entry.producerLost).toBe(0);
    expect(Math.abs(entry.bytes - estimatedBytes(estimate, 120)) / entry.bytes).toBeLessThan(TOLERANCE);
    for (const signal of estimate.signals) {
      if (signal.upperBound || !signal.produced) continue;
      expect([signal.name, entry.rows[signal.name] ?? 0]).toEqual([signal.name, signal.rowsPerSimS * 120]);
    }
    // MirageSITL sensor frames are absent from a Run-tab run: no rows, and the estimate counts none.
    expect(estimate.signals.filter(signal => signal.name.startsWith('sensors.')).every(signal => signal.bytesPerSimS === 0)).toBe(true);
    expect(entry.rows['sensors.imu']).toBeUndefined();
  }, 120000);

  it('matches a plan with 800 Hz truth and motors requested at 2 kHz, capped at the physics rate', async () => {
    const plan = planRates({ groups: { truth: 800, motors: 2000 }, signals: { battery: 7 } }, { physicsHz: 800, telemetryHz: 10 });
    const estimate = estimateRecording(plan, RUN_TAB_SOURCES);
    expect(plan.signals.find(signal => signal.name === 'motors.speed')).toMatchObject({ effectiveHz: 800, capped: true });
    const entry = await record(plan, 30);
    expect(entry.producerLost).toBe(0);
    expect(Math.abs(entry.bytes - estimatedBytes(estimate, 30)) / entry.bytes).toBeLessThan(TOLERANCE);
    expect(entry.rows['truth.position']).toBe(800 * 30);
    expect(entry.rows['battery']).toBe(7 * 30);
  }, 120000);

  it('counts each row at its padded width and each chunk header', () => {
    const plan = planRates({ commonHz: 0, signals: { 'truth.position': 100 } }, { physicsHz: 400, telemetryHz: 10 });
    const estimate = estimateRecording(plan, RUN_TAB_SOURCES);
    // truth.position: a 40-byte header and three f64 channels.
    expect(estimate.signals.find(signal => signal.name === 'truth.position')).toMatchObject({ rowBytes: 64, rowsPerSimS: 100, bytesPerSimS: 6400 });
    expect(estimate.rowBytesPerSimS).toBe(6400);
    expect(chunkedBytes(CHUNK_BYTES - CHUNK_HEADER_BYTES)).toBe(CHUNK_BYTES);
    expect(chunkedBytes(CHUNK_BYTES - CHUNK_HEADER_BYTES + 8)).toBe(CHUNK_BYTES + 8 + CHUNK_HEADER_BYTES);
    expect(estimate.bytesPerSimHour).toBe(chunkedBytes(6400 * 3600));
    expect(estimate.upperBound).toBe(false);
  });
});
