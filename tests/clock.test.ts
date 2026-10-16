import { describe, expect, it } from 'vitest';
import { DemoDynamics, FixedStepClock, MultiRateClock, isSampleDue, sampleIndexAtTick, tickToMicros } from '@mirage/physics';
import { SeededRandom } from '@mirage/test-support/prng';
import { newInput, tickToNumber, type PhysicsHz, type TickId } from '@mirage/protocol';

const RATES: PhysicsHz[] = [400, 800, 1200];

describe('multi-rate fixed-step clock', () => {
  it.each(RATES)('executes exactly 10*hz steps in 10 s at %i Hz under jittered wakeups, without drift', hz => {
    const clock = new MultiRateClock({ hz }), rng = new SeededRandom(11, hz);
    clock.reset(0);
    let ticks = 0, lastTick = 0, now = 0;
    // Irregular wakeups between 0.05 and 1.5 ms, never exceeding the catch-up bound.
    while (now < 10_000) {
      now = Math.min(10_000, now + 0.05 + rng.nextFloat() * 1.45);
      clock.advance(now, tick => { ticks++; lastTick = tickToNumber(tick); });
    }
    expect(ticks).toBe(10 * hz);
    expect(lastTick).toBe(10 * hz);
    expect(clock.droppedSteps).toBe(0);
    // The next deadline is exactly one step after 10 s: no accumulated error.
    expect(clock.nextMs).toBe(10_000 + 1000 / hz);
  });
  it('bounds catch-up, counts dropped wall time, and resumes after a pause without backlog', () => {
    const clock = new MultiRateClock({ hz: 1200, maxCatchUp: 8 });
    clock.reset(0);
    let ticks = 0;
    expect(clock.advance(1000, () => ticks++)).toBe(8);
    expect(clock.droppedSteps).toBe(1200 - 8); expect(clock.overruns).toBe(1);
    // Paused from 1 s to 5 s: reset() on resume must not replay the 4 s gap.
    clock.reset(5000);
    expect(clock.advance(5000 + 0.5, () => ticks++)).toBe(0);
    expect(clock.advance(5000 + 1000 / 1200, () => ticks++)).toBe(1);
    expect(tickToNumber(clock.tick)).toBe(9);
    clock.resetEpoch(6000);
    expect([tickToNumber(clock.tick), clock.droppedSteps, clock.overruns]).toEqual([0, 0, 0]);
  });
  it('rejects unsupported rates and catch-up bounds; the v1 clock stays 400 Hz', () => {
    expect(() => new MultiRateClock({ hz: 500 as PhysicsHz })).toThrow('rate');
    expect(() => new MultiRateClock({ maxCatchUp: 0 })).toThrow();
    const v1 = new FixedStepClock(8);
    expect([v1.hz, v1.maxCatchUp, v1.stepMs]).toEqual([400, 8, 2.5]);
  });
});

describe('rational time stamps', () => {
  it('produces 833/834 us intervals at 1200 Hz that sum exactly to one second', () => {
    const intervals = new Set<number>();
    let previous = 0;
    for (let n = 1; n <= 1200; n++) {
      const now = tickToMicros({ lo: n, hi: 0 }, 1200);
      intervals.add(now - previous); previous = now;
    }
    expect([...intervals].sort()).toEqual([833, 834]);
    expect(previous).toBe(1_000_000);
    expect(tickToMicros({ lo: 400, hi: 0 }, 400)).toBe(1_000_000);
    expect(tickToMicros({ lo: 1, hi: 0 }, 800)).toBe(1250);
  });
  it('stays exact across the 32-bit tick carry and far into a session', () => {
    const tick: TickId = { lo: 0, hi: 1 }; // 2^32 ticks
    expect(tickToMicros(tick, 1200)).toBe(Math.floor((2 ** 32 * 1_000_000) / 1200));
    expect(tickToMicros(tick, 400)).toBe(2 ** 32 * 2500);
    const late: TickId = { lo: 0xffffffff, hi: 0x1fffff }; // 2^53 - 1 ticks: beyond 2^53 us
    expect(tickToMicros(late, 400)).toBeNaN();
  });
  it('schedules 200/400 Hz IMU and 5/10 Hz GNSS samples phase-locked to every physics rate', () => {
    for (const hz of RATES) {
      for (const sensorHz of [200, 400, 5, 10]) {
        let due = 0;
        for (let n = 1; n <= hz * 10; n++) if (isSampleDue({ lo: n, hi: 0 }, sensorHz, hz)) due++;
        expect(due, `${sensorHz} Hz at ${hz} Hz`).toBe(sensorHz * 10);
        expect(sampleIndexAtTick({ lo: hz * 10, hi: 0 }, sensorHz, hz)).toBe(sensorHz * 10);
      }
    }
    expect(isSampleDue({ lo: 0, hi: 0 }, 200, 400)).toBe(false);
  });
});

describe('demo dynamics at every rate', () => {
  it.each(RATES)('integrates with dt = 1/%i and sim_time = tick/hz', hz => {
    const model = new DemoDynamics(hz), input = { ...newInput(), throttle: 0.7, flags: 3 };
    for (let tick = 1; tick <= 2 * hz; tick++) {
      input.wallTimeMs = (tick * 1000) / hz; model.step(input, input.wallTimeMs);
    }
    expect(model.state.tick).toBe(2 * hz);
    expect(model.state.simTime).toBe(2);
    expect(model.state.down).toBeLessThan(-3);
  });
  it('converges toward the same trajectory as the rate increases', () => {
    const climb = (hz: PhysicsHz) => {
      const model = new DemoDynamics(hz), input = { ...newInput(), throttle: 0.7, flags: 3 };
      for (let tick = 1; tick <= 2 * hz; tick++) { input.wallTimeMs = (tick * 1000) / hz; model.step(input, input.wallTimeMs); }
      return model.state.down;
    };
    const d400 = climb(400), d800 = climb(800), d1200 = climb(1200);
    // First-order (semi-implicit Euler) error shrinks with dt.
    expect(Math.abs(d800 - d1200)).toBeLessThan(Math.abs(d400 - d1200));
    expect(Math.abs(d400 - d1200)).toBeLessThan(0.05);
  });
});
