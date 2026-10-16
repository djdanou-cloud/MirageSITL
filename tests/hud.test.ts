import { expect, test } from "vitest";
import { newFlightStateV2, VehicleFlagV2 } from "@mirage/protocol";
import { attitudeFromQuaternion } from "../apps/web/src/hud/attitude";
import { hudTelemetry } from "../apps/web/src/hud/telemetry";
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
