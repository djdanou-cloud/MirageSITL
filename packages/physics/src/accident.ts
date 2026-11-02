// Accident detection (TASK-149, S18): decision F-09 of
// docs/decisions/phase1-fidelity.md. A contact of the body hull or of a
// propeller disc is an accident; contact on the support points alone,
// including a hard landing, is not. The stakeholder asked Claude to choose the
// minimum contact that counts: a propeller disc counts on any contact while
// its rotor turns, and the hull, or a propeller that has stopped, once its
// penetration reaches 1 mm or its normal force 5 % of the aircraft's weight.
// "Turns" is a rotor speed of at least 1 rad/s (under 10 rpm), Claude's choice
// recorded with F-09.
//
// The monitor reads the contact reports of the last step (TASK-095, contact
// ABI v3 per-shape output) and the rotor speeds. An accident is raised on the
// tick a shape starts to meet the criteria, so a contact that continues after
// the run resumes does not raise it again; a new contact does. `check` runs in
// the physics step and allocates nothing: events wait in a bounded outbox,
// and `drain` hands them out after the compute batch.

/** The F-09 thresholds. */
export const ACCIDENT_RULES = Object.freeze({
  /** A propeller disc counts on any contact while its rotor turns at least this fast, rad/s. */
  turningRadS: 1,
  /** The hull, or a stopped propeller, counts once its penetration reaches this, m. */
  penetrationM: 0.001,
  /** ... or once its normal force reaches this fraction of the aircraft's weight. */
  forceOfWeight: 0.05,
});
/** Standard gravity, m/s², as the contact engine applies it. */
const GRAVITY_MPS2 = 9.80665;
/** Outbox capacity; events beyond it are counted in `dropped`. */
export const ACCIDENT_OUTBOX_CAPACITY = 64;

/** What a contact shape stands for: a hull shape of the manifest, or the disc of a rotor. */
export type ContactShapePart =
  | { readonly part: 'hull'; readonly hullId: number }
  | { readonly part: 'propeller'; readonly rotorId: number };

/** One shape that met the F-09 criteria on a tick. */
export interface AccidentEvent {
  readonly tick: number;
  readonly simTimeS: number;
  readonly part: ContactShapePart;
  /** The deepest touching point, body FRD metres from the CG. */
  readonly pointBodyM: readonly [number, number, number];
  readonly penetrationM: number;
  /** Normal impulse of the step, N·s, and the normal force it gives, N: the contact load. */
  readonly impulseNs: number;
  readonly forceN: number;
  /** The rotor's speed for a propeller, rad/s; null for a hull shape. */
  readonly rotorSpeedRadS: number | null;
}

/** What the monitor reads after each step; the BET dynamics implements it. */
export interface AccidentSource {
  /** Shape `index`'s report of the last step: [penetration, impulse, force, point (3), touching, 0]. */
  contactShapeStateInto(index: number, out: Float64Array): boolean;
  /**
   * Every rotor's speed after the last step, rad/s, into `out` in rotor order. Into a typed array,
   * since a double returned from a call that V8 does not inline is boxed.
   */
  rotorSpeedsInto(out: Float64Array): void;
}

/** Outbox columns of one event. */
const Column = Object.freeze({ tick: 0, simTimeS: 1, kind: 2, id: 3, x: 4, y: 5, z: 6, penetration: 7, impulse: 8, force: 9, speed: 10, stride: 11 });

export class AccidentMonitor {
  /** Events lost because the outbox was full. */
  dropped = 0;
  /** Accidents raised since the last reset, outbox overflow included. */
  total = 0;
  /** Inputs of the next `check`, written by the caller: [tick, simulated time s]. Indexed, so no double is boxed. */
  readonly at = new Float64Array(2);
  private source: AccidentSource;
  private readonly kinds: Uint8Array;
  private readonly ids: Float64Array;
  private readonly rotorIndex: Int32Array;
  private readonly forceLimitN: number;
  private readonly report = new Float64Array(8);
  private readonly speeds: Float64Array;
  private readonly propellers: boolean;
  /** Whether each shape met the criteria on the previous tick. */
  private readonly meeting: Uint8Array;
  private readonly outbox = new Float64Array(ACCIDENT_OUTBOX_CAPACITY * Column.stride);
  private head = 0;
  private count = 0;

  /**
   * `parts`: what each contact shape stands for, in the contact's shape order. `rotorIds`: the
   * rotor ID of each rotor index of the dynamics. `massKg`: the aircraft's mass, whose weight the
   * force threshold scales.
   */
  constructor(source: AccidentSource, parts: readonly ContactShapePart[], rotorIds: readonly number[], massKg: number) {
    if (!(massKg > 0) || !Number.isFinite(massKg)) throw new RangeError('The accident monitor needs a positive mass');
    this.source = source;
    this.kinds = new Uint8Array(parts.length);
    this.ids = new Float64Array(parts.length);
    this.rotorIndex = new Int32Array(parts.length).fill(-1);
    parts.forEach((part, i) => {
      if (part.part === 'hull') { this.kinds[i] = 0; this.ids[i] = part.hullId; return; }
      const index = rotorIds.indexOf(part.rotorId);
      if (index < 0) throw new RangeError(`Contact shape ${i} names unknown rotor ${part.rotorId}`);
      this.kinds[i] = 1; this.ids[i] = part.rotorId; this.rotorIndex[i] = index;
    });
    this.meeting = new Uint8Array(parts.length);
    this.speeds = new Float64Array(rotorIds.length);
    this.propellers = parts.some(part => part.part === 'propeller');
    this.forceLimitN = ACCIDENT_RULES.forceOfWeight * massKg * GRAVITY_MPS2;
    this.prime();
  }

