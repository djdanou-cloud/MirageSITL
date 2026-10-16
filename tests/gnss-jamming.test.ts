import { expect, it } from "vitest";
import { GnssJamming } from "../packages/ew/src/gnss-jamming";
import { gpsSample } from "./sensor-samples";
it("preserves the baseline at zero, applies the exact low-pass severity, and respects recovery hysteresis", () => {
  const j = new GnssJamming(1),
    s = gpsSample(),
    t = gpsSample(),
    copy = { ...s };
  expect(j.distortInto(s, t)).toBe(true);
  expect(t).toEqual(s);
  for (let i = 0; i < 400; i++) expect(j.advance(1, 1 / 400)).toBe(true);
  j.distortInto(s, t);
  expect(t.hdop).toBeCloseTo(1.2 + (99 - 1.2) * (1 - Math.exp(-1)), 10);
  expect(t.fixType).toBe(3);
  for (let i = 0; i < 400; i++) j.advance(1, 1 / 400);
  j.distortInto(s, t);
  expect(t.fixType).toBe(0);
  for (let i = 0; i < 100; i++) j.advance(0, 1 / 400);
  j.distortInto(s, t);
  expect(t.fixType).toBe(0);
  for (let i = 0; i < 100; i++) j.advance(0, 1 / 400);
  j.distortInto(s, t);
  expect(t.fixType).toBe(3);
  expect(s).toEqual(copy);
  j.reset();
  j.distortInto(s, t);
  expect(t).toEqual(s);
  expect(j.distortInto(s, s)).toBe(false);
  expect(j.advance(NaN, 0.0025)).toBe(false);
});
it("never improves a degraded/no-fix or unknown baseline", () => {
  const j = new GnssJamming(0.01);
  for (let i = 0; i < 400; i++) j.advance(1, 1 / 400);
  const s = gpsSample(),
    t = gpsSample();
  s.hdop = 120;
  s.vdop = 130;
  s.fixType = 0;
  s.satellites = 0;
  j.distortInto(s, t);
  expect(t.hdop).toBe(120);
  expect(t.vdop).toBe(130);
  expect(t.fixType).toBe(0);
  expect(t.satellites).toBe(0);
  s.hdopValid = s.vdopValid = s.satellitesValid = false;
  j.distortInto(s, t);
  expect(t.hdopValid).toBe(false);
  expect(t.satellitesValid).toBe(false);
});
it("does not infer satellite recovery from an unknown satellite count", () => {
  const j = new GnssJamming(0.01),
    s = gpsSample(),
    t = gpsSample();
  for (let i = 0; i < 100; i++) j.advance(1, 0.0025);
  j.distortInto(s, t);
  expect(t.fixType).toBe(0);
  s.satellitesValid = false;
  s.satellites = 255;
  for (let i = 0; i < 100; i++) j.advance(0, 0.0025);
  j.distortInto(s, t);
  expect(t.fixType).toBe(0);
  expect(t.satellitesValid).toBe(false);
  s.satellitesValid = true;
  s.satellites = 14;
  j.distortInto(s, t);
  expect(t.fixType).toBe(3);
});
