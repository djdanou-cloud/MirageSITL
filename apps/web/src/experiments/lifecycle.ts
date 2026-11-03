// Experiment lifecycle (TASK-165, S16): Repeat runs a stored experiment's
// inputs again and Create variant runs them with changes, each as a new
// experiment that names its parent; the parent is never changed. By the
// user's decision of 2026-11-03 reproduction is never judged: the Experiments
// tab shows how a repeat or a variant differs from its parent, inputs and
// recorded trajectory, and the user decides. An exported experiment lists
// what its archive cannot hold. Cold path, configuration time.
import { experimentChanges, type ExperimentLineage, type ExperimentPayload, type ExperimentRecording } from "@mirage/aircraft/experiment";
import type { LoggingSettings } from "../logging/logging-settings";

/** A run the Experiments tab asked the Run tab to start (TASK-165). */
export interface PlannedRun {
  /** A repeat keeps every input; a variant starts from the parent's inputs and may change them. */
  readonly kind: "repeat" | "variant";
  readonly parentSha256: string;
  readonly parentName: string;
  readonly parent: ExperimentPayload;
}

/** The lineage a planned run's record gets: a variant that changed nothing is a repeat. */
export function lineageFor(plan: PlannedRun | null, payload: ExperimentPayload): ExperimentLineage {
  if (!plan) return { kind: "original" };
  const changes = experimentChanges(plan.parent, payload);
  if (plan.kind === "repeat" || changes.length === 0) return { kind: "repeat", of: plan.parentSha256 };
  return { kind: "variant", of: plan.parentSha256, changes };
}

/** The Logging tab settings a recording was made with, so that a repeat records as its parent did. */
export function loggingOf(recording: ExperimentRecording): LoggingSettings {
  return { schemaVersion: 1, commonHz: recording.commonHz, groups: recording.groups, signals: recording.signals, durationMin: recording.durationMin,
    reserveMb: recording.reserveMb };
}

/** How the record names where it comes from. */
export function lineageText(lineage: ExperimentLineage, nameOf: (sha256: string) => string): string {
  switch (lineage.kind) {
    case "original": return "Original run";
    case "repeat": return `Repeat of ${nameOf(lineage.of)}`;
    case "variant": return `Variant of ${nameOf(lineage.of)}: ${lineage.changes.join(", ")} changed`;
    default: { const never: never = lineage; return never; }
  }
}

/** One thing an exported experiment needs that its project archive does not hold. */
export interface ExternalDependency { readonly what: string; readonly why: string }
/** What an experiment's archive cannot carry: the ArduPilot build its SITL ran and the recording kept in this browser. */
export function externalDependencies(payload: ExperimentPayload): ExternalDependency[] {
  const out: ExternalDependency[] = [];
  const sitl = payload.sitl;
  if (sitl.ownership === "launcher") {
    out.push({ what: `ArduPilot build ${sitl.ardupilot.catalogId} (${sitl.ardupilot.firmwareVersion}, commit ${sitl.ardupilot.commit}, binary ${sitl.ardupilot.binarySha256})`,
      why: "A Repeat starts this exact build, which the launcher of the receiving computer must have installed" });
  } else {
    out.push({ what: `A SITL started by hand from ArduPilot commit ${sitl.ardupilot.commit} (${sitl.ardupilot.firmwareVersion})`,
      why: "MirageSITL connected to it and never had its binary" });
  }
  if (payload.recording) {
    out.push({ what: `Recording ${payload.recording.recordId}`, why: "Recordings stay in the browser storage of the computer that made them" });
  }
  return out;
}

/** The difference between two recorded truth.position series at the ticks both hold (TASK-165: shown, never judged). */
export interface TrajectoryDifference {
  readonly comparedTicks: number;
  /** The largest horizontal and vertical distance, m, and the simulated time of the larger, s. */
  readonly maxHorizontalM: number;
  readonly maxVerticalM: number;
  readonly atSimTimeS: number | null;
  /** The first common tick at which the positions differ, or null when they are identical. */
  readonly firstDifferentTick: number | null;
}
export interface PositionRow { readonly tick: number; readonly simTimeS: number; readonly northM: number; readonly eastM: number; readonly downM: number }
export function trajectoryDifference(a: readonly PositionRow[], b: readonly PositionRow[]): TrajectoryDifference {
  const byTick = new Map(b.map(row => [row.tick, row]));
  let compared = 0, maxH = 0, maxV = 0, at: number | null = null, first: number | null = null, worst = 0;
  for (const row of a) {
    const other = byTick.get(row.tick);
    if (!other) continue;
    compared++;
    const h = Math.hypot(row.northM - other.northM, row.eastM - other.eastM), v = Math.abs(row.downM - other.downM);
    if ((h > 0 || v > 0) && first === null) first = row.tick;
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
    if (Math.max(h, v) > worst) { worst = Math.max(h, v); at = row.simTimeS; }
  }
  return { comparedTicks: compared, maxHorizontalM: maxH, maxVerticalM: maxV, atSimTimeS: at, firstDifferentTick: first };
}
