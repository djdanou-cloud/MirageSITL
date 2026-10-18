import acceptance from "./fixtures/airframes/jsbsim-trim.json";
import { expect, it } from "vitest";
import {
  JsbsimBackend,
  JSBSIM_ABI,
  type JsbsimModule,
} from "@mirage/wasm-jsbsim/backend";
it("pins SI/FRD/NED output shape and rejects incompatible modules before aircraft loading", () => {
  expect(JSBSIM_ABI).toMatchObject({
    version: 1,
    inputCount: 4,
    outputCount: 22,
    feetToMetres: 0.3048,
  });
  let loaded = false;
  const fake: JsbsimModule = {
    HEAPU8: new Uint8Array(1024),
    HEAPF64: new Float64Array(128),
    _malloc: () => 1,
    _free: () => {},
    _jsb_abi_version: () => 2,
    _jsb_create: () => {
      loaded = true;
      return 0;
    },
    _jsb_step: () => -1,
    _jsb_dispose: () => {},
  };
  expect(() => new JsbsimBackend(fake, "/jsbsim", "c172x", 1 / 400)).toThrow(
    "Invalid",
  );
  expect(loaded).toBe(false);
});

it("records numerical acceptance separately from measured calibration and model redistribution", () => {
  expect(acceptance.trimValidated).toBe(true);
  expect(acceptance.wasmParityValidated).toBe(true);
  expect(acceptance.contactValidated).toBe(true);
  expect(acceptance.allocatorValidated).toBe(true);
  expect(acceptance.measuredFidelityValidated).toBe(false);
  expect(acceptance.modelDataIncluded).toBe(false);
  expect(acceptance.status).toBe("numerical-pass");
});

// Boundary doubles validate adapter guards, not JSBSim physics or WASM parity.
function boundaryModule(): JsbsimModule {
  const memory = new ArrayBuffer(4096);
  let next = 64;
  const module: JsbsimModule = {
    HEAPU8: new Uint8Array(memory),
    HEAPF64: new Float64Array(memory),
    _malloc: (bytes: number) => {
      const pointer = next;
      next += Math.ceil(bytes / 8) * 8;
      return pointer;
    },
    _free: () => {},
    _jsb_abi_version: () => 1,
    _jsb_create: () => 16,
    _jsb_dispose: () => {},
    _jsb_trim: (_handle: number, pointer: number) => {
      module.HEAPF64.set([0.4, 0.01, -0.03, 0], pointer / 8);
      return 0;
    },
    _jsb_step: (
      _handle: number,
      _input: number,
      _count: number,
      pointer: number,
    ) => {
      module.HEAPF64.fill(0, pointer / 8, pointer / 8 + 22);
      module.HEAPF64[pointer / 8 + 6] = 1;
      return 0;
    },
  };
  return module;
}
it("allows cold trim once setup is valid, blocks it after stepping and disposes idempotently", () => {
  const module = boundaryModule(),
    backend = new JsbsimBackend(module, "/jsbsim", "c172x", 1 / 400),
    controls = new Float64Array(4);
  expect(backend.trimInto(controls)).toBe(true);
  expect(Array.from(controls)).toEqual([0.4, 0.01, -0.03, 0]);
  const out = {
    positionNedM: new Float64Array(3),
    velocityNedMps: new Float64Array(3),
    quaternionBodyToNed: new Float64Array(4),
    angularVelocityBodyRadS: new Float64Array(3),
    accelerationNedMps2: new Float64Array(3),
    specificForceBodyMps2: new Float64Array(3),
    timeS: 0,
    altitudeAslM: 0,
  };
  expect(backend.stepInto(controls, out)).toBe(true);
  expect(backend.trimInto(controls)).toBe(false);
  backend.dispose();
  backend.dispose();
  expect(backend.stepInto(controls, out)).toBe(false);
});
it("rejects mismatched heap views, unaligned allocations and frame allocation aliases", () => {
  const mismatch = boundaryModule();
  mismatch.HEAPF64 = new Float64Array(512);
  expect(
    () => new JsbsimBackend(mismatch, "/jsbsim", "c172x", 1 / 400),
  ).toThrow("Invalid");
  const unaligned = boundaryModule();
  unaligned._malloc = () => 65;
  expect(
    () => new JsbsimBackend(unaligned, "/jsbsim", "c172x", 1 / 400),
  ).toThrow("allocation");
  const aliased = boundaryModule();
  aliased._malloc = () => 64;
  expect(() => new JsbsimBackend(aliased, "/jsbsim", "c172x", 1 / 400)).toThrow(
    "allocation",
  );
});
