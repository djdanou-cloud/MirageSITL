// TASK-151 (S01, S02), TASK-154: the local launcher. The shared fake SITL
// (tests/support/fake-sitl.mjs) checks start, stop, crash, restart,
// TERM-resistant and forking children, refusals that leave nothing behind,
// exit reasons and the in-process bridge-loss seam; the real pinned
// ArduCopter build from TASK-127 and the TASK-152 installation, when present,
// run in JSON lockstep against a WebSocket client through the launcher's own
// bridge and relay.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { decodeRecord, encodeRecord } from "../apps/bridge/src/framing.ts";
import { parseCatalog, readCatalog, writeCatalogEntry, type FirmwareEntry } from "../apps/launcher/src/catalog.ts";
import { checkPrerequisites } from "../apps/launcher/src/prerequisites.ts";
import { ensureToken, startLauncher } from "../apps/launcher/src/server.ts";
import sitlLock from "../scripts/sitl.lock.json" with { type: "json" };
import { writeFakeFirmware } from "./support/fake-firmware.ts";

const ORIGIN = "http://127.0.0.1:5173";
const ROOT = new URL("..", import.meta.url).pathname;
// The TASK-127 build when this checkout still has it, otherwise what the installer built: a clean installation has only that, and
// scripts/phase1/global-workflows.mjs counts a skipped test as a failure (TASK-190).
const TASK_127 = join(ROOT, ".cache/task-127"), INSTALLED = join(ROOT, ".cache/task-152/home");
const builtBy127 = existsSync(join(TASK_127, "build-stock/sitl/bin/arducopter"));
const REAL_BINARY = builtBy127 ? join(TASK_127, "build-stock/sitl/bin/arducopter") : join(INSTALLED, "build/sitl/bin/arducopter");
const REAL_DEFAULTS = join(builtBy127 ? join(TASK_127, "ardupilot") : join(INSTALLED, "sources/ardupilot"), "Tools/autotest/default_params/copter.parm");
const REAL_PYTHON = builtBy127 ? join(TASK_127, "venv/bin/python") : join(INSTALLED, "venv/bin/python");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "mirage-launcher-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fake = writeFakeFirmware(scratch, { modeFile: join(scratch, "fake-mode") });
const fakeDefaults = join(scratch, "copter.parm");
writeFileSync(fakeDefaults, "SYSID_THISMAV 1\n");
function entry(id: string, binary: string, defaults: string, commit = sitlLock.commit): FirmwareEntry {
  return { id, firmwareVersion: "ArduCopter V4.7.2", commit, binaryPath: binary, binarySha256: sha256(binary), defaultParametersPath: defaults, defaultParametersSha256: sha256(defaults) };
}
/** Fakes are shell scripts; this admission accepts any executable regular file. */
const admitAny = (path: string) => readFileSync(path);

