import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ExternalSitlLockstep, newSitlPhysicsState, MAX_STATE_LINE_BYTES } from "../packages/autopilot/src/external-sitl.ts";
/**
 * Version 2 proposal TASK-051: Hybrid SITL JSON lockstep prototype on this computer.
 * No serial port is opened and no flight controller is required.
 * Simulation-on-Hardware remains a later recorded bench.
 */
const RATE_HZ = 400;
const DURATION_S = 60;
const FRAMES = RATE_HZ * DURATION_S;
const STEP_US = 1000000 / RATE_HZ;
function servoPacket(frameCount) {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 18458, true);
  view.setUint16(2, RATE_HZ, true);
  view.setUint32(4, frameCount, true);
  for (let channel = 0; channel < 16; channel++) view.setUint16(8 + channel * 2, 1000, true);
  return bytes;
}
const lockstep = new ExternalSitlLockstep({ motorChannels: [1, 2, 3, 4] });
const state = newSitlPhysicsState();
state.accelBodyMps2[2] = -9.80665;
const actuators = new Float64Array(4);
const reply = new Uint8Array(MAX_STATE_LINE_BYTES);
const frames = [];
for (let i = 0; i < FRAMES; i++) {
  const started = performance.now();
  const disposition = lockstep.receive(servoPacket(i));
  if (disposition !== "step" || !lockstep.consumeActuatorsInto(actuators)) throw new Error(`Frame ${i} was not a single lockstep`);
  state.timestampS = (i + 1) / RATE_HZ;
  if (lockstep.completeStepInto(state, reply) <= 0) throw new Error(`Frame ${i} produced no JSON reply`);
  const computeUs = (performance.now() - started) * 1000;
  frames.push({ sequence: i, scheduledUs: i * STEP_US, sentUs: i * STEP_US + computeUs });
}
if (lockstep.stats.steps !== FRAMES || lockstep.stats.gaps !== 0 || lockstep.stats.invalid !== 0) {
  throw new Error(`Lockstep stats steps=${lockstep.stats.steps} gaps=${lockstep.stats.gaps} invalid=${lockstep.stats.invalid}`);
}
const trace = {
  schemaVersion: 2,
  provenance: {
    source: "virtual-sitl",
    operator: "virtual-no-drone",
    recordedAt: new Date().toISOString(),
    firmwareSha256: createHash("sha256").update("ardupilot-json-protocol-8ab6afde107a91df1b5f60ade8f333cb8a61b190").digest("hex"),
    modelSha256: createHash("sha256").update("virtual-hover-no-airframe").digest("hex"),
  },
  board: "none",
  mode: "hybrid-sitl",
  execution: "virtual",
  firmware: { stack: "ardupilot", major: 0, minor: 0, patch: 0, gitShort: "8ab6afde" },
  durationS: DURATION_S,
  observation: {
    placement: "pc",
    vehicle: "copter",
    jsonMagic: 18458,
    pwmChannels: 16,
    simRateHz: RATE_HZ,
    udpPort: 9002,
    frames,
    propsRemoved: true,
  },
  unplug: { tUs: Math.ceil(frames[frames.length - 1].sentUs) + 1, linkLost: true, actuatorsDisabled: true },
};
const bytes = Buffer.from(JSON.stringify(trace));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "mirage-virtual-hitl-"));
const input = join(directory, "trace.json");
writeFileSync(input, bytes);
const child = spawnSync(process.execPath, ["scripts/bench-hitl.mjs", "--input", input, "--sha256", sha256], { encoding: "utf8" });
process.stdout.write(child.stdout ?? "");
process.stderr.write(child.stderr ?? "");
if (child.status !== 0) process.exit(child.status ?? 1);
