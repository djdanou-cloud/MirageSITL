import { DEFAULT_MAX_CATCH_UP, MultiRateClock } from './clock.ts';

export * from './clock.ts';
export * from './clock-policy.ts';
export * from './demo-dynamics.ts';
export * from './session-v2.ts';

/** ABI v1 400 Hz clock: fixed integration dt, bounded catch-up, dropped wall time is counted. */
export class FixedStepClock extends MultiRateClock {
  constructor(maxCatchUp = DEFAULT_MAX_CATCH_UP) {
    super({ hz: 400, maxCatchUp });
  }
}
