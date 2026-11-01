// Parameter read-back before arming (TASK-154): the autopilot's complete
// PARAM_VALUE list, collected by index against param_count, must hold every
// generated initial parameter at its float32 value. A generated name missing
// from a complete list is accepted only under the TASK-147 rule (an instance
// the build does not compile, or a hidden second GNSS receiver), which
// scripts/check-sitl-sensors.mjs applies to its native captures as well.
// Cold path: one ingest per received PARAM_VALUE, never inside the physics step.
import type { MavFrame } from "@mirage/mavlink/codec";
import { fieldOf, readNumber, readText } from "@mirage/mavlink/messages";
import type { ArduPilotCatalog } from "./error-ownership.ts";

/** MAVLink PARAM_VALUE. */
const PARAM_VALUE = 22;
/** param_index of a PARAM_VALUE that is not part of the list (an answer to a write or a read by name). */
const NOT_LISTED = 65535;
/** ArduPilot parameter names are at most 16 characters (AP_MAX_NAME_SIZE). */
const MAX_NAME_LENGTH = 16;

export interface ExpectedParameter { readonly name: string; readonly value: number }
/** The value the autopilot last reported for a name, or undefined. */
export type ReportedLookup = (name: string) => number | undefined;
/** True when a generated parameter may be missing from a complete list. */
export type AbsentRule = (name: string, reported: ReportedLookup) => boolean;

export type ReadbackVerdict =
  /** The list is not complete yet; `total` is null before the first PARAM_VALUE. */
  | { readonly kind: "incomplete"; readonly received: number; readonly total: number | null }
  /** The list is complete and holds every generated parameter (or the rule excuses its absence). */
  | { readonly kind: "confirmed" }
  /** The autopilot holds another value: `reported` is its float32, `expected` the generated value. */
  | { readonly kind: "mismatch"; readonly name: string; readonly reported: number; readonly expected: number }
  /** A generated parameter is missing from the complete list and the rule does not excuse it. */
  | { readonly kind: "absent"; readonly name: string };

/**
 * True for a generated parameter the build legitimately lacks: a cataloged
 * instance it does not compile, or a hidden second receiver. The conditions
 * are the pinned catalog's `#if` lines per SIM_* name (vector names by their
 * base name).
 */
