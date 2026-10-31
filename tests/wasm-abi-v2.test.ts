// TASK-088: step interfaces v2, with the TASK-092 drive mode 1 and shared bus.
// Oracles: the engine-spec layout tables, golden
// records packed by tests/fixtures/wasm-abi/generate.py, the unchanged v1 steps
// and the native reference example (native/bet/examples/interface_v2_reference.rs).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { specFields } from './support/spec-layout.ts';
import { BetRotorEngine, encodeBoundRotor, type BoundRotorDefinition } from '@mirage/wasm-bet/rotor';
import { BetRigidBodyBackend, newBodyTruth } from '@mirage/wasm-bet/backend';
import { BOUND_V2, BOUND_V2_DRIVE_DOUBLES, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS, BetRotorEngineV2 } from '@mirage/wasm-bet/rotor-v2';
import { BUS_V1, BetBus } from '@mirage/wasm-bet/bus';
import { BODY_V2, BetRigidBodyBackendV2, newBodyTruthV2 } from '@mirage/wasm-bet/body-v2';
import iface from './fixtures/wasm-abi/interface-v2.json';
import { rotorDefinition } from './bet-runtime-fixture.ts';

const engineSpec = readFileSync(new URL('../docs/SPECS_SIMULATION_ENGINES.md', import.meta.url), 'utf8');
const header = readFileSync(new URL('../native/bet/include/bet_bound.h', import.meta.url), 'utf8');
const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], byte => parseInt(byte, 16));
const modules: { variant: string; module: WebAssembly.Module }[] = [];
let referenceBinary = '';
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  for (const variant of ['scalar', 'simd128']) {
    modules.push({ variant, module: new WebAssembly.Module(readFileSync(`packages/wasm-bet/dist/mirage_bet.${variant}.wasm`)) });
  }
  execFileSync('cargo', ['build', '--release', '-p', 'mirage-bet', '--example', 'interface_v2_reference', '--locked'], { cwd: 'native', stdio: 'pipe' });
  referenceBinary = 'native/target/release/examples/interface_v2_reference';
}, 600000);

interface Raw {
  memory: WebAssembly.Memory; heap: number;
  init: (...a: number[]) => number; boundV1: (...a: number[]) => number; boundV2: (...a: number[]) => number;
  bodyV2: (...a: number[]) => number; bus: (...a: number[]) => number;
}
function fn(value: unknown): (...a: number[]) => number {
  if (typeof value !== 'function') throw new Error('Missing export');
  return (...a: number[]) => Number(Reflect.apply(value, undefined, a));
}
function raw(module: WebAssembly.Module): Raw {
  const e = new WebAssembly.Instance(module, {}).exports;
  if (!(e.memory instanceof WebAssembly.Memory) || !(e.__heap_base instanceof WebAssembly.Global) || typeof e.__heap_base.value !== 'number') {
    throw new Error('Missing memory exports');
  }
  if (fn(e.bet_bound_v2_version)() !== 2 || fn(e.bet_body_v2_version)() !== 2 || fn(e.bet_bound_version)() !== 1 ||
      fn(e.bet_bus_version)() !== 1) throw new Error('Wrong versions');
  return { memory: e.memory, heap: Math.ceil(e.__heap_base.value / 64) * 64, init: fn(e.bet_bound_init), boundV1: fn(e.bet_bound_step),
    boundV2: fn(e.bet_bound_step_v2), bodyV2: fn(e.bet_body_step_v2), bus: fn(e.bet_bus_step) };
}
/** Bound arena at the heap base: config, arena, a v2 input and a v2 output region. */
function boundArena(r: Raw, config: Uint8Array) {
  const configAt = r.heap, arena = configAt + Math.ceil(config.length / 64) * 64, size = config.length + 64;
  const input = arena + Math.ceil(size / 64) * 64, output = input + 256, end = output + 256;
  if (r.memory.buffer.byteLength < end) r.memory.grow(Math.ceil((end - r.memory.buffer.byteLength) / 65536));
  new Uint8Array(r.memory.buffer, configAt, config.length).set(config);
  expect(r.init(configAt, config.length, arena, size)).toBe(0);
  return { arena, input, output };
}
/** One stripped midpoint rotor with a constant polar, cheap enough for 10^6 WASM steps. */
function cheapRotor(): BoundRotorDefinition {
  const d = rotorDefinition();
  d.geometry = { ...d.geometry, radiusM: 0.5, rootCutoutM: 0.1, radialStationM: [0.3], chordM: [0.03], twistRad: [0], quadratureWidthM: [0.4],
    shaftInertiaKgM2: 0.02, bearingViscousNmPerRadS: 0, azimuthSamples: 8 };
  d.initialOmegaRadS = 100;
  d.polar = { alphaRad: [-3.15, 3.15], reynolds: [1, 1e9], mach: [0, 1], cl: Array<number>(8).fill(1), cd: Array<number>(8).fill(0.02),
    confidence: Array<number>(8).fill(1) };
  return d;
}
const relative = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));
/**
 * Native glibc and the WASM libm may differ by an ulp in trigonometric functions,
 * and a vector component's round-off scales with its vector's magnitude, so
 * force and moment components are compared relative to their vector's norm.
 */
