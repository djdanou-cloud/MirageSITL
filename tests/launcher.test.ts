// TASK-151 (S01, S02): the local launcher. Fake SITL executables check
// start, stop, crash, restart, TERM-resistant and forking children; the real
// pinned ArduCopter build from TASK-127, when present, runs in JSON lockstep
// against a WebSocket client through the launcher's own bridge and relay.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { decodeRecord, encodeRecord } from "../apps/bridge/src/framing.ts";
import { parseCatalog, writeCatalogEntry, type FirmwareEntry } from "../apps/launcher/src/catalog.ts";
import { checkPrerequisites } from "../apps/launcher/src/prerequisites.ts";
import { ensureToken, startLauncher } from "../apps/launcher/src/server.ts";
import sitlLock from "../scripts/sitl.lock.json" with { type: "json" };

const ORIGIN = "http://127.0.0.1:5173";
const ROOT = new URL("..", import.meta.url).pathname;
const REAL_BINARY = join(ROOT, ".cache/task-127/build-stock/sitl/bin/arducopter");
const REAL_DEFAULTS = join(ROOT, ".cache/task-127/ardupilot/Tools/autotest/default_params/copter.parm");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "mirage-launcher-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fake SITL: a shell wrapper around a Node script whose behaviour experiment.parm selects with FAKE_MODE. */
function fakeFirmware(): { binary: string; defaults: string } {
  const script = join(scratch, "fake-sitl.mjs");
  writeFileSync(script, `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const defaults = process.argv[process.argv.indexOf("--defaults") + 1].split(",");
const mode = Number((/^FAKE_MODE (\\d+)$/m.exec(readFileSync(defaults[1], "utf8")) ?? [0, 0])[1]);
console.log(JSON.stringify({ args: process.argv.slice(2) }));
console.error("fake sitl diagnostics");
mkdirSync("logs", { recursive: true });
writeFileSync("logs/00000001.BIN", Buffer.from([0xa3, 0x95, 0x80, 1, 2, 3]));
if (mode === 1) setTimeout(() => process.exit(3), 200);
if (mode === 2) process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
if (mode === 3) {
  const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  writeFileSync("grandchild.pid", String(child.pid));
}
setInterval(() => undefined, 1000);
`);
  const binary = join(scratch, "fake-arducopter");
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(binary, 0o755);
  const defaults = join(scratch, "copter.parm");
  writeFileSync(defaults, "SYSID_THISMAV 1\n");
  return { binary, defaults };
}
const fake = fakeFirmware();
function entry(id: string, binary: string, defaults: string, commit = sitlLock.commit): FirmwareEntry {
  return { id, firmwareVersion: "ArduCopter V4.8.0-dev", commit, binaryPath: binary, binarySha256: sha256(binary), defaultParametersPath: defaults, defaultParametersSha256: sha256(defaults) };
}
/** Fakes are shell scripts; this admission accepts any executable regular file. */
const admitAny = (path: string) => readFileSync(path);

interface Launcher { port: number; close(): Promise<void> }
async function call(launcher: Launcher, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${launcher.port}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === "" ? null : JSON.parse(text) as unknown };
}
function field(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  return current;
}
const spec = (parameters: { name: string; value: number }[], firmwareId = "fake") => ({
  firmwareId, parameters, frameScript: null, speedup: 1, rateHz: 800, home: [-35.362938, 149.165085, 584, 0],
});
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(done => setTimeout(done, 25));
  }
}

