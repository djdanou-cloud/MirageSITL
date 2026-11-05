import { isEffectId, parseEffectControl } from "@mirage/protocol";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import type { ControllerView, EffectEntry } from "../run/session-controller";

// What became of every effect of a run (TASK-169, S09), kept as one project item per run with a new version whenever an entry changes,
// like the parameter change log (TASK-160). It extends the acknowledgement ledger of TASK-075 with where the control came from and the
// parameters it wrote. It says what reached ArduPilot; what ArduPilot did about it, the run's recording and log hold. Schema 2
// (TASK-167) adds each control's parameters, so a weather change is logged with its values and seeds; schema 1 logs read with
// `parameters: null`, and new logs are schema 2.

export const EFFECT_LOG_SCHEMA_VERSION = 2;
/** The TASK-169 schema, still read. */
export const EFFECT_LOG_SCHEMA_VERSION_1 = 1;
export interface EffectLog {
  readonly schemaVersion: typeof EFFECT_LOG_SCHEMA_VERSION;
  readonly experimentSha256: string;
  readonly entries: readonly EffectEntry[];
}
const MAX_ENTRIES = 4096;
const fail = (message: string): never => { throw new Error(`Invalid effect log: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const simTime = (value: unknown, label: string): number | null => {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(`${label} must be a time or null`);
};

function entryOf(value: unknown, index: number, version: typeof EFFECT_LOG_SCHEMA_VERSION | typeof EFFECT_LOG_SCHEMA_VERSION_1): EffectEntry {
  const label = `entries[${index}]`;
  if (!isRecord(value)) return fail(`${label} must be an object`);
  const keys = ["id", "effect", "enabled", "intensity", "status", "message", "origin", "requestedSimS", "appliedSimS", "writes", ...(version === EFFECT_LOG_SCHEMA_VERSION ? ["parameters"] : [])];
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} has an unexpected field ${key}`);
  const { id, effect, enabled, intensity, status, message, origin, requestedSimS, appliedSimS, writes } = value;
  if (typeof id !== "string" || id.length > 64) fail(`${label}.id must be text`);
  if (!isEffectId(effect)) return fail(`${label}.effect is not an effect`);
  if (typeof enabled !== "boolean") fail(`${label}.enabled must be a boolean`);
  if (typeof intensity !== "number" || !Number.isFinite(intensity) || intensity < 0) fail(`${label}.intensity must be at least 0`);
  if (status !== "pending" && status !== "applied" && status !== "rejected") return fail(`${label}.status must be pending, applied or rejected`);
  if (typeof message !== "string" || message.length > 4096) fail(`${label}.message must be text`);
  if (origin !== "manual" && origin !== "schedule") return fail(`${label}.origin must be manual or schedule`);
  if (!Array.isArray(writes) || !writes.every(name => typeof name === "string" && name.length <= 16)) return fail(`${label}.writes must be parameter names`);
  let parameters: EffectEntry["parameters"] = null;
  if (version === EFFECT_LOG_SCHEMA_VERSION) {
    // The values must be those the protocol accepts for this effect.
    try {
      parameters = parseEffectControl({ schemaVersion: 1, id, effect, enabled, intensity, parameters: value.parameters }).parameters;
    } catch (cause) {
      return fail(`${label}.parameters: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { id: id as string, effect: effect, enabled: enabled as boolean, intensity: intensity as number, status, message: message as string, origin,
    requestedSimS: simTime(requestedSimS, `${label}.requestedSimS`), appliedSimS: simTime(appliedSimS, `${label}.appliedSimS`), writes: writes as string[], parameters };
}
/** A log of schema 2, or of schema 1 as TASK-169 stored it, read as schema 2 with `parameters: null`. */
export function validateEffectLog(value: unknown): EffectLog {
  const version = isRecord(value) ? value.schemaVersion : undefined;
  if (!isRecord(value) || (version !== EFFECT_LOG_SCHEMA_VERSION && version !== EFFECT_LOG_SCHEMA_VERSION_1)) {
    return fail(`schemaVersion must be ${EFFECT_LOG_SCHEMA_VERSION} or ${EFFECT_LOG_SCHEMA_VERSION_1}`);
  }
  const { experimentSha256, entries } = value;
  if (typeof experimentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(experimentSha256)) fail("experimentSha256 is not a SHA-256");
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) return fail(`entries must hold 1 to ${MAX_ENTRIES} entries`);
  const raw: readonly unknown[] = entries;
  return { schemaVersion: EFFECT_LOG_SCHEMA_VERSION, experimentSha256: experimentSha256 as string, entries: raw.map((entry, index) => entryOf(entry, index, version)) };
}
export const readEffectLog = (stored: StoredVersion): EffectLog => validateEffectLog(stored.record.payload);

/** Saves each run's entries as they change; a save that fails is reported and the next change tries again. */
export class EffectLogWriter {
  private head: { readonly id: string; readonly head: string } | null = null;
  private latest = "";
  private pending: EffectLog | null = null;
  private saving: Promise<void> | null = null;
  constructor(private readonly store: ProjectStore, private readonly projectId: string, private readonly onError: (message: string) => void) {}
  update(view: ControllerView): void {
    if (view.effects.length === 0 || !view.recordSha256) return;
    const signature = JSON.stringify(view.effects);
    if (signature === this.latest) return;
    this.latest = signature;
    this.pending = { schemaVersion: EFFECT_LOG_SCHEMA_VERSION, experimentSha256: view.recordSha256, entries: view.effects };
    this.saving ??= this.drain();
  }
  /** Resolves once every change handed over is stored. */
  async flush(): Promise<void> {
    while (this.saving) await this.saving;
  }
  private async drain(): Promise<void> {
    try {
      for (let next = this.pending; next; next = this.pending) {
        this.pending = null;
        try {
          const payload = validateEffectLog(next), draft = { name: "Effects of a run", payload, dependencies: [payload.experimentSha256] };
          const stored = await (this.head ? this.store.saveVersion(this.head.id, this.head.head, draft) : this.store.createItem(this.projectId, "effect-log", draft));
          this.head = { id: stored.record.id, head: stored.sha256 };
        } catch (cause) {
          this.onError(`The effect log could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    } finally {
      this.saving = null;
    }
  }
}
