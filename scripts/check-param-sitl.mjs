#!/usr/bin/env node
// TASK-159 native evidence: the parameter service against an installed stock
// ArduCopter SITL. The firmware comes from a launcher home's catalog
// (TASK-152), rechecked by the launcher's own verification, and runs in its
// own process group with ArduPilot JSON physics in lockstep: this script
// answers every servo packet with the vehicle at rest on the ground, so
// simulated time advances only while it answers. The service's clock is that
// simulated time. The run:
//   1. downloads the complete list and checks its indices independently;
//   2. writes a float gain whose float32 needs five digits (0.00017), a
//      reboot-required parameter, an internal parameter ArduPilot refuses
//      (BARO1_DEVID, AP_PARAM_FLAG_INTERNAL_USE_ONLY), a name not in the
//      list and a fractional value for an integer parameter;
//   3. holds the physics answers for a wall-time pause during a write and
//      checks the write neither times out nor completes while simulated time
//      stands, then completes after the answers resume (TASK-129);
//   4. enables the gripper (GRIP_ENABLE carries AP_PARAM_FLAG_ENABLE), which
//      renumbers the list, and downloads it again;
//   5. checks each confirmed value in the new list, which is read
//      independently of the write path;
//   6. downloads once more while dropping, on its first arrival, every list
//      entry whose index ends in 37 (as lost datagrams), so the list completes
//      only through the service's reads by index, and compares it with step 5.
//
//   node scripts/check-param-sitl.mjs [--home DIR] [--firmware ID] [--out FILE]
//
// --home     launcher home with catalog.json (default MIRAGE_LAUNCHER_HOME, else
//            ~/Library/Application Support/MirageSITL/launcher)
// --firmware catalog entry ID (default: the only entry)
// --out      report path (default test-results/validation/param-sitl.json)
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
/** Physics rate and the vehicle's home (CMAC, ArduPilot's default SITL location). */
const RATE_HZ = 400;
const HOME = [-35.363261, 149.165230, 584, 353];
const GRAVITY_MPS2 = 9.80665;
/** Wall-time limits of each stage, ms. */
const BOOT_DEADLINE_MS = 60_000, STAGE_DEADLINE_MS = 60_000;
/** The wall-time pause of step 3, ms; TASK-129 paused for 60 s, a shorter hold shows the same clock property. */
const PAUSE_MS = 5000;
export const WRITES = [
  { name: "ATC_RAT_RLL_I", value: 0.00017, expect: "confirmed", shown: "0.00017" },
  { name: "SERIAL1_PROTOCOL", value: 1, expect: "confirmed", rebootRequired: true },
  { name: "BARO1_DEVID", value: 1, expect: "refused", by: "autopilot" },
  { name: "MIRAGE_NO_PARAM", value: 1, expect: "refused", by: "service" },
  { name: "FRAME_CLASS", value: 1.5, expect: "refused", by: "service" },
];
const PAUSED_WRITE = { name: "PSC_D_POS_P", value: 1.25 };
const ENABLE_WRITE = { name: "GRIP_ENABLE", value: 1 };
/** Step 6 loses the first arrival of every list entry whose index is congruent to this modulo LOSS_EVERY. */
const LOSS_EVERY = 100, LOSS_AT = 37;

/** Volatile parameters (ArduPilot changes them itself, such as ground pressures) may differ between downloads. */
function isVolatile(report, name) { return (report.metadata?.volatile ?? []).includes(name); }

/**
 * Judges a report independently of the code that produced it. Returns the
 * failures; an empty list is PASS. Exported for tests/integration/param-sitl.test.ts.
 */
