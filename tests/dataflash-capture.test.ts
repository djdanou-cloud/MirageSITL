// TASK-164: DataFlash capture per experiment. Oracles: the generated
// parameter metadata of the pinned commit (TASK-159) for the LOG_* checks; the
// real ArduCopter 8ab6afde SITL log slice of TASK-178
// (tests/fixtures/dataflash/sitl-copter.bin, whose PARM and VER records
// pymavlink reads in reference.json) for the classification and read-back;
// the launcher with the shared fake SITL, whose 6-byte log is a record cut
// short; and, when the TASK-127 build is present, the real ArduCopter through
// the launcher's own bridge in JSON lockstep on free ports.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { decodeRecord, encodeRecord } from "../apps/bridge/src/framing.ts";
import { writeCatalogEntry, type FirmwareEntry } from "../apps/launcher/src/catalog.ts";
import { captureDataflash, snapshotDataflash, writeDataflashManifest } from "../apps/launcher/src/logs.ts";
import { ensureToken, startLauncher } from "../apps/launcher/src/server.ts";
import { assessDataflash, checkLoggingParameters, confirmLogging, firmwareMatches } from "../packages/autopilot/src/dataflash-logging.ts";
import { parseParameterMetadata } from "../packages/autopilot/src/param-metadata.ts";
import sitlLock from "../scripts/sitl.lock.json" with { type: "json" };
import { writeFakeFirmware } from "./support/fake-firmware.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const ORIGIN = "http://127.0.0.1:5173";
const FIXTURE = join(ROOT, "tests/fixtures/dataflash/sitl-copter.bin");
const COMMIT = sitlLock.commit;
const metadataFile: unknown = JSON.parse(readFileSync(join(ROOT, "data/ardupilot/param-metadata.json"), "utf8"));
const metadata = parseParameterMetadata(metadataFile).forCommit(COMMIT);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "mirage-dataflash-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fixture = new Uint8Array(readFileSync(FIXTURE));
const expected = (logging: { name: string; value: number }[] = []) => ({ firmwareVersion: "ArduCopter V4.8.0-dev", commit: COMMIT, logging });

describe("LOG_* parameters against the metadata of the firmware's commit", () => {
  test("accepts declared values, bits and ranges, and ignores other parameters", () => {
    expect(checkLoggingParameters([{ name: "LOG_BACKEND_TYPE", value: 1 }, { name: "LOG_DISARMED", value: 1 }, { name: "LOG_BITMASK", value: 180222 },
      { name: "LOG_MAX_FILES", value: 10 }], metadata)).toEqual([]);
    expect(checkLoggingParameters([{ name: "FRAME_CLASS", value: 99 }], null)).toEqual([]);
    expect(checkLoggingParameters([{ name: "LOG_BACKEND_TYPE", value: 3 }], metadata)).toEqual([]);
  });
  test("names every reason a logging configuration cannot be used", () => {
    expect(checkLoggingParameters([
      { name: "LOG_DISARMED", value: 7 },
      // Bit 14 is not declared in ArduCopter's LOG_BITMASK at 8ab6afde.
      { name: "LOG_BITMASK", value: 180222 + 2 ** 14 },
      { name: "LOG_MAX_FILES", value: 1 },
      { name: "LOG_BACKEND_TYPE", value: 2 },
      { name: "LOG_BACKEND_TYPE", value: 5 },
      { name: "LOG_NOT_A_PARAMETER", value: 1 },
      { name: "LOG_REPLAY", value: Number.NaN },
    ], metadata)).toEqual([
      "LOG_DISARMED 7 is not one of its values (0 Disabled, 1 Enabled, 2 Disabled on USB connection, 3 Discard log on reboot if never armed)",
      "LOG_BITMASK sets bits 14, which ArduPilot does not declare",
      "LOG_MAX_FILES 1 is outside its range 2 to 500",
      "LOG_BACKEND_TYPE must include the File backend (bit 0): the launcher collects the logs SITL writes to logs/",
      "LOG_BACKEND_TYPE requests the Block backend (bit 2), which SITL does not have",
      "LOG_NOT_A_PARAMETER is not a parameter of ArduPilot 8ab6afde",
      "LOG_REPLAY must be a finite number",
    ]);
    expect(checkLoggingParameters([{ name: "LOG_DISARMED", value: 1 }], null)).toEqual([
      "MirageSITL has no parameter metadata for this firmware's commit, so its logging parameters cannot be checked"]);
  });
});

