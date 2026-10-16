// mirage-bet arena binding (TASK-018). Places the configuration, step input,
// rotor outputs, and engine arena in WASM linear memory above __heap_base, all
// inside the memory the loader reserved, so nothing grows after arming. Each
// step writes the preallocated input fields through one DataView, calls
// bet_step, and decodes the 128-byte rotor output records into caller-owned
// objects: no per-step object marshaling or allocation. Layouts mirror
// native/bet/include/bet.h (checked by tests/wasm-abi.test.ts).
import type { BetExports } from './loader.ts';

/** Every `#define BET_*` of native/bet/include/bet.h, without the prefix. */
export const BET_ABI = {
  ABI_VERSION: 1, MAX_ROTORS: 32, MAX_STATIONS: 64, MAX_AZIMUTH_SAMPLES: 64, MAX_BLADES: 16, RECORD_ALIGN: 8,
  CONFIG_HEADER_BYTES: 64, CONFIG_ABI_VERSION: 0, CONFIG_CONFIG_BYTES: 4, CONFIG_ROTOR_COUNT: 8, CONFIG_ROTOR_STRIDE: 12,
  CONFIG_DT_S: 16, CONFIG_RESERVED: 24,
  ROTOR_BYTES: 2160, ROTOR_ID: 0, ROTOR_BLADE_COUNT: 4, ROTOR_SPIN_SIGN: 8, ROTOR_STATION_COUNT: 12,
  ROTOR_AZIMUTH_SAMPLES: 16, ROTOR_POLAR_ID: 20, ROTOR_RADIUS_M: 24, ROTOR_ROOT_CUTOUT_M: 32,
  ROTOR_HUB_POSITION_BODY_M: 40, ROTOR_HUB_TO_BODY: 64, ROTOR_SHAFT_INERTIA_KG_M2: 96,
  ROTOR_BEARING_VISCOUS_NM_PER_RAD_S: 104, ROTOR_RADIAL_STATION_M: 112, ROTOR_CHORD_M: 624, ROTOR_TWIST_RAD: 1136,
  ROTOR_QUADRATURE_WIDTH_M: 1648,
  INPUT_HEADER_BYTES: 64, INPUT_ROTOR_COUNT: 0, INPUT_ROTOR_STRIDE: 4, INPUT_DENSITY_KG_M3: 8,
  INPUT_DYNAMIC_VISCOSITY_PA_S: 16, INPUT_SPEED_OF_SOUND_MPS: 24, INPUT_RESERVED: 32,
  ROTOR_INPUT_BYTES: 96, ROTOR_INPUT_AIR_VELOCITY_AT_HUB_HUB_MPS: 0, ROTOR_INPUT_BODY_ANGULAR_VELOCITY_HUB_RAD_S: 24,
  ROTOR_INPUT_COLLECTIVE_PITCH_RAD: 48, ROTOR_INPUT_CYCLIC_COS_RAD: 56, ROTOR_INPUT_CYCLIC_SIN_RAD: 64,
  ROTOR_INPUT_MOTOR_TORQUE_MAGNITUDE_NM: 72, ROTOR_INPUT_FLAGS: 80, ROTOR_INPUT_RESERVED: 84,
  OUTPUT_BYTES: 128, OUTPUT_FORCE_HUB_N: 0, OUTPUT_AIR_MOMENT_HUB_NM: 24, OUTPUT_TRANSMITTED_MOMENT_HUB_NM: 48,
  OUTPUT_OMEGA_RAD_S: 72, OUTPUT_AERO_SHAFT_TORQUE_NM: 80, OUTPUT_SHAFT_POWER_W: 88,
  OUTPUT_INDUCED_AXIAL_VELOCITY_MPS: 96, OUTPUT_CONE_RAD: 104, OUTPUT_FLAGS: 112, OUTPUT_RESERVED: 116,
  OUTPUT_ANGULAR_MOMENTUM_NMS: 120,
  ARENA_HEADER_BYTES: 64, ARENA_ROTOR_STATE_BYTES: 64,
  STATUS_OK: 0, STATUS_AERODYNAMICS_UNAVAILABLE: 1, STATUS_BAD_HANDLE: -1, STATUS_BAD_POINTER: -2,
  STATUS_BAD_INPUT: -3, STATUS_BAD_DT: -4, STATUS_MEMORY_GROWN: -5, STATUS_ARENA_TOO_SMALL: -6,
  STATUS_ABI_MISMATCH: -7,
  FLAG_AERODYNAMICS_UNAVAILABLE: 1, FLAG_OUTSIDE_POLAR_VALIDITY: 2,
} as const;
const A = BET_ABI;
/** Region alignment used by the binding (a multiple of RECORD_ALIGN). */
const REGION_ALIGN = 64;

