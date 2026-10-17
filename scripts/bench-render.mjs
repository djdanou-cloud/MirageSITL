import { cli, exact, finite, text, percentile, report } from "./validation/evidence.mjs";
export function assessGpu(v) {
  exact(v, ["schemaVersion", "source", "device", "gpu", "os", "browser", "powerMode", "backend", "fps", "width", "height", "dpr", "warmupS", "durationS", "visible", "production", "terrain", "fpv", "thermal", "frameMs", "gpuBytes", "cpuBytes"]);
  if (v.schemaVersion !== 1 || v.source !== "hardware" || !["M4", "RTX4050"].includes(v.device) || !["webgl2", "webgpu"].includes(v.backend) || ![60, 120].includes(v.fps)) throw new Error("Unsupported real GPU/profile identity");
  for (const k of ["gpu", "os", "browser", "powerMode"]) text(v[k]);
  if (/swiftshader|llvmpipe|software|headless/i.test(v.gpu + " " + v.browser)) return report("gpu-report", "BLOCKED_EXTERNAL", ["Software/headless rendering cannot certify target hardware"]);
  if (v.width !== 1920 || v.height !== 1080 || v.dpr !== 1 || v.visible !== true || v.production !== true || v.terrain !== true || v.fpv !== true || v.thermal !== true) throw new Error("Production visible full-feature 1080p DPR1 profile required");
  finite(v.warmupS, 60); finite(v.durationS, 600, 3600);
  if (!Array.isArray(v.frameMs) || v.frameMs.length < 100 || v.frameMs.length > 1000000) throw new Error("Missing bounded measured frame intervals");
  let total = 0;
  for (const ms of v.frameMs) total += finite(ms, .01, 60000);
  if (Math.abs(total / 1000 - v.durationS) > .02) throw new Error("Frame stream does not cover declared measurement duration");
  finite(v.gpuBytes, 1); finite(v.cpuBytes, 1);
  const p99FrameMs = percentile(v.frameMs, .99);
  const ok = p99FrameMs <= (v.fps === 60 ? 16.67 : 8.33) && v.gpuBytes <= 2 * 1024 ** 3 && v.cpuBytes <= 512 * 1024 ** 2;
  return report("gpu-report", ok ? "PASS" : "FAIL", ok ? [] : ["Frame-time or terrain residency budget exceeded"], { p99FrameMs, p50FrameMs: percentile(v.frameMs, .5), measuredFrames: v.frameMs.length });
}
cli(import.meta.url, "gpu-report", assessGpu);
