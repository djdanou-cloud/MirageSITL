import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";

interface Harness {
  memory: WebAssembly.Memory;
  evaluate(kind: number, x: number, rate: number, count: number): number;
}
const modules: Harness[] = [];
function numericExport(value: unknown): value is (...args: number[]) => unknown {
  return typeof value === "function";
}
beforeAll(async () => {
  const native = fileURLToPath(new URL("../native/", import.meta.url));
  for (const variant of ["scalar", "simd128"]) {
    const target = join(native, "target", `landing-${variant}`);
    execFileSync("cargo", ["build", "--release", "-p", "mirage-bet", "--features", "kernel-test-exports",
      "--target", "wasm32-unknown-unknown", "--locked"], {
      cwd: native, stdio: "pipe", env: { ...process.env, CARGO_TARGET_DIR: target,
        RUSTFLAGS: variant === "scalar" ? "" : "-C target-feature=+simd128" },
    });
    const bytes = readFileSync(join(target, "wasm32-unknown-unknown/release/mirage_bet.wasm"));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const { memory, bet_test_landing: evaluate } = instance.exports;
    if (!(memory instanceof WebAssembly.Memory) || !numericExport(evaluate))
      throw new Error("Missing landing-gear numerical harness");
    modules.push({ memory, evaluate: (kind, x, rate, count) => Number(evaluate(kind, x, rate, count)) });
  }
}, 300000);

it("matches independent gas, orifice, tire and lever-arm oracles on scalar/SIMD WASM", () => {
  const elastic = (300000 * 10 / 9 - 100000) * 0.01;
  const hydraulic = 850 / 2 * (0.001 / 0.00007) ** 2 * 0.005;
  const cases = [
    [0, 0.1, 0.2, elastic + hydraulic],
    [0, 0.1, -0.2, elastic - 4 * hydraulic],
    [1, 0.1, 0, 3000 * Math.log(10 / 9) - 100],
    [2, 0.1, 0.2, hydraulic * 0.2],
    [3, 0.02, 0.2, 310], [4, 0.02, 0, 2.5], [5, 0.02, 0.2, 2],
    [6, 0.1, 0.2, 130], [7, 0.1, 2, -50], [8, 0.1, 2, -100],
  ];
  for (const module of modules) for (const row of cases) {
    const [kind = 0, x = 0, rate = 0, expected = 0] = row;
    expect(Math.abs(module.evaluate(kind, x, rate, 1) - expected)).toBeLessThan(1e-9);
  }
});

it("rejects unmodeled travel and invalid states without inventing ground support", () => {
  for (const module of modules) {
    expect(module.evaluate(3, -0.01, 10, 1)).toBe(0);
    expect(module.evaluate(3, 0.02, -10, 1)).toBe(0);
    for (const [kind = 0, x = 0, rate = 0, count = 0] of [
      [0, -0.01, 0, 1], [0, 0.51, 0, 1], [3, 0.031, 0, 1],
      [0, 0.1, NaN, 1], [0, 0.1, 0, 0], [9, 0.1, 0, 1],
    ]) expect(Number.isNaN(module.evaluate(kind, x, rate, count))).toBe(true);
  }
});

it("runs a million compliance evaluations per component under the trapping WASM allocator", () => {
  for (const module of modules) {
    const memory = module.memory.buffer;
    for (const kind of [0, 3, 6, 7]) {
      const x = kind === 3 ? 0.02 : 0.1;
      const expected = module.evaluate(kind, x + 0.001, 0.2, 1);
      expect(module.evaluate(kind, x, 0.2, 1000000)).toBe(expected);
    }
    expect(module.memory.buffer).toBe(memory);
  }
}, 60000);