describe("a DataFlash file judged from its own bytes", () => {
  test("reads the firmware from VER and the logging it ran with from PARM", () => {
    const assessment = assessDataflash(fixture);
    expect(assessment).toMatchObject({ status: "complete", records: 2259, truncatedBytes: 0, damaged: [],
      firmware: { version: "ArduCopter V4.8.0-dev (8ab6afde)", gitHash: "8ab6afde" } });
    expect(firmwareMatches(assessment, COMMIT)).toBe(true);
    expect(firmwareMatches(assessment, "0".repeat(40))).toBe(false);
    expect(assessment.parameters.size).toBe(1410);
    expect([assessment.parameters.get("LOG_BITMASK"), assessment.parameters.get("LOG_BACKEND_TYPE"), assessment.parameters.get("LOG_DISARMED")]).toEqual([180222, 1, 0]);
    expect(confirmLogging(assessment, [{ name: "LOG_BITMASK", value: 180222 }, { name: "LOG_DISARMED", value: 0 }, { name: "FRAME_CLASS", value: 1 }]))
      .toEqual({ confirmed: true, checked: [{ name: "LOG_BITMASK", configured: 180222, logged: 180222 }, { name: "LOG_DISARMED", configured: 0, logged: 0 }] });
    expect(confirmLogging(assessment, [{ name: "LOG_DISARMED", value: 1 }, { name: "LOG_FILE_NOPE", value: 1 }])).toEqual({ confirmed: false, checked: [
      { name: "LOG_DISARMED", configured: 1, logged: 0 }, { name: "LOG_FILE_NOPE", configured: 1, logged: null }] });
  });
  test("reports a cut tail as truncated, damage inside as damaged, and no bytes as empty", () => {
    const cut = assessDataflash(fixture.subarray(0, fixture.length - 7));
    expect(cut.status).toBe("truncated");
    expect(cut.truncatedBytes).toBeGreaterThan(0);
    expect(cut.records).toBe(2258);
    const broken = fixture.slice();
    // A byte inside the record stream that is not a record header: the reader skips to the next header.
    broken[40000] = 0x00; broken[40001] = 0x00;
    const damaged = assessDataflash(broken);
    expect(damaged.status).toBe("damaged");
    expect(damaged.damaged.length).toBeGreaterThan(0);
    expect(assessDataflash(new Uint8Array(0))).toMatchObject({ status: "empty", records: 0, firmware: null });
    expect(assessDataflash(new Uint8Array([0xa3, 0x95, 0x80, 1, 2, 3]))).toMatchObject({ status: "truncated", records: 0, truncatedBytes: 6 });
  });
});