/** `RotorGeometry` (SPECS_SIMULATION_ENGINES section 2); station arrays share one length. */
export interface BetRotorConfig {
  id: number; bladeCount: number; spinSign: number; azimuthSamples: number; polarId: number;
  radiusM: number; rootCutoutM: number;
  hubPositionBodyM: readonly number[]; hubToBody: readonly number[];
  shaftInertiaKgM2: number; bearingViscousNmPerRadS: number;
  radialStationM: readonly number[]; chordM: readonly number[]; twistRad: readonly number[];
  quadratureWidthM: readonly number[];
}
export interface BetConfig { dtS: number; rotors: readonly BetRotorConfig[] }

const isU32 = (value: number) => (value >>> 0) === value;
/**
 * Packs a configuration into the ABI byte layout. Throws on structural errors
 * (counts, array lengths, integer fields); semantic validation (ranges,
 * finiteness, station order, dt) is bet_required_bytes's job, so both paths
 * reject through one implementation. Initialization only.
 */
export function encodeBetConfig(config: BetConfig): Uint8Array<ArrayBuffer> {
  const count = config.rotors.length;
  if (count < 1 || count > A.MAX_ROTORS) throw new Error(`Rotor count must be 1..${A.MAX_ROTORS}`);
  const bytes = new Uint8Array(A.CONFIG_HEADER_BYTES + count * A.ROTOR_BYTES), view = new DataView(bytes.buffer);
  view.setUint32(A.CONFIG_ABI_VERSION, A.ABI_VERSION, true);
  view.setUint32(A.CONFIG_CONFIG_BYTES, bytes.byteLength, true);
  view.setUint32(A.CONFIG_ROTOR_COUNT, count, true);
  view.setUint32(A.CONFIG_ROTOR_STRIDE, A.ROTOR_BYTES, true);
  view.setFloat64(A.CONFIG_DT_S, config.dtS, true);
  config.rotors.forEach((rotor, index) => {
    const at = A.CONFIG_HEADER_BYTES + index * A.ROTOR_BYTES, stations = rotor.radialStationM.length;
    if (![rotor.id, rotor.bladeCount, rotor.azimuthSamples, rotor.polarId].every(isU32) ||
      (rotor.spinSign !== 1 && rotor.spinSign !== -1) || rotor.hubPositionBodyM.length !== 3 || rotor.hubToBody.length !== 4 ||
      stations < 1 || stations > A.MAX_STATIONS || rotor.chordM.length !== stations || rotor.twistRad.length !== stations ||
      rotor.quadratureWidthM.length !== stations) throw new Error(`Invalid rotor ${index} structure`);
    view.setUint32(at + A.ROTOR_ID, rotor.id, true);
    view.setUint32(at + A.ROTOR_BLADE_COUNT, rotor.bladeCount, true);
    view.setInt32(at + A.ROTOR_SPIN_SIGN, rotor.spinSign, true);
    view.setUint32(at + A.ROTOR_STATION_COUNT, stations, true);
    view.setUint32(at + A.ROTOR_AZIMUTH_SAMPLES, rotor.azimuthSamples, true);
    view.setUint32(at + A.ROTOR_POLAR_ID, rotor.polarId, true);
    view.setFloat64(at + A.ROTOR_RADIUS_M, rotor.radiusM, true);
    view.setFloat64(at + A.ROTOR_ROOT_CUTOUT_M, rotor.rootCutoutM, true);
    rotor.hubPositionBodyM.forEach((value, i) => view.setFloat64(at + A.ROTOR_HUB_POSITION_BODY_M + 8 * i, value, true));
    rotor.hubToBody.forEach((value, i) => view.setFloat64(at + A.ROTOR_HUB_TO_BODY + 8 * i, value, true));
    view.setFloat64(at + A.ROTOR_SHAFT_INERTIA_KG_M2, rotor.shaftInertiaKgM2, true);
    view.setFloat64(at + A.ROTOR_BEARING_VISCOUS_NM_PER_RAD_S, rotor.bearingViscousNmPerRadS, true);
    for (let i = 0; i < stations; i++) {
      view.setFloat64(at + A.ROTOR_RADIAL_STATION_M + 8 * i, rotor.radialStationM[i] ?? NaN, true);
      view.setFloat64(at + A.ROTOR_CHORD_M + 8 * i, rotor.chordM[i] ?? NaN, true);
      view.setFloat64(at + A.ROTOR_TWIST_RAD + 8 * i, rotor.twistRad[i] ?? NaN, true);
      view.setFloat64(at + A.ROTOR_QUADRATURE_WIDTH_M + 8 * i, rotor.quadratureWidthM[i] ?? NaN, true);
    }
  });
  return bytes;
}

