import { describe, expect, it } from 'vitest';
import { CAPACITY_V2, HEADER_BYTES_V2, HeaderV2, PILOT_BYTES_V2, PILOT_OFFSET_V2, PilotCodecV2, PilotOffsetV2,
  SHARED_BYTES_V2, STATE_STRIDE_V2, StateCodecV2, StateOffsetV2, UNKNOWN_U32, compareTicks, createSharedMemory,
  createSharedMemoryV2, incrementTickInPlace, isValidFlightStateV2, isValidPilotInputV2, isValidTick,
  negotiateAbiVersion, newFlightStateV2, newPilotInputV2, simTimeFromTick, tickToNumber, validateSharedMemory,
  validateSharedMemoryV2 } from '@mirage/protocol';
import { goldenPilot, goldenState, loadGoldenV2, type GoldenRegionV2 } from './support/golden-v2';
import { WIDTH, assertCoverage, regionRow, specFields } from './support/spec-layout';

const SECTION = '## 3. Target ABI v2';
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const rowsAsSpec = (region: GoldenRegionV2) => region.rows.map(({ spec, offset, type, count }) => ({ spec, offset, type, count }));

describe('ABI v2 layout contract', () => {
  it('golden records describe exactly the v2 tables of the English specification', async () => {
    const golden = await loadGoldenV2();
    expect(rowsAsSpec(golden.header)).toEqual(specFields('### Header v2'));
    expect(rowsAsSpec(golden.state)).toEqual(specFields('### State v2'));
    expect(rowsAsSpec(golden.pilot)).toEqual(specFields('### Pilot mailbox v2'));
    assertCoverage(golden.header.rows, HEADER_BYTES_V2, 'Header v2');
    assertCoverage(golden.state.rows, STATE_STRIDE_V2, 'State v2');
    assertCoverage(golden.pilot.rows, PILOT_BYTES_V2, 'Pilot mailbox v2');
  });
  it('sizes and region offsets match the specification region table', () => {
    expect(regionRow(SECTION, 'Header')).toEqual({ offset: 0, bytes: HEADER_BYTES_V2 });
    expect(regionRow(SECTION, 'State ring')).toEqual({ offset: HEADER_BYTES_V2, bytes: CAPACITY_V2 * STATE_STRIDE_V2 });
    expect(regionRow(SECTION, 'Pilot mailbox')).toEqual({ offset: PILOT_OFFSET_V2, bytes: PILOT_BYTES_V2 });
    expect([HEADER_BYTES_V2, STATE_STRIDE_V2, CAPACITY_V2, PILOT_OFFSET_V2, PILOT_BYTES_V2, SHARED_BYTES_V2])
      .toEqual([64, 192, 256, 49216, 64, 49280]);
  });
  it('exported offset tables cover every field exactly, with natural alignment in every slot', async () => {
    const golden = await loadGoldenV2();
    const offsets = (region: GoldenRegionV2) => Object.fromEntries(region.rows
      .filter(row => row.property !== 'reserved' || region !== golden.header).map(row => [row.property, row.offset]));
    expect(offsets(golden.state)).toEqual(StateOffsetV2);
    expect(offsets(golden.pilot)).toEqual(PilotOffsetV2);
    expect(offsets(golden.header)).toEqual(Object.fromEntries(Object.entries(HeaderV2).map(([key, word]) => [key, word * 4])));
    for (const [base, region] of [[0, golden.header], [PILOT_OFFSET_V2, golden.pilot]] as const) {
      for (const row of region.rows) expect((base + row.offset) % Math.min(WIDTH[row.type], 8), row.property).toBe(0);
    }
    for (let slot = 0; slot < CAPACITY_V2; slot++) {
      for (const row of golden.state.rows) {
        expect((HEADER_BYTES_V2 + slot * STATE_STRIDE_V2 + row.offset) % WIDTH[row.type]).toBe(0);
      }
    }
  });
});