  get shapeCount(): number { return this.kinds.length; }
  /** Events waiting in the outbox. */
  get pending(): number { return this.count; }

  /**
   * Checks the last step's reports at `at`; returns how many shapes started to meet the criteria.
   * Allocation-free.
   */
  check(): number {
    const report = this.report, n = this.kinds.length, speeds = this.speeds;
    if (this.propellers) this.source.rotorSpeedsInto(speeds);
    let raised = 0;
    for (let i = 0; i < n; i++) {
      if (!this.source.contactShapeStateInto(i, report)) { this.meeting[i] = 0; continue; }
      const rotor = this.rotorIndex[i]!;
      const touching = report[6]! !== 0;
      const turning = rotor >= 0 && Math.abs(speeds[rotor]!) >= ACCIDENT_RULES.turningRadS;
      const meets = touching && (turning || report[0]! >= ACCIDENT_RULES.penetrationM || report[2]! >= this.forceLimitN);
      if (meets && this.meeting[i] === 0) {
        this.queue(i);
        raised++;
      }
      this.meeting[i] = meets ? 1 : 0;
    }
    this.total += raised;
    return raised;
  }

  private queue(shape: number): void {
    if (this.count === ACCIDENT_OUTBOX_CAPACITY) { this.dropped++; return; }
    const o = this.outbox, base = ((this.head + this.count) % ACCIDENT_OUTBOX_CAPACITY) * Column.stride, r = this.report;
    o[base + Column.tick] = this.at[0]!; o[base + Column.simTimeS] = this.at[1]!;
    o[base + Column.kind] = this.kinds[shape]!; o[base + Column.id] = this.ids[shape]!;
    o[base + Column.x] = r[3]!; o[base + Column.y] = r[4]!; o[base + Column.z] = r[5]!;
    o[base + Column.penetration] = r[0]!; o[base + Column.impulse] = r[1]!; o[base + Column.force] = r[2]!;
    const rotor = this.rotorIndex[shape]!;
    o[base + Column.speed] = rotor >= 0 ? this.speeds[rotor]! : 0;
    this.count++;
  }

  /** Cold: hands every queued event to `sink`, oldest first; returns how many. */
  drain(sink: (event: AccidentEvent) => void): number {
    const drained = this.count;
    while (this.count > 0) {
      const o = this.outbox, base = this.head * Column.stride, propeller = o[base + Column.kind] === 1, id = o[base + Column.id]!;
      sink(Object.freeze({
        tick: o[base + Column.tick]!, simTimeS: o[base + Column.simTimeS]!,
        part: Object.freeze(propeller ? { part: 'propeller' as const, rotorId: id } : { part: 'hull' as const, hullId: id }),
        pointBodyM: Object.freeze([o[base + Column.x]!, o[base + Column.y]!, o[base + Column.z]!] as const),
        penetrationM: o[base + Column.penetration]!, impulseNs: o[base + Column.impulse]!, forceN: o[base + Column.force]!,
        rotorSpeedRadS: propeller ? o[base + Column.speed]! : null,
      }));
      this.head = (this.head + 1) % ACCIDENT_OUTBOX_CAPACITY;
      this.count--;
    }
    return drained;
  }

  /** Forgets queued events, the previous tick's contacts and the counters (a new epoch). */
  reset(): void {
    this.meeting.fill(0);
    this.head = 0; this.count = 0; this.dropped = 0; this.total = 0;
  }

  /**
   * Runs the raising branch once on a synthetic report, then resets. V8 optimizes `check` with the
   * type feedback of the branches it has seen; a first accident in flight would otherwise
   * deoptimize it, and unoptimized code boxes doubles. Cold, at construction.
   */
  private prime(): void {
    if (this.kinds.length === 0) return;
    const source = this.source;
    this.source = {
      contactShapeStateInto: (_index, out) => { out.fill(0); out[0] = 1; out[2] = Infinity; out[6] = 1; return true; },
      rotorSpeedsInto: out => { out.fill(1000); },
    };
    this.check();
    this.check();
    this.source = source;
    this.drain(() => undefined);
    this.reset();
  }
}

/**
 * Cold: the `events.accident` rows of the recording (TASK-162) for one event, each a registry code
 * and up to three numbers: code 1 a hull shape (its ID, normal force N, penetration m) or code 2 a
 * propeller (its rotor ID, normal force N, penetration m); code 3 the deepest point, body FRD
 * metres from the CG; code 4 the normal impulse N·s, and for a propeller its rotor speed rad/s.
 */
export function accidentRows(event: AccidentEvent): number[][] {
  const propeller = event.part.part === 'propeller';
  const id = event.part.part === 'propeller' ? event.part.rotorId : event.part.hullId;
  return [
    [propeller ? 2 : 1, id, event.forceN, event.penetrationM],
    [3, ...event.pointBodyM],
    propeller && event.rotorSpeedRadS !== null ? [4, event.impulseNs, event.rotorSpeedRadS] : [4, event.impulseNs],
  ];
}

/**
 * One line for an accident, for the Run tab. A derived manifest's rotor IDs are the profile's motor
 * IDs; its hull is the standard hull (TASK-095), whose shape 0 is the body and shape k the arm
 * `armIds[k - 1]`, the arms in ascending ID order.
 */
export function describeAccident(event: AccidentEvent, armIds: readonly number[] = []): string {
  const part = event.part;
  const what = part.part === 'propeller' ? `The propeller of motor ${part.rotorId}`
    : part.hullId === 0 ? 'The body' : `Arm ${armIds[part.hullId - 1] ?? `shape ${part.hullId}`}`;
  return `${what} struck the ground at ${event.simTimeS.toFixed(2)} s: ${event.forceN.toFixed(1)} N, ${(event.penetrationM * 1000).toFixed(1)} mm deep`;
}
