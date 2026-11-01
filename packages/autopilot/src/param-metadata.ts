// ArduPilot parameter metadata (TASK-159). data/ardupilot/param-metadata.json
// holds, per supported ArduPilot commit, the metadata that ArduPilot's own
// param_parse.py generates from that source (scripts/generate-param-metadata.mjs).
// The file starts as `unknown` and becomes a catalog only after this
// validator; the reboot-required, read-only and range facts the parameter
// service and the Parameters tab use come from here, never from a list kept
// by hand. Cold path: parsed once when a session or tab loads.

export const PARAM_METADATA_SCHEMA_VERSION = 1;

export type UserLevel = "Standard" | "Advanced";
export interface ParameterMetadata {
  readonly name: string;
  /** The upstream group: a library prefix such as "INS_", or the vehicle's own group. */
  readonly group: string;
  readonly displayName: string;
  readonly description: string;
  /** ArduPilot's unit notation, for example "Hz", "m/s" or "cdeg"; null when the source declares none. */
  readonly units: string | null;
  /** The declared range, low ≤ high; null when the source declares none or declares a reversed one. */
  readonly range: readonly [low: number, high: number] | null;
  readonly increment: number | null;
  /** Enumerated values with their labels, ascending; null when not an enumeration. */
  readonly values: readonly (readonly [value: number, label: string])[] | null;
  /** Bit numbers (0..63) with their labels, ascending; null when not a bitmask. */
  readonly bitmask: readonly (readonly [bit: number, label: string])[] | null;
  /** A change takes effect only after the autopilot reboots. */
  readonly rebootRequired: boolean;
  /** The autopilot refuses writes from a ground station. */
  readonly readOnly: boolean;
  /** The autopilot changes the value itself, for example a ground pressure. */
  readonly volatile: boolean;
  readonly user: UserLevel | null;
}
/** An upstream record the generator did not repair: the field is left out of that parameter. */
export interface MetadataAnomaly { readonly name: string; readonly field: string; readonly reason: string }
export interface ParameterMetadataSet {
  readonly commit: string;
  readonly vehicle: string;
  readonly anomalies: readonly MetadataAnomaly[];
  readonly size: number;
  get(name: string): ParameterMetadata | undefined;
  names(): readonly string[];
}
export interface ParameterMetadataCatalog {
  readonly commits: readonly string[];
  /** The metadata of exactly this commit, or null: metadata of another commit is never substituted. */
  forCommit(commit: string): ParameterMetadataSet | null;
}

const RECORD_KEYS = new Set(["group", "displayName", "description", "units", "range", "increment", "values", "bitmask", "rebootRequired", "readOnly",
  "volatile", "user"]);