type Launcher = Awaited<ReturnType<typeof startLauncher>>;
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
/** The error code of `kill(pid, 0)`, or null when the process exists. */
function signalZeroError(pid: number): unknown {
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    return field(error, "code");
  }
}
/** The error code of a TCP connection to a loopback port, or null when it connects. */
function tcpConnectError(port: number): Promise<unknown> {
  return new Promise(done => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); done(null); });
    socket.once("error", error => done(field(error, "code")));
  });
}
/** The error code of binding a UDP socket to a loopback port, or null when the bind succeeds. */
function udpBindError(port: number): Promise<unknown> {
  return new Promise(done => {
    const socket = createSocket("udp4");
    socket.once("error", error => { socket.close(); done(field(error, "code")); });
    socket.bind(port, "127.0.0.1", () => socket.close(() => done(null)));
  });
}
/** Members of a process group, as `ps -g` lists them. */
function groupMembers(pid: number): string {
  return spawnSync("/bin/ps", ["-g", String(pid), "-o", "pid="], { encoding: "utf8" }).stdout.trim();
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
    writeCatalogEntry(home, entry("fake", fake.binary, fakeDefaults));
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
    fake.setMode("fork");
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([{ name: "FRAME_TYPE", value: 3 }, { name: "FRAME_CLASS", value: 1 }]));
    expect(started.status).toBe(201);
    const id = String(field(started.json, "id")), work = String(field(started.json, "workDirectory"));
    expect(work.startsWith(join(home, "experiments"))).toBe(true);
    expect(readFileSync(join(work, "experiment.parm"), "utf8")).toBe("FRAME_TYPE 3\nFRAME_CLASS 1\n");
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
    expect(field(stopped.json, "runs", 0, "reason")).toBeNull();
    await until(() => !alive(pid) && !alive(grandchild), 5000, "the owned group to exit");
    const owner: unknown = JSON.parse(readFileSync(join(work, "owner-1.json"), "utf8"));
    expect(field(owner, "pid")).toBe(pid);
  });

  test("records a crash, restarts as a new run, and escalates to SIGKILL for a TERM-resistant process", async () => {
    fake.setMode("exit3");
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    const id = String(field(started.json, "id"));
    await until(async () => field((await call(launcher, token, "GET", `/v1/experiments/${id}`)).json, "state") === "crashed", 5000, "the crash");
    const crashed = await call(launcher, token, "GET", `/v1/experiments/${id}`);
    expect(field(crashed.json, "runs", 0, "exitCode")).toBe(3);
    expect(field(crashed.json, "runs", 0, "reason")).toBe("exit code 3: fake sitl diagnostics");
    const restarted = await call(launcher, token, "POST", `/v1/experiments/${id}/restart`);
    expect(field(restarted.json, "runs", 1, "run")).toBe(2);
    await until(async () => field((await call(launcher, token, "GET", `/v1/experiments/${id}`)).json, "state") === "crashed", 5000, "the second crash");

    fake.setMode("ignore-term");
    const resistant = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    const rid = String(field(resistant.json, "id")), pid = Number(field(resistant.json, "runs", 0, "pid"));
    const work = String(field(resistant.json, "workDirectory"));
    await until(() => readFileSync(join(work, "stdout-1.log"), "utf8").includes("--model"), 5000, "the fake to start");
    const before = Date.now();
    const stopped = await call(launcher, token, "POST", `/v1/experiments/${rid}/stop`);
    expect(Date.now() - before).toBeGreaterThanOrEqual(2900);
    expect(field(stopped.json, "runs", 0, "signal")).toBe("SIGKILL");
    // A requested stop has no failure reason, even when it needed SIGKILL.
    expect(field(stopped.json, "runs", 0, "reason")).toBeNull();
    expect(alive(pid)).toBe(false);
  }, 20000);

  test("never signals a process it did not start", async () => {
    const outsider = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = outsider.pid!;
    expect((await call(launcher, token, "POST", `/v1/experiments/${pid}/stop`)).status).toBe(404);
    expect((await call(launcher, token, "POST", "/v1/experiments/../stop")).status).toBe(404);
    fake.setMode("idle");
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
    writeCatalogEntry(home, entry("changed", changed, fakeDefaults));
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
    writeCatalogEntry(empty, entry("old", fake.binary, fakeDefaults, "0".repeat(40)));
    const old = checkPrerequisites({ home: empty, python: "/nonexistent/python", admit: admitAny }).find(check => check.id === "firmware");
    expect(old?.status).toBe("failed");
    expect(old?.detail).toContain("not a commit MirageSITL supports");
    expect(() => parseCatalog({ schemaVersion: 1, firmware: [{ id: "x" }] })).toThrow(/entry 1/);
  });

  const experimentIds = async (): Promise<string[]> => {
    const list = field((await call(launcher, token, "GET", "/v1/status")).json, "experiments");
    return (Array.isArray(list) ? list : []).map(item => String(field(item, "id")));
  };
  const folders = (): string[] => {
    const directory = join(home, "experiments");
    return existsSync(directory) ? readdirSync(directory).sort() : [];
  };
  const stateOf = async (id: string): Promise<unknown> => field((await call(launcher, token, "GET", `/v1/experiments/${id}`)).json, "state");

  test("refuses a start before creating anything: a deleted binary, or a second start while one runs", async () => {
    const deleted = join(scratch, "deleted-arducopter");
    copyFileSync(fake.binary, deleted);
    chmodSync(deleted, 0o755);
    writeCatalogEntry(home, entry("deleted", deleted, fakeDefaults));
    rmSync(deleted);
    const ids = await experimentIds(), directories = folders();
    const refused = await call(launcher, token, "POST", "/v1/experiments", spec([], "deleted"));
    expect(refused.status).toBe(409);
    expect(String(field(refused.json, "error"))).toMatch(/^Firmware deleted cannot be started: Executable not admitted: ENOENT/);
    expect(field(refused.json, "experimentId")).toBeUndefined();
    expect(await experimentIds()).toEqual(ids);
    expect(folders()).toEqual(directories);

    fake.setMode("idle");
    const running = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    expect(running.status).toBe(201);
    const id = String(field(running.json, "id"));
    const withRunning = await experimentIds(), withRunningDirectories = folders();
    expect(withRunning).toEqual([...ids, id]);
    expect(withRunningDirectories).toEqual([...directories, id].sort());
    const second = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    expect(second.status).toBe(409);
    expect(field(second.json, "error")).toBe("Another experiment is running; stop it first");
    expect(await experimentIds()).toEqual(withRunning);
    expect(folders()).toEqual(withRunningDirectories);
    expect(field((await call(launcher, token, "POST", `/v1/experiments/${id}/stop`)).json, "state")).toBe("stopped");
  });

  test("a SITL that cannot bind its port crashes with ArduPilot's message as the reason", async () => {
    const holder = createTcpServer();
    await new Promise<void>((done, reject) => { holder.once("error", reject); holder.listen(0, "127.0.0.1", () => done()); });
    try {
      const address = holder.address();
      if (address === null || typeof address === "string") throw new Error("The held port has no TCP address");
      const { port } = address;
      fake.setMode(`bind-busy ${port}`);
      const started = await call(launcher, token, "POST", "/v1/experiments", spec([]));
      expect(started.status).toBe(201);
      const id = String(field(started.json, "id"));
      await until(async () => (await stateOf(id)) === "crashed", 5000, "the bind failure");
      const crashed = await call(launcher, token, "GET", `/v1/experiments/${id}`);
      expect(field(crashed.json, "runs", 0, "exitCode")).toBe(1);
      expect(field(crashed.json, "runs", 0, "signal")).toBeNull();
      expect(field(crashed.json, "runs", 0, "reason")).toBe(`exit code 1: bind failed on port ${port} - Address already in use`);
    } finally {
      await new Promise<void>(done => holder.close(() => done()));
    }
  });

  test("SIGKILL of the run reads as killed by SIGKILL, and the view echoes the firmware without machine paths", async () => {
    fake.setMode("idle");
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    expect(started.status).toBe(201);
    const installed = readCatalog(home).find(item => item.id === "fake");
    if (!installed) throw new Error("The fake firmware is not in the catalog");
    const { binaryPath, defaultParametersPath, ...identity } = installed;
    expect(field(started.json, "firmware")).toEqual(identity);
    const firmwareText = JSON.stringify(field(started.json, "firmware"));
    expect(firmwareText.includes(binaryPath) || firmwareText.includes(defaultParametersPath)).toBe(false);
    const id = String(field(started.json, "id")), pid = Number(field(started.json, "runs", 0, "pid"));
    const work = String(field(started.json, "workDirectory"));
    await until(() => readFileSync(join(work, "stdout-1.log"), "utf8").includes("--model"), 5000, "the fake to start");
    process.kill(pid, "SIGKILL");
    await until(async () => (await stateOf(id)) === "crashed", 5000, "the killed run");
    const killed = await call(launcher, token, "GET", `/v1/experiments/${id}`);
    expect(field(killed.json, "runs", 0, "exitCode")).toBeNull();
    expect(field(killed.json, "runs", 0, "signal")).toBe("SIGKILL");
    expect(field(killed.json, "runs", 0, "reason")).toBe("killed by SIGKILL");
  });

  test("closeBridge ends the bridge and relay without stopping SITL; stop then leaves no process of the group, and restart opens new ports", async () => {
    fake.setMode("idle");
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    expect(started.status).toBe(201);
    const id = String(field(started.json, "id")), pid = Number(field(started.json, "runs", 0, "pid"));
    const work = String(field(started.json, "workDirectory"));
    const bridgePort = Number(field(started.json, "ports", "bridge")), relayPort = Number(field(started.json, "ports", "mavlinkRelay"));
    const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`, ["mirage-v1", `session.${token}`], { origin: ORIGIN });
    await new Promise<void>((done, reject) => { ws.once("open", () => done()); ws.once("error", reject); });
    const closed = new Promise<number>(done => ws.once("close", code => done(code)));
    expect(await launcher.closeBridge(id)).toBe(true);
    // The bridge terminates its client without a close frame.
    expect(await closed).toBe(1006);
    // The bridge listener and the relay's SITL-side socket are gone: nothing accepts on the one, and the other can be bound again.
    expect(await tcpConnectError(bridgePort)).toBe("ECONNREFUSED");
    expect(await udpBindError(relayPort)).toBeNull();
    // SITL still runs: a heartbeat it prints well after closeBridge proves it neither died unreaped nor got SIGTERM.
    const beatsAt = (text: string) => [...text.matchAll(/fake sitl alive (\d+)/g)].map(match => Number(match[1])).at(-1) ?? 0;
    const beatAtClose = beatsAt(readFileSync(join(work, "stdout-1.log"), "utf8"));
    await new Promise(done => setTimeout(done, 500));
    const stdoutLater = readFileSync(join(work, "stdout-1.log"), "utf8");
    expect(beatsAt(stdoutLater)).toBeGreaterThanOrEqual(beatAtClose + 3);
    expect(stdoutLater).not.toContain("received SIGTERM");
    const afterClose = await call(launcher, token, "GET", `/v1/experiments/${id}`);
    expect(field(afterClose.json, "state")).toBe("running");
    expect(field(afterClose.json, "ports")).toBeNull();
    expect(alive(pid)).toBe(true);
    expect(await launcher.closeBridge(id)).toBe(false);
    expect(await launcher.closeBridge("no-such-experiment")).toBe(false);
    const stopped = await call(launcher, token, "POST", `/v1/experiments/${id}/stop`);
    expect(field(stopped.json, "state")).toBe("stopped");
    expect(readFileSync(join(work, "stdout-1.log"), "utf8")).toContain("received SIGTERM");
    expect(groupMembers(pid)).toBe("");
    expect(signalZeroError(pid)).toBe("ESRCH");
    // The app starts a new experiment after a failure; the launcher's restart still works after a bridge loss.
    const restarted = await call(launcher, token, "POST", `/v1/experiments/${id}/restart`);
    expect(restarted.status).toBe(200);
    expect(field(restarted.json, "runs", 1, "run")).toBe(2);
    expect(field(restarted.json, "state")).toBe("running");
    const newBridgePort = Number(field(restarted.json, "ports", "bridge"));
    expect(Number.isInteger(newBridgePort) && newBridgePort !== bridgePort).toBe(true);
    const secondPid = Number(field(restarted.json, "runs", 1, "pid"));
    expect(field((await call(launcher, token, "POST", `/v1/experiments/${id}/stop`)).json, "state")).toBe("stopped");
    expect(groupMembers(secondPid)).toBe("");
  });

  test("an unreadable stderr log still ends the run, with the exit reason alone", async () => {
    fake.setMode("idle");
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    expect(started.status).toBe(201);
    const id = String(field(started.json, "id")), pid = Number(field(started.json, "runs", 0, "pid"));
    const work = String(field(started.json, "workDirectory"));
    await until(() => readFileSync(join(work, "stdout-1.log"), "utf8").includes("--model"), 5000, "the fake to start");
    const stderrPath = join(work, "stderr-1.log");
    chmodSync(stderrPath, 0o000);
    try {
      expect(() => readFileSync(stderrPath)).toThrow(/EACCES/);
      process.kill(pid, "SIGKILL");
      await until(async () => (await stateOf(id)) === "crashed", 5000, "the killed run with an unreadable stderr log");
      expect(field((await call(launcher, token, "GET", `/v1/experiments/${id}`)).json, "runs", 0, "reason")).toBe("killed by SIGKILL");
    } finally {
      chmodSync(stderrPath, 0o600);
    }
    // The launcher still admits a new start after that exit.
    const next = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    expect(next.status).toBe(201);
    await call(launcher, token, "POST", `/v1/experiments/${String(field(next.json, "id"))}/stop`);
  });

  test("a spawn failure answers 500 with the experiment ID, and the launcher stays able to start", async () => {
    const unexecutable = join(scratch, "unexecutable-arducopter");
    copyFileSync(fake.binary, unexecutable);
    chmodSync(unexecutable, 0o644);
    writeCatalogEntry(home, entry("unexecutable", unexecutable, fakeDefaults));
    const failed = await call(launcher, token, "POST", "/v1/experiments", spec([], "unexecutable"));
    expect(failed.status).toBe(500);
    expect(String(field(failed.json, "error"))).toMatch(/^SITL did not start: .*EACCES/);
    const id = field(failed.json, "experimentId");
    if (typeof id !== "string") throw new Error("The 500 answer names no experiment");
    const failedView = await call(launcher, token, "GET", `/v1/experiments/${id}`);
    expect(failedView.status).toBe(200);
    expect(field(failedView.json, "runs")).toEqual([]);
    // A run that never started is not "stopped".
    expect(field(failedView.json, "state")).toBe("start-failed");
    expect(String(field(failedView.json, "startError"))).toMatch(/^SITL did not start: .*EACCES/);
    expect(field(failedView.json, "ports")).toBeNull();
    expect((await call(launcher, token, "GET", `/v1/experiments/${id}/logs`)).status).toBe(200);
    fake.setMode("idle");
    const next = await call(launcher, token, "POST", "/v1/experiments", spec([]));
    expect(next.status).toBe(201);
    await call(launcher, token, "POST", `/v1/experiments/${String(field(next.json, "id"))}/stop`);
  });

  test("does not start on a launcher port another program answers on", async () => {
    // The launcher side of a busy launcher port; how the page reports it belongs to the LauncherClient.
    const foreign = createHttpServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<html>another program</html>"); });
    await new Promise<void>((done, reject) => { foreign.once("error", reject); foreign.listen(0, "127.0.0.1", () => done()); });
    try {
      const address = foreign.address();
      if (address === null || typeof address === "string") throw new Error("The foreign server has no TCP address");
      await expect(startLauncher({ home, origin: ORIGIN, port: address.port, python: "/nonexistent/python", admit: admitAny })).rejects.toThrow(/EADDRINUSE/);
      // The other program keeps its port and answers as before.
      expect(await (await fetch(`http://127.0.0.1:${address.port}/v1/status`)).text()).toBe("<html>another program</html>");
    } finally {
      await new Promise<void>(done => foreign.close(() => done()));
    }
  });

  test("the wrapper's real mode execs the given binary with the launcher's arguments", async () => {
    const directory = mkdtempSync(join(scratch, "real-mode-"));
    const wrapper = writeFakeFirmware(directory, { modeFile: join(directory, "mode"), realBinary: "/bin/echo" });
    wrapper.setMode("real");
    writeCatalogEntry(home, entry("echo-wrapper", wrapper.binary, fakeDefaults));
    const started = await call(launcher, token, "POST", "/v1/experiments", spec([], "echo-wrapper"));
    expect(started.status).toBe(201);
    const id = String(field(started.json, "id")), work = String(field(started.json, "workDirectory"));
    await until(async () => (await stateOf(id)) === "exited", 5000, "echo to exit");
    expect(readFileSync(join(work, "stdout-1.log"), "utf8")).toMatch(/^--model JSON:127\.0\.0\.1 --speedup 1 /);
    expect(field((await call(launcher, token, "GET", `/v1/experiments/${id}`)).json, "runs", 0, "reason")).toBe("exit code 0");
    expect(() => writeFakeFirmware(directory, { modeFile: "relative-mode" })).toThrow(/absolute paths/);
    expect(() => fake.setMode("real")).toThrow(/realBinary/);
  });
});