/** `RotorStepInput` (section 2); vectors are length-3 hub-axis arrays. */
export interface BetRotorInput {
  readonly airVelocityAtHubHubMps: Float64Array; readonly bodyAngularVelocityHubRadS: Float64Array;
  collectivePitchRad: number; cyclicCosRad: number; cyclicSinRad: number; motorTorqueMagnitudeNm: number;
}
export interface BetStepInput {
  densityKgM3: number; dynamicViscosityPaS: number; speedOfSoundMps: number;
  readonly rotors: readonly BetRotorInput[];
}
export function newBetStepInput(rotorCount: number): BetStepInput {
  return { densityKgM3: 1.225, dynamicViscosityPaS: 1.81e-5, speedOfSoundMps: 340.29,
    rotors: Array.from({ length: rotorCount }, () => ({ airVelocityAtHubHubMps: new Float64Array(3),
      bodyAngularVelocityHubRadS: new Float64Array(3), collectivePitchRad: 0, cyclicCosRad: 0, cyclicSinRad: 0,
      motorTorqueMagnitudeNm: 0 })) };
}
/** Decoded rotor output record (section 4, 128 bytes). */
export interface BetRotorOutput {
  readonly forceHubN: Float64Array; readonly airMomentHubNm: Float64Array; readonly transmittedMomentHubNm: Float64Array;
  omegaRadS: number; aeroShaftTorqueNm: number; shaftPowerW: number; inducedAxialVelocityMps: number;
  coneRad: number; flags: number; angularMomentumNms: number;
}
export function newBetRotorOutputs(rotorCount: number): BetRotorOutput[] {
  return Array.from({ length: rotorCount }, () => ({ forceHubN: new Float64Array(3), airMomentHubNm: new Float64Array(3),
    transmittedMomentHubNm: new Float64Array(3), omegaRadS: 0, aeroShaftTorqueNm: 0, shaftPowerW: 0,
    inducedAxialVelocityMps: 0, coneRad: 0, flags: 0, angularMomentumNms: 0 }));
}

export interface BetArenaLayout { configPtr: number; configBytes: number; inputPtr: number; inputBytes: number;
  outputPtr: number; outputBytes: number; arenaPtr: number; arenaBytes: number; endPtr: number }
const alignUp = (value: number, align: number) => Math.ceil(value / align) * align;

export type BetArenaResult = { ok: true; arena: BetArena } | { ok: false; status: number; reason: string };

/**
 * Lays out and initializes one engine. Must run before arming, after the
 * loader reserved memory; it never grows memory and fails if the layout does
 * not fit.
 */
