// Allocation instrumentation for the actual protocol/EW kernels. I/O and observers are outside step.
//   node scripts/bench-links-ew.mjs [all|ew|mavlink|state] [400|800|1200] [--out DIR]
// writes DIR/links-ew-<component>-<Hz>.json (default DIR: test-results/bench).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import v8 from "node:v8";
import { outputDirectory } from "./validation/evidence.mjs";
if (!globalThis.gc) {
  const p = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--max-semi-space-size=64",
      "--single-threaded",
      "--experimental-transform-types",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(p.status ?? 1);
}
const { HazardVolumes } = await import("../packages/ew/src/volumes.ts");
const { GnssJamming } = await import("../packages/ew/src/gnss-jamming.ts");
const { MagneticAnomaly } = await import("../packages/ew/src/magnetic.ts");
const { MotorFaults } = await import("../packages/physics/src/motor-fault.ts");
const { MavParser, encodeInto } = await import(
  "../packages/mavlink/src/codec.ts"
);
const { SensorMapping } = await import(
  "../packages/mavlink/src/sensor-mapping.ts"
);
const { RcOverride, PilotRcMapper } = await import(
  "../packages/mavlink/src/rc-override.ts"
);
const { AutopilotSession } = await import(
  "../packages/autopilot/src/state-machine.ts"
);
const component = process.argv[2] ?? "all";
const hz = Number(process.argv[3] ?? 400);
if (![400, 800, 1200].includes(hz)) throw new Error("Invalid probe Hz");
const directory = outputDirectory("test-results/bench");
const dt = 1 / hz;
const { newPilotInputV2, ControlFlag } = await import(
  "../packages/protocol/src/index.ts"
);
const pilot = newPilotInputV2();
pilot.flags = ControlFlag.Connected;
pilot.roll = 0.2;
pilot.pitch = 0.3;
pilot.yaw = 0.4;
pilot.throttle = 0.5;
pilot.calibratedModeSlot = 5;
const rcMapper = new PilotRcMapper();
if (!["all", "ew", "mavlink", "state"].includes(component))
  throw new Error("Invalid probe component");
const hazard = new HazardVolumes(
  [
    {
      id: 1,
      shape: "sphere",
      centerNedM: [0, 0, 0],
      radiusM: 100,
      power: 10,
      referenceM: 10,
      minimumM: 1,
    },
    {
      id: 2,
      shape: "cone",
      centerNedM: [5, 0, 0],
      radiusM: 100,
      power: 1,
      referenceM: 10,
      minimumM: 1,
      axisNed: [1, 0, 0],
      halfAngleRad: 0.5,
    },
  ],
  0,
  10,
);
const jam = new GnssJamming(0.1),
  mag = new MagneticAnomaly([0.1, 0.2, 0.3], [0.01, 0.01, 0.01]),
  fault = new MotorFaults([3, 7]);
fault.set(3, "power-cut", 0.5);
fault.set(7, "instant-thrust-loss", 0.2);
const source = {
    timeLoUs: 1,
    timeHiUs: 0,
    latitudeRad: 0.1,
    longitudeRad: 0.1,
    altitudeMslM: 100.1,
    vnMps: 0.1,
    veMps: 0.1,
    vdMps: 0.1,
    hdop: 1.1,
    vdop: 1.2,
    hdopValid: true,
    vdopValid: true,
    fixType: 3,
    satellites: 14,
    satellitesValid: true,
    velocityValid: true,
    courseRad: 0.1,
    courseValid: true,
  },
  target = { ...source };
const imu = {
  timeLoUs: 1,
  timeHiUs: 0,
  specificForceBodyMps2: new Float64Array([0, 0, -9.80665]),
  gyroBodyRadS: new Float64Array([0.1, 0.2, 0.3]),
  magBodyGauss: new Float64Array([0.2, 0.1, 0.4]),
  pressurePa: 101325,
  differentialPressurePa: 12,
  pressureAltitudeM: 100,
  temperatureK: 293.15,
  updatedMask: 8191,
};
const baselineTorque = new Float64Array(1);
const severityOut = new Float64Array(1),
  torqueOut = new Float64Array(1);
const magnetic = new Float64Array([0.2, 0.1, 0.4]),
  distorted = new Float64Array(3),
  wrench = new Float64Array([0, 0, -1, 0, 0, 0.1]),
  outWrench = new Float64Array(6),
  mapping = new SensorMapping(),
  wire = new Uint8Array(280),
  rc = new RcOverride();
