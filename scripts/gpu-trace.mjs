// TASK-073 acceptance decision. Schema-only observations are not hardware evidence.
import { assessGpu } from "./bench-render.mjs";
import { report } from "./validation/evidence.mjs";

export function classifyGpuDevice(renderer, hostModel) {
  const gpu = `${renderer}\n${hostModel}`;
  if (/swiftshader|llvmpipe|software/i.test(gpu)) return "software";
  if (/apple m4/i.test(gpu)) return "M4";
  if (/rtx\s*4050/i.test(gpu)) return "RTX4050";
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

/** 59.88 Hz is the accepted M4 panel rate and admits a 60 FPS profile. 60 Hz does not admit 120 FPS. */
export function profileFitsDisplay(refreshHz, fps) {
  return typeof refreshHz === "number" && Number.isFinite(refreshHz) && refreshHz + 1 >= fps;
}

/** Returns the gpu-report for one measured profile. Never treats a short or software run as PASS. */
export function decideGpuAcceptance(input) {
  const device = classifyGpuDevice(input.gpu, input.hostModel);
  if (device === "software") return report("gpu-report", "BLOCKED_EXTERNAL", ["Software/headless rendering cannot certify target hardware"]);
  if (device === "other") return report("gpu-report", "BLOCKED_EXTERNAL", ["GPU is not Apple M4 or RTX 4050"]);
  if (input.backend === "webgpu") return report("gpu-report", "BLOCKED_EXTERNAL", ["WebGPU fisheye and thermal passes are not implemented"]);
  if (!(input.warmupS >= 60) || !(input.measuredS >= 600)) return report("gpu-report", "BLOCKED_EXTERNAL", ["G3 requires 60 s warmup and 600 s measurement"]);
  if (!input.featuresHeld) return report("gpu-report", "BLOCKED_EXTERNAL", ["Terrain, FPV, and thermal were not all active for the whole measurement"]);
  if (input.visible !== true) return report("gpu-report", "BLOCKED_EXTERNAL", ["The measurement tab was not visible"]);
  const trace = {
    schemaVersion: 1, source: "hardware", device, gpu: input.gpu, os: input.os, browser: input.browser, powerMode: input.powerMode,
    backend: "webgl2", fps: input.fps, width: input.width, height: input.height, dpr: input.dpr, warmupS: input.warmupS,
    durationS: input.durationS, visible: true, production: true, terrain: true, fpv: true, thermal: true,
    frameMs: input.frameMs, gpuBytes: input.gpuBytes, cpuBytes: input.cpuBytes,
  };
  try { return assessGpu(trace); }
  catch (error) { return report("gpu-report", "FAIL", [error instanceof Error ? error.message : String(error)]); }
}