export function absentAllowed(name: string, catalogConditions: ReadonlyMap<string, readonly string[]>, reported: ReportedLookup): boolean {
  const base = catalogConditions.has(name) ? name : name.replace(/_[XYZ]$/, "");
  const conditions = catalogConditions.get(base);
  if (!conditions) return false;
  if (conditions.some(c => /^#if (INS_MAX_INSTANCES|HAL_COMPASS_MAX_SENSORS) > [1-9]$/.test(c))) return true;
  // SIM_GPS2_ENABLE carries AP_PARAM_FLAG_ENABLE: the rest of its group is hidden while it is 0.
  return name.startsWith("SIM_GPS2_") && reported("SIM_GPS2_ENABLE") === 0;
}

/** The absent rule over a parsed pinned catalog. */
export function catalogAbsentRule(catalog: ArduPilotCatalog): AbsentRule {
  const conditions = new Map<string, readonly string[]>();
  for (const [name, parameter] of catalog.parameters) conditions.set(name, parameter.conditions);
  return (name, reported) => absentAllowed(name, conditions, reported);
}

function layout(name: string, type: string, count = 0) {
  const field = fieldOf(PARAM_VALUE, name);
  if (!field || field.type !== type || field.count !== count) throw new Error(`MAVLink table changed ${PARAM_VALUE}.${name}`);
  return field;
}
const VALUE = layout("param_value", "float"), COUNT = layout("param_count", "uint16_t"), INDEX = layout("param_index", "uint16_t");
const ID = layout("param_id", "char", MAX_NAME_LENGTH);

/** Collects one autopilot's PARAM_VALUE list and judges it against the generated parameters. */
export class ParameterReadback {
  private readonly expected: readonly ExpectedParameter[];
  private readonly absent: AbsentRule;
  private readonly systemId: number;
  private readonly componentId: number;
  private readonly values = new Map<string, number>();
  /** One flag per list index below param_count. */
  private readonly listed = new Uint8Array(NOT_LISTED);
  private count: number | null = null;
  private receivedIndices = 0;
  private readonly lookup: ReportedLookup = name => this.values.get(name);

  /**
   * @param expected the generated parameters, unique names of at most 16 characters with finite values
   * @param absentAllowedRule which generated names may be missing from a complete list
   * @param systemId the autopilot's system ID; other senders are ignored
   */
  constructor(expected: readonly ExpectedParameter[], absentAllowedRule: AbsentRule, systemId = 1, componentId = 1) {
    const names = new Set<string>();
    for (const parameter of expected) {
      if (!/^[\x21-\x7e]{1,16}$/.test(parameter.name)) throw new Error(`Invalid parameter name ${JSON.stringify(parameter.name)}`);
      if (names.has(parameter.name)) throw new Error(`Parameter ${parameter.name} is listed twice`);
      if (!Number.isFinite(parameter.value)) throw new Error(`Parameter ${parameter.name} has no finite value`);
      names.add(parameter.name);
    }
    this.expected = expected.map(parameter => Object.freeze({ name: parameter.name, value: parameter.value }));
    this.absent = absentAllowedRule;
    this.systemId = systemId;
    this.componentId = componentId;
  }

  /** Distinct list indices received for the current param_count. */
  get received(): number { return this.receivedIndices; }
  /** The autopilot's param_count, or null before the first PARAM_VALUE. */
  get total(): number | null { return this.count; }
  /** The value last reported for `name` in the current enumeration, as its float32. */
  reported(name: string): number | undefined { return this.values.get(name); }

  /**
   * Takes a PARAM_VALUE of the autopilot; returns false for any other frame.
   * A repeated index is idempotent. A param_count other than the current one
   * (from a list entry, or from an answer outside the list once a list has
   * started) means the autopilot renumbered its list, for example after an
   * *_ENABLE change: the enumeration starts again and every value reported
   * before is dropped, so a name is judged present only from the current
   * enumeration and the answers outside the list received during it.
   */
  ingest(frame: MavFrame): boolean {
    if (frame.id !== PARAM_VALUE || frame.systemId !== this.systemId || frame.componentId !== this.componentId) return false;
    const name = readText(frame.payload, ID);
    if (name === "") return false;
    const count = readNumber(frame.view, COUNT), index = readNumber(frame.view, INDEX);
    if (count !== this.count && (index !== NOT_LISTED || this.count !== null)) {
      this.count = count;
      this.listed.fill(0);
      this.receivedIndices = 0;
      this.values.clear();
    }
    this.values.set(name, readNumber(frame.view, VALUE));
    if (index === NOT_LISTED) return true;
    if (index < count && this.listed[index] === 0) {
      this.listed[index] = 1;
      this.receivedIndices++;
    }
    return true;
  }

  /** Complete when the received indices equal param_count; then the first generated parameter that fails, in the given order. */
  verdict(): ReadbackVerdict {
    if (this.count === null || this.count === 0 || this.receivedIndices !== this.count) {
      return { kind: "incomplete", received: this.receivedIndices, total: this.count };
    }
    for (const parameter of this.expected) {
      const reported = this.values.get(parameter.name);
      if (reported === undefined) {
        if (!this.absent(parameter.name, this.lookup)) return { kind: "absent", name: parameter.name };
      } else if (reported !== Math.fround(parameter.value)) {
        return { kind: "mismatch", name: parameter.name, reported, expected: parameter.value };
      }
    }
    return { kind: "confirmed" };
  }

  /**
   * Every generated parameter the complete list does not hold, in the given
   * order: `reported` null for an absent name the rule does not excuse.
   * Null while the list is incomplete. A SITL the user started is judged by
   * all of them at once (TASK-155), since nothing is written to it.
   */
  differences(): readonly ParameterDifference[] | null {
    if (this.verdict().kind === "incomplete") return null;
    const differences: ParameterDifference[] = [];
    for (const parameter of this.expected) {
      const reported = this.values.get(parameter.name);
      if (reported === undefined) {
        if (!this.absent(parameter.name, this.lookup)) differences.push({ name: parameter.name, expected: parameter.value, reported: null });
      } else if (reported !== Math.fround(parameter.value)) {
        differences.push({ name: parameter.name, expected: parameter.value, reported });
      }
    }
    return differences;
  }
}

/** A generated parameter the autopilot holds at another value (its float32), or not at all (null). */
export interface ParameterDifference { readonly name: string; readonly expected: number; readonly reported: number | null }
