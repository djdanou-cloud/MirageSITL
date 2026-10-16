import { describe, expect, it } from 'vitest';
import { SteppingPolicy, newPumpReport, type ClockMode, type StepGate } from '@mirage/physics';
import { tickToNumber, type TickId } from '@mirage/protocol';

const ALWAYS: StepGate = { ready: () => true };
/** Drives a policy with 1 ms wakeups, recording every integrated tick. */
function run(policy: SteppingPolicy, fromMs: number, toMs: number, gate: StepGate, ticks: number[], everyMs = 1) {
  const report = newPumpReport();
  let dropped = 0, waits = 0, maxPerPump = 0;
  for (let now = fromMs; now <= toMs; now += everyMs) {
    policy.pump(now, gate, (tick: TickId) => ticks.push(tickToNumber(tick)), report);
    dropped += report.dropped; if (report.waiting) waits++;
    maxPerPump = Math.max(maxPerPump, report.executed);
  }
  return { dropped, waits, maxPerPump, fault: report.fault };
}
const contiguous = (ticks: number[]) => ticks.every((tick, i) => tick === i + 1);

describe('clock modes under a 1 s stall', () => {
  it('interactive: counts dropped intervals and keeps simulation ticks contiguous', () => {
    const policy = new SteppingPolicy({ hz: 400, mode: 'interactive' }), ticks: number[] = [];
    policy.resume(0);
    run(policy, 1, 1000, ALWAYS, ticks);
    const stall = run(policy, 2000, 2000, ALWAYS, ticks); // the Worker was blocked from 1 s to 2 s
    expect(stall.dropped).toBe(400 - 8);
    expect(policy.droppedSteps).toBe(392);
    expect(contiguous(ticks)).toBe(true); // drops lose wall time, never simulation ticks
    expect(ticks.length).toBe(400 + 8);
  });
  it('sitl-lockstep: an autopilot stall delays ticks but preserves every one of them', () => {
    const policy = new SteppingPolicy({ hz: 400, mode: 'sitl-lockstep' }), ticks: number[] = [];
    let framesProvided = 0, stalled = false;
    // Autopilot frames: one per tick, unavailable while stalled.
    const autopilot: StepGate = { ready: tick => !stalled && tickToNumber(tick) <= framesProvided };
    policy.resume(0);
    for (let now = 1; now <= 3000; now++) {
      if (now === 1000) stalled = true;
      if (now === 2000) stalled = false;
      if (!stalled) framesProvided += 1; // autopilot runs at ~1 kHz once resumed
      run(policy, now, now, autopilot, ticks);
    }
    expect(contiguous(ticks)).toBe(true);
    expect(ticks.length).toBe(framesProvided);
    expect(policy.droppedSteps).toBe(0);
    // A blocked Worker catches up at most maxCatchUp ticks per wakeup, never dropping.
    const result = run(policy, 4000, 4000, ALWAYS, ticks);
    expect([result.dropped, result.maxPerPump]).toEqual([0, 8]);
    expect(contiguous(ticks)).toBe(true);
  });
  it('hitl-realtime: tolerates normal catch-up but faults on a 1 s stall until the epoch resets', () => {
    const policy = new SteppingPolicy({ hz: 1200, mode: 'hitl-realtime' }), ticks: number[] = [];
    policy.resume(0);
    const normal = run(policy, 4, 1000, ALWAYS, ticks, 4); // 4 ms timer clamping: about 5 steps per wakeup
    expect([normal.dropped, normal.fault]).toEqual([0, 'none']);
    const stall = run(policy, 2000, 2000, ALWAYS, ticks);
    expect(stall.fault).toBe('hitl-overrun');
    const before = ticks.length;
    const after = run(policy, 2001, 2100, ALWAYS, ticks);
    expect([after.fault, ticks.length - before]).toEqual(['hitl-overrun', 0]);
    policy.resetEpoch(3000);
    expect(policy.fault).toBe('none');
    expect(tickToNumber(policy.tick)).toBe(0);
  });
});

describe('responsiveness without actuators', () => {
  it('a lockstep pump with no actuator frames returns at once with bounded work', () => {
    const policy = new SteppingPolicy({ hz: 1200, mode: 'sitl-lockstep' }), report = newPumpReport();
    let gateCalls = 0;
    const absent: StepGate = { ready: () => { gateCalls++; return false; } };
    policy.resume(0);
    const started = performance.now();
    for (let i = 0; i < 100_000; i++) policy.pump(i, absent, () => { throw new Error('must not step'); }, report);
    expect(performance.now() - started).toBeLessThan(1000);
    expect([report.executed, report.waiting]).toEqual([0, true]);
    expect(gateCalls).toBe(100_000); // one readiness check per wakeup, then return
  });
  it('runs at most maxCatchUp ticks per pump in every mode', () => {
    for (const mode of ['interactive', 'sitl-lockstep', 'hitl-realtime'] as ClockMode[]) {
      const policy = new SteppingPolicy({ hz: 800, mode, maxCatchUp: 8 }), report = newPumpReport();
      policy.resume(0);
      policy.pump(5, ALWAYS, () => undefined, report);
      expect(report.executed, mode).toBeLessThanOrEqual(8);
    }
    expect(() => new SteppingPolicy({ mode: 'turbo' as ClockMode })).toThrow('mode');
  });
});
