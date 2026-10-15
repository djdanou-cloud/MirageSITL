import { describe, expect, it } from 'vitest';
import { CAPACITY, CONTROL_OFFSET, HEADER_WORDS, Header, StateReader, StateWriter,
  ControlReader, ControlWriter, createSharedMemory, newInput, newState, validateSharedMemory } from '@mirage/protocol';

describe('atomic shared memory ABI', () => {
  it('rejects incompatible versions and sizes', () => {
    expect(() => validateSharedMemory(new SharedArrayBuffer(8))).toThrow();
    const buffer = createSharedMemory();
    expect(buffer.byteLength).toBe(32896);
    expect(HEADER_WORDS * 4).toBe(64);
    expect(CONTROL_OFFSET * 4).toBe(32832);
    expect(Array.from(new Int32Array(buffer, 0, 16))).toEqual([
      0x4d534954, 1, 256, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(() => validateSharedMemory(buffer)).not.toThrow();
    Atomics.store(new Int32Array(buffer), Header.Version, 2);
    expect(() => validateSharedMemory(buffer)).toThrow('ABI');
  });
  it('round-trips all fields and float64 position/time without float32 loss', () => {
    const buffer = createSharedMemory(), writer = new StateWriter(buffer), reader = new StateReader(buffer);
    const expected = { ...newState(), tick: 900, simTime: 2.25, north: 6000000.123456789,
      east: -3456.0000004, down: -44.75, qw: 0.5, qx: -0.5, qy: 0.5, qz: 0.5,
      vn: 12.5, ve: -3.5, vd: 0.25, an: 1.5, ae: 2.5, ad: -0.5,
      p: 0.25, q: -0.5, r: 0.75, spool: 0.5, batteryVoltage: 12.25, flags: 2,
      wallTimeMs: 1790000000000.123 };
    const target = newState();
    expect(reader.latest(target)).toBe(false);
    writer.publish(expected);
    expect(reader.latest(target)).toBe(true);
    expect(target).toEqual(expected);
    // Frozen bytes independently packed from the ABI v1 table (little endian).
    const actualHex = Array.from(new Uint8Array(buffer, 64, 128), byte => byte.toString(16).padStart(2, '0')).join('');
    expect(actualHex).toBe('020000008403000000000000000002404eb7e60760e35641f96b0d000000abc000000000006046c00000003f000000bf0000003f0000003f00004841000060c00000803e0000c03f00002040000000bf0000803e000000bf0000403f0000003f0000444102000000f801c006450c7a4200000000000000000000000000000000');
  });
  it('wraps the ring, retains bounded history, and never reads a busy slot', () => {
    const buffer = createSharedMemory(), writer = new StateWriter(buffer), reader = new StateReader(buffer);
    const s = newState(), target = newState();
    for (let i = 0; i < CAPACITY + 1; i++) { s.tick = i; writer.publish(s); }
    expect(reader.latest(target)).toBe(true); expect(target.tick).toBe(CAPACITY);
    expect(reader.latest(target, CAPACITY - 1)).toBe(true); expect(target.tick).toBe(1);
    expect(reader.latest(target, CAPACITY)).toBe(false);
    const before = { ...target };
    Atomics.add(new Int32Array(buffer), HEADER_WORDS, 1); // latest slot (0) busy
    expect(reader.latest(target)).toBe(false); expect(target).toEqual(before);
  });
  it('publishes coherent pilot commands and retains last input on contention', () => {
    const buffer = createSharedMemory(), writer = new ControlWriter(buffer), reader = new ControlReader(buffer);
    const input = { ...newInput(), roll: -0.5, pitch: 0.25, yaw: 0.75, throttle: 0.5, flags: 3, wallTimeMs: 12345678.125 };
    writer.publish(input);
    const result = newInput(); expect(reader.latest(result)).toBe(true); expect(result).toEqual(input);
    Atomics.add(new Int32Array(buffer), CONTROL_OFFSET, 1);
    expect(reader.latest(result)).toBe(false); expect(result).toEqual(input);
  });
});