const messages = await import("../packages/mavlink/src/messages.ts");
const { actuatorInto } = messages;
// TASK-150: the high-rate telemetry subset, packed once (cold) and decoded every tick into preallocated targets.
const { definition: layoutOf } = await import("../packages/mavlink/src/codec.ts");
const { HIGH_RATE_MESSAGES } = await import("../packages/mavlink/src/message-table.ts");
const telemetry = {
  1: { target: messages.newSysStatus(), decode: messages.sysStatusInto,
    values: { onboard_control_sensors_health: 0x2fffff, load: 312, voltage_battery: 16180, current_battery: 1234, battery_remaining: 87,
      errors_count1: 1, errors_count4: 4, onboard_control_sensors_health_extended: 1 } },
  30: { target: messages.newAttitude(), decode: messages.attitudeInto,
    values: { time_boot_ms: 123456, roll: 0.05, pitch: -0.02, yaw: 1.5, rollspeed: 0.01, pitchspeed: -0.01, yawspeed: 0.2 } },
  32: { target: messages.newLocalPositionNed(), decode: messages.localPositionNedInto,
    values: { time_boot_ms: 123456, x: 12.5, y: -3.25, z: -20, vx: 4, vy: -1, vz: 0.5 } },
  33: { target: messages.newGlobalPositionInt(), decode: messages.globalPositionIntInto,
    values: { time_boot_ms: 123456, lat: -353632621, lon: 1491652374, alt: 604000, relative_alt: 20000, vx: 400, vy: -100, vz: 50, hdg: 9000 } },
  36: { target: messages.newServoOutputRaw(), decode: messages.servoOutputRawInto,
    values: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`servo${i + 1}_raw`, 1100 + 50 * i])) },
  74: { target: messages.newVfrHud(), decode: messages.vfrHudInto,
    values: { airspeed: 4.1, groundspeed: 4.0, heading: 90, throttle: 48, alt: 604, climb: 0.5 } },
  147: { target: messages.newBatteryStatus(), decode: messages.batteryStatusInto,
    values: { id: 0, voltages: [4045, 4046, 4044, 4047, 65535, 65535, 65535, 65535, 65535, 65535], current_battery: 1234, current_consumed: 250,
      energy_consumed: 1800, battery_remaining: 87, voltages_ext: [0, 0, 0, 0] } },
};
const telemetryIds = Int32Array.from(HIGH_RATE_MESSAGES);
const telemetryPayloads = new Map();
for (const id of telemetryIds) {
  const entry = telemetry[id];
  if (!entry) throw new Error(`No probe for high-rate message ${id}`);
  const payload = new Uint8Array(layoutOf(id).length);
  if (!messages.packInto(id, entry.values, payload)) throw new Error(`Invalid probe payload ${id}`);
  telemetryPayloads.set(id, payload);
}
const telemetryPayloadList = Array.from(telemetryIds, (id) => telemetryPayloads.get(id));
const telemetryEntries = Array.from(telemetryIds, (id) => telemetry[id]);
let decoded = 0;
const actuatorPayload = new Uint8Array(81),
  actuatorView = new DataView(actuatorPayload.buffer),
  decodedActuators = {
    timeLoUs: 0,
    timeHiUs: 0,
    flagsLo: 0,
    flagsHi: 0,
    mode: 0,
    controls: new Float64Array(16),
  };
actuatorView.setUint32(0, 0xabcdef01, true);
actuatorView.setUint32(4, 0x12345678, true);
for (let i = 0; i < 16; i++) actuatorView.setFloat32(16 + i * 4, i / 16, true);
actuatorView.setUint8(80, 128);
let received = 0;
const parser = new MavParser((frame) => {
  received++;
  if (frame.id === 93 && !actuatorInto(frame, decodedActuators))
    throw new Error("Invalid actuator decode");
  for (let k = 0; k < telemetryEntries.length; k++) {
    const entry = telemetryEntries[k];
    if (entry.decode(frame, entry.target)) decoded++;
  }
});
const ap = new AutopilotSession(),
  health = {
    epoch: 1,
    sampleTimeMs: 0.1,
    ekfHealthy: true,
    linkHealthy: true,
    source: "autopilot",
  },
  controls = new Float64Array(16).fill(0.2);
ap.connect("external-sitl", 1, 0);
ap.initialized();
let tick = 0;
const clock = new Float64Array(1);
const checksum = new Float64Array(1),
  position = new Float64Array([0, 1, 1]);