/**
 * Launches a stationary JSON lockstep experiment of a real ArduCopter build,
 * waits for a HEARTBEAT through the relay after 800 frames, and stops it.
 * Returns the experiment's working directory.
 */
async function flyLockstep(launcher: Launcher, token: string, firmwareId: string): Promise<string> {
  const parameters = readFileSync(join(ROOT, "tests/fixtures/sitl/parameters.parm"), "utf8").split("\n").filter(line => /^[A-Z]/.test(line))
    .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name!, value: Number(value) }; });
  const started = await call(launcher, token, "POST", "/v1/experiments", spec(parameters, firmwareId));
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
  return String(field(started.json, "workDirectory"));
}

const realAvailable = existsSync(REAL_BINARY) && existsSync(REAL_DEFAULTS);
describe.skipIf(!realAvailable)("launcher with the real pinned ArduCopter SITL", () => {
  test("runs JSON lockstep through the hosted bridge, carries MAVLink through the relay, and stops the owned group", async () => {
    const home = join(scratch, "real-home");
    const token = ensureToken(home);
    writeCatalogEntry(home, entry("arducopter-fb773567", REAL_BINARY, REAL_DEFAULTS));
    const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: REAL_PYTHON });
    try {
      const checks = await call(launcher, token, "GET", "/v1/prerequisites");
      const list = field(checks.json, "checks");
      const checksList: readonly unknown[] = Array.isArray(list) ? list : [];
      const firmware = checksList.find(check => field(check, "id") === "firmware");
      expect(field(firmware, "status")).toBe("ok");
      await flyLockstep(launcher, token, "arducopter-fb773567");
    } finally {
      await launcher.close();
    }
  }, 120000);
});

