import { expect, test } from "vitest";
import { ThermalNuc } from "../packages/thermal/src/nuc";
test("fixed shutter duration, bias removal, held display and monotone sensor time", () => {
  const c = {
    pixels: 2,
    frameHz: 30,
    intervalFrames: 30,
    closedFrames: 2,
    calibrationFrames: 3,
    openFrames: 1,
  };
  const n = new ThermalNuc(c);
  const raw = new Float32Array([301, 298]);
  n.update(0, raw, 300);
  expect(Array.from(n.output)).toEqual([301, 298]);
  n.request();
  const states = [];
  for (let i = 1; i <= 6; i++) {
    expect(n.update(i, raw, 300)).toBe(true);
    states.push(n.status.state);
    expect(n.status.sensorTimeS).toBe(i / 30);
    expect(Array.from(n.output)).toEqual([301, 298]);
  }
  expect(states).toEqual([
    "closed",
    "closed",
    "calibrating",
    "calibrating",
    "calibrating",
    "open",
  ]);
  raw.set([321, 318]);
  n.update(7, raw, 300);
  expect(Array.from(n.output)).toEqual([320, 320]);
  expect(n.status.cycles).toBe(1);
  expect(n.update(7, raw, 300)).toBe(false);
  expect(n.update(9, raw, 300)).toBe(false);
  expect(n.status.frameId).toBe(7);
});
test("equal frame streams reproduce calibration; malformed frames leave output unchanged", () => {
  const c = {
    pixels: 1,
    frameHz: 60,
    intervalFrames: 10,
    closedFrames: 1,
    calibrationFrames: 2,
    openFrames: 1,
  };
  const a = new ThermalNuc(c),
    b = new ThermalNuc(c),
    raw = new Float32Array([303]);
  for (let i = 0; i < 100; i++) {
    a.update(i, raw, 300);
    b.update(i, raw, 300);
    expect(a.status).toEqual(b.status);
    expect(a.output).toEqual(b.output);
  }
  expect(a.status.cycles).toBe(9);
  expect(a.update(100, new Float32Array([NaN]), 300)).toBe(false);
  expect(a.status.frameId).toBe(99);
});
