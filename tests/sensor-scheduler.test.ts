import { expect, it } from "vitest";
import { SensorScheduler } from "@mirage/sensors/scheduler";
import { LatencyQueue } from "@mirage/sensors/latency";
it("emits exact rational counts and ending timestamps over 60 seconds", () => {
  for (const hz of [400, 800, 1200] as const)
    for (const rate of [5, 10, 200, 400]) {
      const scheduler = new SensorScheduler(hz, rate),
        time = { lo: 0, hi: 0 };
      let n = 0;
      for (let tick = 0; tick < hz * 60; tick++) if (scheduler.advance()) n++;
      expect(n).toBe(rate * 60);
      scheduler.timeInto(time);
      expect(time).toEqual({ lo: 60000000, hi: 0 });
      scheduler.reset();
      expect(scheduler.advance()).toBe(rate === hz);
    }
});
it("bounds monotonic latency and reports overflow without rewriting old data", () => {
  const q = new LatencyQueue(2),
    out = new Float64Array(2);
  expect(q.push(0, 100, 1)).toBe(true);
  expect(q.push(10, 100, 2)).toBe(true);
  expect(q.push(20, 100, 3)).toBe(false);
  expect(q.dropped).toBe(1);
  expect(q.pollInto(99, out)).toBe(false);
  expect(q.pollInto(100, out)).toBe(true);
  expect(Array.from(out)).toEqual([100, 1]);
  expect(q.pollInto(90, out)).toBe(false);
  expect(q.push(5, 0, 4)).toBe(false);
  expect(q.pollInto(110, out)).toBe(true);
  expect(out[1]).toBe(2);
});
