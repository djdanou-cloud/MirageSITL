import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BetRigidBodyBackend,
  newBodyTruth,
  BODY_ABI,
} from "../packages/wasm-bet/src/backend";
import layout from "./fixtures/abi/body-v1.json";
it("integrates real WASM body ABI and preserves state on rejected input", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    outDir = mkdtempSync(join(tmpdir(), "mirage-body-"));
  try {
    execFileSync(
      process.execPath,
      ["scripts/build-wasm.mjs", "--out", outDir],
      { cwd: root, stdio: "pipe" },
    );
    for (const variant of ["scalar", "simd128"]) {
      const { instance } = await WebAssembly.instantiate(
        readFileSync(join(outDir, `mirage_bet.${variant}.wasm`)),
        {},
      );
      expect(BODY_ABI.inputBytes).toBe(layout.inputBytes);
      expect(BODY_ABI.outputBytes).toBe(layout.outputBytes);
      for (const [key, value] of Object.entries(layout.inputOffsets))
        expect(Reflect.get(BODY_ABI, key)).toBe(value);
      const body = new BetRigidBodyBackend(
          instance,
          1,
          [1, 0, 0, 0, 1, 0, 0, 0, 1],
        ),
        truth = newBodyTruth(),
        w = new Float64Array(6);
      for (let i = 0; i < 400; i++)
        expect(body.stepInto(w, 1 / 400, truth)).toBe(true);
      expect(truth.positionNedM[2]).toBeCloseTo(4.903325, 10);
      expect(
        () => new BetRigidBodyBackend(instance, 1, [1, 0, 0, 0, 1, 0, 0, 0, 1]),
      ).toThrow("dedicated");
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory))
        throw new Error("Missing memory");
      const buffer = memory.buffer;
      w[2] = -9.80665;
      body.reset(newBodyTruth());
      let completed = true;
      for (let i = 0; i < 1000000; i++)
        if (!body.stepInto(w, 1 / 400, truth)) {
          completed = false;
          break;
        }
      expect(completed).toBe(true);
      expect(memory.buffer).toBe(buffer);
      expect(truth.positionNedM[2]).toBeCloseTo(0, 12);
      const previous = truth.positionNedM.slice();
      w[0] = NaN;
      expect(body.stepInto(w, 1 / 400, truth)).toBe(false);
      expect(truth.positionNedM).toEqual(previous);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 300000);