// TASK-152: the launcher folder of the clean installation in .cache/task-152/home
// (node scripts/install-macos.mjs --home .cache/task-152/home), used as it is:
// its own token, catalog, Python environment and installed build. The
// installation is only read: the flight runs from a scratch launcher folder
// holding copies of its token and catalog, whose entry names the installed
// build in place, so no experiment folder is added to the installation.
const INSTALL_HOME = join(ROOT, ".cache/task-152/home");
describe.skipIf(!existsSync(join(INSTALL_HOME, "install-manifest.json")))("launcher on the TASK-152 installation", () => {
  test("restarts with the same token and every prerequisite OK, then launches the installed build", async () => {
    const token = ensureToken(INSTALL_HOME);
    const [installed] = readCatalog(INSTALL_HOME);
    if (!installed) throw new Error("The installation has no firmware in its catalog");
    expect(installed.commit).toBe(sitlLock.commit);
    for (let start = 1; start <= 2; start++) {
      const launcher = await startLauncher({ home: INSTALL_HOME, origin: ORIGIN, port: 0, python: join(INSTALL_HOME, "venv/bin/python") });
      try {
        expect(ensureToken(INSTALL_HOME)).toBe(token);
        const checks = await call(launcher, token, "GET", "/v1/prerequisites");
        const list = field(checks.json, "checks");
        const statuses = (Array.isArray(list) ? list : []).map(check => `${String(field(check, "id"))}:${String(field(check, "status"))}`);
        expect(statuses).toEqual(["platform:ok", "node:ok", "storage:ok", "pymavlink:ok", "installation:ok", "firmware:ok"]);
      } finally {
        await launcher.close();
      }
    }
    const flightHome = mkdtempSync(join(scratch, "task-152-flight-"));
    copyFileSync(join(INSTALL_HOME, "token"), join(flightHome, "token"));
    chmodSync(join(flightHome, "token"), 0o600);
    copyFileSync(join(INSTALL_HOME, "catalog.json"), join(flightHome, "catalog.json"));
    expect(readCatalog(flightHome)).toEqual(readCatalog(INSTALL_HOME));
    const launcher = await startLauncher({ home: flightHome, origin: ORIGIN, port: 0, python: join(INSTALL_HOME, "venv/bin/python") });
    try {
      expect(ensureToken(flightHome)).toBe(token);
      const work = await flyLockstep(launcher, token, installed.id);
      expect(work.startsWith(join(flightHome, "experiments"))).toBe(true);
      expect(existsSync(join(INSTALL_HOME, "experiments", basename(work)))).toBe(false);
    } finally {
      await launcher.close();
    }
  }, 180000);
});
