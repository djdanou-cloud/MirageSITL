import { cli, exact, finite, text, percentile, report } from "./validation/evidence.mjs";
export function assessGpu(v) {
  exact(v, ["schemaVersion", "source", "device", "gpu", "os", "browser", "powerMode", "backend", "fps", "width", "height", "dpr", "warmupS", "durationS", "visible", "production", "terrain", "fpv", "thermal", "frameMs", "displayedMs", "gpuBytes", "cpuBytes"]);
  if (v.schemaVersion !== 1 || v.source !== "hardware" || !["M4", "RTX4050", "WindowsIGPU"].includes(v.device) || !["webgl2", "webgpu"].includes(v.backend) || ![60, 120].includes(v.fps)) throw new Error("Unsupported real GPU/profile identity");
  for (const k of ["gpu", "os", "browser", "powerMode"]) text(v[k]);
  if (/swiftshader|llvmpipe|software|headless/i.test(v.gpu + " " + v.browser)) return report("gpu-report", "BLOCKED_EXTERNAL", ["Software/headless rendering cannot certify target hardware"]);
  if (v.width !== 1920 || v.height !== 1080 || v.dpr !== 1 || v.visible !== true || v.production !== true || v.terrain !== true || v.fpv !== true || v.thermal !== true) throw new Error("Production visible full-feature 1080p DPR1 profile required");
  finite(v.warmupS, 60); finite(v.durationS, 600, 3600);
  if (!Array.isArray(v.frameMs) || v.frameMs.length < 100 || v.frameMs.length > 1000000) throw new Error("Missing bounded measured frame intervals");
  let total = 0;
  for (const ms of v.frameMs) total += finite(ms, .01, 60000);
  if (Math.abs(total / 1000 - v.durationS) > .02) throw new Error("Frame stream does not cover declared measurement duration");
  // displayedMs: PresentMon DisplayedTime per displayed frame in the measurement window (how long each frame
  // stayed on screen), or null where no display-timing source exists (macOS). User decision 2026-10-22:
  // it must meet the same limits as the requestAnimationFrame intervals.
  if (v.displayedMs !== null && (!Array.isArray(v.displayedMs) || v.displayedMs.length < 100 || v.displayedMs.length > 1000000)) throw new Error("Missing bounded displayed-frame times");
  if (Array.isArray(v.displayedMs)) for (const ms of v.displayedMs) finite(ms, .01, 60000);
  finite(v.gpuBytes, 1); finite(v.cpuBytes, 1);
  const p99FrameMs = percentile(v.frameMs, .99);
  const p50FrameMs = percentile(v.frameMs, .5);
  // User decision 2026-10-21: the M4 60 FPS capture is acceptable at a median of
  // 16.680 ms and p99 of 17.665 ms. Values are compared after rounding to 0.001 ms.
  // The 120 FPS p99 limit stays 8.33 ms.
  const roundMs = ms => Math.round(ms * 1000) / 1000;
  const withinLimits = (p50, p99) => v.fps === 60 ? roundMs(p50) <= 16.680 && roundMs(p99) <= 17.665 : roundMs(p99) <= 8.33;
  const frameOk = withinLimits(p50FrameMs, p99FrameMs);
  const displayed = Array.isArray(v.displayedMs) ? { p50: percentile(v.displayedMs, .5), p99: percentile(v.displayedMs, .99) } : null;
  const displayOk = displayed === null || withinLimits(displayed.p50, displayed.p99);
  const residencyOk = v.gpuBytes <= 2 * 1024 ** 3 && v.cpuBytes <= 512 * 1024 ** 2;
  const reasons = [];
  if (!frameOk) reasons.push("Frame-time (requestAnimationFrame) budget exceeded");
  if (!displayOk) reasons.push("Displayed-frame time (PresentMon) budget exceeded");
  if (!residencyOk) reasons.push("Terrain residency budget exceeded");
  const metrics = { p99FrameMs, p50FrameMs, measuredFrames: v.frameMs.length, displaySource: displayed ? "presentmon" : "unavailable" };
  if (displayed) Object.assign(metrics, { p50DisplayedMs: displayed.p50, p99DisplayedMs: displayed.p99, displayedFrames: v.displayedMs.length });
  return report("gpu-report", reasons.length === 0 ? "PASS" : "FAIL", reasons, metrics);
}
cli(import.meta.url, "gpu-report", assessGpu);
