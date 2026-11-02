import { planRates, SIGNAL_CATALOG, type RatePlan, type RateRequest, type SignalGroup } from "@mirage/aar/signal-catalog";
import type { ProjectStore } from "@mirage/project/store";

// Logging settings (TASK-163, S13): the rates the next run records, kept in
// the store's local settings so they survive a reload, and the storage
// warning margin. A run copies them into its experiment record. Recording
// starts with every signal at the common rate, A-09's 50 Hz by default; a
// group or a signal may override it, and 0 records none of it. Cold path.

export const LOGGING_SETTING = "logging";
/** The autopilot streams the Run tab requests, Hz (EKF_STATUS_REPORT, GPS_RAW_INT, GLOBAL_POSITION_INT at 100 000 µs). */
export const RUN_TELEMETRY_HZ = 10;

export interface LoggingSettings {
  readonly schemaVersion: 1;
  readonly commonHz: number;
  readonly groups: Readonly<Partial<Record<SignalGroup, number>>>;
  readonly signals: Readonly<Record<string, number>>;
  /** The run length the estimate totals, simulated minutes. */
  readonly durationMin: number;
  /** Warn while the free storage is below this margin, or below what the rest of the run needs plus it, MB (10⁶ bytes). */
  readonly reserveMb: number;
}
export const DEFAULT_LOGGING: LoggingSettings = Object.freeze({ schemaVersion: 1, commonHz: 50, groups: Object.freeze({}), signals: Object.freeze({}),
  durationMin: 60, reserveMb: 500 });

const GROUPS: readonly SignalGroup[] = [...new Set(SIGNAL_CATALOG.filter(signal => signal.source !== "event").map(signal => signal.group))];
const isGroup = (value: string): value is SignalGroup => GROUPS.some(group => group === value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The rate plan of these settings at `physicsHz`; throws a RangeError that names an invalid rate. */
export function planOf(settings: LoggingSettings, physicsHz: number): RatePlan {
  const request: RateRequest = { commonHz: settings.commonHz, groups: settings.groups, signals: settings.signals };
  return planRates(request, { physicsHz, telemetryHz: RUN_TELEMETRY_HZ });
}

/** Settings from unknown (a stored value), or null when they do not hold a valid plan. */
export function parseLoggingSettings(value: unknown): LoggingSettings | null {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.groups) || !isObject(value.signals)) return null;
  const { commonHz, durationMin, reserveMb } = value;
  if (typeof commonHz !== "number" || typeof durationMin !== "number" || typeof reserveMb !== "number") return null;
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 24 * 60 || !Number.isFinite(reserveMb) || reserveMb < 0) return null;
  const groups: Partial<Record<SignalGroup, number>> = {}, signals: Record<string, number> = {};
  for (const [group, rate] of Object.entries(value.groups)) {
    if (!isGroup(group) || typeof rate !== "number") return null;
    groups[group] = rate;
  }
  for (const [name, rate] of Object.entries(value.signals)) {
    if (typeof rate !== "number") return null;
    signals[name] = rate;
  }
  const settings: LoggingSettings = { schemaVersion: 1, commonHz, groups, signals, durationMin, reserveMb };
  try {
    planOf(settings, 800);
  } catch {
    return null;
  }
  return settings;
}

export async function loadLoggingSettings(store: ProjectStore): Promise<LoggingSettings> {
  try {
    return parseLoggingSettings(await store.readSetting(LOGGING_SETTING)) ?? DEFAULT_LOGGING;
  } catch {
    // A damaged setting costs only the logging choices; the next save replaces it.
    return DEFAULT_LOGGING;
  }
}
export async function saveLoggingSettings(store: ProjectStore, settings: LoggingSettings): Promise<void> {
  await store.writeSetting(LOGGING_SETTING, settings);
}
