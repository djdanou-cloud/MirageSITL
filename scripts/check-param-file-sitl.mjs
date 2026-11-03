#!/usr/bin/env node
// TASK-161 native evidence: an exported parameter file loaded back into
// SITL reproduces its values. Against an installed stock ArduCopter (the
// TASK-152 catalog, rechecked by the launcher's own verification), held at
// rest in JSON lockstep as scripts/check-param-sitl.mjs does:
//   1. SITL A boots with the build's copter.parm, its complete list is
//      downloaded with the parameter service, and four writes are confirmed
//      (a float whose float32 needs five digits, a float in metres, a value in
//      m/s and a reboot-required integer); the list is downloaded again;
//   2. that list is exported with formatParamFile, all parameters;
//   3. SITL B boots in a fresh directory, with no stored parameters, from
//      copter.parm followed by the exported file (--defaults A,B: ArduPilot's
//      own loader reads it), and its complete list is downloaded;
//   4. every exported value must read back as the same float32, except the
//      parameters ArduPilot's metadata marks read-only or volatile, which the
//      autopilot sets itself (device IDs, counters, ground pressures). That
//      rule was fixed before the first run; such values are reported, never
//      judged. FORMAT_VERSION, which a SITL loader ignores, is the same build's.
//
//   node scripts/check-param-file-sitl.mjs [--home DIR] [--firmware ID] [--out FILE]
//
// --home     launcher home with catalog.json (default MIRAGE_LAUNCHER_HOME, else
//            ~/Library/Application Support/MirageSITL/launcher)
// --firmware catalog entry ID (default: the only entry)
// --out      report path (default test-results/validation/param-file-sitl.json)
// Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED_EXTERNAL (no usable installed firmware).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const self = fileURLToPath(import.meta.url);
const RATE_HZ = 400;
const HOME = [-35.363261, 149.165230, 584, 353];
const GRAVITY_MPS2 = 9.80665;
const BOOT_DEADLINE_MS = 60_000, STAGE_DEADLINE_MS = 60_000;
export const WRITES = [
  { name: "ATC_RAT_RLL_I", value: 0.00017 },
  { name: "RTL_ALT_M", value: 20.25 },
  { name: "LAND_SPD_MS", value: 0.75 },
  { name: "GPS1_DELAY_MS", value: 10 },
];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

/**
 * Judges a report independently of the code that produced it. Returns the
 * failures; an empty list is PASS. Exported for tests/param-file.test.ts.
 */
export function assessParamFileRun(report) {
  const failures = [];
  const listed = (label, list) => {
    if (list?.download?.kind !== "complete" || list.parameters?.length !== list.download.total) failures.push(`${label}: the list is not complete`);
    return new Map((list?.parameters ?? []).map(p => [p.name, p.value]));
  };
  const a = listed("SITL A", report.exported), b = listed("SITL B", report.loaded);
  const own = new Set(report.autopilotOwned ?? []);
  for (const write of WRITES) {
    const state = report.writes?.find(w => w.name === write.name)?.state;
    if (state?.kind !== "confirmed" || state.value !== Math.fround(write.value)) failures.push(`${write.name} was not confirmed at ${write.value}`);
    if (a.get(write.name) !== Math.fround(write.value)) failures.push(`${write.name} is not ${write.value} in the exported list`);
    if (own.has(write.name)) failures.push(`${write.name} is one of the user's writes, not a parameter the autopilot sets`);
  }
  const lines = (report.file?.lines ?? 0);
  if (lines !== a.size) failures.push(`the file holds ${lines} parameters, the exported list ${a.size}`);
  if (report.file?.sha256 !== sha256(Buffer.from(report.file?.text ?? "", "utf8"))) failures.push("the file's hash does not match its text");
  if (!(report.file?.text ?? "").startsWith("# ArduPilot parameter file exported by MirageSITL")) failures.push("the file has no context header");
  let compared = 0;
  for (const [name, value] of a) {
    if (own.has(name)) continue;
    compared++;
    if (!b.has(name)) failures.push(`${name} is missing from SITL B's list`);
    else if (!Object.is(b.get(name), value) && b.get(name) !== value) failures.push(`${name} reads back ${b.get(name)} in SITL B, the file holds ${value}`);
  }
  if (compared < 1000) failures.push(`only ${compared} parameters were compared`);
  if (report.loadedFresh !== true) failures.push("SITL B did not start from an empty parameter store");
  return failures;
}

