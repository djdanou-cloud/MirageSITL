// TASK-152 (S01, S02): macOS installation. Unit checks of the host checks,
// the hash-pinned Python requirements, the manifest rules and the plan; when
// a clean installation exists in .cache/task-152/home (made by
// node scripts/install-macos.mjs --home .cache/task-152/home), its manifest
// is rechecked file by file and the launcher reports every prerequisite met.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkPrerequisites } from "../apps/launcher/src/prerequisites.ts";
import { hostChecks, manifestItem, parseInstallManifest } from "../scripts/install/install-rules.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const inventory: unknown = JSON.parse(readFileSync(join(ROOT, "config/offline-inventory.json"), "utf8"));
const HOME = join(ROOT, ".cache/task-152/home");

describe("installer rules", () => {
  test("host checks name each missing tool with its fix", () => {
    const none = () => null;
    const checks = hostChecks({ platform: "linux", arch: "x64", nodeVersion: "22.3.0", probe: none });
    expect(checks.map(check => [check.id, check.ok])).toEqual([["platform", false], ["node", false], ["xcode-tools", false], ["git", false], ["python", false]]);
    for (const check of checks) expect(check.fix.length).toBeGreaterThan(20);
    const tools = (command: string) => (command === "python3" ? "3.9" : command === "git" ? "git version 2.50.1" : "/Library/Developer/CommandLineTools");
    const ok = hostChecks({ platform: "darwin", arch: "arm64", nodeVersion: "24.22.1", probe: tools });
    expect(ok.every(check => check.ok && check.fix === "")).toBe(true);
    expect(hostChecks({ platform: "darwin", arch: "arm64", nodeVersion: "24.22.1", probe: c => (c === "python3" ? "3.8" : "x") }).find(c => c.id === "python")?.ok).toBe(false);
  });

  test("Python packages are pinned to one version with hashes each, pymavlink 2.4.50 among them", () => {
    const text = readFileSync(join(ROOT, "scripts/install/requirements-macos.txt"), "utf8");
    const requirements = text.split("\n").filter(line => /^[A-Za-z]/.test(line));
    expect(requirements.map(line => line.split(" ")[0])).toEqual([
      "dronecan==1.0.27", "empy==3.3.4", "fastcrc==0.5.0", "lxml==6.1.3", "pexpect==4.9.0", "ptyprocess==0.7.0", "pymavlink==2.4.50", "pyserial==3.5",
    ]);
    const blocks = text.split(/\n(?=[A-Za-z])/).filter(block => /^[A-Za-z]/.test(block));
    for (const block of blocks) expect(block.match(/--hash=sha256:[0-9a-f]{64}/g)?.length ?? 0).toBeGreaterThan(0);
  });

  test("manifest items take the inventory license, and file items need a hash and size", () => {
    const item = manifestItem(inventory, "pymavlink", { id: "python-environment", version: "pymavlink 2.4.50" });
    expect(item.license).toMatch(/LGPL-3.0/);
    expect(() => manifestItem(inventory, "no-such-row", { id: "x" })).toThrow(/missing/);
    expect(() => parseInstallManifest({ schemaVersion: 1, items: [{ ...item, path: "/x" }] })).toThrow(/SHA-256 and size/);
    expect(() => parseInstallManifest({ schemaVersion: 1, items: [{ ...item, license: "" }] })).toThrow(/item/);
    expect(parseInstallManifest({ schemaVersion: 1, items: [item] }).items).toHaveLength(1);
  });

  test("--plan lists the six steps without changing anything", () => {
    const output = execFileSync(process.execPath, [join(ROOT, "scripts/install-macos.mjs"), "--plan", "--home", "/nonexistent/mirage-plan"], { encoding: "utf8" });
    expect(output.trim().split("\n").map(line => line.slice(0, 2))).toEqual(["1.", "2.", "3.", "4.", "5.", "6."]);
    expect(existsSync("/nonexistent/mirage-plan")).toBe(false);
  });
});

describe.skipIf(!existsSync(join(HOME, "install-manifest.json")))("the clean installation in .cache/task-152/home", () => {
  test("every recorded file keeps its hash and the launcher reports every prerequisite met", () => {
    const parsed: unknown = JSON.parse(readFileSync(join(HOME, "install-manifest.json"), "utf8"));
    const manifest = parseInstallManifest(parsed);
    for (const item of manifest.items) {
      if (item.path === undefined || !String(item.path).startsWith(HOME)) continue;
      expect(createHash("sha256").update(readFileSync(String(item.path))).digest("hex")).toBe(item.sha256);
    }
    const checks = checkPrerequisites({ home: HOME, python: join(HOME, "venv/bin/python") });
    expect(checks.filter(check => check.status !== "ok")).toEqual([]);
    expect(checks.map(check => check.id)).toEqual(["platform", "node", "storage", "pymavlink", "installation", "firmware"]);
  });
});
