// ArduPilot parameter service (TASK-159, S11). Downloads the autopilot's
// complete parameter list, writes parameters and classifies every write by
// read-back, after ArduPilot's handlers at 8ab6afde (GCS_Param.cpp):
//
// * PARAM_REQUEST_LIST makes ArduPilot stream every parameter as PARAM_VALUE
//   with its index and param_count. ArduPilot ignores the request until its
//   parameters are ready, so it is resent while nothing answers. Indices still
//   missing after a quiet interval are read one by one (PARAM_REQUEST_READ
//   by index), the gap recovery QGroundControl also uses.
// * param_count changes when an *_ENABLE write shows or hides a group. During a
//   download that restarts it, and list entries still in flight from the
//   replaced stream, which carry the old count, are dropped rather than
//   restarting it again; after completion a new count marks the list stale.
// * PARAM_SET is answered by the new value, outside the list (index 65535);
//   a parameter the ground station may not write is answered with its old
//   value; an unknown name is answered only by PARAM_ERROR, which is outside
//   the TASK-150 message set and so ends in `timeout`. Every write is followed
//   by PARAM_REQUEST_READ of the same name. An answer outside the list that
//   holds the requested float32 confirms it. Another value starts one more
//   read, and the write counts as refused only when the latest answer still
//   differs after the autopilot has been quiet for a retry interval, so
//   answers in flight from before the write, or from a write it replaced,
//   cannot refuse it.
// * ArduPilot answers a read by name from a queue, so the answer to a read
//   sent before a write can arrive after the write's confirmation (TASK-160
//   saw it when a paused SITL resumed with two writes queued). A confirmed
//   write that an answer contradicts is therefore read once more, and it is
//   stale only when the latest answer still differs after a quiet retry
//   interval. A newer confirmed write of the same name replaces it at once.
//
// Values are the float32 numbers of the wire, stored exactly. Timeouts run on
// a clock the caller passes in seconds, normally the SITL's simulated time,
// so a paused lockstep SITL, which answers nothing (TASK-129), times nothing
// out. Cold path: one call per received PARAM_VALUE or per tick of the
// caller's control loop, never inside the physics step.
import type { MavFrame } from "@mirage/mavlink/codec";
import { fieldOf, readNumber, readText } from "@mirage/mavlink/messages";
import type { GroundStation } from "./ground-station.ts";
import { outsideRange, type ParameterMetadataSet } from "./param-metadata.ts";

/** MAVLink PARAM_VALUE. */
const PARAM_VALUE = 22;
/** param_index of a PARAM_VALUE outside the list: an answer to a write or to a read by name. */
const NOT_LISTED = 65535;

/** MAV_PARAM_TYPE (common.xml); ArduPilot reports INT8, INT16, INT32 and REAL32. */
export const MavParamType = { Uint8: 1, Int8: 2, Uint16: 3, Int16: 4, Uint32: 5, Int32: 6, Uint64: 7, Int64: 8, Real32: 9, Real64: 10 } as const;
/** Inclusive limits of the integer types PARAM_SET can carry exactly in its float32 value. */
const INTEGER_LIMITS: ReadonlyMap<number, readonly [number, number]> = new Map([
  [MavParamType.Uint8, [0, 255]], [MavParamType.Int8, [-128, 127]], [MavParamType.Uint16, [0, 65535]],
  [MavParamType.Int16, [-32768, 32767]], [MavParamType.Uint32, [0, 4294967295]], [MavParamType.Int32, [-2147483648, 2147483647]],
]);

export interface ParameterTiming {
  /** PARAM_REQUEST_LIST is resent after this long without any PARAM_VALUE, s. */
  readonly listRetryS: number;
  readonly maxListRequests: number;
  /** Missing indices are read after this long without a new index, s. */
  readonly gapS: number;
  /** Rounds of index reads without a new index before the download fails. */
  readonly maxGapRounds: number;
  /** Indices read per round. */
  readonly indexBatch: number;
  /** A write's PARAM_SET and read are resent after this long without an answer, s. */
  readonly writeRetryS: number;
  /** Sends of one write before it times out. */
  readonly writeAttempts: number;
}
export const DEFAULT_PARAMETER_TIMING: ParameterTiming = Object.freeze({
  listRetryS: 2, maxListRequests: 5, gapS: 1, maxGapRounds: 5, indexBatch: 20, writeRetryS: 1, writeAttempts: 3,
});

