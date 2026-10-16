import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BET_ABI, createBetArena, encodeBetConfig, newBetRotorOutputs, newBetStepInput, type BetArena,
  type BetConfig, type BetStepInput } from '@mirage/wasm-bet/arena';
import { loadBetModule, type BetExports } from '@mirage/wasm-bet/loader';
import golden from './fixtures/wasm-abi/bet-abi-v1.json';

// TASK-018: layout oracle is native/bet/include/bet.h plus golden records packed
// independently with Python struct (tests/fixtures/wasm-abi/generate.py).
const root = fileURLToPath(new URL('..', import.meta.url));
const A = BET_ABI;
let out = '';
let manifest: unknown;
const files = new Map<string, Uint8Array>();

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'mirage-wasm-abi-'));
  execFileSync(process.execPath, [join(root, 'scripts/build-wasm.mjs'), '--out', out], { cwd: root, stdio: 'pipe' });
  manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  for (const variant of ['scalar', 'simd128']) {
    const file = `mirage_bet.${variant}.wasm`;
    files.set(file, readFileSync(join(out, file)));
  }
}, 300_000);
afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }); });

async function load(): Promise<BetExports> {
  const result = await loadBetModule({ manifest, simd128: false, fetchBytes: file => {
    const bytes = files.get(file);
    return bytes ? Promise.resolve(bytes.slice()) : Promise.reject(new Error(file));
  } });
  if (!result.ok) throw new Error(result.reason);
  return result.module.exports;
}
const config: BetConfig = golden.config;
function goldenInput(): BetStepInput {
  const input = newBetStepInput(2);
  input.densityKgM3 = golden.input.densityKgM3;
  input.dynamicViscosityPaS = golden.input.dynamicViscosityPaS;
  input.speedOfSoundMps = golden.input.speedOfSoundMps;
  golden.input.rotors.forEach((source, i) => {
    const rotor = input.rotors[i];
    if (!rotor) throw new Error('rotor');
    rotor.airVelocityAtHubHubMps.set(source.airVelocityAtHubHubMps);
    rotor.bodyAngularVelocityHubRadS.set(source.bodyAngularVelocityHubRadS);
    rotor.collectivePitchRad = source.collectivePitchRad; rotor.cyclicCosRad = source.cyclicCosRad;
    rotor.cyclicSinRad = source.cyclicSinRad; rotor.motorTorqueMagnitudeNm = source.motorTorqueMagnitudeNm;
  });
  return input;
}
function arenaFor(exports: BetExports, value: BetConfig = config): BetArena {
  const result = createBetArena(exports, value);
  if (!result.ok) throw new Error(result.reason);
  return result.arena;
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('mirage-bet C ABI and arena binding', () => {
  it('mirrors every bet.h define exactly', () => {
    const header = readFileSync(join(root, 'native/bet/include/bet.h'), 'utf8');
    const defines = Object.fromEntries(Array.from(header.matchAll(/^#define BET_(\w+) (-?\d+)\b/gm), m => [m[1] ?? '', Number(m[2])]));
    expect(defines).toEqual({ ...A });
    expect([A.OUTPUT_BYTES, A.OUTPUT_FLAGS, A.OUTPUT_ANGULAR_MOMENTUM_NMS]).toEqual([128, 112, 120]); // section 4
  });
  it('encodes the golden configuration and input byte for byte', async () => {
    expect(hex(encodeBetConfig(config))).toBe(golden.configHex);
    const exports = await load(), arena = arenaFor(exports);
    expect(arena.layout.arenaBytes).toBe(golden.requiredArenaBytes);
    expect(arena.stepInto(goldenInput(), newBetRotorOutputs(2))).toBe(A.STATUS_AERODYNAMICS_UNAVAILABLE);
    expect(hex(new Uint8Array(exports.memory.buffer, arena.layout.inputPtr, arena.layout.inputBytes))).toBe(golden.inputHex);
  });
  it('places every region above __heap_base, aligned, disjoint, and inside reserved memory', async () => {
    const exports = await load(), { layout, handle } = arenaFor(exports);
    expect(layout.configPtr).toBeGreaterThanOrEqual(exports.heapBase);
    const regions = [[layout.configPtr, layout.configBytes], [layout.inputPtr, layout.inputBytes],
      [layout.outputPtr, layout.outputBytes], [layout.arenaPtr, layout.arenaBytes]] as const;
    regions.forEach(([ptr], i) => {
      expect(ptr % 64).toBe(0);
      const next = regions[i + 1];
      if (next) expect(ptr + (regions[i]?.[1] ?? 0)).toBeLessThanOrEqual(next[0]);
    });
    expect(handle).toBe(layout.arenaPtr);
    expect(layout.endPtr).toBeLessThanOrEqual(exports.memory.buffer.byteLength);
  });
  it('steps 1e6 times without allocation or growth, overwriting outputs in place', async () => {
    const exports = await load(), arena = arenaFor(exports), input = goldenInput(), outputs = newBetRotorOutputs(2);
    const memory = new DataView(exports.memory.buffer), flagsAt = arena.layout.outputPtr + A.OUTPUT_FLAGS;
    /** The measured loop; run once unmeasured so the same code is optimized when measured. */
    const run = (steps: number) => {
      let unavailable = 0;
      for (let i = 0; i < steps; i++) {
        memory.setUint32(flagsAt, 0xffffffff, true); // sentinel the step must overwrite
        outputs[0]!.flags = 0;
        if (arena.stepInto(input, outputs) === A.STATUS_AERODYNAMICS_UNAVAILABLE &&
          memory.getUint32(flagsAt, true) === A.FLAG_AERODYNAMICS_UNAVAILABLE &&
          outputs[0]!.flags === A.FLAG_AERODYNAMICS_UNAVAILABLE) unavailable++;
      }
      return unavailable;
    };
    expect(run(200_000)).toBe(200_000);
    const gcStarts: number[] = [];
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) gcStarts.push(entry.startTime); });
    observer.observe({ entryTypes: ['gc'] });
    const t0 = performance.now(), unavailable = run(1_000_000), t1 = performance.now();
    await new Promise(resolve => setTimeout(resolve, 100));
    observer.disconnect();
    expect(unavailable).toBe(1_000_000);
    expect(gcStarts.filter(start => start >= t0 && start <= t1)).toEqual([]); // an allocation-free loop never triggers GC
    expect(arena.memoryStable()).toBe(true);
    for (const output of outputs) {
      expect(Array.from(output.forceHubN).every(Number.isNaN)).toBe(true); // explicit unavailability, never a fake zero
      // At rest; a spin -1 rotor reports -0 angular momentum, which equals zero.
      expect([output.omegaRadS, output.shaftPowerW, output.angularMomentumNms].every(value => value === 0)).toBe(true);
    }
  }, 120_000);
  it('rejects invalid pointers, overlaps, handles, and dt through the real exports', async () => {
    const exports = await load(), arena = arenaFor(exports), { layout } = arena;
    const memoryBytes = exports.memory.buffer.byteLength, len = layout.configBytes;
    const required = (ptr: number) => [exports.bet_required_bytes(ptr, len), exports.bet_last_error()];
    expect(required(layout.configPtr)).toEqual([golden.requiredArenaBytes, A.STATUS_OK]);
    for (const ptr of [0, 8, layout.configPtr + 4, memoryBytes - 64]) expect(required(ptr), String(ptr)).toEqual([0, A.STATUS_BAD_POINTER]);
    // Overlapping config and arena.
    expect(exports.bet_init(layout.configPtr, len, layout.configPtr + 64, layout.arenaBytes)).toBe(0);
    expect(exports.bet_last_error()).toBe(A.STATUS_BAD_POINTER);
    expect(exports.bet_init(layout.configPtr, len, layout.arenaPtr, layout.arenaBytes - 8)).toBe(0);
    expect(exports.bet_last_error()).toBe(A.STATUS_ARENA_TOO_SMALL);
    const step = (handle: number, input: number, output: number, dt = arena.dtS) => exports.bet_step(handle, input, output, dt);
    arena.stepInto(goldenInput(), newBetRotorOutputs(2)); // valid input bytes in place
    const { handle } = arena, { inputPtr, outputPtr } = layout;
    expect(step(handle, inputPtr, outputPtr)).toBe(A.STATUS_AERODYNAMICS_UNAVAILABLE);
    for (const bad of [0, 8, handle + 8, layout.configPtr, memoryBytes - 8]) expect(step(bad, inputPtr, outputPtr), String(bad)).toBe(A.STATUS_BAD_HANDLE);
    for (const [input, output] of [[inputPtr, inputPtr], [inputPtr, outputPtr + 4], [8, outputPtr], [inputPtr, memoryBytes - 128],
      [inputPtr, handle], [handle + 64, outputPtr]] as const) {
      expect(step(handle, input, output), `${input},${output}`).toBe(A.STATUS_BAD_POINTER);
    }
    expect(step(handle, inputPtr, outputPtr, 1 / 800)).toBe(A.STATUS_BAD_DT);
    expect(exports.bet_reset(handle, 3)).toBe(A.STATUS_OK);
    arena.dispose();
    expect(step(handle, inputPtr, outputPtr)).toBe(A.STATUS_BAD_HANDLE);
    expect(arena.stepInto(goldenInput(), newBetRotorOutputs(2))).toBe(A.STATUS_BAD_HANDLE);
  });
  it('rejects invalid configurations before arming', async () => {
    const exports = await load();
    const rotor = golden.config.rotors[0]!;
    const cases: [BetConfig, number][] = [
      [{ ...config, dtS: 1 / 500 }, A.STATUS_BAD_INPUT],
      [{ ...config, rotors: [{ ...rotor, radiusM: NaN }] }, A.STATUS_BAD_INPUT],
      [{ ...config, rotors: [{ ...rotor, radialStationM: [0.08, 0.04, 0.12] }] }, A.STATUS_BAD_INPUT],
      [{ ...config, rotors: [{ ...rotor, hubToBody: [1, 0, 0, 0.01] }] }, A.STATUS_BAD_INPUT],
      [{ ...config, rotors: [{ ...rotor, chordM: [0.02] }] }, A.STATUS_BAD_INPUT], // structural, caught by the encoder
      [{ ...config, rotors: [{ ...rotor, spinSign: 0 }] }, A.STATUS_BAD_INPUT],
      [{ ...config, rotors: [] }, A.STATUS_BAD_INPUT],
    ];
    for (const [value, status] of cases) expect(createBetArena(exports, value)).toMatchObject({ ok: false, status });
  });
  it('faults stepping after memory growth instead of using stale views', async () => {
    const exports = await load(), arena = arenaFor(exports), input = goldenInput(), outputs = newBetRotorOutputs(2);
    expect(arena.stepInto(input, outputs)).toBe(A.STATUS_AERODYNAMICS_UNAVAILABLE);
    exports.memory.grow(1);
    expect(arena.memoryStable()).toBe(false);
    expect(arena.stepInto(input, outputs)).toBe(A.STATUS_MEMORY_GROWN);
    expect(exports.bet_step(arena.handle, arena.layout.inputPtr, arena.layout.outputPtr, arena.dtS)).toBe(A.STATUS_MEMORY_GROWN);
  });
});
