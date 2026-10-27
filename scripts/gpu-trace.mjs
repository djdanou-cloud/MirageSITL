// TASK-073 run analysis: GPU class, display refresh, frame metrics, the 0-100
// device rating and the per-run gate verdict. Schema-only observations are not
// hardware evidence.
//
// User decision 2026-10-23: the gate is a 1920 x 1080 canvas at 1x scale on an
// integrated GPU; every other machine, screen and GPU is measured and rated
// but does not decide TASK-073 (docs/DEVICE_RATINGS.md). Across all tested
// integrated GPUs, the least performant one decides (scripts/gpu-ratings.mjs).
import { percentile, report } from "./validation/evidence.mjs";

/** Gate profile and accepted limits (user decisions 2026-10-21 and 2026-10-23). */
export const GATE = Object.freeze({
  width: 1920, height: 1080, dpr: 1, fps: 60, minRefreshHz: 58, warmupS: 60, measuredS: 600,
  p50LimitMs: 16.680, p99LimitMs: 17.665, gpuBudgetBytes: 2 * 1024 ** 3, cpuBudgetBytes: 512 * 1024 ** 2,
});
/** The 120 FPS p99 limit; 120 FPS profiles are informational only. */
export const P99_LIMIT_120_MS = 8.33;
/** Wall time may lead monotonic time by this much before a run counts as slept through (macOS pauses performance.now() in sleep). */
export const MAX_SLEEP_SKEW_MS = 2000;

/**
 * GPU class from the WebGL renderer string, host model and OS. Integrated:
 * Apple Silicon, Intel UHD/Iris/Xe/Graphics and Intel Arc integrated graphics,
 * AMD Radeon(TM) Graphics. Discrete: NVIDIA, AMD Radeon RX/Pro, Intel Arc A/B.
 * Software renderers never produce evidence.
 */
export function classifyGpu(renderer, hostModel = "") {
  const gpu = `${renderer}\n${hostModel}`;
  if (/swiftshader|llvmpipe|software|microsoft basic render/i.test(gpu)) return "software";
  if (/nvidia|geforce|quadro|radeon\s*(rx|pro)\b|intel\(r\)\s*arc\(tm\)\s*[ab]\d|\barc\s+[ab]\d{3}/i.test(renderer)) return "discrete";
  if (/apple\s+m\d|apple gpu/i.test(gpu)) return "integrated";
  if (/intel\(r\)[^,)]*graphics|intel.*\b(uhd|iris|xe|arc)\b|radeon\(tm\)\s+graphics|amd radeon graphics/i.test(renderer)) return "integrated";
  return "unknown";
}

/** A composited window reports a positive layout size, screen size, and DPR. */
export function assertDisplaySurface(sample) {
  for (const field of ["innerWidth", "innerHeight", "screenWidth", "screenHeight", "dpr"]) {
    const value = sample?.[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("The browser has no display surface");
  }
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Median interval of a blank-page vsync sample, in Hz. */
export function displayRefreshHz(frameMs) {
  if (!Array.isArray(frameMs) || frameMs.length < 30) throw new Error("Missing display refresh sample");
  const samples = [];
  for (const ms of frameMs) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > 1000) throw new Error("Invalid display refresh sample");
    samples.push(ms);
  }
  return 1000 / median(samples);
}

/**
 * User decision 2026-10-22: the 60 FPS profile runs on any display above 58 Hz
 * (59.88 Hz M4 panel, 60 Hz monitors). Other profiles need refresh + 1 >= fps,
 * so 60 Hz does not admit 120 FPS.
 */
export function profileFitsDisplay(refreshHz, fps) {
  if (typeof refreshHz !== "number" || !Number.isFinite(refreshHz)) return false;
  return fps === 60 ? refreshHz > GATE.minRefreshHz : refreshHz + 1 >= fps;
}

/** Target frame interval: the display refresh, or the profile rate when the display is faster. */
export function targetIntervalMs(refreshHz, fps) {
  return 1000 / Math.min(refreshHz, fps);
}

/** Refresh slots without a new frame: an interval of k target periods misses k - 1. */
export function missedRefreshes(frameMs, intervalMs) {
  let missed = 0;
  for (const ms of frameMs) missed += Math.max(0, Math.round(ms / intervalMs) - 1);
  return missed;
}

/** p50/p99/max frame time, measured seconds and missed refreshes for one window. */
export function frameMetrics(frameMs, refreshHz, fps) {
  if (!Array.isArray(frameMs) || frameMs.length < 100) throw new Error("Missing bounded measured frame intervals");
  let totalMs = 0, maxMs = 0;
  for (const ms of frameMs) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > 60000) throw new Error("Invalid frame interval");
    totalMs += ms;
    if (ms > maxMs) maxMs = ms;
  }
  const intervalMs = targetIntervalMs(refreshHz, fps);
  return {
    frames: frameMs.length, measuredS: totalMs / 1000, p50FrameMs: percentile(frameMs, 0.5), p99FrameMs: percentile(frameMs, 0.99),
    maxFrameMs: maxMs, missedRefreshes: missedRefreshes(frameMs, intervalMs), expectedFrames: totalMs / intervalMs,
  };
}

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const roundMs = ms => Math.round(ms * 1000) / 1000;

