import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
export function exact(v, keys) {
  if (!object(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) throw new Error("Invalid evidence fields");
}
export function finite(v, min = -Infinity, max = Infinity) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error("Invalid finite evidence quantity");
  return v;
}
export function text(v) {
  if (typeof v !== "string" || !v.trim() || v.length > 2048) throw new Error("Invalid evidence identity");
  return v;
}
export function percentile(values, p) {
  if (!values.length) throw new Error("Empty measurement window");
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
export function loadJson(path, expected) {
  if (!hash(expected)) throw new Error("Missing evidence SHA-256");
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd), limit = 32 * 1024 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error("Evidence size budget exceeded");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count !== stat.size || sha256(bytes.subarray(0, count)) !== expected) throw new Error("Evidence size or SHA-256 mismatch");
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally { closeSync(fd); }
}
export function provenance(v, source) {
  exact(v, ["source", "operator", "recordedAt", "firmwareSha256", "modelSha256"]);
  if (v.source !== source || !hash(v.firmwareSha256) || !hash(v.modelSha256)) throw new Error("Real source/model/firmware provenance required");
  text(v.operator);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text(v.recordedAt)) || !Number.isFinite(Date.parse(v.recordedAt))) throw new Error("Invalid acquisition timestamp");
}
export function report(kind, status, reasons, metrics = {}) { return { schemaVersion: 1, kind, status, reasons, metrics }; }
export function cli(url, kind, assess) {
  if (!process.argv[1] || fileURLToPath(url) !== process.argv[1]) return;
  let result;
  try {
    if (process.argv.length === 2) result = report(kind, "BLOCKED_EXTERNAL", ["Provide a real trace using --input PATH --sha256 HEX; see the task procedure"]);
    else {
      if (process.argv.length !== 6 || process.argv[2] !== "--input" || process.argv[4] !== "--sha256") throw new Error("Expected --input PATH --sha256 HEX");
      result = assess(loadJson(process.argv[3], process.argv[5]));
      result.inputSha256 = process.argv[5];
    }
  } catch (error) { result = report(kind, "FAIL", [error instanceof Error ? error.message : String(error)]); }
  result.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  result.validatorSha256 = sha256(readFileSync(fileURLToPath(url)));
  const path = `test-results/validation/${kind}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  console.log(`${kind}: ${result.status}; ${path}`);
  process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
}
