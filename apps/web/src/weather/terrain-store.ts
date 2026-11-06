import type { ProjectStore } from "@mirage/project/store";
import { DEFAULT_RUN_RADIUS_M, MAX_RUN_RADIUS_M, MIN_RUN_RADIUS_M } from "@mirage/terrain/run-terrain";

// The ground the next run of a project stands on (TASK-186): the synthetic level pad, or the local real terrain with the radius
// around the home it loads. Kept in the store's local settings, as the location is (TASK-148); a run copies what it used into its
// experiment record, and that copy is what a repeat flies. Cold path.

export const TERRAIN_CHOICE_SOURCES = ["synthetic-pad", "fabdem-elevation"] as const;
export type TerrainChoiceSource = typeof TERRAIN_CHOICE_SOURCES[number];
export interface TerrainChoice {
  readonly schemaVersion: 1;
  readonly sourceId: TerrainChoiceSource;
  /** The radius around the home a real-terrain run loads, m; kept for the pad too, so switching back keeps it. */
  readonly radiusM: number;
}
export const DEFAULT_TERRAIN_CHOICE: TerrainChoice = Object.freeze({ schemaVersion: 1, sourceId: "synthetic-pad", radiusM: DEFAULT_RUN_RADIUS_M });

/** A terrain choice from unknown, or the reason it is not one. */
export function parseTerrainChoice(value: unknown): TerrainChoice | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "The terrain choice must be an object";
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "radiusM,schemaVersion,sourceId") return "The terrain choice must hold exactly schemaVersion, sourceId and radiusM";
  const { schemaVersion, sourceId, radiusM } = value as Record<string, unknown>;
  if (schemaVersion !== 1) return "The terrain choice must be schema 1";
  const source = TERRAIN_CHOICE_SOURCES.find(id => id === sourceId);
  if (!source) return `The terrain source must be one of ${TERRAIN_CHOICE_SOURCES.join(", ")}`;
  if (typeof radiusM !== "number" || !Number.isFinite(radiusM) || radiusM < MIN_RUN_RADIUS_M || radiusM > MAX_RUN_RADIUS_M) {
    return `The terrain radius must be ${MIN_RUN_RADIUS_M} m to ${MAX_RUN_RADIUS_M} m`;
  }
  return { schemaVersion: 1, sourceId: source, radiusM };
}

/** A setting key's segment starts with a letter and holds at most 32 characters; a project's UUID without its dashes has 32 hexadecimal digits. */
const settingKey = (projectId: string): string => `terrain-choice.p${projectId.replaceAll("-", "").slice(0, 31)}`;

export async function loadTerrainChoice(store: ProjectStore, projectId: string): Promise<TerrainChoice> {
  try {
    const stored = await store.readSetting(settingKey(projectId));
    const parsed = stored === undefined ? DEFAULT_TERRAIN_CHOICE : parseTerrainChoice(stored);
    // A damaged setting costs only this choice; the pad is the default, and the next save replaces it.
    return typeof parsed === "string" ? DEFAULT_TERRAIN_CHOICE : parsed;
  } catch {
    return DEFAULT_TERRAIN_CHOICE;
  }
}
export async function saveTerrainChoice(store: ProjectStore, projectId: string, choice: TerrainChoice): Promise<void> {
  const parsed = parseTerrainChoice(choice);
  if (typeof parsed === "string") throw new Error(parsed);
  await store.writeSetting(settingKey(projectId), parsed);
}