export interface ParameterValue {
  readonly name: string;
  /** The float32 the autopilot reported, exactly. */
  readonly value: number;
  /** MAV_PARAM_TYPE. */
  readonly type: number;
  /** The list index, or null for a parameter known only from an answer outside the list. */
  readonly index: number | null;
}

export type DownloadState =
  | { readonly kind: "idle" }
  /** `total` is null until the first PARAM_VALUE. */
  | { readonly kind: "downloading"; readonly received: number; readonly total: number | null }
  | { readonly kind: "complete"; readonly total: number }
  | { readonly kind: "failed"; readonly received: number; readonly total: number | null; readonly missing: readonly number[]; readonly reason: string };

interface WriteBase {
  readonly id: number;
  readonly name: string;
  /** The value the caller asked for. */
  readonly requested: number;
}
export type WriteState =
  /** PARAM_SET sent; `attempts` sends so far. */
  | WriteBase & { readonly kind: "requested"; readonly attempts: number }
  /** The read-back holds the requested float32. `rebootRequired` and `outsideRange` are null without metadata for this parameter. */
  | WriteBase & { readonly kind: "confirmed"; readonly value: number; readonly rebootRequired: boolean | null; readonly outsideRange: boolean | null }
  /** Not applied: refused by the service before sending, or the autopilot holds `reported` instead. */
  | WriteBase & { readonly kind: "refused"; readonly by: "service" | "autopilot"; readonly reason: string; readonly reported: number | null }
  /** No answer after every attempt. */
  | WriteBase & { readonly kind: "timeout"; readonly attempts: number }
  /** The outcome no longer describes the autopilot: a newer write replaced it, or the autopilot now reports another value. */
  | WriteBase & { readonly kind: "stale"; readonly reason: string; readonly reported: number | null };

function layout(name: string, type: string, count = 0) {
  const field = fieldOf(PARAM_VALUE, name);
  if (!field || field.type !== type || field.count !== count) throw new Error(`MAVLink table changed ${PARAM_VALUE}.${name}`);
  return field;
}
const VALUE = layout("param_value", "float"), COUNT = layout("param_count", "uint16_t"), INDEX = layout("param_index", "uint16_t");
const ID = layout("param_id", "char", 16), TYPE = layout("param_type", "uint8_t");

/** The largest float32 significand needs 9 significant decimal digits to round-trip. */
const MAX_FLOAT32_DIGITS = 9;
/**
 * The shortest decimal that parses back to exactly this float32, for example
 * "0.00017" for Math.fround(0.00017), never a rounded "0.00". -0 keeps its sign.
 * Throws for a number that is not a float32 or not finite.
 */
export function formatParameterValue(value: number): string {
  if (!Number.isFinite(value) || Math.fround(value) !== value) throw new Error(`${value} is not a finite float32`);
  if (Object.is(value, -0)) return "-0";
  for (let digits = 1; digits <= MAX_FLOAT32_DIGITS; digits++) {
    const decimal = Number(value.toPrecision(digits));
    if (Math.fround(decimal) === value) return String(decimal);
  }
  throw new Error(`${value} did not round-trip in ${MAX_FLOAT32_DIGITS} digits`);
}
/** The float32 a decimal text denotes, or null for text that is not one finite number. */
export function parseParameterValue(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) return null;
  const value = Math.fround(Number(trimmed));
  return Number.isFinite(value) ? value : null;
}

interface PendingWrite {
  readonly id: number;
  readonly name: string;
  readonly requested: number;
  readonly wire: number;
  readonly type: number;
  attempts: number;
  sentS: number;
  /** The latest differing answer, or null; one more read was sent at the first. */
  reported: number | null;
  answeredS: number;
}

export interface ParameterServiceOptions {
  readonly ground: GroundStation;
  /** Sends one MAVLink frame to the autopilot; the bytes are reused after the call. */
  readonly send: (frame: Uint8Array) => void;
  /** Metadata of the autopilot's exact commit, or null when MirageSITL has none for it. */
  readonly metadata: ParameterMetadataSet | null;
  readonly timing?: Partial<ParameterTiming>;
  /** Why this run must not write a parameter, or null (TASK-089: an error's owner). Refused like any other write the service refuses. */
  readonly writeConflict?: (name: string) => string | null;
}

export class ParameterService {
  private readonly ground: GroundStation;
  private readonly sendFrame: (frame: Uint8Array) => void;
  private readonly metadata: ParameterMetadataSet | null;
  private readonly timing: ParameterTiming;
  private readonly writeConflict: ((name: string) => string | null) | undefined;
  private readonly packet = new Uint8Array(64);

