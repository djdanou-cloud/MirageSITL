import { describe, expect, it } from 'vitest';
import { GamepadAdapter, defaultCalibration, normalizeAxis } from '@mirage/input';
import { newInput } from '@mirage/protocol';

describe('gamepad calibration', () => {
  it('handles asymmetric endpoints, deadzone, inversion and unipolar throttle', () => {
    const c = { ...defaultCalibration().roll, min: -0.8, center: 0.1, max: 0.9, deadzone: 0.1 };
    expect(normalizeAxis(0.12, c)).toBe(0);
    expect(normalizeAxis(-0.8, c)).toBe(-1); expect(normalizeAxis(0.9, c)).toBe(1);
    expect(normalizeAxis(0.9, { ...c, inverted: true })).toBe(-1);
    expect(normalizeAxis(-0.8, c, true)).toBe(0); expect(normalizeAxis(0.9, c, true)).toBe(1);
    expect(normalizeAxis(-0.8, { ...c, inverted: true }, true)).toBe(1);
    expect(normalizeAxis(NaN, c)).toBeNaN();
    expect(normalizeAxis(0, { ...c, min: c.max })).toBeNaN();
  });
  it('reads USB axes, reports disconnection, and never silently switches devices', () => {
    const pad = { index: 0, connected: true, id: 'EdgeTX test', axes: [0.5, 0, -1, -0.5] } as unknown as Gamepad;
    const other = { ...pad, index: 1 };
    let pads: (Gamepad | null)[] = [pad];
    const adapter = new GamepadAdapter(defaultCalibration(), () => pads);
    const input = newInput(); adapter.poll(input, 100, true);
    expect(input.flags).toBe(3); expect(input.throttle).toBe(0); expect(input.roll).toBeGreaterThan(0);
    pads = [null, other]; adapter.poll(input, 102, true);
    expect(input.flags).toBe(0); expect(input.throttle).toBe(0); expect(adapter.status).toBe('disconnected');
  });
  it('fails closed on missing axes and browser permission errors', () => {
    const pad = { index: 0, connected: true, id: 'two axes', axes: [0, 0] } as unknown as Gamepad;
    const adapter = new GamepadAdapter(defaultCalibration(), () => [pad]);
    const input = newInput(); adapter.poll(input, 2, true);
    expect(input.flags).toBe(0); expect(adapter.status).toBe('invalid-axes');
    new GamepadAdapter(defaultCalibration(), () => { throw new Error('blocked'); }).poll(input, 3, true);
    expect(input.flags).toBe(0);
  });
});
