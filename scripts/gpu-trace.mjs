// TASK-073 acceptance decision. Schema-only observations are not hardware evidence.
import { assessGpu } from "./bench-render.mjs";
import { report } from "./validation/evidence.mjs";

/**
 * Target device class. M4 and RTX 4050 are the original targets; user decision 2026-10-22 (TASK-073 P7):
 * on Windows an integrated GPU (Intel Graphics, AMD Radeon Graphics) is also an accepted device, recorded
 * as "WindowsIGPU" with the exact renderer string in the report. Software renderers are never accepted.
 */
export function classifyGpuDevice(renderer, hostModel, osName = "") {
  const gpu = `${renderer}\n${hostModel}`;
  if (/swiftshader|llvmpipe|software/i.test(gpu)) return "software";
  if (/apple m4/i.test(gpu)) return "M4";
  if (/rtx\s*4050/i.test(gpu)) return "RTX4050";
  if (/^(win32|windows)\b/i.test(osName) && !/nvidia|geforce|radeon\s+rx/i.test(renderer) &&
    /intel\(r\)[^,)]*graphics|intel.*\b(uhd|iris|arc)\b|radeon\(tm\)\s+graphics/i.test(renderer)) return "WindowsIGPU";
  return "other";
}

export function peakResidency(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("Missing residency samples");
  let gpuBytes = 0, cpuBytes = 0;
  for (const sample of samples) {
    if (sample === null || typeof sample !== "object") throw new Error("Invalid residency sample");
    const gpu = sample.gpuBytes, cpu = sample.cpuBytes;
    if (typeof gpu !== "number" || typeof cpu !== "number" || !Number.isFinite(gpu) || !Number.isFinite(cpu) || gpu < 0 || cpu < 0) throw new Error("Invalid residency sample");
    if (gpu > gpuBytes) gpuBytes = gpu;
    if (cpu > cpuBytes) cpuBytes = cpu;
  }
  return { gpuBytes, cpuBytes };
}

export function featuresHeld(samples) {
  return Array.isArray(samples) && samples.length > 0 && samples.every(sample => sample?.terrain === true && sample?.fpv === true && sample?.thermal === true);
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** A composited window reports a positive layout size, screen size, and DPR. */
export function assertDisplaySurface(sample) {
  for (const field of ["innerWidth", "innerHeight", "screenWidth", "screenHeight", "dpr"]) {
    const value = sample?.[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("The browser has no display surface");
  }
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
  return fps === 60 ? refreshHz > 58 : refreshHz + 1 >= fps;
}

/** Returns the gpu-report for one measured profile. Never treats a short or software run as PASS. */
export function decideGpuAcceptance(input) {
  const device = classifyGpuDevice(input.gpu, input.hostModel, input.os);
  if (device === "software") return report("gpu-report", "BLOCKED_EXTERNAL", ["Software/headless rendering cannot certify target hardware"]);
  if (device === "other") return report("gpu-report", "BLOCKED_EXTERNAL", [`GPU is not Apple M4, RTX 4050 or a Windows integrated GPU: ${input.gpu}`]);
  if (input.backend !== "webgl2" && input.backend !== "webgpu") return report("gpu-report", "BLOCKED_EXTERNAL", ["Unknown render backend"]);
  if (!(input.warmupS >= 60) || !(input.measuredS >= 600)) return report("gpu-report", "BLOCKED_EXTERNAL", ["G3 requires 60 s warmup and 600 s measurement"]);
  if (!input.featuresHeld) return report("gpu-report", "BLOCKED_EXTERNAL", ["Terrain, FPV, and thermal were not all active for the whole measurement"]);
  if (input.visible !== true) return report("gpu-report", "BLOCKED_EXTERNAL", ["The measurement tab was not visible"]);
  // On Windows the displayed-frame gate needs PresentMon; elsewhere no display-timing source exists yet.
  const displayedMs = Array.isArray(input.displayedMs) ? input.displayedMs : null;
  if (displayedMs === null && /^(win32|windows)\b/i.test(input.os ?? "")) {
    return report("gpu-report", "BLOCKED_EXTERNAL", ["PresentMon displayed-frame times are required on Windows"]);
  }
  const trace = {
    schemaVersion: 1, source: "hardware", device, gpu: input.gpu, os: input.os, browser: input.browser, powerMode: input.powerMode,
    backend: input.backend, fps: input.fps, width: input.width, height: input.height, dpr: input.dpr, warmupS: input.warmupS,
    durationS: input.durationS, visible: true, production: true, terrain: true, fpv: true, thermal: true,
    frameMs: input.frameMs, displayedMs, gpuBytes: input.gpuBytes, cpuBytes: input.cpuBytes,
  };
  // Every verdict records which GPU produced it.
  const withDevice = result => ({ ...result, metrics: { ...result.metrics, device, gpu: input.gpu } });
  try { return withDevice(assessGpu(trace)); }
  catch (error) { return withDevice(report("gpu-report", "FAIL", [error instanceof Error ? error.message : String(error)])); }
}