describe('ABI v2 codecs against golden bytes', () => {
  it('packs the golden state into exactly the golden 192 bytes and decodes them back', async () => {
    const golden = await loadGoldenV2();
    const { state, properties } = goldenState(golden);
    expect([...properties].sort()).toEqual(Object.keys(newFlightStateV2()).sort());
    expect(isValidFlightStateV2(state)).toBe(true);
    const codec = new StateCodecV2();
    codec.pack(state);
    expect(hex(new Uint8Array(codec.words.buffer))).toBe(hex(golden.state.bytes));
    const decoder = new StateCodecV2(), decoded = newFlightStateV2();
    new Uint8Array(decoder.words.buffer).set(golden.state.bytes);
    decoder.unpack(decoded);
    expect(decoded).toEqual(state);
  });
  it('packs the golden pilot mailbox into exactly the golden 64 bytes and decodes them back', async () => {
    const golden = await loadGoldenV2();
    const { pilot, properties } = goldenPilot(golden);
    expect([...properties].sort()).toEqual(Object.keys(newPilotInputV2()).sort());
    expect(isValidPilotInputV2(pilot)).toBe(true);
    const codec = new PilotCodecV2();
    codec.pack(pilot);
    expect(hex(new Uint8Array(codec.words.buffer))).toBe(hex(golden.pilot.bytes));
    const decoder = new PilotCodecV2(), decoded = newPilotInputV2();
    new Uint8Array(decoder.words.buffer).set(golden.pilot.bytes);
    decoder.unpack(decoded);
    expect(decoded).toEqual(pilot);
  });
  it('initializes the header to the golden bytes and leaves the ring and mailbox zero', async () => {
    const golden = await loadGoldenV2();
    const bytes = new Uint8Array(createSharedMemoryV2(400).slice(0));
    expect(hex(bytes.subarray(0, HEADER_BYTES_V2))).toBe(hex(golden.header.bytes));
    expect(bytes.subarray(HEADER_BYTES_V2).every(byte => byte === 0)).toBe(true);
  });
});

describe('ABI v2 validation and negotiation', () => {
  const mutated = (word: number, value: number) => {
    const buffer = createSharedMemoryV2();
    Atomics.store(new Int32Array(buffer), word, value);
    return buffer;
  };
  it('accepts every supported rate and rejects v1 buffers and malformed headers', () => {
    for (const hz of [400, 800, 1200] as const) expect(() => validateSharedMemoryV2(createSharedMemoryV2(hz))).not.toThrow();
    expect(() => validateSharedMemoryV2(createSharedMemory())).toThrow('size');
    expect(() => validateSharedMemoryV2(new ArrayBuffer(SHARED_BYTES_V2))).toThrow();
    expect(() => validateSharedMemoryV2(new SharedArrayBuffer(SHARED_BYTES_V2))).toThrow('mismatch');
    const invalid: [number, number][] = [
      [HeaderV2.Magic, 0x12345678], [HeaderV2.Version, 1], [HeaderV2.HeaderBytes, 128], [HeaderV2.StateStride, 128],
      [HeaderV2.Capacity, 255], [HeaderV2.PhysicsHz, 500], [HeaderV2.SessionEpoch, 0], [HeaderV2.MaxCatchUp, 9],
      [HeaderV2.RuntimeFlags, 8], [HeaderV2.PilotOffset, 32832], [HeaderV2.PilotBytes, 32], [14, 1], [15, 1],
    ];
    for (const [word, value] of invalid) expect(() => validateSharedMemoryV2(mutated(word, value)), `word ${word}`).toThrow('mismatch');
    expect(() => createSharedMemoryV2(500 as 400)).toThrow('rate');
  });
  it('negotiates v1 and v2 by version word and never reinterprets one as the other', () => {
    expect(negotiateAbiVersion(createSharedMemory())).toBe(1);
    expect(negotiateAbiVersion(createSharedMemoryV2())).toBe(2);
    expect(() => validateSharedMemory(createSharedMemoryV2())).toThrow();
    const v1Claiming2 = createSharedMemory();
    Atomics.store(new Int32Array(v1Claiming2), HeaderV2.Version, 2);
    expect(() => negotiateAbiVersion(v1Claiming2)).toThrow('size');
    expect(() => negotiateAbiVersion(mutated(HeaderV2.Version, 3))).toThrow('Unsupported');
    expect(() => negotiateAbiVersion(new SharedArrayBuffer(4))).toThrow();
  });
});