describe("launcher with fake SITL executables", () => {
  const home = join(scratch, "home");
  let launcher: Launcher, token: string;
  beforeAll(async () => {
    token = ensureToken(home);
    writeCatalogEntry(home, entry("fake", fake.binary, fake.defaults));
    launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: "/nonexistent/python", admit: admitAny });
  });
  afterAll(async () => { await launcher.close(); });

  test("creates a private token file and never accepts a token from a URL or the wrong origin or host", async () => {
    expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureToken(home)).toBe(token);
    expect((await call(launcher, token, "GET", "/v1/status")).status).toBe(200);
    expect((await call(launcher, "b".repeat(64), "GET", "/v1/status")).status).toBe(401);
    expect((await call(launcher, "", "GET", "/v1/status")).status).toBe(401);
    expect((await call(launcher, token, "GET", `/v1/status?token=${"0".repeat(64)}`)).status).toBe(400);
    const raw = async (headers: Record<string, string>, method = "GET") => new Promise<number>((done, reject) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port: launcher.port, path: "/v1/status", method, headers }, incoming => { incoming.resume(); done(incoming.statusCode ?? 0); });
      outgoing.on("error", reject);
      outgoing.end();
    });
    const auth = { authorization: `Bearer ${token}` };
    expect(await raw({ ...auth })).toBe(403);
    expect(await raw({ ...auth, origin: "http://evil.example" })).toBe(403);
    expect(await raw({ ...auth, origin: "http://localhost:5173" })).toBe(403);
    expect(await raw({ ...auth, origin: ORIGIN, host: `attacker.example:${launcher.port}` })).toBe(403);
    expect(await raw({ origin: ORIGIN, "access-control-request-method": "POST" }, "OPTIONS")).toBe(204);
    expect(await raw({ origin: "http://evil.example", "access-control-request-method": "POST" }, "OPTIONS")).toBe(403);
    // The token file may not be readable by others.
    const loose = join(scratch, "loose");
    ensureToken(loose);
    chmodSync(join(loose, "token"), 0o644);
    expect(() => ensureToken(loose)).toThrow(/owner only/);
  });

  test("starts with a private working directory and parameter file, collects logs, and stops the owned group", async () => {
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([{ name: "FAKE_MODE", value: 3 }, { name: "FRAME_CLASS", value: 1 }]));
    expect(started.status).toBe(201);
    const id = String(field(started.json, "id")), work = String(field(started.json, "workDirectory"));
    expect(work.startsWith(join(home, "experiments"))).toBe(true);
    expect(readFileSync(join(work, "experiment.parm"), "utf8")).toBe("FAKE_MODE 3\nFRAME_CLASS 1\n");
    await until(() => existsSync(join(work, "grandchild.pid")), 5000, "the grandchild");
    const grandchild = Number(readFileSync(join(work, "grandchild.pid"), "utf8"));
    const pid = Number(field(started.json, "runs", 0, "pid"));
    expect(alive(pid) && alive(grandchild)).toBe(true);
    await until(async () => String(field((await call(launcher, token, "GET", `/v1/experiments/${id}/logs`)).json, "stdout")).includes("--sim-port-out"), 5000, "stdout");
    const logs = await call(launcher, token, "GET", `/v1/experiments/${id}/logs`);
    const args: unknown = JSON.parse(String(field(logs.json, "stdout")).split("\n")[0]!);
    const argv = field(args, "args");
    expect(Array.isArray(argv) && argv.includes("--model") && argv.includes("JSON:127.0.0.1")).toBe(true);
    expect(field(logs.json, "stderr")).toBe("fake sitl diagnostics\n");
    expect(field(logs.json, "dataflash")).toEqual([{ name: "00000001.BIN", bytes: 6 }]);
    const download = await fetch(`http://127.0.0.1:${launcher.port}/v1/experiments/${id}/dataflash/00000001.BIN`, { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } });
    expect(Array.from(new Uint8Array(await download.arrayBuffer()))).toEqual([0xa3, 0x95, 0x80, 1, 2, 3]);
    expect((await call(launcher, token, "GET", `/v1/experiments/${id}/dataflash/..%2Ftoken`)).status).toBe(404);
    expect((await call(launcher, token, "POST", "/v1/experiments", spec([]))).status).toBe(409);
    const stopped = await call(launcher, token, "POST", `/v1/experiments/${id}/stop`);
    expect(field(stopped.json, "state")).toBe("stopped");
    await until(() => !alive(pid) && !alive(grandchild), 5000, "the owned group to exit");
    const owner: unknown = JSON.parse(readFileSync(join(work, "owner-1.json"), "utf8"));
    expect(field(owner, "pid")).toBe(pid);
  });

  test("records a crash, restarts as a new run, and escalates to SIGKILL for a TERM-resistant process", async () => {
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([{ name: "FAKE_MODE", value: 1 }]));
    const id = String(field(started.json, "id"));
    await until(async () => field((await call(launcher, token, "GET", `/v1/experiments/${id}`)).json, "state") === "crashed", 5000, "the crash");
    const crashed = await call(launcher, token, "GET", `/v1/experiments/${id}`);
    expect(field(crashed.json, "runs", 0, "exitCode")).toBe(3);
    const restarted = await call(launcher, token, "POST", `/v1/experiments/${id}/restart`);
    expect(field(restarted.json, "runs", 1, "run")).toBe(2);
    await until(async () => field((await call(launcher, token, "GET", `/v1/experiments/${id}`)).json, "state") === "crashed", 5000, "the second crash");

    const resistant = await call(launcher, token, "POST", "/v1/experiments", spec([{ name: "FAKE_MODE", value: 2 }]));
    const rid = String(field(resistant.json, "id")), pid = Number(field(resistant.json, "runs", 0, "pid"));
    const work = String(field(resistant.json, "workDirectory"));
    await until(() => readFileSync(join(work, "stdout-1.log"), "utf8").includes("--model"), 5000, "the fake to start");
    const before = Date.now();
    const stopped = await call(launcher, token, "POST", `/v1/experiments/${rid}/stop`);
    expect(Date.now() - before).toBeGreaterThanOrEqual(2900);
    expect(field(stopped.json, "runs", 0, "signal")).toBe("SIGKILL");
    expect(alive(pid)).toBe(false);
  }, 20000);

  test("never signals a process it did not start", async () => {
    const outsider = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = outsider.pid!;
    expect((await call(launcher, token, "POST", `/v1/experiments/${pid}/stop`)).status).toBe(404);
    expect((await call(launcher, token, "POST", "/v1/experiments/../stop")).status).toBe(404);
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    await call(launcher, token, "POST", `/v1/experiments/${String(field(started.json, "id"))}/stop`);
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
  });

  test("refuses invalid start requests and firmware whose files changed", async () => {
    const bad = [
      { ...spec([]), extra: 1 }, { ...spec([{ name: "lower", value: 1 }]) }, { ...spec([{ name: "A", value: Number.NaN }]) },
      { ...spec([{ name: "A", value: 1 }, { name: "A", value: 2 }]) }, { ...spec([]), speedup: 0 }, { ...spec([]), home: [91, 0, 0, 0] },
      { ...spec([]), frameScript: "print('é')" },
    ];
    for (const body of bad) expect((await call(launcher, token, "POST", "/v1/experiments", body)).status).toBe(400);
    expect((await call(launcher, token, "POST", "/v1/experiments", spec([], "missing"))).status).toBe(404);
    const changed = join(scratch, "changed-arducopter");
    writeFileSync(changed, readFileSync(fake.binary));
    chmodSync(changed, 0o755);
    writeCatalogEntry(home, entry("changed", changed, fake.defaults));
    writeFileSync(changed, `${readFileSync(changed, "utf8")}# changed\n`);
    const refused = await call(launcher, token, "POST", "/v1/experiments", spec([], "changed"));
    expect(refused.status).toBe(409);
    expect(String(field(refused.json, "error"))).toContain("SHA-256 mismatch");
    const catalog = await call(launcher, token, "GET", "/v1/catalog");
    expect(field(catalog.json, "firmware", 1, "usable")).toBe(false);
  });

  test("reports each prerequisite with a fix", () => {
    const checks = checkPrerequisites({ home, python: "/nonexistent/python", admit: admitAny, platform: "linux", architecture: "x64", nodeVersion: "22.1.0" });
    const byId = new Map(checks.map(check => [check.id, check]));
    expect(byId.get("platform")?.status).toBe("failed");
    expect(byId.get("node")?.status).toBe("failed");
    expect(byId.get("pymavlink")?.status).toBe("missing");
    expect(byId.get("firmware")?.status).toBe("ok");
    for (const check of checks) expect(check.status === "ok" ? check.fix === "" : check.fix.length > 10).toBe(true);
    const empty = join(scratch, "empty-home");
    ensureToken(empty);
    expect(checkPrerequisites({ home: empty, python: "/nonexistent/python" }).find(check => check.id === "firmware")?.status).toBe("missing");
    writeCatalogEntry(empty, entry("old", fake.binary, fake.defaults, "0".repeat(40)));
    const old = checkPrerequisites({ home: empty, python: "/nonexistent/python", admit: admitAny }).find(check => check.id === "firmware");
    expect(old?.status).toBe("failed");
    expect(old?.detail).toContain("not a commit MirageSITL supports");
    expect(() => parseCatalog({ schemaVersion: 1, firmware: [{ id: "x" }] })).toThrow(/entry 1/);
  });
});