  private readonly entries = new Map<string, ParameterValue>();
  /** One flag per list index below param_count. */
  private readonly listed = new Uint8Array(NOT_LISTED);
  private count: number | null = null;
  /** The param_count a restart replaced: list entries still carrying it belong to the replaced stream. */
  private replacedCount: number | null = null;
  private receivedIndices = 0;
  private phase: "idle" | "downloading" | "complete" | "failed" = "idle";
  private failure = "";
  private listRequests = 0;
  private lastListRequestS = 0;
  private lastProgressS = 0;
  private gapRounds = 0;
  private listStale = false;

  private nextWriteId = 1;
  private readonly states = new Map<number, WriteState>();
  private readonly pending = new Map<string, PendingWrite>();
  /** The latest confirmed write per name, watched for a later change. */
  private readonly confirmed = new Map<string, number>();
  /** Confirmed writes an answer contradicted: the latest differing value and when it came; one read was sent at the first. */
  private readonly doubted = new Map<string, { reported: number; answeredS: number }>();
  private revisionValue = 0;

  constructor(options: ParameterServiceOptions) {
    this.ground = options.ground;
    this.sendFrame = options.send;
    this.metadata = options.metadata;
    this.writeConflict = options.writeConflict;
    this.timing = Object.freeze({ ...DEFAULT_PARAMETER_TIMING, ...options.timing });
    const t = this.timing;
    for (const value of [t.listRetryS, t.gapS, t.writeRetryS]) if (!(Number.isFinite(value) && value > 0)) throw new Error("Parameter timing intervals must be positive");
    for (const value of [t.maxListRequests, t.maxGapRounds, t.indexBatch, t.writeAttempts]) if (!(Number.isInteger(value) && value >= 1)) throw new Error("Parameter timing counts must be positive integers");
  }

  /** Increases on every change of the list, the download or a write. */
  get revision(): number { return this.revisionValue; }
  /** True when the autopilot renumbered its list after the download completed; download again. */
  get stale(): boolean { return this.listStale; }

