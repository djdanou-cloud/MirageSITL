import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import inflow from "./fixtures/rotors/axial-inflow.json";
import shaft from "./fixtures/rotors/free-shaft.json";
import flap from "./fixtures/rotors/flapping.json";
import coaxial from "./fixtures/rotors/coaxial.json";
interface Harness {
  propulsion: (kind: number) => number;
  coaxial: (
    separation: number,
    overlap: number,
    enabled: number,
    quantity: number,
    iterations: number,
  ) => number;
  memory: WebAssembly.Memory;
  blade: (n: number, az: number, spin: number, kind: number) => number;
  dynamics: (kind: number, steps: number, dt: number) => number;
}
function numericExport(
  value: unknown,
): value is (...args: number[]) => unknown {
  return typeof value === "function";
}
const modules: Harness[] = [];
const native = fileURLToPath(new URL("../native/", import.meta.url));
beforeAll(async () => {
  for (const variant of ["scalar", "simd128"]) {
    const target = join(native, "target", `kernel-${variant}`);
    execFileSync(
      "cargo",
      [
        "build",
        "--release",
        "-p",
        "mirage-bet",
        "--features",
        "kernel-test-exports",
        "--target",
        "wasm32-unknown-unknown",
        "--locked",
      ],
      {
        cwd: native,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: target,
          RUSTFLAGS: variant === "simd128" ? "-C target-feature=+simd128" : "",
        },
        stdio: "pipe",
      },
    );
    const bytes = readFileSync(
      join(target, "wasm32-unknown-unknown/release/mirage_bet.wasm"),
    );
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const {
      memory,
      bet_test_blade: blade,
      bet_test_dynamics: dynamics,
      bet_test_coaxial: wake,
      bet_test_propulsion: propulsion,
    } = instance.exports;
    if (
      !(memory instanceof WebAssembly.Memory) ||
      !numericExport(blade) ||
      !numericExport(dynamics) ||
      !numericExport(wake) ||
      !numericExport(propulsion)
    )
      throw new Error("Missing numerical harness exports");
    // WebAssembly exports were instantiated locally from the pinned test-feature build.
    modules.push({
      memory,
      propulsion: (kind) => Number(propulsion(kind)),
      coaxial: (d, overlap, enabled, quantity, n) =>
        Number(wake(d, overlap, enabled, quantity, n)),
      blade: (n, az, spin, kind) => Number(blade(n, az, spin, kind)),
      dynamics: (kind, steps, dt) => Number(dynamics(kind, steps, dt)),
    });
  }
}, 300000);
it("matches independent discrete annulus sums with SIMD tail counts and spin reversal", () => {
  for (const n of [1, 3, 5, 16, 32, 63, 64]) {
    const width = 0.4 / n;
    let force = 0,
      torque = 0;
    for (let k = 0; k < n; k++) {
      const r = 0.1 + (k + 0.5) * width;
      force += 1.225 * 0.03 * 10000 * r * r * width;
      torque -= 1.225 * 0.03 * 0.02 * 10000 * r * r * r * width;
    }
    for (const module of modules)
      for (const az of [16, 32, 64]) {
        expect(Math.abs(module.blade(n, az, 1, 0) - force)).toBeLessThan(1e-9);
        expect(Math.abs(module.blade(n, az, -1, 0) - force)).toBeLessThan(1e-9);
        expect(Math.abs(module.blade(n, az, 1, 1) - torque)).toBeLessThan(1e-9);
        expect(Math.abs(module.blade(n, az, -1, 1) + torque)).toBeLessThan(
          1e-9,
        );
      }
  }
});
it("matches analytic inflow, passive shaft, oscillator and inertial moment on scalar/SIMD WASM", () => {
  for (const module of modules)
    for (const hz of [400, 800, 1200]) {
      expect(
        Math.abs(
          module.dynamics(0, hz, 1 / hz) -
            inflow.inducedMps * (1 - Math.exp(-10)),
        ),
      ).toBeLessThan(1e-9);
      expect(
        Math.abs(module.dynamics(1, hz, 1 / hz) - shaft.omegaRadS),
      ).toBeLessThan(1e-9);
      expect(
        Math.abs(module.dynamics(2, hz, 1 / hz) - flap.coneRad),
      ).toBeLessThan(1e-8);
      expect(Math.abs(module.dynamics(3, 1, 1 / hz) + 0.2 * hz)).toBeLessThan(
        1e-9,
      );
    }
});
it("runs a million dynamics steps with the trapping allocator and stable WASM memory", () => {
  for (const module of modules) {
    const buffer = module.memory.buffer;
    expect(Number.isFinite(module.dynamics(0, 1000000, 1 / 400))).toBe(true);
    expect(Number.isFinite(module.dynamics(1, 1000000, 1 / 400))).toBe(true);
    expect(Number.isFinite(module.dynamics(2, 1000000, 1 / 400))).toBe(true);
    expect(module.memory.buffer).toBe(buffer);
  }
});

it("matches coaxial flux oracles on scalar/SIMD and conserves the passive wake budget", () => {
  for (const module of modules) {
    for (const [quantity, expected] of [
      [0, coaxial.receiverDeltaZMps],
      [1, coaxial.sourcePowerW],
      [2, coaxial.receivedPowerW],
      [3, coaxial.mixingLossW],
      [4, coaxial.receivedMomentumN],
    ] as const) {
      expect(
        Math.abs(module.coaxial(0.5, 0.75, 1, quantity, 1) - expected),
      ).toBeLessThan(1e-9);
    }
    expect(module.coaxial(0.5, 0.75, 0, 0, 1)).toBe(0);
    expect(module.coaxial(0.5, 0, 1, 0, 1)).toBe(0);
    expect(Math.abs(module.coaxial(1e8, 0.75, 1, 0, 1))).toBeLessThan(1e-5);
    const at = (q: number) => module.coaxial(0.5, 0.75, 1, q, 1);
    expect(Math.abs(at(2) + at(3) + at(5) - at(1))).toBeLessThan(1e-9);
    expect(Math.abs(at(4) + at(6) - 100)).toBeLessThan(1e-9);
    const buffer = module.memory.buffer;
    expect(Number.isFinite(module.coaxial(0.5, 0.75, 1, 0, 1000000))).toBe(
      true,
    );
    expect(module.memory.buffer).toBe(buffer);
  }
});

it("matches motor, shared-battery and tilted-frame analytical values on scalar/SIMD", () => {
  for (const module of modules) {
    expect(module.propulsion(0)).toBeCloseTo(1 - Math.exp(-10), 12);
    expect(module.propulsion(1)).toBeCloseTo((12 - Math.sqrt(100)) / 0.2, 12);
    expect(module.propulsion(2)).toBeCloseTo(2, 12);
  }
});