/**
 * Device rating out of 100 (user decision 2026-10-23), against the target
 * interval T = 1000 / min(refresh, profile fps):
 *   pacing   50  1 at p99 <= 1.06 T, 0 at p99 >= 2 T, linear between
 *   sustain  20  1 - missed / (0.05 expected frames), floored at 0
 *   median   10  1 at p50 <= T, 0 at p50 >= 1.5 T
 *   features 10  terrain, FPV and thermal held and the scripted flight airborne
 *   memory   10  1 - peak / budget (2 GiB GPU, 512 MiB CPU), worst of the two
 * `airborne`, `missedRefreshes` or memory may be null for historical records;
 * the missing part scores 0 and the rating is marked provisional with its upper bound.
 */
export function rateRun({ refreshHz, fps, p50FrameMs, p99FrameMs, missedRefreshes: missed, expectedFrames, featuresHeld, airborne, gpuBytes, cpuBytes }) {
  const t = targetIntervalMs(refreshHz, fps);
  const pacing = clamp01((2 * t - p99FrameMs) / (2 * t - 1.06 * t));
  const missedKnown = typeof missed === "number";
  const sustain = missedKnown ? clamp01(1 - missed / (0.05 * expectedFrames)) : 0;
  const medianScore = clamp01((1.5 * t - p50FrameMs) / (0.5 * t));
  const features = featuresHeld === true && airborne === true ? 1 : 0;
  const memoryKnown = typeof gpuBytes === "number" && typeof cpuBytes === "number";
  const memory = memoryKnown ? clamp01(1 - Math.max(gpuBytes / GATE.gpuBudgetBytes, cpuBytes / GATE.cpuBudgetBytes)) : 0;
  const components = { pacing: 50 * pacing, sustain: 20 * sustain, median: 10 * medianScore, features: 10 * features, memory: 10 * memory };
  const score = Math.round(components.pacing + components.sustain + components.median + components.features + components.memory);
  const unknown = [];
  let headroom = 0;
  if (!missedKnown) { unknown.push("missed refreshes"); headroom += 20; }
  if (featuresHeld === true && airborne === null) { unknown.push("flight"); headroom += 10; }
  if (!memoryKnown) { unknown.push("memory"); headroom += 10; }
  const rating = { score, band: ratingBand(score), components };
  if (unknown.length) rating.provisional = { unknown, upperBound: Math.min(100, score + headroom) };
  return rating;
}

export function ratingBand(score) {
  return score >= 90 ? "excellent" : score >= 75 ? "good" : score >= 50 ? "usable" : "poor";
}

/** On Windows a gate-eligible run needs PresentMon displayed-frame times (user decision 2026-10-22). */
const WINDOWS_OS = /^(win32|windows)\b/i;

/**
 * Displayed-frame metrics from PresentMon DisplayedTime (how long each frame stayed on screen), or null where
 * no display-timing source exists (macOS). User decision 2026-10-22: they meet the same limits as the frame clock.
 */
export function displayedMetrics(displayedMs) {
  if (displayedMs === null || displayedMs === undefined) return null;
  if (!Array.isArray(displayedMs) || displayedMs.length < 100 || displayedMs.length > 1000000) throw new Error("Missing bounded displayed-frame times");
  for (const ms of displayedMs) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > 60000) throw new Error("Invalid displayed-frame time");
  }
  return { displayedFrames: displayedMs.length, p50DisplayedMs: percentile(displayedMs, 0.5), p99DisplayedMs: percentile(displayedMs, 0.99) };
}

/** Scripted-flight evidence: every 1 Hz sample inside the measurement window is airborne with live input. */
export function flightAirborne(flight, warmupS) {
  if (!Array.isArray(flight)) return false;
  const window = flight.filter(sample => sample !== null && typeof sample === "object" && typeof sample.s === "number" && sample.s > warmupS);
  if (window.length === 0) return false;
  return window.every(sample => Number.parseFloat(String(sample.altitude)) > 1 && sample.inputFailsafe === false);
}

/**
 * Scores one measured run: validity, rating and the per-run gate verdict.
 * status: BLOCKED_EXTERNAL (no usable evidence), PASS/FAIL (gate-eligible run),
 * INFO (rated, not gate-eligible). The rating is present whenever the run is valid.
 */
