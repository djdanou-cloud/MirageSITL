import type { ClockModeV2, PhysicsHz, TickId } from '@mirage/protocol';
import { DEFAULT_MAX_CATCH_UP, MultiRateClock } from './clock.ts';

// Clock modes and overload policy (docs/PROJECT_ROADMAP.md TASK-012).
//
// interactive    Wall-clock paced. A stall drops whole intervals, which are
//                counted; simulation time advances only for executed steps.
// sitl-lockstep  Simulation-time paced by the autopilot: a tick runs only when
//                the gate reports its actuator frame is ready. Ticks are never
//                dropped; a stall only delays them. Each pump runs at most
//                maxCatchUp ticks and returns at once when it must wait, so
//                pause/dispose messages are never starved.
// hitl-realtime  Wall-clock paced against a physical flight controller. Normal
//                catch-up within maxCatchUp is allowed, but any dropped interval
//                faults the session; it stays faulted until the epoch is reset.

export type ClockMode = ClockModeV2;
export const CLOCK_MODES: readonly ClockMode[] = ['interactive', 'sitl-lockstep', 'hitl-realtime'];

/** Reports whether the inputs for the next tick are available (SITL: the autopilot's actuator frame). */
export interface StepGate { ready(tick: TickId): boolean }
export const ALWAYS_READY: StepGate = { ready: () => true };

export type ClockFault = 'none' | 'hitl-overrun';
/** Preallocated per-pump result; pump() overwrites every field. */
export interface PumpReport { executed: number; dropped: number; waiting: boolean; fault: ClockFault }
export function newPumpReport(): PumpReport {
  return { executed: 0, dropped: 0, waiting: false, fault: 'none' };
}

export interface SteppingPolicyOptions { hz?: PhysicsHz; mode?: ClockMode; maxCatchUp?: number }

export class SteppingPolicy {
  readonly mode: ClockMode;
  readonly clock: MultiRateClock;
  private faultValue: ClockFault = 'none';
  private readonly nextTick: TickId = { lo: 0, hi: 0 };

  constructor(options: SteppingPolicyOptions = {}) {
    const mode = options.mode ?? 'interactive';
    if (!CLOCK_MODES.includes(mode)) throw new Error('Unsupported clock mode');
    this.mode = mode;
    this.clock = new MultiRateClock({ hz: options.hz ?? 400, maxCatchUp: options.maxCatchUp ?? DEFAULT_MAX_CATCH_UP });
  }
  get hz(): PhysicsHz { return this.clock.hz; }
  get tick(): TickId { return this.clock.tick; }
  get fault(): ClockFault { return this.faultValue; }
  get droppedSteps(): number { return this.clock.droppedSteps; }

  /** Resume pacing at nowMs without backlog (start/resume after pause). A fault persists. */
  resume(nowMs: number): void { this.clock.reset(nowMs); }
  /** New epoch (reset/configure/model swap): ticks, counters, and any fault are cleared. */
  resetEpoch(nowMs: number): void {
    this.faultValue = 'none';
    this.clock.resetEpoch(nowMs);
  }

  /** Runs due work for this wakeup and describes it in `out`. Never blocks; allocation-free. */
  pump(nowMs: number, gate: StepGate, step: (tick: TickId) => void, out: PumpReport): void {
    out.executed = 0; out.dropped = 0; out.waiting = false; out.fault = this.faultValue;
    if (this.faultValue !== 'none') return;
    switch (this.mode) {
      case 'interactive': {
        const before = this.clock.droppedSteps;
        out.executed = this.clock.advance(nowMs, step);
        out.dropped = this.clock.droppedSteps - before;
        return;
      }
      case 'hitl-realtime': {
        const before = this.clock.droppedSteps;
        out.executed = this.clock.advance(nowMs, step);
        out.dropped = this.clock.droppedSteps - before;
        if (out.dropped > 0) { this.faultValue = 'hitl-overrun'; out.fault = this.faultValue; }
        return;
      }
      case 'sitl-lockstep': {
        const t = this.clock.tick, next = this.nextTick;
        while (out.executed < this.clock.maxCatchUp) {
          next.lo = (t.lo + 1) >>> 0; next.hi = next.lo === 0 ? (t.hi + 1) >>> 0 : t.hi;
          if (!gate.ready(next)) { out.waiting = true; return; }
          this.clock.stepOnce(step);
          out.executed++;
        }
        return;
      }
      default: { const never: never = this.mode; throw new Error(`Unhandled clock mode ${String(never)}`); }
    }
  }
}
