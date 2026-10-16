import { expect, it } from "vitest";
import { SensorNoise } from "@mirage/sensors/noise";
const input = new Float64Array(1),
  output = new Float64Array(1);
function draw(noise: SensorNoise, value = 0): number {
  input[0] = value;
  if (!noise.sampleInto(input, output)) throw new Error("Invalid noise input");
  return output[0]!;
}
it("reproduces reset, separates streams, and matches Gaussian RMS/lag statistics", () => {
  const noise = new SensorNoise(123, 7, 400, 2, 20),
    control = new SensorNoise(123, 7, 400, 2, 20),
    other = new SensorNoise(123, 8, 400, 2, 20);
  const first = draw(noise);
  expect(first).toBe(draw(control));
  expect(first).not.toBe(draw(other));
  noise.reset(123);
  expect(draw(noise)).toBe(first);
  for (let i = 0; i < 2000; i++) draw(noise);
  let sum = 0,
    sq = 0,
    cross = 0,
    prev = draw(noise);
  const n = 1000000;
  for (let i = 0; i < n; i++) {
    const x = draw(noise);
    sum += x;
    sq += x * x;
    cross += x * prev;
    prev = x;
  }
  const mean = sum / n,
    variance = sq / n - mean * mean;
  expect(Math.abs(mean)).toBeLessThan(0.03);
  expect(Math.abs(variance - 4)).toBeLessThan(0.08);
  expect(
    Math.abs(
      (cross / n - mean * mean) / variance -
        Math.exp((-2 * Math.PI * 20) / 400),
    ),
  ).toBeLessThan(0.01);
});
it("bias random walk replays independently and zero noise stays exact", () => {
  const zero = new SensorNoise(0, 0, 400, 0, 20);
  expect(draw(zero, 12)).toBe(12);
  const a = new SensorNoise(1, 1, 400, 0, 20, 0.1),
    b = new SensorNoise(1, 1, 400, 0, 20, 0.1);
  for (let i = 0; i < 1000; i++) expect(draw(a)).toBe(draw(b));
  expect(() => new SensorNoise(1, 1, 400, 1, 200)).toThrow();
});
