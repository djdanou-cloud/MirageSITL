import { expect, test } from "vitest";
import { MavParser } from "@mirage/mavlink/codec";
import { EkfMonitor } from "../packages/autopilot/src/ekf-status";
import { EkfWarmup } from "../packages/autopilot/src/warmup";
import golden from "./fixtures/mavlink/ekf-golden.json";
function monitor(time = 30000) {
  const m = new EkfMonitor(1, 1, 2),
    p = new MavParser((f) => {
      m.ingest(f, time);
    });
  for (const f of golden.frames)
    p.push(Uint8Array.from(Buffer.from(f.hex, "hex")));
  return m;
}
test("official ArduPilot EKF and heartbeat frames map absolute flags and mode", () => {
  const m = monitor();
  expect(m.snapshot(30000)).toMatchObject({
    flags: 31,
    mode: 5,
    healthy: true,
    ageMs: 0,
  });
  expect(m.snapshot(31001).healthy).toBe(false);
  expect(m.snapshot(29999).healthy).toBe(false);
  const wrong = new EkfMonitor(2, 1, 2),
    p = new MavParser((f) => {
      expect(wrong.ingest(f, 0)).toBe(false);
    });
  for (const f of golden.frames)
    p.push(Uint8Array.from(Buffer.from(f.hex, "hex")));
  expect(wrong.snapshot(0).healthy).toBe(false);
});
test("30 seconds alone never admits readiness; sensor coherence, health, epoch and HITL clock enforced", () => {
  const w = new EkfWarmup("external-sitl", 2, 0, 0, 10),
    h = monitor().snapshot(30000);
  const s = {
    epoch: 2,
    simTimeS: 30,
    wallTimeMs: 3000,
    imuTimeS: 30,
    gpsTimeS: 30,
    health: h,
  };
  expect(
    w.observe({
      ...s,
      simTimeS: 29,
      imuTimeS: 29,
      gpsTimeS: 29,
      wallTimeMs: 2900,
    }),
  ).toBe(false);
  expect(w.observe({ ...s, health: { ...h, healthy: false } })).toBe(false);
  expect(w.ewAllowed).toBe(false);
  expect(w.observe({ ...s, imuTimeS: 29 })).toBe(false);
  expect(w.observe({ ...s, epoch: 3 })).toBe(false);
  expect(w.observe(s)).toBe(true);
  expect(w.accelerationFactor).toBe(10);
  expect(w.ewAllowed).toBe(true);
  expect(w.observe({ ...s, health: { ...h, innovationHealthy: false } })).toBe(
    false,
  );
  expect(w.ready).toBe(false);
  expect(() => new EkfWarmup("hitl", 1, 0, 0, 10)).toThrow();
});
test("failed innovation diagnostics and initializing flags cannot be normalized to healthy", () => {
  const m = new EkfMonitor(1, 1, 2),
    p = new MavParser((f) => {
      if (f.id === 193) {
        f.view.setFloat32(0, 1, true);
        f.view.setUint16(20, 55 | 1024, true);
      }
      m.ingest(f, 30);
    });
  for (const f of golden.frames)
    p.push(Uint8Array.from(Buffer.from(f.hex, "hex")));
  expect(m.snapshot(30)).toMatchObject({
    flags: 31,
    healthy: false,
    innovationHealthy: false,
  });
});