async function run(args) {
  const { readCatalog, verifyEntry } = await import("../apps/launcher/src/catalog.ts");
  const { OwnedProcess } = await import("../apps/launcher/src/processes.ts");
  const { MavParser } = await import("../packages/mavlink/src/codec.ts");
  const { GroundStation } = await import("../packages/autopilot/src/ground-station.ts");
  const { ExternalSitlLockstep, newSitlPhysicsState, MAX_STATE_LINE_BYTES } = await import("../packages/autopilot/src/external-sitl.ts");
  const { ParameterService } = await import("../packages/autopilot/src/param-service.ts");
  const { parseParameterMetadata } = await import("../packages/autopilot/src/param-metadata.ts");
  const { formatParamFile, parseParamFile } = await import("../packages/autopilot/src/param-file.ts");

  const home = resolve(option(args, "--home") ?? process.env.MIRAGE_LAUNCHER_HOME ?? join(homedir(), "Library", "Application Support", "MirageSITL", "launcher"));
  const out = resolve(option(args, "--out") ?? join(root, "test-results/validation/param-file-sitl.json"));
  const entries = readCatalog(home);
  const wanted = option(args, "--firmware");
  const entry = wanted ? entries.find(item => item.id === wanted) : entries.length === 1 ? entries[0] : undefined;
  if (!entry) { console.error(`BLOCKED_EXTERNAL: no single installed firmware in ${join(home, "catalog.json")} (install with scripts/install-macos.mjs or pass --firmware)`); return 2; }
  const status = verifyEntry(entry);
  if (!status.usable) { console.error(`BLOCKED_EXTERNAL: firmware ${entry.id} cannot be started: ${status.reason}`); return 2; }
  const metadata = parseParameterMetadata(JSON.parse(readFileSync(join(root, "data/ardupilot/param-metadata.json"), "utf8"))).forCommit(entry.commit);
  if (!metadata) { console.error(`BLOCKED_EXTERNAL: no parameter metadata for ArduPilot ${entry.commit}`); return 2; }

  /** One SITL at rest in lockstep with a parameter service; `defaults` is the --defaults list. */
  async function session(defaults, work) {
    const physics = createSocket("udp4"), mavlink = createSocket("udp4");
    physics.bind(0, "127.0.0.1"); mavlink.bind(0, "127.0.0.1");
    await Promise.all([once(physics, "listening"), once(mavlink, "listening")]);
    const link = new ExternalSitlLockstep({ motorChannels: [1, 2, 3, 4] });
    const state = newSitlPhysicsState(), reply = new Uint8Array(MAX_STATE_LINE_BYTES), motors = new Float64Array(4);
    state.accelBodyMps2[2] = -GRAVITY_MPS2;
    let steps = 0;
    const simTime = () => steps / RATE_HZ;
    physics.on("message", (bytes, from) => {
      const disposition = link.receive(bytes);
      if (link.ready()) {
        link.consumeActuatorsInto(motors);
        steps++;
        state.timestampS = simTime();
        const n = link.completeStepInto(state, reply);
        if (n > 0) physics.send(reply.subarray(0, n), from.port, from.address);
      } else if (disposition === "duplicate") {
        const n = link.resendReplyInto(reply);
        if (n > 0) physics.send(reply.subarray(0, n), from.port, from.address);
      }
    });
    const ground = new GroundStation();
    let address = null, heartbeats = 0, ended = null;
    const send = frame => { if (address) mavlink.send(Buffer.from(frame), address.port, address.address); };
    const service = new ParameterService({ ground, send, metadata });
    const parser = new MavParser(frame => {
      if (frame.id === 0 && frame.systemId === 1 && frame.componentId === 1) heartbeats++;
      service.ingest(frame, simTime());
    });
    mavlink.on("message", (bytes, from) => { address = { address: from.address, port: from.port }; parser.push(bytes); });
    const argv = ["--model", "JSON:127.0.0.1", "--speedup", "100", "--rate", String(RATE_HZ), "--home", HOME.join(","),
      "--sim-port-out", String(physics.address().port), "--serial0", `udpclient:127.0.0.1:${mavlink.address().port}`,
      "--serial1", "none", "--serial2", "none", "--defaults", defaults.join(",")];
    const sitl = await OwnedProcess.start({ command: entry.binaryPath, args: argv, cwd: work, run: 1 }, info => { ended = info; });
    const packet = new Uint8Array(64);
    let lastBeatS = -1;
    const until = async (label, done, deadlineMs = STAGE_DEADLINE_MS) => {
      const start = performance.now();
      while (!done()) {
        if (ended) throw new Error(`SITL ended during ${label}: ${ended.reason ?? ended.state}`);
        if (performance.now() - start > deadlineMs) throw new Error(`${label} did not finish within ${deadlineMs} ms of wall time`);
        const now = simTime();
        if (now - lastBeatS >= 1) { lastBeatS = now; const n = ground.heartbeatInto(packet); send(packet.subarray(0, n)); }
        service.tick(now);
        await new Promise(resolveWait => setTimeout(resolveWait, 2));
      }
    };
    const download = async label => {
      service.requestList(simTime());
      await until(label, () => ["complete", "failed"].includes(service.download().kind));
      return { download: service.download(), parameters: service.parameters().map(p => ({ name: p.name, value: p.value, type: p.type, index: p.index })) };
    };
    await until("boot", () => heartbeats > 0, BOOT_DEADLINE_MS);
    return {
      service, simTime, until, download, steps: () => steps,
      close: async () => { if (sitl.running) await sitl.stop(); physics.close(); mavlink.close(); },
    };
  }

  const workA = mkdtempSync(join(tmpdir(), "mirage-param-file-a-")), workB = mkdtempSync(join(tmpdir(), "mirage-param-file-b-"));
  const startedWall = performance.now();
  let a = null, b = null;
  try {
    a = await session([entry.defaultParametersPath], workA);
    await a.download("SITL A's first download");
    const writes = [];
    for (const write of WRITES) {
      const started = a.service.set(write.name, write.value, a.simTime());
      await a.until(`the write of ${write.name}`, () => a.service.write(started.id)?.kind !== "requested");
      writes.push({ name: write.name, requested: write.value, state: a.service.write(started.id) });
    }
    const exported = await a.download("SITL A's second download");
    await a.close();
    a = null;

    const text = formatParamFile({
      exportedAt: new Date().toISOString(), source: "SITL A's read-back", selection: `all ${exported.parameters.length} parameters`, aircraft: null,
      firmware: { version: entry.firmwareVersion, commit: entry.commit }, experiment: null,
    }, exported.parameters);
    const fileLines = parseParamFile(text).length;
    const file = join(workB, "exported.param");
    writeFileSync(file, text);
    // A fresh directory: SITL B has no eeprom.bin, so every parameter starts from the defaults files.
    const loadedFresh = !readFileSync(join(workB, "exported.param")).equals(Buffer.alloc(0)) && spawnSync("/bin/ls", [workB], { encoding: "utf8" }).stdout.trim() === "exported.param";
    b = await session([entry.defaultParametersPath, file], workB);
    const loaded = await b.download("SITL B's download");
    await b.close();
    b = null;

    const autopilotOwned = exported.parameters.map(p => p.name).filter(name => metadata.get(name)?.readOnly === true || metadata.get(name)?.volatile === true);
    const loadedValues = new Map(loaded.parameters.map(p => [p.name, p.value]));
    const report = {
      schemaVersion: 1,
      task: "TASK-161",
      recordedAt: new Date().toISOString(),
      host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", node: process.version },
      firmware: { id: entry.id, firmwareVersion: entry.firmwareVersion, commit: entry.commit, binarySha256: entry.binarySha256,
        defaultParametersSha256: entry.defaultParametersSha256 },
      sources: Object.fromEntries(["scripts/check-param-file-sitl.mjs", "packages/autopilot/src/param-file.ts", "packages/autopilot/src/param-service.ts",
        "data/ardupilot/param-metadata.json"].map(path => [path, sha256(readFileSync(join(root, path)))])),
      writes,
      exported,
      file: { lines: fileLines, bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text, "utf8")), text },
      loadedFresh,
      loaded,
      autopilotOwned,
      autopilotOwnedDiffering: autopilotOwned.filter(name => loadedValues.get(name) !== exported.parameters.find(p => p.name === name)?.value),
      wallMs: performance.now() - startedWall,
    };
    const failures = assessParamFileRun(report);
    report.status = failures.length === 0 ? "PASS" : "FAIL";
    report.failures = failures;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
    const compared = exported.parameters.length - autopilotOwned.length;
    console.log(`${report.status}: exported ${exported.parameters.length} parameters (${report.file.bytes} bytes); SITL B listed ${loaded.parameters.length}; ` +
      `${compared} compared, ${autopilotOwned.length} set by the autopilot itself (${report.autopilotOwnedDiffering.length} of them differ: ${report.autopilotOwnedDiffering.join(", ")}); report ${out}`);
    for (const failure of failures) console.log(`  FAIL ${failure}`);
    return failures.length === 0 ? 0 : 1;
  } finally {
    await a?.close();
    await b?.close();
    rmSync(workA, { recursive: true, force: true });
    rmSync(workB, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  if (!process.execArgv.includes("--experimental-transform-types")) {
    // The TypeScript modules use parameter properties, which type stripping alone does not run.
    const child = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", self, ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(child.status ?? 1);
  }
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
