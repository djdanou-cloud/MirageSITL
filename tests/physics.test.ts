import { describe, expect, it } from 'vitest';
import { DT, StateFlag, newInput } from '@mirage/protocol';
import { DemoDynamics, FixedStepClock } from '@mirage/physics';
import { Vector3 } from 'three';
import { nedToRenderBasis } from '../apps/web/src/coordinates';

describe('fixed-step scheduler', () => {
  it('executes 400 exact steps per simulated wall second without drift', () => {
    const clock = new FixedStepClock(); clock.reset(0);
    let ticks = 0;
    for (let ms = 1; ms <= 1000; ms++) clock.advance(ms, () => ticks++);
    expect(ticks).toBe(400); expect(clock.droppedSteps).toBe(0);
  });
  it('bounds catch-up and accounts for dropped wall time; resume has no backlog', () => {
    const clock = new FixedStepClock(8); clock.reset(0);
    let ticks = 0;
    expect(clock.advance(1000, () => ticks++)).toBe(8);
    expect(clock.droppedSteps).toBe(392); expect(clock.overruns).toBe(1);
    clock.reset(2000); expect(clock.advance(2001, () => ticks++)).toBe(0);
  });
});
describe('demo dynamics', () => {
  it('takes off with fresh armed input and kills target thrust on stale input', () => {
    const model = new DemoDynamics(), input = { ...newInput(), throttle: 0.7, flags: 3 };
    for (let tick = 1; tick <= 800; tick++) {
      input.wallTimeMs = tick * 2.5; model.step(input, input.wallTimeMs);
    }
    expect(model.state.down).toBeLessThan(-3);
    expect(model.state.flags & StateFlag.InputFailsafe).toBe(0);
    expect(model.state.simTime).toBe(800 * DT);
    for (let tick = 801; tick <= 1200; tick++) model.step(input, tick * 2.5);
    expect(model.state.flags & StateFlag.InputFailsafe).toBeTruthy();
    expect(model.state.spool).toBeLessThan(0.001);
  });
  it('is deterministic, normalizes quaternions, and resets to safe state', () => {
    const a = new DemoDynamics(), b = new DemoDynamics();
    const input = { ...newInput(), roll: 0.3, pitch: -0.2, yaw: 0.1, throttle: 0.6, flags: 3 };
    for (let i = 1; i <= 4000; i++) {
      input.wallTimeMs = i * 2.5; a.step(input, input.wallTimeMs); b.step(input, input.wallTimeMs);
    }
    expect(a.state).toEqual(b.state);
    expect(Math.hypot(a.state.qw, a.state.qx, a.state.qy, a.state.qz)).toBeCloseTo(1, 12);
    a.reset(); expect(a.state.tick).toBe(0); expect(a.state.spool).toBe(0);
    expect(a.state.flags & StateFlag.InputFailsafe).toBeTruthy();
  });
  it('does not apply invalid or disarmed input, and constrains the ground plane', () => {
    const m = new DemoDynamics(), input = { ...newInput(), throttle: 1, flags: 1, wallTimeMs: 10 };
    m.step(input, 10); expect(m.state.spool).toBe(0); expect(m.state.down).toBe(0);
    input.flags = 3; input.roll = NaN; m.step(input, 11); expect(m.state.spool).toBe(0);
  });
  it('maps all NED basis vectors to render coordinates without reflection', () => {
    const b = nedToRenderBasis();
    const close = (actual: Vector3, expected: number[]) => actual.toArray().forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 12));
    close(new Vector3(1, 0, 0).applyQuaternion(b), [0, 0, -1]);
    close(new Vector3(0, 1, 0).applyQuaternion(b), [1, 0, 0]);
    close(new Vector3(0, 0, 1).applyQuaternion(b), [0, -1, 0]);
  });
});