export function assessParamRun(report) {
  const failures = [];
  const listCheck = (list, label) => {
    if (!list || list.download?.kind !== "complete") { failures.push(`${label}: the download did not complete`); return; }
    const { total } = list.download;
    const indices = new Set(list.parameters.map(p => p.index));
    const names = new Set(list.parameters.map(p => p.name));
    if (list.parameters.length !== total || indices.size !== total || names.size !== total) failures.push(`${label}: ${list.parameters.length} entries, ${indices.size} indices and ${names.size} names for ${total}`);
    for (let i = 0; i < total; i++) if (!indices.has(i)) { failures.push(`${label}: index ${i} missing`); break; }
    for (const p of list.parameters) if (!(typeof p.value === "number" && Math.fround(p.value) === p.value)) { failures.push(`${label}: ${p.name} is not a float32`); break; }
  };
  listCheck(report.first, "first download");
  listCheck(report.second, "second download");
  for (const expected of WRITES) {
    const outcome = report.writes?.find(w => w.name === expected.name);
    if (!outcome) { failures.push(`${expected.name}: no outcome`); continue; }
    if (outcome.state.kind !== expected.expect) failures.push(`${expected.name}: ${outcome.state.kind}, expected ${expected.expect}`);
    if (expected.by && outcome.state.by !== expected.by) failures.push(`${expected.name}: refused by ${outcome.state.by}, expected ${expected.by}`);
    if (expected.expect === "confirmed") {
      if (outcome.state.value !== Math.fround(expected.value)) failures.push(`${expected.name}: confirmed ${outcome.state.value}, requested float32 ${Math.fround(expected.value)}`);
      const listed = report.second?.parameters.find(p => p.name === expected.name);
      if (listed?.value !== Math.fround(expected.value)) failures.push(`${expected.name}: the second download holds ${listed?.value}`);
      if (expected.rebootRequired !== undefined && outcome.state.rebootRequired !== expected.rebootRequired) failures.push(`${expected.name}: rebootRequired ${outcome.state.rebootRequired}`);
      if (expected.shown !== undefined && outcome.shown !== expected.shown) failures.push(`${expected.name}: shown as ${outcome.shown}, expected ${expected.shown}`);
    }
    if (expected.by === "autopilot") {
      const listed = report.second?.parameters.find(p => p.name === expected.name);
      if (outcome.state.reported !== listed?.value) failures.push(`${expected.name}: refused with ${outcome.state.reported}, the list holds ${listed?.value}`);
    }
  }
  const pause = report.pause;
  if (!pause) failures.push("pause: no record");
  else {
    if (pause.duringPause !== "requested") failures.push(`pause: the write was ${pause.duringPause} while paused`);
    if (!(pause.wallMs >= PAUSE_MS)) failures.push(`pause: held ${pause.wallMs} ms`);
    if (pause.simAdvancedS !== 0) failures.push(`pause: simulated time advanced ${pause.simAdvancedS} s while paused`);
    if (pause.after !== "confirmed") failures.push(`pause: the write ended ${pause.after} after resuming`);
  }
  const renumber = report.renumber;
  if (!renumber || renumber.staleAfterEnable !== true) failures.push("renumber: the completed list was not marked stale");
  else if (!(report.second?.download.total > report.first?.download.total)) failures.push("renumber: the second list is not longer");
  else if (!report.second.parameters.some(p => p.name.startsWith("GRIP_") && p.name !== "GRIP_ENABLE")) failures.push("renumber: no gripper parameter appeared");
  const lossy = report.lossy;
  if (!lossy) failures.push("lossy download: no record");
  else {
    listCheck(lossy, "lossy download");
    if (!(lossy.dropped > 0)) failures.push("lossy download: nothing was dropped");
    if (!(lossy.indexReads >= lossy.dropped)) failures.push(`lossy download: ${lossy.indexReads} index reads for ${lossy.dropped} lost entries`);
    const second = new Map((report.second?.parameters ?? []).map(p => [p.name, p.value]));
    const differing = (lossy.parameters ?? []).filter(p => !isVolatile(report, p.name) && second.get(p.name) !== p.value).map(p => p.name);
    if (lossy.download?.total !== report.second?.download.total || differing.length > 0) failures.push(`lossy download: differs from the second download (${differing.slice(0, 5).join(", ")})`);
  }
  if (!(report.metadata?.covered > 0)) failures.push("metadata: no parameter of the list has metadata");
  return failures;
}