describe("attaching the files of each run", () => {
  test("attaches files that are new, grown or rewritten since the run started, with their hashes, and reports a run without one", () => {
    const work = join(scratch, "capture");
    mkdirSync(join(work, "logs"), { recursive: true });
    copyFileSync(FIXTURE, join(work, "logs", "00000001.BIN"));
    utimesSync(join(work, "logs", "00000001.BIN"), 1000, 1000);
    const before = snapshotDataflash(work);
    expect(captureDataflash(work, 1, before, expected())).toEqual([{ run: 1, name: null, status: "missing", reason: "The run wrote no DataFlash file to logs/" }]);
    copyFileSync(FIXTURE, join(work, "logs", "00000002.BIN"));
    writeFileSync(join(work, "logs", "LASTLOG.TXT"), "2\n");
    const captures = captureDataflash(work, 2, before, expected([{ name: "LOG_BITMASK", value: 180222 }]));
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ run: 2, name: "00000002.BIN", bytes: fixture.length, sha256: sha256(fixture), status: "complete",
      firmware: { gitHash: "8ab6afde", matchesBuild: true }, logging: { confirmed: true } });
    // The same name rewritten at the same size counts by its modification time.
    const again = snapshotDataflash(work);
    utimesSync(join(work, "logs", "00000002.BIN"), 2000, 2000);
    expect(captureDataflash(work, 3, again, expected()).map(capture => capture.name)).toEqual(["00000002.BIN"]);
    const manifest = writeDataflashManifest(work, "experiment", expected(), captures);
    expect(JSON.parse(readFileSync(join(work, "dataflash.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(manifest)));
    expect(readdirSync(work).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(done => setTimeout(done, 25));
  }
}
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
function entry(id: string, binary: string, defaults: string): FirmwareEntry {
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  return { id, firmwareVersion: "ArduCopter V4.8.0-dev", commit: COMMIT, binaryPath: binary, binarySha256: hash(binary), defaultParametersPath: defaults, defaultParametersSha256: hash(defaults) };
}
const spec = (parameters: { name: string; value: number }[], firmwareId: string) => ({
  firmwareId, parameters, frameScript: null, speedup: 1, rateHz: 800, home: [-35.362938, 149.165085, 584, 0],
});

describe("the launcher attaches each run's logs", () => {
  test("refuses unusable logging before it creates anything, and attaches every run's file, a cut one as truncated", async () => {
    const home = join(scratch, "fake-home");
    const token = ensureToken(home);
    const fake = writeFakeFirmware(scratch, { modeFile: join(scratch, "fake-mode") });
    const defaults = join(scratch, "copter.parm");
    writeFileSync(defaults, "SYSID_THISMAV 1\n");
    writeCatalogEntry(home, entry("fake", fake.binary, defaults));
    const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: "/nonexistent/python", admit: path => readFileSync(path) });
    try {
      const refused = await call(launcher, token, "POST", "/v1/experiments", spec([{ name: "LOG_BACKEND_TYPE", value: 4 }, { name: "LOG_DISARMED", value: 9 }], "fake"));
      expect(refused.status).toBe(400);
      expect(String(field(refused.json, "error"))).toContain("LOG_BACKEND_TYPE must include the File backend");
      expect(String(field(refused.json, "error"))).toContain("LOG_DISARMED 9 is not one of its values");
      expect(existsSync(join(home, "experiments")) ? readdirSync(join(home, "experiments")) : []).toEqual([]);

      fake.setMode("idle");
      const logging = [{ name: "LOG_DISARMED", value: 1 }, { name: "FRAME_CLASS", value: 1 }];
      const started = await call(launcher, token, "POST", "/v1/experiments", spec(logging, "fake"));
      expect(started.status).toBe(201);
      const id = String(field(started.json, "id")), work = String(field(started.json, "workDirectory"));
      await until(() => existsSync(join(work, "logs", "00000001.BIN")), 5000, "the fake log");
      expect(field((await call(launcher, token, "POST", `/v1/experiments/${id}/stop`)).json, "state")).toBe("stopped");
      // The fake writes logs/00000001.BIN again on restart: same name and size, a new modification time.
      await new Promise(done => setTimeout(done, 20));
      expect((await call(launcher, token, "POST", `/v1/experiments/${id}/restart`)).status).toBe(200);
      await until(async () => field(await call(launcher, token, "GET", `/v1/experiments/${id}`), "json", "state") === "running", 5000, "the second run");
      await new Promise(done => setTimeout(done, 200));
      await call(launcher, token, "POST", `/v1/experiments/${id}/stop`);
      const logs = await call(launcher, token, "GET", `/v1/experiments/${id}/logs`);
      const attachments = field(logs.json, "attachments");
      const six = new Uint8Array([0xa3, 0x95, 0x80, 1, 2, 3]);
      const one = { name: "00000001.BIN", bytes: 6, sha256: sha256(six), status: "truncated", records: 0, truncatedBytes: 6, damaged: [], firmware: null,
        logging: { confirmed: false, checked: [{ name: "LOG_DISARMED", configured: 1, logged: null }] } };
      expect(attachments).toEqual([{ run: 1, ...one }, { run: 2, ...one }]);
      const manifest: unknown = JSON.parse(readFileSync(join(work, "dataflash.json"), "utf8"));
      expect(field(manifest, "captures")).toEqual(attachments);
      expect([field(manifest, "experimentId"), field(manifest, "commit")]).toEqual([id, COMMIT]);
    } finally {
      await launcher.close();
    }
  }, 30000);
});

const REAL_BINARY = join(ROOT, ".cache/task-127/build-stock/sitl/bin/arducopter");
const REAL_DEFAULTS = join(ROOT, ".cache/task-127/ardupilot/Tools/autotest/default_params/copter.parm");
describe.skipIf(!existsSync(REAL_BINARY) || !existsSync(REAL_DEFAULTS))("the real ArduCopter 8ab6afde through the launcher (TASK-127 build)", () => {
  test("attaches the run's log, hashed, with the firmware and the configured logging read back from the log itself", async () => {
    const home = join(scratch, "real-home");
    const token = ensureToken(home);
    writeCatalogEntry(home, entry("arducopter-8ab6afde", REAL_BINARY, REAL_DEFAULTS));
    const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(ROOT, ".cache/task-127/venv/bin/python") });
    // Logging while disarmed, so a run on the ground writes a log; a LOG_BITMASK other than the default, so the read-back is not the default's.
    const logging = [{ name: "LOG_BACKEND_TYPE", value: 1 }, { name: "LOG_DISARMED", value: 1 }, { name: "LOG_BITMASK", value: 176126 }, { name: "LOG_FILE_DSRMROT", value: 0 }];
    const parameters = [...readFileSync(join(ROOT, "tests/fixtures/sitl/parameters.parm"), "utf8").split("\n").filter(line => /^[A-Z]/.test(line))
      .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name ?? "", value: Number(value) }; }), ...logging];
    try {
      const started = await call(launcher, token, "POST", "/v1/experiments", spec(parameters, "arducopter-8ab6afde"));
      expect(started.status, JSON.stringify(started.json)).toBe(201);
      const id = String(field(started.json, "id")), work = String(field(started.json, "workDirectory"));
      const ws = new WebSocket(`ws://127.0.0.1:${Number(field(started.json, "ports", "bridge"))}`, ["mirage-v1", `session.${token}`], { origin: ORIGIN });
      let servo = 0, sequence = 0;
      ws.on("message", data => {
        if (!Buffer.isBuffer(data)) return;
        const record = decodeRecord(data);
        if (!record || record.channel !== 3) return;
        // The aircraft at rest on the ground, one state line per servo frame at 800 Hz.
        const line = `\n${JSON.stringify({ timestamp: servo++ / 800, imu: { gyro: [0, 0, 0], accel_body: [0, 0, -9.80665] }, position: [0, 0, 0], quaternion: [1, 0, 0, 0], velocity: [0, 0, 0] })}\n`;
        ws.send(encodeRecord({ channel: 2, epoch: 1, sequence: sequence++, payload: Buffer.from(line) }));
      });
      // Twenty simulated seconds: the log's PARM block is written at its start and the file backend flushes about once a second.
      await until(() => servo > 16000, 90000, "16,000 lockstep frames");
      ws.close();
      expect(field((await call(launcher, token, "POST", `/v1/experiments/${id}/stop`)).json, "state")).toBe("stopped");
      const attachments = field((await call(launcher, token, "GET", `/v1/experiments/${id}/logs`)).json, "attachments");
      expect(Array.isArray(attachments) ? attachments.length : 0).toBe(1);
      const name = field(attachments, 0, "name");
      if (typeof name !== "string") throw new Error(`No log: ${String(field(attachments, 0, "reason"))}`);
      const bytes = new Uint8Array(readFileSync(join(work, "logs", name)));
      expect(field(attachments, 0, "sha256")).toBe(sha256(bytes));
      expect(field(attachments, 0, "bytes")).toBe(bytes.length);
      expect(["complete", "truncated"]).toContain(field(attachments, 0, "status"));
      expect(field(attachments, 0, "damaged")).toEqual([]);
      expect(field(attachments, 0, "firmware")).toEqual({ version: "ArduCopter V4.8.0-dev (8ab6afde)", gitHash: "8ab6afde", matchesBuild: true });
      expect(field(attachments, 0, "logging")).toEqual({ confirmed: true, checked: logging.map(p => ({ name: p.name, configured: p.value, logged: p.value })) });
      // Evidence: the attachment as the launcher reported it, written only where MIRAGE_DATAFLASH_EVIDENCE names a file.
      const evidence = process.env.MIRAGE_DATAFLASH_EVIDENCE;
      if (evidence) writeFileSync(evidence, JSON.stringify({ name, bytes: bytes.length, sha256: field(attachments, 0, "sha256"), status: field(attachments, 0, "status"),
        records: field(attachments, 0, "records"), truncatedBytes: field(attachments, 0, "truncatedBytes"), frames: servo }) + "\n");
    } finally {
      await launcher.close();
    }
  }, 150000);
});
