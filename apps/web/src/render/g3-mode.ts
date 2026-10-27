/** `?g3=1` selects the TASK-073 production measurement scene. The demo stays unchanged. */
/**
 * What the measurement scene shows full-screen: the external chase camera with
 * the whole drone (default, used by tests and captures), the mounted FPV image
 * (`?view=fpv`) or the LWIR camera image (`?view=thermal`, for inspection).
 * All three always render; only the presented image changes.
 */
export type G3View = "chase" | "fpv" | "thermal";
export function g3ViewFromSearch(search: string): G3View {
  const view = new URLSearchParams(search).get("view");
  return view === "fpv" || view === "thermal" ? view : "chase";
}

export function g3Requested(search: string): boolean {
  return new URLSearchParams(search).get("g3") === "1";
}

/** `?g3profile=1`: per-pass GPU timing published as probe.passMs (diagnostics only, both backends). */
export function g3ProfileFromSearch(search: string): boolean {
  return new URLSearchParams(search).get("g3profile") === "1";
}

/**
 * `?g3skip=fpv,thermal`: skips the FPV chain and/or the thermal camera for pacing bisection (diagnostics
 * only, both backends). A skipped pass marks its probe feature off, so such a run never counts as a
 * full-feature capture. Unknown names are ignored.
 */
export function g3SkipFromSearch(search: string): { fpv: boolean; thermal: boolean } {
  const names = (new URLSearchParams(search).get("g3skip") ?? "").split(",");
  return { fpv: names.includes("fpv"), thermal: names.includes("thermal") };
}

/** Default thermal scene instant: 2026-07-15 07:00 UTC (10:00 local summer time in Israel). */
export const DEFAULT_THERMAL_UTC_MS = Date.UTC(2026, 6, 15, 7, 0, 0);

/** UTC instant of thermal sensor time zero from `?thermalUtc=<ISO 8601 with zone>`, else the default. */
export function g3ThermalUtcFromSearch(search: string): number {
  const value = new URLSearchParams(search).get("thermalUtc");
  if (value === null || !/(Z|[+-]\d\d:\d\d)$/.test(value)) return DEFAULT_THERMAL_UTC_MS;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= Date.UTC(1901, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : DEFAULT_THERMAL_UTC_MS;
}