describe('TickId arithmetic', () => {
  it('carries into the high word, compares, and stays exact below 2^53', () => {
    const tick = { lo: 0xfffffffe, hi: 7 };
    incrementTickInPlace(tick); expect(tick).toEqual({ lo: 0xffffffff, hi: 7 });
    incrementTickInPlace(tick); expect(tick).toEqual({ lo: 0, hi: 8 });
    expect(tickToNumber(tick)).toBe(8 * 2 ** 32);
    expect(compareTicks({ lo: 5, hi: 1 }, { lo: 0xffffffff, hi: 0 })).toBe(1);
    expect(compareTicks({ lo: 5, hi: 1 }, { lo: 6, hi: 1 })).toBe(-1);
    expect(compareTicks({ lo: 6, hi: 1 }, { lo: 6, hi: 1 })).toBe(0);
    const max = { lo: 0xffffffff, hi: 0x1fffff };
    expect(isValidTick(max)).toBe(true); expect(tickToNumber(max)).toBe(Number.MAX_SAFE_INTEGER);
    expect(isValidTick({ lo: 0, hi: 0x200000 })).toBe(false);
    expect(isValidTick({ lo: -1, hi: 0 })).toBe(false);
    expect(simTimeFromTick({ lo: 400, hi: 1 }, 400)).toBe((2 ** 32 + 400) / 400);
    expect(simTimeFromTick({ lo: 1200, hi: 0 }, 1200)).toBe(1);
  });
});

describe('writer-side value contracts', () => {
  it('rejects nonfinite truth, f32 overflow, non-uint32 integers, unsafe ticks, and unassigned bits', async () => {
    const { state } = goldenState(await loadGoldenV2());
    const broken: ((s: typeof state) => void)[] = [
      s => { s.northM = NaN; }, s => { s.qw = Infinity; }, s => { s.batteryCurrentA = 1e39; },
      s => { s.sampleId = -1; }, s => { s.epoch = 1.5; }, s => { s.modelId = 2 ** 32; },
      s => { s.tickId.hi = 0x200000; }, s => { s.lastActuatorTick.lo = -1; },
      s => { s.vehicleFlags = 1 << 7; }, s => { s.ekfFlags = 1 << 5; }, s => { s.ewFlags = 1 << 5; },
      s => { s.sensorValidMask = 1 << 6; }, s => { s.autopilotHealth = 1 << 4; },
    ];
    for (const breakState of broken) {
      const candidate = newFlightStateV2();
      Object.assign(candidate, state, { tickId: { ...state.tickId }, lastActuatorTick: { ...state.lastActuatorTick } });
      breakState(candidate);
      expect(isValidFlightStateV2(candidate), breakState.toString()).toBe(false);
    }
    expect(isValidFlightStateV2(newFlightStateV2())).toBe(true);
  });
  it('rejects out-of-range pilot channels, flags, and mode slots', async () => {
    const { pilot } = goldenPilot(await loadGoldenV2());
    const broken: Partial<typeof pilot>[] = [
      { roll: 1.5 }, { pitch: NaN }, { throttle: -0.1 }, { flags: 4 }, { calibratedModeSlot: 6 },
      { sampledWallTimeMs: Infinity }, { deviceGeneration: -1 }, { inputSampleId: 0.5 },
    ];
    for (const change of broken) expect(isValidPilotInputV2({ ...pilot, ...change }), JSON.stringify(change)).toBe(false);
    expect(isValidPilotInputV2({ ...pilot, calibratedModeSlot: UNKNOWN_U32 })).toBe(true);
    expect(isValidPilotInputV2(newPilotInputV2())).toBe(true);
  });
});