function run(n) {
  for (let i = 0; i < n; i++) {
    tick++;
    if (component === "ew" || component === "all") {
      position[0] = (tick % 4000) * 0.01;
      baselineTorque[0] = (tick % 1000) * 0.01;
      if (
        !hazard.severityFromNedInto(position, severityOut) ||
        !fault.driveTorqueFromArrayInto(3, baselineTorque, torqueOut)
      )
        throw new Error("Invalid exposure/fault");
      if (
        !jam.advanceInto(severityOut, dt) ||
        !jam.distortInto(source, target) ||
        !mag.distortInto(magnetic, distorted) ||
        !fault.wrenchInto(7, wrench, outWrench)
      )
        throw new Error("Invalid EW probe step");
      checksum[0] += target.hdop + distorted[0] + outWrench[2] + torqueOut[0];
    }
    if (component === "mavlink" || component === "all") {
      source.timeLoUs = Math.floor((tick * 1000000) / hz) >>> 0;
      source.timeHiUs = Math.floor((tick * 1000000) / hz / 4294967296) >>> 0;
      if (
        !mapping.gpsInto(source) ||
        !mapping.sensorInto(imu) ||
        !rcMapper.mapInto(pilot) ||
        !rc.into(rcMapper.channels, 1, 1)
      )
        throw new Error("Invalid MAVLink mapping");
      const seq = tick & 255,
        index = tick & 3,
        id = index === 0 ? 113 : index === 1 ? 107 : index === 2 ? 70 : 93,
        payload =
          index === 0
            ? mapping.gps
            : index === 1
              ? mapping.sensor
              : index === 2
                ? rc.payload
                : actuatorPayload,
        len = encodeInto(id, payload, seq, 42, 7, wire);
      for (let b = 0; b < len; b++) parser.pushByte(wire[b]);
      // TASK-150: one high-rate telemetry frame per tick, parsed and decoded.
      const t = tick % telemetryIds.length,
        telemetryLength = encodeInto(telemetryIds[t], telemetryPayloadList[t], seq, 1, 1, wire);
      for (let b = 0; b < telemetryLength; b++) parser.pushByte(wire[b]);
      checksum[0] += mapping.gps[24] + rc.payload[0];
    }
    if (component === "state" || component === "all") advanceAutopilot(tick);
  }
}
function advanceAutopilot(tick) {
  clock[0] = (tick * 1000) / hz;
  const now = clock[0];
  health.sampleTimeMs = now;
  if (
    !ap.healthAt(health, clock) ||
    !ap.acceptActuatorsAt(controls, 1, clock, clock) ||
    !ap.pollAt(clock)
  )
    throw new Error("Invalid lifecycle step");
}
// Expose a byte-at-a-time parser entry to avoid allocating subarray views in the hot path.
const events = [],
  sink = { value: null },
  observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) events.push(e.startTime);
  });
observer.observe({ entryTypes: ["gc"] });
const settle = () => new Promise((done) => setTimeout(done, 50));
const young = () =>
  v8.getHeapSpaceStatistics().find((s) => s.space_name === "new_space")
    .space_used_size;
async function measure(body, steps) {
  body(steps);
  globalThis.gc();
  await settle();
  const before = young(),
    start = performance.now();
  body(steps);
  const end = performance.now(),
    bytes = young() - before;
  await settle();
  return {
    steps,
    bytes,
    gcEvents: events.filter((t) => t >= start && t <= end).length,
  };
}
run(4000000);
const samples = [];
for (let i = 0; i < 3; i++) {
  samples.push(await measure(run, 1000000), await measure(run, 2000000));
}
const control = await measure((n) => {
  for (let i = 0; i < n; i++) sink.value = { i };
}, 2000000);
const short = Math.min(
    ...samples.filter((s) => s.steps === 1000000).map((s) => s.bytes),
  ),
  long = Math.min(
    ...samples.filter((s) => s.steps === 2000000).map((s) => s.bytes),
  ),
  bytesPerStep = Math.max(0, long - short) / 1000000;
const files = [
  "packages/ew/src/volumes.ts",
  "packages/ew/src/gnss-jamming.ts",
  "packages/ew/src/magnetic.ts",
  "packages/physics/src/motor-fault.ts",
  "packages/mavlink/src/codec.ts",
  "packages/mavlink/src/messages.ts",
  "packages/mavlink/src/message-table.ts",
  "packages/mavlink/src/samples.ts",
  "packages/mavlink/src/sensor-mapping.ts",
  "packages/mavlink/src/rc-override.ts",
  "packages/autopilot/src/state-machine.ts",
  "scripts/bench-links-ew.mjs",
];
const report = {
  schemaVersion: 1,
  component,
  hz,
  warmupSteps: 4000000,
  method:
    "warmed V8 N/2N new-space windows and GC observation; allocating positive control; I/O excluded",
  node: process.version,
  samples,
  bytesPerStep,
  zeroAllocation: samples.every((s) => s.gcEvents === 0) && bytesPerStep < 0.01,
  controlDetected: control.gcEvents > 0 || control.bytes > 1000000,
  positiveControl: control,
  received,
  decodedTelemetry: decoded,
  highRateMessages: Array.from(telemetryIds),
  checksum: checksum[0],
  sourceSha256: Object.fromEntries(
    files.map((f) => [
      f,
      createHash("sha256").update(readFileSync(f)).digest("hex"),
    ]),
  ),
};
mkdirSync(directory, { recursive: true });
writeFileSync(
  `${directory}/links-ew-${component}-${hz}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
observer.disconnect();
if (!report.zeroAllocation || !report.controlDetected) process.exitCode = 1;
