import { expect, it } from "vitest";
import { FrameLayout } from "../packages/physics/src/frame";
import quad from "./fixtures/models/demo-quad.json";
import octo from "./fixtures/models/tilted-octo.json";
it("sums stable-ID transmitted moments once and preserves output on invalid input", () => {
  const layout = new FrameLayout(quad),
    hub = new Float64Array(24),
    out = new Float64Array(6);
  for (let i = 0; i < 4; i++) {
    hub[i * 6 + 2] = 1;
    hub[i * 6 + 5] = i % 2 === 0 ? 0.1 : -0.1;
  }
  expect(layout.sumInto(hub, out)).toBe(true);
  expect(Array.from(out)).toEqual([0, 0, -4, 0, 0, 0]);
  const before = out.slice();
  hub[0] = NaN;
  expect(layout.sumInto(hub, out)).toBe(false);
  expect(out).toEqual(before);
});

it("rotates tilted octo thrust into lateral force without duplicate reactions", () => {
  const frame = new FrameLayout(octo),
    hub = new Float64Array(48),
    out = new Float64Array(6);
  for (let i = 0; i < 8; i++) hub[i * 6 + 2] = 1;
  expect(frame.sumInto(hub, out)).toBe(true);
  expect(out[0]).toBeCloseTo(4 * Math.SQRT2, 12);
  expect(out[2]).toBeCloseTo(4 * Math.SQRT2, 12);
  for (let i = 3; i < 6; i++) expect(out[i]).toBeCloseTo(0, 12);
});