export function createBetArena(exports: BetExports, config: BetConfig): BetArenaResult {
  let configBytes: Uint8Array<ArrayBuffer>;
  try { configBytes = encodeBetConfig(config); } catch (error) {
    return { ok: false, status: A.STATUS_BAD_INPUT, reason: error instanceof Error ? error.message : 'Invalid config' };
  }
  const count = config.rotors.length, memory = exports.memory;
  const configPtr = alignUp(exports.heapBase, REGION_ALIGN);
  const inputPtr = alignUp(configPtr + configBytes.byteLength, REGION_ALIGN);
  const inputBytes = A.INPUT_HEADER_BYTES + count * A.ROTOR_INPUT_BYTES;
  const outputPtr = alignUp(inputPtr + inputBytes, REGION_ALIGN), outputBytes = count * A.OUTPUT_BYTES;
  const arenaPtr = alignUp(outputPtr + outputBytes, REGION_ALIGN);
  if (arenaPtr > memory.buffer.byteLength) return { ok: false, status: A.STATUS_ARENA_TOO_SMALL, reason: 'Reserved memory too small' };
  new Uint8Array(memory.buffer, configPtr, configBytes.byteLength).set(configBytes);
  const arenaBytes = exports.bet_required_bytes(configPtr, configBytes.byteLength);
  if (arenaBytes === 0) {
    const status = exports.bet_last_error();
    return { ok: false, status, reason: `bet_required_bytes rejected the configuration (status ${status})` };
  }
  const endPtr = arenaPtr + arenaBytes;
  if (endPtr > memory.buffer.byteLength) return { ok: false, status: A.STATUS_ARENA_TOO_SMALL, reason: 'Reserved memory too small' };
  const handle = exports.bet_init(configPtr, configBytes.byteLength, arenaPtr, arenaBytes);
  if (handle === 0) {
    const status = exports.bet_last_error();
    return { ok: false, status, reason: `bet_init failed (status ${status})` };
  }
  const layout = { configPtr, configBytes: configBytes.byteLength, inputPtr, inputBytes, outputPtr, outputBytes,
    arenaPtr, arenaBytes, endPtr };
  return { ok: true, arena: new BetArena(exports, handle, count, config.dtS, layout) };
}

/** One initialized engine instance; `stepInto` is allocation-free. */
export class BetArena {
  readonly handle: number;
  readonly rotorCount: number;
  readonly dtS: number;
  readonly layout: Readonly<BetArenaLayout>;
  private readonly exports: BetExports;
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private disposed = false;

  constructor(exports: BetExports, handle: number, rotorCount: number, dtS: number, layout: Readonly<BetArenaLayout>) {
    this.exports = exports; this.handle = handle; this.rotorCount = rotorCount; this.dtS = dtS; this.layout = layout;
    this.buffer = exports.memory.buffer;
    this.view = new DataView(this.buffer);
    const v = this.view, at = layout.inputPtr;
    new Uint8Array(this.buffer, at, layout.inputBytes).fill(0); // reserved/flags stay zero
    v.setUint32(at + A.INPUT_ROTOR_COUNT, rotorCount, true);
    v.setUint32(at + A.INPUT_ROTOR_STRIDE, A.ROTOR_INPUT_BYTES, true);
  }

  /** False after memory growth or replacement: views would be stale, so stepping is refused. */
  memoryStable(): boolean {
    return this.exports.memory.buffer === this.buffer;
  }

