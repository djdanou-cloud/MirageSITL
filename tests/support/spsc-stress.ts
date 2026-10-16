import { SpscConsumer, SpscHeader, SpscProducer } from '../../packages/protocol/src/spsc-v2.ts';
import { SensorFrameCodecV2, SensorKindV2, SensorValidityV2, newSensorFrameV2, type SensorFrameV2 } from '../../packages/protocol/src/sensor-frame.ts';

// Shared by the Node worker_threads and browser Worker SPSC stress tests. Frame k
// carries tick k+1 and values that are distinct exact-f32 functions of k, so a
// lost, duplicated, reordered, or torn frame is detected. Explicit .ts imports
// let Node load this file in a worker thread.

export const SPSC_STRESS_FRAMES = 1_000_000;
export const CONTROL_STARTED = 0;
export const CONTROL_FINISHED = 1;
export const CONTROL_WOULD_BLOCK = 2;
export const CONTROL_ENCODE_FAILURES = 3;

export function fillStressFrame(k: number, out: SensorFrameV2): void {
  out.kind = SensorKindV2.Imu; out.epoch = 1; out.valueCount = 6;
  out.tickId.lo = (k + 1) >>> 0; out.tickId.hi = 0;
  out.sampleTimeUs.lo = (k * 2500) >>> 0; out.sampleTimeUs.hi = Math.floor((k * 2500) / 0x100000000);
  out.validityFlags = SensorValidityV2.PayloadValid | SensorValidityV2.TimestampValid;
  for (let i = 0; i < 6; i++) out.values[i] = ((k * 3 + i * 101) % 65536) / 8 - 4096;
  out.sourceId = k & 0xff;
}

/** Producer side (SITL policy): retries on would-block, never drops a frame. */
export function runSpscProducer(buffer: SharedArrayBuffer, control: Int32Array, frames = SPSC_STRESS_FRAMES): void {
  const producer = new SpscProducer(buffer, 'sensor', 'sitl-would-block');
  const codec = new SensorFrameCodecV2(), frame = newSensorFrameV2();
  Atomics.store(control, CONTROL_STARTED, 1);
  for (let k = 0; k < frames; k++) {
    fillStressFrame(k, frame);
    if (!codec.encode(frame)) { Atomics.add(control, CONTROL_ENCODE_FAILURES, 1); continue; }
    while (producer.tryPush(codec.words) === 'would-block') Atomics.add(control, CONTROL_WOULD_BLOCK, 1);
  }
  Atomics.store(control, CONTROL_FINISHED, 1);
}

export interface SpscStressReport {
  received: number; outOfOrder: number; corrupt: number; invalid: number;
  wouldBlock: number; encodeFailures: number; fullEvents: number; timedOut: boolean;
}

/** Consumer side: drains until the producer finished and the queue is empty. */
export function runSpscConsumer(buffer: SharedArrayBuffer, control: Int32Array, timeoutMs: number, frames = SPSC_STRESS_FRAMES): SpscStressReport {
  const consumer = new SpscConsumer(buffer, 'sensor'), codec = new SensorFrameCodecV2();
  const actual = newSensorFrameV2(), expected = newSensorFrameV2(), expectedCodec = new SensorFrameCodecV2();
  const report: SpscStressReport = { received: 0, outOfOrder: 0, corrupt: 0, invalid: 0, wouldBlock: 0, encodeFailures: 0, fullEvents: 0, timedOut: false };
  const deadline = performance.now() + timeoutMs;
  let iteration = 0;
  while (report.received < frames) {
    if ((iteration++ & 1023) === 0 && performance.now() > deadline) { report.timedOut = true; break; }
    if (!consumer.tryPop(codec.words)) continue;
    if (!codec.decode(actual)) { report.invalid++; report.received++; continue; }
    const k = report.received;
    if (actual.tickId.lo !== k + 1) report.outOfOrder++;
    fillStressFrame(k, expected); expectedCodec.encode(expected);
    for (let i = 0; i < codec.words.length; i++) if (codec.words[i] !== expectedCodec.words[i]) { report.corrupt++; break; }
    report.received++;
  }
  report.wouldBlock = Atomics.load(control, CONTROL_WOULD_BLOCK);
  report.encodeFailures = Atomics.load(control, CONTROL_ENCODE_FAILURES);
  report.fullEvents = Atomics.load(new Int32Array(buffer), SpscHeader.FullEvents) >>> 0;
  // Nothing beyond the expected frames may remain.
  if (consumer.tryPop(codec.words)) report.corrupt++;
  return report;
}