export function decideRun(input) {
  const gpuKind = classifyGpu(input.gpu, input.hostModel);
  const identity = { gpuKind, gpu: input.gpu, backend: input.backend, fps: input.fps };
  const blocked = reason => report("gpu-run", "BLOCKED_EXTERNAL", [reason], identity);
  if (gpuKind === "software") return blocked("Software/headless rendering cannot produce hardware evidence");
  if (input.backend !== "webgl2" && input.backend !== "webgpu") return blocked("Unknown render backend");
  if (input.fps !== 60 && input.fps !== 120) return blocked("Unknown frame-rate profile");
  if (!(input.warmupS >= GATE.warmupS) || !(input.measuredS >= GATE.measuredS)) return blocked("A rated run requires 60 s warmup and 600 s measurement");
  if (input.visible !== true) return blocked("The measurement tab was not visible");
  if (!(input.sleepSkewMs <= MAX_SLEEP_SKEW_MS)) return blocked(`The machine slept during the measurement (wall clock led monotonic time by ${Math.round(input.sleepSkewMs)} ms)`);
  if (input.canvasStable !== true) return blocked("The canvas size or DPR changed during the measurement");
  if (!profileFitsDisplay(input.refreshHz, input.fps)) return blocked(`Display refresh ${Number(input.refreshHz).toFixed(2)} Hz does not support the ${input.fps} FPS profile`);
  const m = frameMetrics(input.frameMs, input.refreshHz, input.fps);
  const shown = displayedMetrics(input.displayedMs);
  if (Math.abs(m.measuredS - input.measuredS) > 0.02) return blocked("Frame stream does not cover the declared measurement duration");
  const rating = rateRun({ ...m, refreshHz: input.refreshHz, fps: input.fps, featuresHeld: input.featuresHeld, airborne: input.airborne,
    gpuBytes: input.gpuBytes, cpuBytes: input.cpuBytes });
  const metrics = { ...identity, refreshHz: input.refreshHz, width: input.width, height: input.height, dpr: input.dpr, scale: input.scale, ...m, gpuBytes: input.gpuBytes, cpuBytes: input.cpuBytes,
    featuresHeld: input.featuresHeld, airborne: input.airborne, displaySource: shown ? "presentmon" : "unavailable", ...shown, rating };
  if (Array.isArray(input.chromeArgs) && input.chromeArgs.length) metrics.chromeArgs = input.chromeArgs;
  const ineligible = gateIneligibility({ gpuKind, ...input });
  if (ineligible.length) return report("gpu-run", "INFO", ineligible.map(reason => `Not gate-eligible: ${reason}`), metrics);
  if (shown === null && WINDOWS_OS.test(input.os ?? "")) {
    return report("gpu-run", "BLOCKED_EXTERNAL", ["PresentMon displayed-frame times are required on Windows"], metrics);
  }
  const failures = [];
  if (roundMs(m.p50FrameMs) > GATE.p50LimitMs) failures.push(`median ${roundMs(m.p50FrameMs)} ms > ${GATE.p50LimitMs} ms`);
  if (roundMs(m.p99FrameMs) > GATE.p99LimitMs) failures.push(`p99 ${roundMs(m.p99FrameMs)} ms > ${GATE.p99LimitMs} ms`);
  if (shown && roundMs(shown.p50DisplayedMs) > GATE.p50LimitMs) failures.push(`displayed median ${roundMs(shown.p50DisplayedMs)} ms > ${GATE.p50LimitMs} ms`);
  if (shown && roundMs(shown.p99DisplayedMs) > GATE.p99LimitMs) failures.push(`displayed p99 ${roundMs(shown.p99DisplayedMs)} ms > ${GATE.p99LimitMs} ms`);
  if (!(input.gpuBytes <= GATE.gpuBudgetBytes) || !(input.cpuBytes <= GATE.cpuBudgetBytes)) failures.push("terrain residency budget exceeded");
  if (input.featuresHeld !== true) failures.push("terrain, FPV and thermal were not all active for the whole window");
  if (input.airborne !== true) failures.push("the scripted flight was not airborne for the whole window");
  return report("gpu-run", failures.length ? "FAIL" : "PASS", failures, metrics);
}

/** Why a valid run cannot decide the gate (empty when it is gate-eligible). */
export function gateIneligibility(run) {
  const reasons = [];
  if (run.gpuKind !== "integrated") reasons.push(`${run.gpuKind} GPU, the gate needs an integrated GPU`);
  if (run.fps !== GATE.fps) reasons.push(`${run.fps} FPS profile, the gate is ${GATE.fps} FPS`);
  if (run.width !== GATE.width || run.height !== GATE.height || run.dpr !== GATE.dpr) {
    reasons.push(`canvas ${run.width} x ${run.height} at ${run.dpr}x, the gate is ${GATE.width} x ${GATE.height} at 1x`);
  }
  // The renderers fix their pixel ratio at 1, so the display scale (window.devicePixelRatio) is what makes it 1x.
  if (run.scale !== GATE.dpr) reasons.push(`display scale ${run.scale}x, the gate needs 1x`);
  return reasons;
}
