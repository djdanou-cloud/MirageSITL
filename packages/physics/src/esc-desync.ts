/**
 * TASK-105: ESC desynchronization (SPECS_SIMULATION_ENGINES "ESC desynchronization"). A sensorless ESC can lose the back-EMF zero
 * crossings it commutates on when its drive outruns the rotor or a heavy load holds a large winding current; the motor's torque then
 * collapses until the ESC starts it again. Per rotor and tick the caller writes the drive margin m = d − k·|Ω|/V into `margin`; a rotor
 * not in a desynchronization starts one with probability 1 − exp(−λ·dt), λ = i·λ₀·min(1, max(0, (m − m₀)/(1 − m₀))), from its own seeded
 * stream, and `cut` holds 1 for each of the round(t_r·f) ticks it lasts. Every number of the model is an engineering choice: the one
 * recorded case gives no rate, threshold or restart time.
 *
 * `step` and `set` allocate nothing: the streams are a Uint32Array stepped inline, and a control arrives in preallocated slots.
 */

/** The random algorithm of the streams, as `@mirage/test-support/prng` names it, and the stream of rotor 0; rotor i uses base + i. */
export const ESC_DESYNC_RANDOM_ALGORITHM = 'mulberry32-mix32-v1';
export const ESC_DESYNC_STREAM_BASE = 0x00105001;
/** The slots of a control, as `set` reads them. */
export const EscDesyncSlot = Object.freeze({ Active: 0, MarginThreshold: 1, RatePerS: 2, Intensity: 3, RecoveryS: 4, Seed: 5, Count: 6 });
/** The ranges of the control's fields (EFFECT_CATALOG `esc.desync` states the same). */
export const ESC_DESYNC_LIMITS = Object.freeze({ maxMarginThreshold: 0.95, maxRatePerS: 1000, minRecoveryS: 0.005, maxRecoveryS: 2 });

export class EscDesync {
  readonly rotorCount: number;
  readonly hz: number;
  readonly dtS: number;
  /** Per rotor: the drive margin of this tick, written by the caller before `step`. */
  readonly margin: Float64Array;
  /** Per rotor: 1 while it is desynchronized on this tick, after `step`. */
  readonly cut: Uint8Array;
  /** Per rotor: the ticks still to come of a running desynchronization, after this one. */
  readonly remaining: Int32Array;
  /** Per rotor: the desynchronizations started since the last reset. */
  readonly events: Uint32Array;
  private readonly streams: Uint32Array;
  private on = false;
  private threshold = 0;
  private rate = 0;
  private recoveryTicks = 1;
  constructor(rotorCount: number, hz: number) {
    if (!Number.isInteger(rotorCount) || rotorCount < 1 || rotorCount > 32 || !(hz > 0) || !Number.isFinite(hz)) throw new Error('Invalid ESC desynchronization');
    this.rotorCount = rotorCount; this.hz = hz; this.dtS = 1 / hz;
    this.margin = new Float64Array(rotorCount); this.cut = new Uint8Array(rotorCount); this.remaining = new Int32Array(rotorCount);
    this.events = new Uint32Array(rotorCount); this.streams = new Uint32Array(rotorCount);
  }
  get active(): boolean { return this.on; }
  /**
   * A control at its tick boundary, from the slots of `EscDesyncSlot`. Off (or intensity 0) ends a running desynchronization at once;
   * on seeds every rotor's stream again from the seed and leaves a running one to finish. Returns false, changing nothing, for values
   * outside the effect's ranges. Allocation-free: no double crosses a call.
   */
  set(values: Float64Array): boolean {
    const active = values[EscDesyncSlot.Active]!, threshold = values[EscDesyncSlot.MarginThreshold]!, rate = values[EscDesyncSlot.RatePerS]!;
    const intensity = values[EscDesyncSlot.Intensity]!, recovery = values[EscDesyncSlot.RecoveryS]!, seed = values[EscDesyncSlot.Seed]!;
    if (active !== 0 && active !== 1) return false;
    if (active === 0 || intensity === 0) { this.clear(); return true; }
    const scaled = intensity * rate;
    if (!(threshold >= 0 && threshold <= ESC_DESYNC_LIMITS.maxMarginThreshold) || !(rate >= 0) || !(intensity > 0) ||
        !(scaled <= ESC_DESYNC_LIMITS.maxRatePerS) || !(recovery >= ESC_DESYNC_LIMITS.minRecoveryS && recovery <= ESC_DESYNC_LIMITS.maxRecoveryS) ||
        !(seed >= 0 && seed <= 0xffffffff && seed === Math.floor(seed))) return false;
    this.threshold = threshold; this.rate = scaled; this.recoveryTicks = Math.max(1, Math.round(recovery * this.hz));
    // The seeding of SeededRandom.reset(seed, stream), written out: mix32(seed ^ mix32(stream ^ 0x9e3779b9)).
    const streams = this.streams;
    for (let i = 0; i < this.rotorCount; i++) {
      let a = (ESC_DESYNC_STREAM_BASE + i) ^ 0x9e3779b9;
      a = Math.imul(a ^ (a >>> 16), 0x21f0aaad); a = Math.imul(a ^ (a >>> 15), 0x735a2d97); a = (a ^ (a >>> 15)) >>> 0;
      let b = (seed ^ a) >>> 0;
      b = Math.imul(b ^ (b >>> 16), 0x21f0aaad); b = Math.imul(b ^ (b >>> 15), 0x735a2d97);
      streams[i] = (b ^ (b >>> 15)) >>> 0;
    }
    this.on = true;
    return true;
  }
  /** Off: no running desynchronization, nothing drawn. */
  clear(): void { this.on = false; this.remaining.fill(0); this.cut.fill(0); }
  /** A new epoch: off, and no desynchronization counted. */
  reset(): void { this.clear(); this.margin.fill(0); this.events.fill(0); }
  /**
   * One tick: one uniform drawn for every rotor, in rotor order, whatever its state, then the running desynchronizations go on and a
   * rotor not in one may start one. Does nothing while off. Allocation-free.
   */
  step(): void {
    if (!this.on) return;
    const streams = this.streams, margin = this.margin, cut = this.cut, remaining = this.remaining, events = this.events;
    const m0 = this.threshold, span = 1 - m0, rate = this.rate, dt = this.dtS;
    for (let i = 0; i < this.rotorCount; i++) {
      // SeededRandom.nextFloat, written out.
      const state = (streams[i]! + 0x6d2b79f5) >>> 0;
      streams[i] = state;
      let v = Math.imul(state ^ (state >>> 15), state | 1);
      v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
      const u = ((v ^ (v >>> 14)) >>> 0) / 4294967296;
      const left = remaining[i]!;
      if (left > 0) { remaining[i] = left - 1; cut[i] = 1; continue; }
      const x = (margin[i]! - m0) / span, f = x > 1 ? 1 : x > 0 ? x : 0;
      const lambda = rate * f, p = lambda > 0 ? -Math.expm1(-lambda * dt) : 0;
      if (u < p) { remaining[i] = this.recoveryTicks - 1; cut[i] = 1; events[i] = events[i]! + 1; } else cut[i] = 0;
    }
  }
}
