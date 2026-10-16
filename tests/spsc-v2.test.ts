import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { ACTUATOR_QUEUE_MAGIC, ActuatorFrameCodecV2, SENSOR_QUEUE_MAGIC, SPSC_BYTES, SPSC_CAPACITY, SPSC_SLOT_WORDS,
  SPSC_STRIDE, SensorFrameCodecV2, SensorKindV2, SensorValidityV2, SlotOffsetV2, SpscConsumer, SpscHeader, SpscProducer,
  createSpscQueue, newActuatorFrameV2, newSensorFrameV2, resetSpscQueue, validateSpscQueue } from '@mirage/protocol';
import { SPSC_STRESS_FRAMES, fillStressFrame, runSpscConsumer } from './support/spsc-stress';
import { specFields, specText } from './support/spec-layout';

const frameWithMarker = (marker: number) => { const words = new Int32Array(SPSC_SLOT_WORDS); words.fill(marker); return words; };

describe('SPSC queue layout matches section 5', () => {
  it('slot offsets and types match the specification slot table', () => {
    expect(specFields('| Slot Offset |').map(({ offset, type, count }) => ({ offset, type, count }))).toEqual([
      { offset: SlotOffsetV2.kind, type: 'u32', count: 1 }, { offset: SlotOffsetV2.epoch, type: 'u32', count: 1 },
      { offset: SlotOffsetV2.tickId, type: 'u64', count: 1 }, { offset: SlotOffsetV2.timeUs, type: 'u64', count: 1 },
      { offset: SlotOffsetV2.flags, type: 'u32', count: 1 }, { offset: SlotOffsetV2.count, type: 'u32', count: 1 },
      { offset: SlotOffsetV2.values, type: 'f32', count: 16 }, { offset: SlotOffsetV2.geo, type: 'f64', count: 3 },
      { offset: SlotOffsetV2.sourceId, type: 'u32', count: 1 }, { offset: SlotOffsetV2.reserved, type: 'u32', count: 1 },
    ]);
  });
  it('header offsets, sizes, and magics match the specification text', () => {
    const prose = /Queue header offsets: (.+?)\. Reset clears/.exec(specText.replace(/\n/g, ' '))?.[1] ?? '';
    const offsets = Object.fromEntries(Array.from(prose.matchAll(/(\d+) (\w+) u32/g), m => [m[2] ?? '', Number(m[1])] as const));
    expect(offsets).toEqual({ magic: 0, version: 4, stride: 8, capacity: 12, write_counter: 16, read_counter: 20, full_events: 24, epoch: 28 });
    expect(prose).toContain('8 stride u32=128'); expect(prose).toContain('12 capacity u32=1024'); expect(prose).toContain('32..63 reserved_zero');
    expect([SpscHeader.Magic, SpscHeader.Version, SpscHeader.Stride, SpscHeader.Capacity, SpscHeader.WriteCounter,
      SpscHeader.ReadCounter, SpscHeader.FullEvents, SpscHeader.Epoch].map(word => word * 4)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect([SPSC_STRIDE, SPSC_CAPACITY, SPSC_BYTES]).toEqual([128, 1024, 131136]);
    expect(specText).toContain('`0x4d534e53` for\nsensors and `0x4d414354` for actuators');
    expect([SENSOR_QUEUE_MAGIC, ACTUATOR_QUEUE_MAGIC]).toEqual([0x4d534e53, 0x4d414354]);
  });
  it('validates kind, size, ABI words, and reserved header words', () => {
    const sensor = createSpscQueue('sensor');
    expect(() => validateSpscQueue(sensor, 'sensor')).not.toThrow();
    expect(() => validateSpscQueue(sensor, 'actuator')).toThrow('mismatch');
    expect(() => validateSpscQueue(new SharedArrayBuffer(64), 'sensor')).toThrow('size');
    const reserved = createSpscQueue('actuator');
    Atomics.store(new Int32Array(reserved), 12, 1);
    expect(() => validateSpscQueue(reserved, 'actuator')).toThrow('reserved');
  });
});

describe('SPSC queue semantics', () => {
  it('is empty, fills to capacity, reports would-block without overwriting, and drains in order', () => {
    const buffer = createSpscQueue('sensor'), producer = new SpscProducer(buffer, 'sensor', 'sitl-would-block');
    const consumer = new SpscConsumer(buffer, 'sensor'), out = new Int32Array(SPSC_SLOT_WORDS);
    expect(consumer.tryPop(out)).toBe(false);
    for (let i = 0; i < SPSC_CAPACITY; i++) expect(producer.tryPush(frameWithMarker(i))).toBe('ok');
    expect(producer.depth).toBe(SPSC_CAPACITY);
    expect(producer.tryPush(frameWithMarker(-1))).toBe('would-block');
    expect(producer.tryPush(frameWithMarker(-1))).toBe('would-block');
    expect(producer.fullEvents).toBe(2);
    for (let i = 0; i < SPSC_CAPACITY; i++) {
      expect(consumer.tryPop(out)).toBe(true);
      expect(out.every(word => word === i)).toBe(true); // the unread frame survived both full attempts
    }
    expect(consumer.tryPop(out)).toBe(false);
    expect(producer.tryPush(frameWithMarker(7))).toBe('ok'); // space is reusable once released
  });
  it('HITL overflow faults the session instead of dropping, until the queue is reset', () => {
    const buffer = createSpscQueue('actuator'), producer = new SpscProducer(buffer, 'actuator', 'hitl-fault');
    for (let i = 0; i < SPSC_CAPACITY; i++) producer.tryPush(frameWithMarker(i));
    expect(producer.tryPush(frameWithMarker(-1))).toBe('faulted');
    expect([producer.faulted, producer.fullEvents]).toEqual([true, 1]);
    new SpscConsumer(buffer, 'actuator').tryPop(new Int32Array(SPSC_SLOT_WORDS));
    expect(producer.tryPush(frameWithMarker(1))).toBe('faulted'); // stays faulted even with space
    resetSpscQueue(buffer, 'actuator');
    const words = new Int32Array(buffer);
    expect([SpscHeader.WriteCounter, SpscHeader.ReadCounter, SpscHeader.FullEvents, SpscHeader.Epoch].map(i => Atomics.load(words, i))).toEqual([0, 0, 0, 2]);
    expect(new SpscProducer(buffer, 'actuator', 'hitl-fault').tryPush(frameWithMarker(1))).toBe('ok');
  });
  it('keeps order across the uint32 counter wrap', () => {
    const buffer = createSpscQueue('sensor'), words = new Int32Array(buffer);
    Atomics.store(words, SpscHeader.WriteCounter, 0xfffffff0 | 0); Atomics.store(words, SpscHeader.ReadCounter, 0xfffffff0 | 0);
    const producer = new SpscProducer(buffer, 'sensor', 'sitl-would-block'), consumer = new SpscConsumer(buffer, 'sensor');
    const out = new Int32Array(SPSC_SLOT_WORDS);
    for (let i = 0; i < 64; i++) {
      expect(producer.tryPush(frameWithMarker(i))).toBe('ok');
      if (i % 3 === 2) { expect(consumer.tryPop(out)).toBe(true); }
    }
    const seen: number[] = [];
    while (consumer.tryPop(out)) seen.push(out[0]!);
    expect(seen).toEqual(Array.from({ length: 64 - 21 }, (_, i) => i + 21));
    expect(Atomics.load(words, SpscHeader.WriteCounter) >>> 0).toBe((0xfffffff0 + 64) >>> 0);
  });
});

describe('sensor and actuator frame codecs', () => {
  it('encodes each field at its section 5 slot offset and decodes it back', () => {
    const frame = newSensorFrameV2(), codec = new SensorFrameCodecV2();
    frame.kind = SensorKindV2.Gnss; frame.epoch = 3; frame.tickId.lo = 0xfffffffe; frame.tickId.hi = 2;
    frame.sampleTimeUs.lo = 123; frame.sampleTimeUs.hi = 1; frame.valueCount = 8;
    frame.validityFlags = SensorValidityV2.PayloadValid | SensorValidityV2.PositionFixValid | SensorValidityV2.SatellitesValid;
    frame.values.set([1.5, -2.25, 0.125, 0.75, 1.25, 3, 12, 1.5]);
    frame.geoLatLonAlt.set([47.397742, 8.545594, 488.25]); frame.sourceId = 9;
    expect(codec.encode(frame)).toBe(true);
    const view = new DataView(codec.words.buffer), O = SlotOffsetV2;
    expect([view.getUint32(O.kind, true), view.getUint32(O.epoch, true), view.getUint32(O.tickId, true), view.getUint32(O.tickId + 4, true),
      view.getUint32(O.timeUs, true), view.getUint32(O.timeUs + 4, true), view.getUint32(O.flags, true), view.getUint32(O.count, true),
      view.getFloat32(O.values + 4 * 6, true), view.getFloat64(O.geo, true), view.getFloat64(O.geo + 16, true), view.getUint32(O.sourceId, true),
      view.getUint32(O.reserved, true)]).toEqual([2, 3, 0xfffffffe, 2, 123, 1, frame.validityFlags, 8, 12, 47.397742, 488.25, 9, 0]);
    const decoded = newSensorFrameV2();
    expect(new SensorFrameCodecV2().decode(Object.assign(decoded, {}))).toBe(false); // empty scratch is not a frame
    const reader = new SensorFrameCodecV2(); reader.words.set(codec.words);
    expect(reader.decode(decoded)).toBe(true);
    expect(decoded).toEqual(frame);
  });
  it('rejects frames that violate the per-kind contract', () => {
    const base = () => { const f = newSensorFrameV2(); fillStressFrame(5, f); return f; };
    const codec = new SensorFrameCodecV2();
    expect(codec.encode(base())).toBe(true);
    const broken: ((f: ReturnType<typeof base>) => void)[] = [
      f => { f.kind = 6; }, f => { f.valueCount = 5; }, f => { f.values[2] = NaN; }, f => { f.values[0] = 1e39; },
      f => { f.values[10] = 1; }, f => { f.validityFlags |= SensorValidityV2.PositionFixValid; }, f => { f.validityFlags |= 1 << 10; },
      f => { f.geoLatLonAlt[0] = 1; }, f => { f.tickId.hi = 0x200000; }, f => { f.sourceId = -1; },
      f => { f.kind = SensorKindV2.Gnss; f.valueCount = 8; f.values[6] = 7.5; }, // fractional satellites
      f => { f.kind = SensorKindV2.Gnss; f.valueCount = 8; f.values[3] = -1; }, // negative HDOP placeholder
      f => { f.kind = SensorKindV2.Gnss; f.valueCount = 8; f.geoLatLonAlt[0] = 91; },
    ];
    for (const breakFrame of broken) {
      const frame = base(); breakFrame(frame);
      expect(codec.encode(frame), breakFrame.toString()).toBe(false);
    }
    const actuator = newActuatorFrameV2(), actuators = new ActuatorFrameCodecV2();
    actuator.actuatorCount = 4; actuator.normalizedActuators.set([0.25, -1, 1, 0]); actuator.actuatorFlags = 1; actuator.motorMapId = 2;
    expect(actuators.encode(actuator)).toBe(true);
    const decoded = newActuatorFrameV2(), reader = new ActuatorFrameCodecV2(); reader.words.set(actuators.words);
    expect(reader.decode(decoded)).toBe(true); expect(decoded).toEqual(actuator);
    for (const change of [{ actuatorCount: 17 }, { actuatorFlags: 2 }, { kind: 2 }]) {
      expect(actuators.encode({ ...actuator, ...change }), JSON.stringify(change)).toBe(false);
    }
    const outOfRange = newActuatorFrameV2(); outOfRange.actuatorCount = 1; outOfRange.normalizedActuators[0] = 1.01;
    expect(actuators.encode(outOfRange)).toBe(false);
    reader.words[SlotOffsetV2.geo / 4] = 1; // a nonzero geo word in an actuator slot
    expect(reader.decode(decoded)).toBe(false);
  });
});

describe('SPSC concurrency stress', () => {
  it(`delivers ${SPSC_STRESS_FRAMES} frames from a producer thread in order, without loss, duplication, or corruption`, async () => {
    const buffer = createSpscQueue('sensor'), control = new SharedArrayBuffer(16);
    const worker = new Worker(new URL('./support/spsc-stress.node-worker.ts', import.meta.url), { workerData: { buffer, control } });
    const exited = new Promise<number>(resolve => worker.once('exit', resolve));
    const failed = new Promise<never>((_, reject) => worker.once('error', reject));
    try {
      const report = runSpscConsumer(buffer, new Int32Array(control), 120_000);
      expect(await Promise.race([exited, failed])).toBe(0);
      expect(report.timedOut).toBe(false);
      expect([report.received, report.outOfOrder, report.corrupt, report.invalid, report.encodeFailures]).toEqual([SPSC_STRESS_FRAMES, 0, 0, 0, 0]);
      // Full conditions are counted, never silent: every would-block was a counted full event.
      expect(report.fullEvents).toBe(report.wouldBlock);
      console.info('spsc stress', JSON.stringify(report));
    } finally {
      await worker.terminate();
    }
  }, 180_000);
});