function parityError(actual: DataView, at: number, expected: DataView, p: number): number {
  const vectorStart = p < 72 ? p - (p % 24) : -1;
  if (vectorStart < 0) return relative(actual.getFloat64(at + p, true), expected.getFloat64(p, true));
  const norm = Math.hypot(expected.getFloat64(vectorStart, true), expected.getFloat64(vectorStart + 8, true), expected.getFloat64(vectorStart + 16, true));
  const error = Math.abs(actual.getFloat64(at + p, true) - expected.getFloat64(p, true));
  return error === 0 ? 0 : error / norm;
}

describe('specification layouts, fixture and header', () => {
  const headings: [string, keyof typeof iface.layouts][] = [['### Bound rotor step input v2', 'boundInputV2'],
    ['### Bound rotor step output v2', 'boundOutputV2'], ['### Rigid-body step input v2', 'bodyInputV2'], ['### Rigid-body step output v2', 'bodyOutputV2'],
    ['### Shared bus input v1', 'busInputV1'], ['### Shared bus output v1', 'busOutputV1']];
  for (const [heading, key] of headings) {
    it(`${heading} matches the golden layout and covers every byte once`, () => {
      const spec = specFields(heading, engineSpec), layout = iface.layouts[key];
      expect(spec.map(f => ({ offset: f.offset, type: f.type, count: f.count, name: f.spec }))).toEqual(layout.fields);
      const covered = new Set<number>();
      for (const f of spec) {
        const width = (f.type === 'u32' ? 4 : 8) * f.count;
        for (let b = f.offset; b < f.offset + width; b++) { expect(covered.has(b)).toBe(false); covered.add(b); }
      }
      expect(covered.size).toBe(layout.bytes);
      expect(Math.max(...covered)).toBe(layout.bytes - 1);
    });
  }

  it('keeps the TypeScript offsets and C header constants equal to the layouts', () => {
    const offset = (key: keyof typeof iface.layouts, name: string) => iface.layouts[key].fields.find(f => f.name === name)?.offset;
    const boundIn: [number, string][] = [[BOUND_V2.input.flags, 'input_flags'], [BOUND_V2.input.driveMode, 'drive_mode'],
      [BOUND_V2.input.density, 'density'], [BOUND_V2.input.airVelocityHub, 'air_velocity_hub_x'], [BOUND_V2.input.motorTorque, 'motor_torque'],
      [BOUND_V2.input.escDuty, 'esc_duty'], [BOUND_V2.input.busVoltage, 'bus_voltage'], [BOUND_V2.input.externalWakeHub, 'external_wake_hub_x'],
      [BOUND_V2.input.groundNormalHub, 'ground_normal_hub_x'], [BOUND_V2.input.groundDistance, 'ground_distance']];
    for (const [value, name] of boundIn) expect(value, name).toBe(offset('boundInputV2', name));
    const boundOut: [number, string][] = [[BOUND_V2.output.validity, 'validity'], [BOUND_V2.output.angularMomentumAxial, 'angular_momentum_axial'],
      [BOUND_V2.output.inflowCos, 'inflow_cos'], [BOUND_V2.output.motorCurrent, 'motor_current'], [BOUND_V2.output.copperLoss, 'copper_loss']];
    for (const [value, name] of boundOut) expect(value, name).toBe(offset('boundOutputV2', name));
    const bodyIn: [number, string][] = [[BODY_V2.input.gravityModel, 'gravity_model'], [BODY_V2.input.mass, 'mass'], [BODY_V2.input.position, 'position_n'],
      [BODY_V2.input.force, 'force_body_x'], [BODY_V2.input.gravityDown, 'gravity_down'], [BODY_V2.input.gravityNed, 'gravity_n'],
      [BODY_V2.input.cgOffsetBody, 'cg_offset_body_x'], [BODY_V2.input.massRate, 'mass_rate']];
    for (const [value, name] of bodyIn) expect(value, name).toBe(offset('bodyInputV2', name));
    expect(BODY_V2.output.specificForceBody).toBe(offset('bodyOutputV2', 'specific_force_body_x'));
    expect(BODY_V2.output.validity).toBe(offset('bodyOutputV2', 'validity'));
    const define = (name: string) => Number(new RegExp(`#define ${name} \\(?(-?\\d+)\\)?`).exec(header)?.[1]);
    expect(define('BET_BOUND_V2_INPUT_BYTES')).toBe(iface.layouts.boundInputV2.bytes);
    expect(define('BET_BOUND_V2_OUTPUT_BYTES')).toBe(iface.layouts.boundOutputV2.bytes);
    expect(define('BET_BODY_V2_INPUT_BYTES')).toBe(iface.layouts.bodyInputV2.bytes);
    expect(define('BET_BODY_V2_OUTPUT_BYTES')).toBe(iface.layouts.bodyOutputV2.bytes);
    expect(define('BET_V2_UNSUPPORTED')).toBe(iface.unsupportedStatus);
    expect(BOUND_V2.unsupported).toBe(iface.unsupportedStatus);
    expect(hex(iface.boundInputHex).length).toBe(256);
    expect(hex(iface.bodyInputHex).length).toBe(448);
    // TASK-092 drive fields and bus records.
    const drive: [number, string][] = [[BOUND_V2.input.motorResistance, 'motor_resistance'], [BOUND_V2.input.motorTorqueConstant, 'motor_torque_constant'],
      [BOUND_V2.input.motorCurrentLimit, 'motor_current_limit'], [BOUND_V2.input.motorBrakeCurrentLimit, 'motor_brake_current_limit'],
      [BOUND_V2.input.motorNoLoadTorque, 'motor_no_load_torque'], [BOUND_V2.input.escCommandTau, 'esc_command_tau'],
      [BOUND_V2.input.escUpdatePeriod, 'esc_update_period'], [BOUND_V2.input.driveFlags, 'drive_flags']];
    for (const [value, name] of drive) expect(value, name).toBe(offset('boundInputV2', name));
    const busIn: [number, string][] = [[BUS_V1.input.openCircuitFull, 'open_circuit_full'], [BUS_V1.input.capacityCoulomb, 'capacity_coulomb'],
      [BUS_V1.input.stateOfCharge, 'state_of_charge'], [BUS_V1.input.motorPower, 'motor_power'], [BUS_V1.input.housePower, 'house_power']];
    for (const [value, name] of busIn) expect(value, name).toBe(offset('busInputV1', name));
    const busOut: [number, string][] = [[BUS_V1.output.voltage, 'voltage'], [BUS_V1.output.current, 'current'], [BUS_V1.output.flags, 'flags']];
    for (const [value, name] of busOut) expect(value, name).toBe(offset('busOutputV1', name));
    expect([define('BET_BUS_INPUT_BYTES'), define('BET_BUS_OUTPUT_BYTES'), define('BET_BUS_VERSION')]).toEqual([128, 128, iface.busVersion]);
    expect([define('BET_BOUND_V2_DRIVE_POWER_CUT'), define('BET_BOUND_V2_FLAG_CURRENT_LIMITED'), define('BET_BUS_FLAG_POWER_LIMITED'),
      define('BET_BUS_FLAG_CHARGE_LIMITED')]).toEqual([BOUND_V2.drivePowerCut, BOUND_V2.flagCurrentLimited, BUS_V1.flagPowerLimited, BUS_V1.flagChargeLimited]);
  });
});

