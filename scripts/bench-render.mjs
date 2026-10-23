// TASK-073 trace re-scorer: replays a saved hardware trace (schema 2, written by
// scripts/check-gpu-perf.mjs) through the same decision as the live harness.
import { cli, exact, finite, text } from "./validation/evidence.mjs";
import { decideRun } from "./gpu-trace.mjs";

export const TRACE_FIELDS = ["schemaVersion", "source", "gpu", "hostModel", "os", "browser", "powerMode", "backend", "fps", "refreshHz", "width", "height", "dpr",
  "scale", "warmupS", "durationS", "visible", "sleepSkewMs", "canvasStable", "featuresHeld", "airborne", "frameMs", "displayedMs", "chromeArgs", "gpuBytes", "cpuBytes"];

export function assessGpu(v) {
  exact(v, TRACE_FIELDS);
  if (v.schemaVersion !== 2 || v.source !== "hardware") throw new Error("Unsupported GPU trace schema");
  for (const k of ["gpu", "hostModel", "os", "browser", "powerMode"]) text(v[k]);
  for (const k of ["refreshHz", "width", "height", "dpr", "scale", "warmupS", "durationS", "sleepSkewMs", "gpuBytes", "cpuBytes"]) finite(v[k], -1e12, 1e12);
  for (const k of ["visible", "canvasStable", "featuresHeld", "airborne"]) if (typeof v[k] !== "boolean") throw new Error(`Invalid trace flag ${k}`);
  if (!Array.isArray(v.frameMs) || v.frameMs.length > 1000000) throw new Error("Missing bounded measured frame intervals");
  // displayedMs: PresentMon DisplayedTime per displayed frame in the window, or null without a display-timing source.
  if (v.displayedMs !== null && !Array.isArray(v.displayedMs)) throw new Error("Invalid displayed-frame times");
  if (!Array.isArray(v.chromeArgs) || v.chromeArgs.length > 32 || !v.chromeArgs.every(arg => typeof arg === "string" && /^--[a-z0-9_-]+(=\S*)?$/i.test(arg))) {
    throw new Error("Invalid Chrome switches");
  }
  return decideRun({ ...v, measuredS: v.durationS });
}
cli(import.meta.url, "gpu-run", assessGpu);