const VERSION_KEYS = new Set(["commit", "vehicle", "parameterCount", "anomalies", "upstreamSha256", "toolSha256", "parameters"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${where}: a finite number expected`);
  return value;
}
function text(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where}: text expected`);
  return value;
}
function labelled(value: unknown, where: string, bits: boolean): readonly (readonly [number, string])[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where}: a non-empty list expected`);
  const list: unknown[] = value;
  let previous = -Infinity;
  return Object.freeze(list.map((item, i) => {
    if (!Array.isArray(item) || item.length !== 2) throw new Error(`${where}[${i}]: [value, label] expected`);
    const pair: unknown[] = item;
    const number = finite(pair[0], `${where}[${i}]`);
    if (bits && (!Number.isInteger(number) || number < 0 || number > 63)) throw new Error(`${where}[${i}]: a bit number 0..63 expected`);
    if (number <= previous) throw new Error(`${where}: values must ascend without repeats`);
    previous = number;
    return Object.freeze([number, text(pair[1], `${where}[${i}]`)] as const);
  }));
}
function flag(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (value !== true) throw new Error(`${where}: only true is stored`);
  return true;
}

function parseRecord(name: string, input: unknown): ParameterMetadata {
  if (!/^[\x21-\x7e]{1,16}$/.test(name)) throw new Error(`Parameter name ${JSON.stringify(name)} is not 1 to 16 printable characters`);
  if (!isRecord(input)) throw new Error(`${name}: an object expected`);
  for (const key of Object.keys(input)) if (!RECORD_KEYS.has(key)) throw new Error(`${name}.${key}: unknown field`);
  let range: readonly [number, number] | null = null;
  if (input.range !== undefined) {
    const value = input.range;
    if (!Array.isArray(value) || value.length !== 2) throw new Error(`${name}.range: [low, high] expected`);
    const bounds: unknown[] = value;
    const low = finite(bounds[0], `${name}.range`), high = finite(bounds[1], `${name}.range`);
    if (low > high) throw new Error(`${name}.range: low is above high`);
    range = Object.freeze([low, high] as const);
  }
  const user = input.user;
  if (user !== undefined && user !== "Standard" && user !== "Advanced") throw new Error(`${name}.user: unknown user level`);
  return Object.freeze({
    name, group: text(input.group, `${name}.group`), displayName: text(input.displayName, `${name}.displayName`),
    description: text(input.description, `${name}.description`),
    units: input.units === undefined ? null : text(input.units, `${name}.units`),
    range,
    increment: input.increment === undefined ? null : finite(input.increment, `${name}.increment`),
    values: input.values === undefined ? null : labelled(input.values, `${name}.values`, false),
    bitmask: input.bitmask === undefined ? null : labelled(input.bitmask, `${name}.bitmask`, true),
    rebootRequired: flag(input.rebootRequired, `${name}.rebootRequired`), readOnly: flag(input.readOnly, `${name}.readOnly`),
    volatile: flag(input.volatile, `${name}.volatile`), user: user ?? null,
  });
}

function parseVersion(input: unknown, index: number): ParameterMetadataSet {
  const where = `versions[${index}]`;
  if (!isRecord(input)) throw new Error(`${where}: an object expected`);
  for (const key of Object.keys(input)) if (!VERSION_KEYS.has(key)) throw new Error(`${where}.${key}: unknown field`);
  const commit = text(input.commit, `${where}.commit`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${where}.commit: a 40-character commit expected`);
  const vehicle = text(input.vehicle, `${where}.vehicle`);
  if (!isRecord(input.parameters)) throw new Error(`${where}.parameters: an object expected`);
  const parameters = new Map<string, ParameterMetadata>();
  for (const [name, record] of Object.entries(input.parameters)) parameters.set(name, parseRecord(name, record));
  if (input.parameterCount !== parameters.size) throw new Error(`${where}: parameterCount does not match the records`);
  if (!Array.isArray(input.anomalies)) throw new Error(`${where}.anomalies: a list expected`);
  const anomalyList: unknown[] = input.anomalies;
  const anomalies = Object.freeze(anomalyList.map((item, i): MetadataAnomaly => {
    if (!isRecord(item)) throw new Error(`${where}.anomalies[${i}]: an object expected`);
    return Object.freeze({ name: text(item.name, `${where}.anomalies[${i}].name`), field: text(item.field, `${where}.anomalies[${i}].field`),
      reason: text(item.reason, `${where}.anomalies[${i}].reason`) });
  }));
  const names = Object.freeze([...parameters.keys()].sort());
  return Object.freeze({ commit, vehicle, anomalies, size: parameters.size, get: (name: string) => parameters.get(name), names: () => names });
}

/** Validates the metadata file from `unknown`; throws on any field outside schema 1. */
export function parseParameterMetadata(input: unknown): ParameterMetadataCatalog {
  if (!isRecord(input) || input.schemaVersion !== PARAM_METADATA_SCHEMA_VERSION || !Array.isArray(input.versions)) {
    throw new Error(`Parameter metadata: schema ${PARAM_METADATA_SCHEMA_VERSION} with a version list expected`);
  }
  const list: unknown[] = input.versions;
  const versions = new Map<string, ParameterMetadataSet>();
  list.forEach((item, i) => {
    const version = parseVersion(item, i);
    if (versions.has(version.commit)) throw new Error(`Parameter metadata: commit ${version.commit} appears twice`);
    versions.set(version.commit, version);
  });
  const commits = Object.freeze([...versions.keys()]);
  return Object.freeze({ commits, forCommit: (commit: string) => versions.get(commit) ?? null });
}

/** True when `value` lies outside the declared range; false without one. ArduPilot itself does not enforce ranges. */
export function outsideRange(metadata: ParameterMetadata, value: number): boolean {
  return metadata.range !== null && (value < metadata.range[0] || value > metadata.range[1]);
}
