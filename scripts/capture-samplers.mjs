// TASK-073 capture side channels. Everything here is supplementary evidence
// recorded beside a G3 trace; none of it feeds scripts/bench-render.mjs.
//
// * gpuProcessMemorySampler: Windows "GPU Process Memory" counters (typeperf)
//   for one process id, summed over adapters, every intervalS seconds.
// * nvidiaSmiSampler: NVIDIA power state, clocks, utilisation, power, clock
//   event reasons once per second when nvidia-smi exists.
// * presentMonCapture: PresentMon display-change timing for one process when
//   the executable exists and the account may start ETW sessions (admin or
//   "Performance Log Users"); otherwise it reports why it did not run.
// * captureDisplay: OS-level screenshot of one display rectangle (Windows), so
//   the evidence shows what the physical display presented, not the page.
// Samplers own only the child processes they start and stop them on stop().
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PRESENTMON = fileURLToPath(new URL("../.cache/tools/presentmon-2.6.0/PresentMon-2.6.0-x64.exe", import.meta.url));

function lines(onLine) {
  let buffer = "";
  return bytes => {
    buffer += bytes.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
    }
  };
}

/** Parses one typeperf CSV row ("a","b",...) into cells. */
export function csvCells(line) {
  if (!line.startsWith("\"") || !line.endsWith("\"")) return null;
  return line.slice(1, -1).split("\",\"");
}

/** Sums the dedicated/shared columns that belong to one pid. */
export function gpuMemoryRow(header, cells, pid) {
  let dedicatedBytes = 0, sharedBytes = 0, matched = 0;
  for (let i = 1; i < cells.length && i < header.length; i++) {
    if (!header[i].includes(`(pid_${pid}_`)) continue;
    const value = Number(cells[i]);
    if (!Number.isFinite(value)) continue;
    matched++;
    if (header[i].endsWith("\\Dedicated Usage")) dedicatedBytes += value; else if (header[i].endsWith("\\Shared Usage")) sharedBytes += value;
  }
  return matched > 0 ? { at: cells[0], dedicatedBytes, sharedBytes } : null;
}

export function gpuProcessMemorySampler(pid, intervalS = 5) {
  const samples = [];
  if (process.platform !== "win32" || !Number.isInteger(pid)) return { kind: "gpu-process-memory", available: false, reason: "Windows only", samples, stop() {} };
  const child = spawn("typeperf", ["\\GPU Process Memory(*)\\Dedicated Usage", "\\GPU Process Memory(*)\\Shared Usage", "-si", String(intervalS)], { windowsHide: true });
  let header = null;
  child.stdout.on("data", lines(line => {
    const cells = csvCells(line);
    if (!cells) return;
    if (cells[0] === "(PDH-CSV 4.0)") { header = cells; return; }
    if (header && cells.length === header.length) {
      const row = gpuMemoryRow(header, cells, pid);
      if (row) samples.push(row);
    }
  }));
  child.on("error", () => undefined);
  return { kind: "gpu-process-memory", available: true, pid, intervalS, samples, stop() { child.kill(); } };
}

export function nvidiaSmiSampler() {
  const samples = [];
  let child;
  try {
    child = spawn("nvidia-smi", ["--query-gpu=timestamp,pstate,clocks.gr,clocks.max.gr,clocks.mem,utilization.gpu,power.draw,temperature.gpu,clocks_event_reasons.active", "--format=csv,noheader,nounits", "-lms", "1000"], { windowsHide: true });
  } catch { return { kind: "nvidia-smi", available: false, reason: "nvidia-smi not found", samples, stop() {} }; }
  const state = { kind: "nvidia-smi", available: true, reason: "", samples, stop() { child.kill(); } };
  child.on("error", () => { state.available = false; state.reason = "nvidia-smi not found"; });
  child.stdout.on("data", lines(line => {
    const [at, pstate, clockMHz, maxClockMHz, memClockMHz, utilizationPct, powerW, temperatureC, reasons] = line.split(",").map(v => v.trim());
    if (!pstate) return;
    samples.push({ at, pstate, clockMHz: Number(clockMHz), maxClockMHz: Number(maxClockMHz), memClockMHz: Number(memClockMHz), utilizationPct: Number(utilizationPct),
      powerW: Number(powerW), temperatureC: Number(temperatureC), reasons });
  }));
  return state;
}

/** Summary of nvidia-smi samples: power-state counts, clock range and state changes. */
export function summarizeClocks(samples) {
  if (!samples.length) return null;
  const pstates = {};
  let changes = 0, minMHz = Infinity, maxMHz = -Infinity, maxTempC = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    pstates[s.pstate] = (pstates[s.pstate] ?? 0) + 1;
    if (i > 0 && samples[i - 1].pstate !== s.pstate) changes++;
    if (Number.isFinite(s.clockMHz)) { minMHz = Math.min(minMHz, s.clockMHz); maxMHz = Math.max(maxMHz, s.clockMHz); }
    if (Number.isFinite(s.temperatureC)) maxTempC = Math.max(maxTempC, s.temperatureC);
  }
  return { samples: samples.length, pstates, pstateChanges: changes, minClockMHz: minMHz, maxClockMHz: maxMHz, maxTemperatureC: maxTempC };
}

/**
 * Node's high-resolution clock in milliseconds. On Windows libuv reads the same
 * QueryPerformanceCounter that PresentMon's --qpc_time_ms column uses, so the two
 * share one time base (checked against a live trace on 2026-10-22).
 */