  /**
   * Writes `input`, advances one fixed step, and on status >= 0 decodes every
   * rotor record into `outputs` (length >= rotorCount). Returns the bet_step
   * status; outputs are untouched on a negative status.
   */
  stepInto(input: BetStepInput, outputs: readonly BetRotorOutput[]): number {
    if (this.disposed) return A.STATUS_BAD_HANDLE;
    if (this.exports.memory.buffer !== this.buffer) return A.STATUS_MEMORY_GROWN;
    if (input.rotors.length !== this.rotorCount || outputs.length < this.rotorCount) return A.STATUS_BAD_INPUT;
    const v = this.view, base = this.layout.inputPtr;
    v.setFloat64(base + A.INPUT_DENSITY_KG_M3, input.densityKgM3, true);
    v.setFloat64(base + A.INPUT_DYNAMIC_VISCOSITY_PA_S, input.dynamicViscosityPaS, true);
    v.setFloat64(base + A.INPUT_SPEED_OF_SOUND_MPS, input.speedOfSoundMps, true);
    for (let r = 0; r < this.rotorCount; r++) {
      const rotor = input.rotors[r], at = base + A.INPUT_HEADER_BYTES + r * A.ROTOR_INPUT_BYTES;
      if (rotor === undefined) return A.STATUS_BAD_INPUT;
      const air = rotor.airVelocityAtHubHubMps, rate = rotor.bodyAngularVelocityHubRadS;
      if (air.length !== 3 || rate.length !== 3) return A.STATUS_BAD_INPUT;
      for (let i = 0; i < 3; i++) {
        // i < 3 === length (checked above), so these are in-bounds float64 loads. A `?? NaN`
        // fallback would widen them to a tagged value and box one HeapNumber per non-zero
        // component per step (caught by the GC check in tests/wasm-abi.test.ts).
        v.setFloat64(at + A.ROTOR_INPUT_AIR_VELOCITY_AT_HUB_HUB_MPS + 8 * i, air[i] as number, true);
        v.setFloat64(at + A.ROTOR_INPUT_BODY_ANGULAR_VELOCITY_HUB_RAD_S + 8 * i, rate[i] as number, true);
      }
      v.setFloat64(at + A.ROTOR_INPUT_COLLECTIVE_PITCH_RAD, rotor.collectivePitchRad, true);
      v.setFloat64(at + A.ROTOR_INPUT_CYCLIC_COS_RAD, rotor.cyclicCosRad, true);
      v.setFloat64(at + A.ROTOR_INPUT_CYCLIC_SIN_RAD, rotor.cyclicSinRad, true);
      v.setFloat64(at + A.ROTOR_INPUT_MOTOR_TORQUE_MAGNITUDE_NM, rotor.motorTorqueMagnitudeNm, true);
    }
    const status = this.exports.bet_step(this.handle, base, this.layout.outputPtr, this.dtS);
    if (status < 0) return status;
    for (let r = 0; r < this.rotorCount; r++) {
      const out = outputs[r], at = this.layout.outputPtr + r * A.OUTPUT_BYTES;
      if (out === undefined) return A.STATUS_BAD_INPUT;
      for (let i = 0; i < 3; i++) {
        out.forceHubN[i] = v.getFloat64(at + A.OUTPUT_FORCE_HUB_N + 8 * i, true);
        out.airMomentHubNm[i] = v.getFloat64(at + A.OUTPUT_AIR_MOMENT_HUB_NM + 8 * i, true);
        out.transmittedMomentHubNm[i] = v.getFloat64(at + A.OUTPUT_TRANSMITTED_MOMENT_HUB_NM + 8 * i, true);
      }
      out.omegaRadS = v.getFloat64(at + A.OUTPUT_OMEGA_RAD_S, true);
      out.aeroShaftTorqueNm = v.getFloat64(at + A.OUTPUT_AERO_SHAFT_TORQUE_NM, true);
      out.shaftPowerW = v.getFloat64(at + A.OUTPUT_SHAFT_POWER_W, true);
      out.inducedAxialVelocityMps = v.getFloat64(at + A.OUTPUT_INDUCED_AXIAL_VELOCITY_MPS, true);
      out.coneRad = v.getFloat64(at + A.OUTPUT_CONE_RAD, true);
      out.flags = v.getUint32(at + A.OUTPUT_FLAGS, true);
      out.angularMomentumNms = v.getFloat64(at + A.OUTPUT_ANGULAR_MOMENTUM_NMS, true);
    }
    return status;
  }

  reset(seed: number): number {
    return this.disposed ? A.STATUS_BAD_HANDLE : this.exports.bet_reset(this.handle, seed);
  }

  dispose(): void {
    if (!this.disposed) { this.exports.bet_dispose(this.handle); this.disposed = true; }
  }
}