function option(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function run(args) {
  const { readCatalog, verifyEntry } = await import("../apps/launcher/src/catalog.ts");
  const { OwnedProcess } = await import("../apps/launcher/src/processes.ts");
  const { MavParser } = await import("../packages/mavlink/src/codec.ts");
  const { GroundStation } = await import("../packages/autopilot/src/ground-station.ts");
  const { ExternalSitlLockstep, newSitlPhysicsState, MAX_STATE_LINE_BYTES } = await import("../packages/autopilot/src/external-sitl.ts");
  const { ParameterService, formatParameterValue } = await import("../packages/autopilot/src/param-service.ts");
  const { parseParameterMetadata } = await import("../packages/autopilot/src/param-metadata.ts");

  const home = resolve(option(args, "--home") ?? process.env.MIRAGE_LAUNCHER_HOME ?? join(homedir(), "Library", "Application Support", "MirageSITL", "launcher"));
  const out = resolve(option(args, "--out") ?? join(root, "test-results/validation/param-sitl.json"));
  const entries = readCatalog(home);
  const wanted = option(args, "--firmware");
  const entry = wanted ? entries.find(item => item.id === wanted) : entries.length === 1 ? entries[0] : undefined;
  if (!entry) { console.error(`BLOCKED_EXTERNAL: no single installed firmware in ${join(home, "catalog.json")} (install with scripts/install-macos.mjs or pass --firmware)`); return 2; }
  const status = verifyEntry(entry);
  if (!status.usable) { console.error(`BLOCKED_EXTERNAL: firmware ${entry.id} cannot be started: ${status.reason}`); return 2; }
  const metadataBytes = readFileSync(join(root, "data/ardupilot/param-metadata.json"));
  const metadata = parseParameterMetadata(JSON.parse(metadataBytes.toString("utf8"))).forCommit(entry.commit);

  const work = mkdtempSync(join(tmpdir(), "mirage-param-sitl-"));
  const physics = createSocket("udp4"), mavlink = createSocket("udp4");
  physics.bind(0, "127.0.0.1"); mavlink.bind(0, "127.0.0.1");
  await Promise.all([once(physics, "listening"), once(mavlink, "listening")]);
  let sitl = null, sitlEnded = null;
  const startedWall = performance.now();
  try {
    // Lockstep physics: the vehicle at rest, level, on the ground at home.
    const link = new ExternalSitlLockstep({ motorChannels: [1, 2, 3, 4] });
    const state = newSitlPhysicsState(), reply = new Uint8Array(MAX_STATE_LINE_BYTES), motors = new Float64Array(4);
    state.accelBodyMps2[2] = -GRAVITY_MPS2;
    let steps = 0, paused = false;
    const simTime = () => steps / RATE_HZ;
    physics.on("message", (bytes, from) => {
      const disposition = link.receive(bytes);
      if (paused) return;
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
    let sitlAddress = null, heartbeats = 0;
    const send = frame => {
      if (!sitlAddress) return;
      // MAVLink2 message ID bytes 7..9: count reads by index (PARAM_REQUEST_READ, param_index at payload offset 0 >= 0).
      if (losing && frame[7] === 20 && frame[8] === 0 && frame[9] === 0 && (frame[10] | (frame[11] << 8)) < 32768) indexReads++;
      mavlink.send(Buffer.from(frame), sitlAddress.port, sitlAddress.address);
    };
    const service = new ParameterService({ ground, send, metadata });
    /** Step 6: list indices whose first arrival was dropped, and the reads by index sent. */
    let losing = false;
    const lost = new Set();
    let indexReads = 0;
    const parser = new MavParser(frame => {
      if (frame.id === 0 && frame.systemId === 1 && frame.componentId === 1) heartbeats++;
      if (losing && frame.id === 22) {
        const index = frame.view.getUint16(6, true); // PARAM_VALUE.param_index (TASK-150 table offset 6)
        if (index !== 65535 && index % LOSS_EVERY === LOSS_AT && !lost.has(index)) { lost.add(index); return; }
      }
      service.ingest(frame, simTime());
    });
    mavlink.on("message", (bytes, from) => { sitlAddress = { address: from.address, port: from.port }; parser.push(bytes); });

    const args = ["--model", "JSON:127.0.0.1", "--speedup", "100", "--rate", String(RATE_HZ), "--home", HOME.join(","),
      "--sim-port-out", String(physics.address().port), "--serial0", `udpclient:127.0.0.1:${mavlink.address().port}`,
      "--serial1", "none", "--serial2", "none", "--defaults", entry.defaultParametersPath];
    sitl = await OwnedProcess.start({ command: entry.binaryPath, args, cwd: work, run: 1 }, info => { sitlEnded = info; });

    const packet = new Uint8Array(64);
    let lastBeatS = -1;
    /** Ticks the service and a 1 Hz (simulated) GCS heartbeat until `done` or the wall deadline. */
    const until = async (label, done, deadlineMs = STAGE_DEADLINE_MS) => {
      const start = performance.now();
      while (!done()) {
        if (sitlEnded) throw new Error(`SITL ended during ${label}: ${sitlEnded.reason ?? sitlEnded.state}`);
        if (performance.now() - start > deadlineMs) throw new Error(`${label} did not finish within ${deadlineMs} ms of wall time`);
        const now = simTime();
        if (now - lastBeatS >= 1) { lastBeatS = now; const n = ground.heartbeatInto(packet); send(packet.subarray(0, n)); }
        service.tick(now);
        await new Promise(done => setTimeout(done, 2));
      }
    };
    const snapshot = () => ({ download: service.download(), parameters: service.parameters().map(p => ({ ...p })) });

    await until("boot", () => heartbeats > 0, BOOT_DEADLINE_MS);
    const listStartS = simTime(), listStartWall = performance.now();
    service.requestList(simTime());
    await until("the first download", () => ["complete", "failed"].includes(service.download().kind));
    const first = { ...snapshot(), simS: simTime() - listStartS, wallMs: performance.now() - listStartWall };

    const outcomes = [];
    for (const write of WRITES) {
      const started = service.set(write.name, write.value, simTime());
      await until(`the write of ${write.name}`, () => !["requested"].includes(service.write(started.id)?.kind ?? "requested"));
      const final = service.write(started.id);
      outcomes.push({ name: write.name, requested: write.value, state: final,
        shown: final?.kind === "confirmed" ? formatParameterValue(final.value) : null });
    }

    // A write whose answers are held: simulated time stands, so the service neither retries nor times out.
    paused = true;
    const pausedAtS = simTime(), pauseStart = performance.now();
    const held = service.set(PAUSED_WRITE.name, PAUSED_WRITE.value, simTime());
    while (performance.now() - pauseStart < PAUSE_MS) { service.tick(simTime()); await new Promise(done => setTimeout(done, 50)); }
    const duringPause = service.write(held.id)?.kind;
    const pause = { name: PAUSED_WRITE.name, wallMs: performance.now() - pauseStart, simAdvancedS: simTime() - pausedAtS, duringPause };
    paused = false;
    await until("the held write", () => service.write(held.id)?.kind !== "requested");
    pause.after = service.write(held.id)?.kind;

    const enable = service.set(ENABLE_WRITE.name, ENABLE_WRITE.value, simTime());
    await until("the gripper enable", () => service.write(enable.id)?.kind !== "requested");
    const renumber = { write: service.write(enable.id), staleAfterEnable: service.stale };
    const secondStartS = simTime();
    service.requestList(simTime());
    await until("the second download", () => ["complete", "failed"].includes(service.download().kind));
    const second = { ...snapshot(), simS: simTime() - secondStartS };
    renumber.staleAfterDownload = service.stale;

    losing = true;
    const lossyStartS = simTime();
    service.requestList(simTime());
    await until("the lossy download", () => ["complete", "failed"].includes(service.download().kind));
    losing = false;
    const lossy = { ...snapshot(), simS: simTime() - lossyStartS, dropped: lost.size, indexReads };

    const names = first.parameters.map(p => p.name);
    const uncovered = metadata ? names.filter(name => !metadata.get(name)) : names;
    const report = {
      schemaVersion: 1,
      task: "TASK-159",
      recordedAt: new Date().toISOString(),
      host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", node: process.version },
      firmware: { id: entry.id, firmwareVersion: entry.firmwareVersion, commit: entry.commit, binarySha256: entry.binarySha256,
        defaultParametersSha256: entry.defaultParametersSha256 },
      physics: { rateHz: RATE_HZ, model: "at rest on the ground, level, specific force (0, 0, -g)", steps, simS: simTime(), lockstep: link.stats },
      sources: Object.fromEntries(["scripts/check-param-sitl.mjs", "packages/autopilot/src/param-service.ts", "packages/autopilot/src/param-metadata.ts",
        "packages/autopilot/src/ground-station.ts", "data/ardupilot/param-metadata.json"].map(file => [file, sha256(readFileSync(join(root, file)))])),
      metadata: { commit: metadata?.commit ?? null, listed: names.length, covered: names.length - uncovered.length, uncoveredCount: uncovered.length,
        uncovered, volatile: names.filter(name => metadata?.get(name)?.volatile === true) },
      first, writes: outcomes, pause, renumber, second, lossy,
      wallMs: performance.now() - startedWall,
    };
    const failures = assessParamRun(report);
    report.status = failures.length === 0 ? "PASS" : "FAIL";
    report.failures = failures;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
    console.log(`${report.status}: ${first.download.total} parameters in ${first.simS.toFixed(2)} s simulated (${first.wallMs.toFixed(0)} ms wall); ` +
      `writes ${outcomes.map(o => `${o.name}=${o.state?.kind}`).join(", ")}; pause ${pause.duringPause} then ${pause.after}; ` +
      `second list ${second.download.total}; lossy list ${lossy.download.kind} with ${lossy.dropped} lost and ${lossy.indexReads} index reads; metadata covers ${report.metadata.covered}/${names.length}; report ${out}`);
    for (const failure of failures) console.log(`  FAIL ${failure}`);
    return failures.length === 0 ? 0 : 1;
  } finally {
    if (sitl?.running) await sitl.stop();
    physics.close(); mavlink.close();
    rmSync(work, { recursive: true, force: true });
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