  download(): DownloadState {
    switch (this.phase) {
      case "idle": return { kind: "idle" };
      case "downloading": return { kind: "downloading", received: this.receivedIndices, total: this.count };
      // A complete list always has a count: completion requires receivedIndices === count > 0.
      case "complete": return { kind: "complete", total: this.count ?? 0 };
      case "failed": return { kind: "failed", received: this.receivedIndices, total: this.count, missing: this.missing(Infinity), reason: this.failure };
      default: { const never: never = this.phase; return never; }
    }
  }
  /** The value the autopilot last reported for `name`. */
  get(name: string): ParameterValue | undefined { return this.entries.get(name); }
  /** Every known parameter, in list order; parameters known only from answers outside the list last, by name. */
  parameters(): readonly ParameterValue[] {
    return [...this.entries.values()].sort((a, b) => (a.index ?? NOT_LISTED) - (b.index ?? NOT_LISTED) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  write(id: number): WriteState | undefined { return this.states.get(id); }
  /** Every write of this service, oldest first. */
  writes(): readonly WriteState[] { return [...this.states.values()]; }
  /** Names whose confirmed, still current write needs a reboot to take effect, by the metadata. */
  rebootPending(): readonly string[] {
    const names: string[] = [];
    for (const id of this.confirmed.values()) {
      const state = this.states.get(id);
      if (state?.kind === "confirmed" && state.rebootRequired === true) names.push(state.name);
    }
    return names.sort();
  }

  /** Starts (or restarts) the download of the complete list. */
  requestList(nowS: number): void {
    this.phase = "downloading";
    this.failure = "";
    this.resetList();
    this.replacedCount = null;
    this.listRequests = 0;
    this.listStale = false;
    this.sendListRequest(nowS);
    this.changed();
  }

  /**
   * Writes `value` to `name`. Refused without sending when the name is not in
   * the autopilot's list, the caller declares a conflict, the value is not
   * finite, or the parameter's type cannot carry it exactly. A pending write of the same name becomes stale.
   */
  set(name: string, value: number, nowS: number): WriteState {
    const id = this.nextWriteId++;
    const refuse = (reason: string): WriteState => this.settle({ kind: "refused", id, name, requested: value, by: "service", reason, reported: null });
    const entry = this.entries.get(name);
    if (!entry) return refuse("the autopilot's parameter list has no parameter of this name");
    const conflict = this.writeConflict?.(name) ?? null;
    if (conflict !== null) return refuse(conflict);
    if (!Number.isFinite(value)) return refuse("the value is not a finite number");
    const limits = INTEGER_LIMITS.get(entry.type);
    if (limits) {
      if (!Number.isInteger(value) || value < limits[0] || value > limits[1]) return refuse(`an integer from ${limits[0]} to ${limits[1]} is required`);
      if (Math.fround(value) !== value) return refuse("the value is not exactly representable in PARAM_SET's float32");
    } else if (entry.type !== MavParamType.Real32) {
      return refuse(`MAV_PARAM_TYPE ${entry.type} cannot be written through PARAM_SET's float32`);
    } else if (!Number.isFinite(Math.fround(value))) {
      return refuse("the value is outside the float32 range");
    }
    const previous = this.pending.get(name);
    if (previous) {
      this.pending.delete(name);
      this.settle({ kind: "stale", id: previous.id, name, requested: previous.requested, reason: `write ${id} of the same parameter replaced it`, reported: null });
    }
    const write: PendingWrite = { id, name, requested: value, wire: Math.fround(value), type: entry.type, attempts: 0, sentS: nowS, reported: null, answeredS: nowS };
    this.pending.set(name, write);
    this.sendWrite(write, nowS);
    return this.settle({ kind: "requested", id, name, requested: value, attempts: write.attempts });
  }

  /** Takes a PARAM_VALUE of the autopilot; returns false for any other frame. */
  ingest(frame: MavFrame, nowS: number): boolean {
    if (frame.id !== PARAM_VALUE || frame.systemId !== this.ground.targetSystem || frame.componentId !== this.ground.targetComponent) return false;
    const name = readText(frame.payload, ID);
    const value = readNumber(frame.view, VALUE);
    // An index read past the list is answered with an empty name and NaN.
    if (name === "" || !Number.isFinite(value)) return false;
    const count = readNumber(frame.view, COUNT), index = readNumber(frame.view, INDEX), type = readNumber(frame.view, TYPE);

    if (this.phase === "downloading") {
      if (this.count === null) {
        this.count = count;
      } else if (count !== this.count) {
        // An entry of the stream a restart replaced: ArduPilot fixed its count when that stream began.
        if (index !== NOT_LISTED && count === this.replacedCount) return true;
        // The autopilot renumbered its list: the indices received so far no longer match.
        this.replacedCount = this.count;
        this.resetList();
        this.count = count;
        this.sendListRequest(nowS);
      }
    } else if (this.phase === "complete" && count !== this.count) {
      this.listStale = true;
    }
    const known = this.entries.get(name);
    this.entries.set(name, Object.freeze({ name, value, type, index: index === NOT_LISTED ? known?.index ?? null : index }));
    if (this.phase === "downloading" && index !== NOT_LISTED && index < count && this.listed[index] === 0) {
      this.listed[index] = 1;
      this.receivedIndices++;
      this.lastProgressS = nowS;
      this.gapRounds = 0;
      if (this.receivedIndices === count) this.phase = "complete";
    }
    if (index === NOT_LISTED) this.answerWrite(name, value, nowS);
    this.watchConfirmed(name, value, nowS);
    this.changed();
    return true;
  }

  /** Resends unanswered requests and times out writes; call it from the session's control loop. */
  tick(nowS: number): void {
    const t = this.timing;
    for (const [name, doubt] of [...this.doubted]) {
      if (nowS - doubt.answeredS < t.writeRetryS) continue;
      this.doubted.delete(name);
      const id = this.confirmed.get(name), state = id === undefined ? undefined : this.states.get(id);
      if (state?.kind !== "confirmed") continue;
      this.confirmed.delete(name);
      this.settle({ kind: "stale", id: state.id, name, requested: state.requested, reported: doubt.reported,
        reason: `the autopilot now reports ${formatParameterValue(doubt.reported)}` });
    }
    for (const write of [...this.pending.values()]) {
      if (write.reported !== null) {
        if (nowS - write.answeredS < t.writeRetryS) continue;
        this.pending.delete(write.name);
        const readOnly = this.metadata?.get(write.name)?.readOnly === true;
        this.settle({ kind: "refused", id: write.id, name: write.name, requested: write.requested, by: "autopilot", reported: write.reported,
          reason: `the autopilot kept ${formatParameterValue(write.reported)}${readOnly ? " (read-only in ArduPilot's metadata)" : ""}` });
        continue;
      }
      if (nowS - write.sentS < t.writeRetryS) continue;
      if (write.attempts >= t.writeAttempts) {
        this.pending.delete(write.name);
        this.settle({ kind: "timeout", id: write.id, name: write.name, requested: write.requested, attempts: write.attempts });
      } else {
        this.sendWrite(write, nowS);
        this.settle({ kind: "requested", id: write.id, name: write.name, requested: write.requested, attempts: write.attempts });
      }
    }
    if (this.phase !== "downloading") return;
    if (this.count === null) {
      if (nowS - this.lastListRequestS < t.listRetryS) return;
      if (this.listRequests >= t.maxListRequests) this.fail(`no PARAM_VALUE after ${this.listRequests} list requests`);
      else this.sendListRequest(nowS);
    } else if (nowS - this.lastProgressS >= t.gapS) {
      if (this.gapRounds >= t.maxGapRounds) {
        this.fail(`${this.count - this.receivedIndices} of ${this.count} indices still missing after ${this.gapRounds} rounds of index reads`);
        return;
      }
      for (const index of this.missing(t.indexBatch)) this.send(this.ground.paramRequestReadIndexInto(index, this.packet));
      this.gapRounds++;
      this.lastProgressS = nowS;
    }
  }

  private answerWrite(name: string, value: number, nowS: number): void {
    const write = this.pending.get(name);
    if (!write) return;
    if (value === write.wire) {
      this.pending.delete(name);
      const metadata = this.metadata?.get(name);
      const replaced = this.confirmed.get(name), earlier = replaced === undefined ? undefined : this.states.get(replaced);
      if (earlier?.kind === "confirmed") {
        this.settle({ kind: "stale", id: earlier.id, name, requested: earlier.requested, reported: null, reason: `write ${write.id} of the same parameter replaced it` });
      }
      this.doubted.delete(name);
      this.confirmed.set(name, write.id);
      this.settle({ kind: "confirmed", id: write.id, name, requested: write.requested, value,
        rebootRequired: metadata ? metadata.rebootRequired : null, outsideRange: metadata ? outsideRange(metadata, value) : null });
    } else {
      if (write.reported === null) this.send(this.ground.paramRequestReadInto(name, this.packet));
      write.reported = value;
      write.answeredS = nowS;
    }
  }

  /** An answer that contradicts a confirmed write starts one more read; an answer that agrees ends the doubt. */
  private watchConfirmed(name: string, value: number, nowS: number): void {
    const id = this.confirmed.get(name);
    const state = id === undefined ? undefined : this.states.get(id);
    if (state?.kind !== "confirmed") return;
    if (value === state.value) { this.doubted.delete(name); return; }
    if (!this.doubted.has(name)) this.send(this.ground.paramRequestReadInto(name, this.packet));
    this.doubted.set(name, { reported: value, answeredS: nowS });
  }

  private sendWrite(write: PendingWrite, nowS: number): void {
    write.attempts++;
    write.sentS = nowS;
    this.send(this.ground.paramSetInto(write.name, write.wire, write.type, this.packet));
    this.send(this.ground.paramRequestReadInto(write.name, this.packet));
  }
  private sendListRequest(nowS: number): void {
    this.listRequests++;
    this.lastListRequestS = nowS;
    this.lastProgressS = nowS;
    this.send(this.ground.paramRequestListInto(this.packet));
  }
  private send(length: number): void {
    // The ground station returns 0 only for arguments this service has already checked.
    if (length === 0) throw new Error("A parameter request could not be encoded");
    this.sendFrame(this.packet.subarray(0, length));
  }
  private resetList(): void {
    this.entries.clear();
    this.listed.fill(0);
    this.count = null;
    this.receivedIndices = 0;
    this.gapRounds = 0;
  }
  private missing(limit: number): number[] {
    const missing: number[] = [];
    if (this.count === null) return missing;
    for (let index = 0; index < this.count && missing.length < limit; index++) if (this.listed[index] === 0) missing.push(index);
    return missing;
  }
  private fail(reason: string): void {
    this.phase = "failed";
    this.failure = reason;
    this.changed();
  }
  private settle(state: WriteState): WriteState {
    const frozen = Object.freeze(state);
    this.states.set(frozen.id, frozen);
    this.changed();
    return frozen;
  }
  private changed(): void { this.revisionValue++; }
}