describe('WASM step interfaces v2', () => {
  it('reproduce v1 bitwise for neutral records in both variants', () => {
    for (const { variant, module } of modules) {
      const definition = rotorDefinition(), v1 = new BetRotorEngine(module, [definition], 400), v2 = new BetRotorEngineV2(module, [definition], 400);
      const inputs = [1.225, 1.789e-5, 340, 6, -1, -2, 0.05, -0.1, 0.02, 0.04, 0.01, -0.01, 0.03];
      v1.input.set(inputs); v2.input.set(inputs);
      for (let step = 0; step < 300; step++) {
        expect(v1.stepInto()).toBe(true);
        expect(v2.stepInto(), `${variant} status ${v2.lastStatus}`).toBe(true);
        for (let j = 0; j < 15; j++) expect(Object.is(v2.output[j], v1.output[j]), `${variant} slot ${j}`).toBe(true);
        expect(Object.is(v2.output[16], v1.output[15])).toBe(true); // angular momentum
        expect(v2.output[BOUND_V2_OUTPUT_SLOTS - 8]).toBe(0); // validity
        for (let j = 17; j < BOUND_V2_OUTPUT_SLOTS; j++) expect(v2.output[j]).toBe(0);
      }
      v1.dispose(); v2.dispose();
      const inertia = [0.03, 0, -0.001, 0, 0.032, 0, -0.001, 0, 0.05];
      const b1 = new BetRigidBodyBackend(new WebAssembly.Instance(module, {}), 1.5, inertia);
      const b2 = new BetRigidBodyBackendV2(new WebAssembly.Instance(module, {}), 1.5, inertia);
      const t1 = newBodyTruth(), t2 = newBodyTruthV2(), wrench = new Float64Array([0.5, -0.2, -15, 0.01, -0.02, 0.005]);
      t1.positionNedM[2] = -10; t2.positionNedM[2] = -10; b1.reset(t1); b2.reset(t2);
      for (let step = 0; step < 2000; step++) {
        expect(b1.stepInto(wrench, 1 / 800, t1)).toBe(true);
        expect(b2.stepInto(wrench, 1 / 800, t2)).toBe(true);
        for (const [a, b] of [[t1.positionNedM, t2.positionNedM], [t1.velocityNedMps, t2.velocityNedMps], [t1.quaternionBodyToNed, t2.quaternionBodyToNed],
          [t1.angularVelocityBodyRadS, t2.angularVelocityBodyRadS], [t1.accelerationNedMps2, t2.accelerationNedMps2]] as const) {
          for (let i = 0; i < a.length; i++) expect(Object.is(a[i], b[i])).toBe(true);
        }
      }
      // TASK-094: angular acceleration and reference position are valid on every step.
      expect(t2.validity).toBe(BODY_V2.validSpecificForce | BODY_V2.validAngularAcceleration | BODY_V2.validReferencePosition);
      expect([...t2.specificForceBodyMps2]).toEqual([0.5 / 1.5, -0.2 / 1.5, -15 / 1.5]);
    }
  });

  it('agree with the native reference within 1e-12 relative for the golden records', () => {
    const definition = rotorDefinition(), config = encodeBoundRotor(definition, 1 / 400), steps = 200;
    const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const native = spawnSync(referenceBinary, [], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      input: `bound ${steps} ${toHex(config)} ${iface.boundInputHex}\nbody ${steps} ${iface.bodyInputHex}\nbody ${steps} ${iface.bodyOffsetInputHex}\n` });
    expect(native.status, native.stderr).toBe(0);
    const lines = native.stdout.trim().split('\n').map(hex);
    expect(lines.length).toBe(3 * steps);
    for (const { variant, module } of modules) {
      const r = raw(module), { arena, input, output } = boundArena(r, config);
      new Uint8Array(r.memory.buffer, input, 256).set(hex(iface.boundInputHex));
      const view = new DataView(r.memory.buffer);
      for (let step = 0; step < steps; step++) {
        expect(r.boundV2(arena, input, output, 1 / 400)).toBe(0);
        const expected = new DataView(lines[step]!.buffer);
        for (let p = 0; p < 256; p += 8) {
          if (p === 112) {
            expect(view.getUint32(output + 112, true)).toBe(expected.getUint32(112, true));
            expect(view.getUint32(output + 116, true)).toBe(expected.getUint32(116, true));
            continue;
          }
          expect(parityError(view, output, expected, p), `${variant} rotor step ${step} byte ${p}`).toBeLessThanOrEqual(1e-12);
        }
      }
      const bodyIn = output + 256, bodyOut = bodyIn + 448;
      if (r.memory.buffer.byteLength < bodyOut + 256) r.memory.grow(1);
      const body = new DataView(r.memory.buffer);
      // The neutral record, then the TASK-094 record with a CG offset.
      for (const [record, first] of [[iface.bodyInputHex, steps], [iface.bodyOffsetInputHex, 2 * steps]] as const) {
        new Uint8Array(r.memory.buffer, bodyIn, 448).set(hex(record));
        for (let step = 0; step < steps; step++) {
          expect(r.bodyV2(bodyIn, bodyOut, 1 / 800)).toBe(0);
          const expected = new DataView(lines[first + step]!.buffer);
          for (let p = 0; p < 200; p += 8) {
            expect(relative(body.getFloat64(bodyOut + p, true), expected.getFloat64(p, true)), `${variant} body step ${step} byte ${p}`).toBeLessThanOrEqual(1e-12);
          }
          expect(body.getUint32(bodyOut + 200, true)).toBe(expected.getUint32(200, true));
          new Uint8Array(r.memory.buffer, bodyIn + 96, 104).set(new Uint8Array(r.memory.buffer, bodyOut, 104));
        }
      }
    }
  });

  it('write the same records as the golden bytes', () => {
    for (const { module } of modules) {
      // The adapter and the Python-packed golden record must give identical outputs.
      const golden = hex(iface.boundInputHex), goldenView = new DataView(golden.buffer);
      const engine = new BetRotorEngineV2(module, [rotorDefinition()], 400);
      for (let j = 0; j < BOUND_V2_INPUT_DOUBLES; j++) engine.input[j] = goldenView.getFloat64(16 + 8 * j, true);
      expect(engine.stepInto()).toBe(true);
      const r = raw(module), { arena, input, output } = boundArena(r, encodeBoundRotor(rotorDefinition(), 1 / 400));
      new Uint8Array(r.memory.buffer, input, 256).set(golden);
      expect(r.boundV2(arena, input, output, 1 / 400)).toBe(0);
      const view = new DataView(r.memory.buffer);
      for (let j = 0; j < 14; j++) expect(Object.is(engine.output[j], view.getFloat64(output + 8 * j, true))).toBe(true);
      engine.dispose();
      const body = hex(iface.bodyInputHex), bodyView = new DataView(body.buffer), f = (p: number) => bodyView.getFloat64(p, true);
      const backend = new BetRigidBodyBackendV2(new WebAssembly.Instance(module, {}), f(16), Array.from({ length: 9 }, (_, i) => f(24 + 8 * i)), f(248));
      const truth = newBodyTruthV2();
      for (let i = 0; i < 3; i++) { truth.positionNedM[i] = f(96 + 8 * i); truth.velocityNedMps[i] = f(120 + 8 * i); truth.angularVelocityBodyRadS[i] = f(176 + 8 * i); }
      for (let i = 0; i < 4; i++) truth.quaternionBodyToNed[i] = f(144 + 8 * i);
      backend.reset(truth);
      const wrench = Float64Array.from({ length: 6 }, (_, i) => f(200 + 8 * i));
      expect(backend.stepInto(wrench, 1 / 800, truth)).toBe(true);
      const bodyIn = output + 256, bodyOut = bodyIn + 448;
      new Uint8Array(r.memory.buffer, bodyIn, 448).set(body);
      expect(r.bodyV2(bodyIn, bodyOut, 1 / 800)).toBe(0);
      for (let i = 0; i < 3; i++) expect(Object.is(truth.positionNedM[i], view.getFloat64(bodyOut + 8 * i, true))).toBe(true);
      for (let i = 0; i < 4; i++) expect(Object.is(truth.quaternionBodyToNed[i], view.getFloat64(bodyOut + 48 + 8 * i, true))).toBe(true);
    }
  });

  it('return the fixture statuses and leave the output untouched for invalid and unsupported records', () => {
    for (const { variant, module } of modules) {
      const r = raw(module), { arena, input, output } = boundArena(r, encodeBoundRotor(rotorDefinition(), 1 / 400));
      const memory = () => new Uint8Array(r.memory.buffer);
      for (const rejection of iface.boundRejections) {
        memory().set(hex(iface.boundInputHex), input);
        memory().set(hex(rejection.patch.hex), input + rejection.patch.offset);
        memory().fill(0x5a, output, output + 256);
        const before = memory().slice(arena, arena + 128);
        expect(r.boundV2(arena, input, output, 1 / 400), `${variant}: ${rejection.why}`).toBe(rejection.status);
        expect(memory().slice(output, output + 256).every(b => b === 0x5a), rejection.why).toBe(true);
        expect(memory().slice(arena, arena + 128)).toEqual(before);
      }
      const bodyIn = output + 256, bodyOut = bodyIn + 448;
      for (const rejection of iface.bodyRejections) {
        memory().set(hex(iface.bodyInputHex), bodyIn);
        memory().set(hex(rejection.patch.hex), bodyIn + rejection.patch.offset);
        memory().fill(0x5a, bodyOut, bodyOut + 256);
        expect(r.bodyV2(bodyIn, bodyOut, 1 / 800), `${variant}: ${rejection.why}`).toBe(rejection.status);
        expect(memory().slice(bodyOut, bodyOut + 256).every(b => b === 0x5a), rejection.why).toBe(true);
      }
      // Overlapping regions and a v1-sized record are pointer errors.
      expect(r.boundV2(arena, input, input + 8, 1 / 400)).toBe(-2);
      expect(r.bodyV2(bodyIn, bodyIn + 64, 1 / 800)).toBe(-2);
    }
  });

  it('run 10^6 steps without allocation traps or memory growth', () => {
    for (const { module } of modules) {
      const rotor = new BetRotorEngineV2(module, [cheapRotor()], 400), before = rotor.memoryBytes;
      rotor.input.set([1.225, 1.789e-5, 340, 3, -0.5, -1, 0.05, -0.1, 0.02, 0.04, 0.01, -0.01, 0.03]);
      let ok = true;
      for (let i = 0; i < 1_000_000 && ok; i++) ok = rotor.stepInto();
      expect(ok, `status ${rotor.lastStatus}`).toBe(true);
      expect(rotor.memoryStable).toBe(true);
      expect(rotor.memoryBytes).toBe(before);
      rotor.dispose();
      const body = new BetRigidBodyBackendV2(new WebAssembly.Instance(module, {}), 1.5, [0.03, 0, 0, 0, 0.03, 0, 0, 0, 0.05], 0);
      const truth = newBodyTruthV2(), wrench = new Float64Array(6);
      for (let i = 0; i < 1_000_000 && ok; i++) ok = body.stepInto(wrench, 1 / 800, truth);
      expect(ok).toBe(true);
      expect(body.memoryStable).toBe(true);
    }
  }, 120000);

  it('surface UNSUPPORTED through the adapters for later-task fields', () => {
    const scalar = modules[0];
    if (!scalar) throw new Error('No WASM module');
    const rotor = new BetRotorEngineV2(scalar.module, [cheapRotor()], 400);
    // TASK-092 implements drive mode 1: without drive parameters it is invalid, not unsupported.
    rotor.driveMode[0] = BOUND_V2.driveEscDuty;
    expect(rotor.stepInto()).toBe(false);
    expect(rotor.lastStatus).toBe(-3);
    rotor.driveMode[0] = BOUND_V2.driveTorque;
    rotor.input[BOUND_V2_INPUT_DOUBLES - 1] = 0.5; // ground distance
    expect(rotor.stepInto()).toBe(false);
    expect(rotor.lastStatus).toBe(BOUND_V2.unsupported);
    rotor.input[BOUND_V2_INPUT_DOUBLES - 1] = 0;
    expect(rotor.stepInto()).toBe(true);
  });
});