const realAvailable = existsSync(REAL_BINARY) && existsSync(REAL_DEFAULTS);
describe.skipIf(!realAvailable)("launcher with the real pinned ArduCopter SITL (TASK-127 build)", () => {
  test("runs JSON lockstep through the hosted bridge, carries MAVLink through the relay, and stops the owned group", async () => {
    const home = join(scratch, "real-home");
    const token = ensureToken(home);
    writeCatalogEntry(home, entry("arducopter-8ab6afde", REAL_BINARY, REAL_DEFAULTS));
    const python = join(ROOT, ".cache/task-127/venv/bin/python");
    const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python });
    try {
      const checks = await call(launcher, token, "GET", "/v1/prerequisites");
      const list = field(checks.json, "checks");
      const checksList: readonly unknown[] = Array.isArray(list) ? list : [];
      const firmware = checksList.find(check => field(check, "id") === "firmware");
      expect(field(firmware, "status")).toBe("ok");
      const parameters = readFileSync(join(ROOT, "tests/fixtures/sitl/parameters.parm"), "utf8").split("\n").filter(line => /^[A-Z]/.test(line))
        .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name!, value: Number(value) }; });
      const started = await call(launcher, token, "POST", "/v1/experiments", spec(parameters, "arducopter-8ab6afde"));
      expect(started.status).toBe(201);
      const id = String(field(started.json, "id")), pid = Number(field(started.json, "runs", 0, "pid"));
      const bridgePort = Number(field(started.json, "ports", "bridge"));
      const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`, ["mirage-v1", `session.${token}`], { origin: ORIGIN });
      let servo = 0, heartbeat = false, sequence = 0;
      ws.on("message", data => {
        if (!Buffer.isBuffer(data)) return;
        const record = decodeRecord(data);
        if (!record) return;
        if (record.channel === 1 && record.payload[0] === 0xfd && record.payload[7] === 0 && record.payload[8] === 0 && record.payload[9] === 0) heartbeat = true;
        if (record.channel !== 3) return;
        // A stationary aircraft on the ground, one state line per servo frame at 800 Hz.
        const line = `\n${JSON.stringify({ timestamp: servo++ / 800, imu: { gyro: [0, 0, 0], accel_body: [0, 0, -9.80665] }, position: [0, 0, 0], quaternion: [1, 0, 0, 0], velocity: [0, 0, 0] })}\n`;
        ws.send(encodeRecord({ channel: 2, epoch: 1, sequence: sequence++, payload: Buffer.from(line) }));
      });
      await until(() => heartbeat && servo > 800, 60000, "a heartbeat after 800 lockstep frames");
      ws.close();
      const stopped = await call(launcher, token, "POST", `/v1/experiments/${id}/stop`);
      expect(field(stopped.json, "state")).toBe("stopped");
      expect(alive(pid)).toBe(false);
      expect(spawnSync("/bin/ps", ["-g", String(pid), "-o", "pid="], { encoding: "utf8" }).stdout.trim()).toBe("");
    } finally {
      await launcher.close();
    }
  }, 120000);
});
