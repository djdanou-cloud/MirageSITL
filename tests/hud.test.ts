import { expect, test } from "vitest";
import { newFlightStateV2, UNKNOWN_U32, VehicleFlagV2 } from "@mirage/protocol";
import { MavParser } from "@mirage/mavlink/codec";
import { EkfMonitor } from "../packages/autopilot/src/ekf-status";
import { attitudeFromQuaternion } from "../apps/web/src/hud/attitude";
import {
  applyAutopilotTelemetry,
  hudTelemetry,
} from "../apps/web/src/hud/telemetry";
import golden from "./fixtures/mavlink/ekf-golden.json";
test("NED aerospace horizon signs, q/-q equivalence and singularity bounds", () => {
  const c = Math.cos(Math.PI / 8),
    s = Math.sin(Math.PI / 8);
  expect(attitudeFromQuaternion(c, s, 0, 0)?.rollRad).toBeCloseTo(
    Math.PI / 4,
    12,
  );
  expect(attitudeFromQuaternion(c, 0, s, 0)?.pitchRad).toBeCloseTo(
    Math.PI / 4,
    12,
  );
  expect(attitudeFromQuaternion(c, 0, 0, s)?.yawRad).toBeCloseTo(
    Math.PI / 4,
    12,
  );
  expect(attitudeFromQuaternion(-c, -s, 0, 0)).toEqual(
    attitudeFromQuaternion(c, s, 0, 0),
  );
  expect(attitudeFromQuaternion(0, 0, 0, 0)).toBeNull();
});
test("demo cannot fabricate EKF and AP age/freshness is explicit", () => {
  const s = newFlightStateV2();
  s.ekfFlags = 31;
  expect(hudTelemetry(s)).toMatchObject({
    status: "unknown",
    ekfFlags: null,
    source: "demo-truth",
  });
  s.vehicleFlags |= VehicleFlagV2.AutopilotStatusValid;
  s.autopilotHealth = 7;
  s.autopilotMode = 5;
  s.autopilotStatusAgeMs = 200;
  expect(hudTelemetry(s)).toMatchObject({
    status: "fresh",
    ekfFlags: 31,
    mode: "AP MODE 5",
  });
  expect(hudTelemetry(s, 1000)).toMatchObject({
    status: "stale",
    ekfFlags: null,
    ageMs: 1200,
  });
});
test("live EkfMonitor frames drive HUD freshness, degraded/valid EKF, failed-innovation rejection, and staleness", () => {
  const s = newFlightStateV2();
  s.epoch = 2;
  const mon = new EkfMonitor(1, 1, 2);
  // Before any frame is ingested, state remains demo-truth / unknown.
  applyAutopilotTelemetry(s, mon.snapshot(100), UNKNOWN_U32);
  expect(hudTelemetry(s)).toMatchObject({
    source: "demo-truth",
    status: "unknown",
    ekfFlags: null,
  });

  // Ingest only HEARTBEAT (id=0): autopilot mode is known, but EKF report is still missing -> stale.
  const hbBytes = Uint8Array.from(Buffer.from(golden.frames[0]!.hex, "hex"));
  const ekfBytes = Uint8Array.from(Buffer.from(golden.frames[1]!.hex, "hex"));
  let lastMode = UNKNOWN_U32;
  const parser = new MavParser((f) => {
    if (mon.ingest(f, 1000) && f.id === 0) lastMode = f.view.getUint32(0, true);
  });
  parser.push(hbBytes);
  applyAutopilotTelemetry(s, mon.snapshot(1050), lastMode);
  expect(hudTelemetry(s)).toMatchObject({
    source: "autopilot",
    status: "stale",
    mode: "AP MODE 5",
    ekfFlags: null,
    ageMs: null,
  });

  // Ingest official EKF_STATUS_REPORT (id=193, flags=31, healthy innovations): fresh & valid.
  parser.push(ekfBytes);
  applyAutopilotTelemetry(s, mon.snapshot(1150), lastMode);
  expect(hudTelemetry(s)).toMatchObject({
    source: "autopilot",
    status: "fresh",
    mode: "AP MODE 5",
    ekfFlags: 31,
    ageMs: 150,
  });

  // Silence beyond 1000 ms marks HUD stale and clears ekfFlags while preserving last known mode.
  applyAutopilotTelemetry(s, mon.snapshot(2001), lastMode);
  expect(hudTelemetry(s)).toMatchObject({
    source: "autopilot",
    status: "stale",
    mode: "AP MODE 5",
    ekfFlags: null,
    ageMs: 1001,
  });

  // Degraded EKF flags (e.g. USB FC without GPS: raw flags 167 -> mapped flags 23 != 31) report fresh but degraded.
  const degradedParser = new MavParser((f) => {
    if (f.id === 193) f.view.setUint16(20, 167, true);
    mon.ingest(f, 2500);
  });
  degradedParser.push(hbBytes);
  degradedParser.push(ekfBytes);
  applyAutopilotTelemetry(s, mon.snapshot(2600), lastMode);
  expect(hudTelemetry(s)).toMatchObject({
    source: "autopilot",
    status: "fresh",
    mode: "AP MODE 5",
    ekfFlags: 23,
    ageMs: 100,
  });

  // Failed innovation ratio (>= 1.0) or EKF_UNINITIALIZED (1024) never reports ekfFlags === 31.
  const badInnovParser = new MavParser((f) => {
    if (f.id === 193) {
      f.view.setFloat32(0, 1.0, true);
      f.view.setUint16(20, 55 | 1024, true);
    }
    mon.ingest(f, 3000);
  });
  badInnovParser.push(hbBytes);
  badInnovParser.push(ekfBytes);
  applyAutopilotTelemetry(s, mon.snapshot(3050), lastMode);
  expect(hudTelemetry(s)).toMatchObject({
    source: "autopilot",
    status: "fresh",
    ekfFlags: 0,
    ageMs: 50,
  });

  // Epoch mismatch clears AutopilotStatusValid back to demo-truth.
  s.epoch = 3;
  applyAutopilotTelemetry(s, mon.snapshot(3050), lastMode);
  expect(hudTelemetry(s)).toMatchObject({
    source: "demo-truth",
    status: "unknown",
    ekfFlags: null,
  });
});