export function nowQpcMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Starts a PresentMon trace of one process for `seconds` and resolves when it
 * ends. Start it before the flight: opening the ETW session can stall the
 * browser for about 300 ms, longer than the 250 ms pilot input timeout.
 * Summarise the CSV afterwards with summarizePresentMon(path, window).
 */
export function presentMonCapture(pid, outputCsv, seconds, executable = process.env.MIRAGE_PRESENTMON ?? DEFAULT_PRESENTMON) {
  if (process.platform !== "win32") return Promise.resolve({ kind: "presentmon", available: false, reason: "Windows only" });
  if (!existsSync(executable)) return Promise.resolve({ kind: "presentmon", available: false, reason: `PresentMon not found at ${executable}` });
  return new Promise(resolve => {
    const child = spawn(executable, ["--process_id", String(pid), "--output_file", outputCsv, "--timed", String(Math.ceil(seconds)), "--terminate_after_timed",
      "--no_console_stats", "--v2_metrics", "--qpc_time_ms", "--session_name", "MirageG3", "--stop_existing_session"], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
    child.on("error", error => resolve({ kind: "presentmon", available: false, reason: error.message }));
    child.on("exit", code => {
      if (code === 0 && existsSync(outputCsv)) resolve({ kind: "presentmon", available: true, outputCsv });
      else resolve({ kind: "presentmon", available: false, reason: /access denied/i.test(stderr)
        ? "ETW session access denied: run elevated or add the account to the Performance Log Users group"
        : `PresentMon exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}` });
    });
  });
}

/**
 * Display timing from a PresentMon CSV. The 2.x metrics name the on-screen
 * duration of each frame `DisplayedTime`; 1.x calls the same interval
 * `MsBetweenDisplayChange`. Frames with no displayed time ("NA") never reached
 * the screen and are counted as not displayed. `GPUBusy` (2.x) is the GPU work
 * per frame; `PresentMode` says how Windows presented the frames. With
 * `window` ({ startMs, endMs } on the nowQpcMs clock) only frames whose
 * `CPUStartQPCTime` lies inside it are counted.
 */
export function summarizePresentMon(path, window = null) {
  const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const header = rows.shift()?.split(",") ?? [];
  let column = header.indexOf("DisplayedTime");
  if (column < 0) column = header.indexOf("MsBetweenDisplayChange");
  const busyColumn = header.indexOf("GPUBusy"), modeColumn = header.indexOf("PresentMode"), timeColumn = header.indexOf("CPUStartQPCTime");
  if (window !== null && timeColumn < 0) throw new Error("PresentMon CSV has no CPUStartQPCTime column for windowing");
  let counted = 0;
  const values = [], busy = [], modes = {};
  for (const row of rows) {
    const cells = row.split(",");
    if (window !== null) {
      const at = Number(cells[timeColumn]);
      if (!(at >= window.startMs && at <= window.endMs)) continue;
    }
    counted++;
    const value = Number(cells[column]);
    if (column >= 0 && Number.isFinite(value) && value > 0) values.push(value);
    const gpu = Number(cells[busyColumn]);
    if (busyColumn >= 0 && Number.isFinite(gpu)) busy.push(gpu);
    if (modeColumn >= 0) modes[cells[modeColumn] ?? ""] = (modes[cells[modeColumn] ?? ""] ?? 0) + 1;
  }
  const quantiles = list => {
    if (!list.length) return null;
    const sorted = list.slice().sort((a, b) => a - b), q = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
    return { p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: sorted.at(-1) };
  };
  return { frames: counted, framesInTrace: rows.length, window, displayed: values.length, notDisplayed: counted - values.length, column: column >= 0 ? header[column] : null,
    displayedMs: quantiles(values), gpuBusyMs: quantiles(busy), presentModes: modes };
}

/** PresentMon DisplayedTime (ms) of every displayed present inside `window` (CPUStartQPCTime, ms), in order. */
export function presentMonDisplayedTimes(path, window) {
  const rows = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const header = rows.shift()?.split(",") ?? [];
  const column = header.indexOf("DisplayedTime"), timeColumn = header.indexOf("CPUStartQPCTime");
  if (column < 0 || timeColumn < 0) throw new Error("PresentMon CSV lacks DisplayedTime or CPUStartQPCTime");
  const values = [];
  for (const row of rows) {
    const cells = row.split(",");
    const at = Number(cells[timeColumn]), value = Number(cells[column]);
    if (at >= window.startMs && at <= window.endMs && Number.isFinite(value) && value > 0) values.push(value);
  }
  return values;
}

/** Screenshot of the display rectangle containing (x, y) to a PNG (Windows); returns the captured bounds. */
export function captureDisplay(x, y, outputPng) {
  if (process.platform !== "win32") return { available: false, reason: "Windows only" };
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    `$s = [System.Windows.Forms.Screen]::FromPoint([System.Drawing.Point]::new(${Math.trunc(x)}, ${Math.trunc(y)}))`,
    "$b = $s.Bounds",
    "$bmp = [System.Drawing.Bitmap]::new($b.Width, $b.Height)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    `$bmp.Save('${outputPng.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "\"$($s.DeviceName)|$($b.X)|$($b.Y)|$($b.Width)|$($b.Height)\"",
  ].join("; ");
  const [device, bx, by, width, height] = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim().split("|");
  return { available: true, device, x: Number(bx), y: Number(by), width: Number(width), height: Number(height), path: outputPng };
}