describe('TASK-092 drive mode 1 and shared bus records', () => {
  const read = (view: DataView, at: number) => view.getFloat64(at, true);

  it('agree with the native reference for the ESC and bus golden records', () => {
    const config = encodeBoundRotor(rotorDefinition(), 1 / 400), steps = 300;
    const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const native = spawnSync(referenceBinary, [], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      input: `bound ${steps} ${toHex(config)} ${iface.escInputHex}\nbus ${steps} ${iface.busInputHex}\n` });
    expect(native.status, native.stderr).toBe(0);
    const lines = native.stdout.trim().split('\n').map(hex);
    expect(lines.length).toBe(2 * steps);
    for (const { variant, module } of modules) {
      const r = raw(module), { arena, input, output } = boundArena(r, config);
      new Uint8Array(r.memory.buffer, input, 256).set(hex(iface.escInputHex));
      const view = new DataView(r.memory.buffer);
      for (let step = 0; step < steps; step++) {
        expect(r.boundV2(arena, input, output, 1 / 400)).toBe(0);
        const expected = new DataView(lines[step]!.buffer);
        expect(view.getUint32(output + 116, true)).toBe(BOUND_V2.validElectrical);
        expect(view.getUint32(output + 112, true)).toBe(expected.getUint32(112, true));
        for (const p of [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 120, 144, 152, 160, 168]) {
          expect(parityError(view, output, expected, p), `${variant} ESC step ${step} byte ${p}`).toBeLessThanOrEqual(1e-12);
        }
      }
      const busIn = output + 256, busOut = busIn + 128;
      new Uint8Array(r.memory.buffer, busIn, 128).set(hex(iface.busInputHex));
      for (let step = 0; step < steps; step++) {
        expect(r.bus(busIn, busOut, 1 / 400)).toBe(0);
        const expected = new DataView(lines[steps + step]!.buffer);
        for (let p = 0; p < 48; p += 8) expect(relative(read(view, busOut + p), read(expected, p)), `${variant} bus step ${step} byte ${p}`).toBeLessThanOrEqual(1e-12);
        new Uint8Array(r.memory.buffer, busIn + 48, 8).set(new Uint8Array(r.memory.buffer, busOut, 8));
      }
    }
  });

  it('write the golden ESC and bus records through the adapters', () => {
    for (const { module } of modules) {
      const golden = hex(iface.escInputHex), g = new DataView(golden.buffer);
      const engine = new BetRotorEngineV2(module, [rotorDefinition()], 400);
      for (let j = 0; j < BOUND_V2_INPUT_DOUBLES; j++) engine.input[j] = read(g, 16 + 8 * j);
      for (let j = 0; j < BOUND_V2_DRIVE_DOUBLES; j++) engine.drive[j] = read(g, 192 + 8 * j);
      engine.driveMode[0] = g.getUint32(8, true);
      expect(engine.stepInto()).toBe(true);
      const r = raw(module), { arena, input, output } = boundArena(r, encodeBoundRotor(rotorDefinition(), 1 / 400));
      new Uint8Array(r.memory.buffer, input, 256).set(golden);
      expect(r.boundV2(arena, input, output, 1 / 400)).toBe(0);
      const view = new DataView(r.memory.buffer);
      for (let j = 0; j < 14; j++) expect(Object.is(engine.output[j], read(view, output + 8 * j))).toBe(true);
      for (let j = 0; j < 7; j++) expect(Object.is(engine.output[16 + j], read(view, output + 120 + 8 * j))).toBe(true);
      expect(engine.output[15]).toBe(BOUND_V2.validElectrical);
      engine.dispose();
      const bus = hex(iface.busInputHex), b = new DataView(bus.buffer);
      const adapter = new BetBus(module, { openCircuitFullV: read(b, 8), openCircuitEmptyV: read(b, 16), internalResistanceOhm: read(b, 24),
        capacityAh: read(b, 32) / 3600, currentLimitA: read(b, 40) }, 400);
      expect(adapter.stepInto(read(b, 48), read(b, 56), read(b, 64))).toBe(true);
      const busIn = output + 256, busOut = busIn + 128;
      new Uint8Array(r.memory.buffer, busIn, 128).set(bus);
      expect(r.bus(busIn, busOut, 1 / 400)).toBe(0);
      for (let j = 0; j < 6; j++) expect(Object.is(adapter.output[j], read(view, busOut + 8 * j))).toBe(true);
      expect(adapter.openCircuitV(0.8)).toBe(13.2 + (16.8 - 13.2) * 0.8);
    }
  });

  it('reject invalid ESC records with the fixture statuses and leave the output untouched', () => {
    for (const { variant, module } of modules) {
      const r = raw(module), { arena, input, output } = boundArena(r, encodeBoundRotor(rotorDefinition(), 1 / 400));
      const memory = () => new Uint8Array(r.memory.buffer);
      for (const rejection of iface.escRejections) {
        memory().set(hex(iface.escInputHex), input);
        memory().set(hex(rejection.patch.hex), input + rejection.patch.offset);
        memory().fill(0x5a, output, output + 256);
        const before = memory().slice(arena, arena + 128);
        expect(r.boundV2(arena, input, output, 1 / 400), `${variant}: ${rejection.why}`).toBe(rejection.status);
        expect(memory().slice(output, output + 256).every(b => b === 0x5a), rejection.why).toBe(true);
        expect(memory().slice(arena, arena + 128)).toEqual(before);
      }
    }
  });

  it('run 10^6 ESC and bus steps without allocation traps or memory growth', () => {
    for (const { module } of modules) {
      const rotor = new BetRotorEngineV2(module, [cheapRotor()], 400), before = rotor.memoryBytes;
      rotor.driveMode[0] = BOUND_V2.driveEscDuty;
      rotor.drive.set([0.05, 0.05, 100, 50, 0.01, 0.02, 0]);
      rotor.input[13] = 0.55; rotor.input[14] = 24; // esc_duty (byte 120) and bus_voltage (byte 128)
      const bus = new BetBus(module, { openCircuitFullV: 25.2, openCircuitEmptyV: 19.8, internalResistanceOhm: 0.02, capacityAh: 1e6, currentLimitA: 200 }, 400);
      let ok = true, soc = 0.9;
      for (let i = 0; i < 1_000_000 && ok; i++) {
        ok = rotor.stepInto() && bus.stepInto(soc, rotor.output[16 + 5]!, 0); // electrical_power (byte 160)
        soc = bus.output[0]!;
      }
      expect(ok, `rotor ${rotor.lastStatus} bus ${bus.lastStatus}`).toBe(true);
      expect(rotor.memoryStable && bus.memoryStable).toBe(true);
      expect(rotor.memoryBytes).toBe(before);
      rotor.dispose();
    }
  }, 240000);
});
