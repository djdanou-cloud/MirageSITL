/**
 * The ESC shaper and motor thermal records (TASK-105, second increment) over `bet_esc_shaper_step` and
 * `bet_motor_thermal_step` (SPECS_SIMULATION_ENGINES "ESC shaper record v1", "Motor thermal record v1"). One instance holds a
 * record per shaped ESC and per heated motor; a hot caller writes the tick's inputs into the preallocated arrays and reads the
 * outputs back, so a step creates no objects, views or boxed doubles.
 */

/** Byte offsets of the two records. */
export const ESC_SHAPER_V1 = {
  version: 1, recordBytes: 192, maxRecords: 32, maxLatencyFrames: 8, maxThrottleSteps: 65535,
  offset: { version: 0, latencyFrames: 4, framePeriod: 8, rampPerS: 16, startDuty: 24, throttleSteps: 32, running: 36, command: 40,
    duty: 48, countdown: 56, frames: 64, target: 128 },
} as const;
export const MOTOR_THERMAL_V1 = {
  version: 1, recordBytes: 192, maxRecords: 32,
  offset: { version: 0, windingCapacity: 8, housingCapacity: 16, windingToHousing: 24, housingToAir: 32, airflowPerMps: 40,
    resistance20c: 48, torqueConstant20c: 56, noLoadCurrent: 64, windingTemperature: 72, housingTemperature: 80, copperLoss: 88,
    shaftSpeed: 96, airTemperature: 104, airspeed: 112, resistance: 120, torqueConstant: 128, noLoadTorque: 136, ironLoss: 144 },
} as const;

/** One ESC's command path. A frame period above 0 and at most 0.1 s; a ramp of 0 is no limit, 0 throttle steps no quantization. */
export interface EscShaping {
  readonly framePeriodS: number; readonly latencyFrames: number; readonly rampPerS: number; readonly startDuty: number;
  readonly throttleSteps: number;
}
/** One motor's two-node thermal network and the 20 °C electrical values it scales. */
export interface MotorHeat {
  readonly windingHeatCapacityJPerK: number; readonly housingHeatCapacityJPerK: number;
  readonly windingToHousingKPerW: number; readonly housingToAirKPerW: number; readonly airflowCoolingPerMps: number;
  readonly resistance20cOhm: number; readonly torqueConstant20cNmPerA: number; readonly noLoadCurrentA: number;
}

/** The columns of `thermalInput` and `thermalOutput`, per heated motor. */
export const ThermalInput = Object.freeze({ CopperLossW: 0, ShaftSpeedRadS: 1, AirC: 2, AirspeedMps: 3, Stride: 4 });
export const ThermalOutput = Object.freeze({ WindingC: 0, HousingC: 1, ResistanceOhm: 2, TorqueConstantNmPerA: 3, NoLoadTorqueNm: 4, IronLossW: 5, Stride: 6 });

function callable(value: unknown): value is (...args: number[]) => number { return typeof value === 'function'; }
const finite = (values: readonly number[]) => values.every(Number.isFinite);

function checkShaping(s: EscShaping): void {
  if (!finite([s.framePeriodS, s.latencyFrames, s.rampPerS, s.startDuty, s.throttleSteps]) || !(s.framePeriodS > 0) || s.framePeriodS > 0.1 ||
      !Number.isInteger(s.latencyFrames) || s.latencyFrames < 0 || s.latencyFrames > ESC_SHAPER_V1.maxLatencyFrames || s.rampPerS < 0 ||
      s.startDuty < 0 || s.startDuty >= 1 || !Number.isInteger(s.throttleSteps) || s.throttleSteps < 0 || s.throttleSteps > ESC_SHAPER_V1.maxThrottleSteps) {
    throw new Error('Invalid ESC shaping');
  }
}
function checkHeat(h: MotorHeat): void {
  const positive = [h.windingHeatCapacityJPerK, h.housingHeatCapacityJPerK, h.windingToHousingKPerW, h.housingToAirKPerW, h.resistance20cOhm,
    h.torqueConstant20cNmPerA];
  if (!finite([...positive, h.airflowCoolingPerMps, h.noLoadCurrentA]) || !positive.every(v => v > 0) || h.airflowCoolingPerMps < 0 || h.noLoadCurrentA < 0) {
    throw new Error('Invalid motor heat');
  }
}

/**
 * The shaped ESCs and heated motors of one vehicle, either list may be empty. `shapeFromInput` steps every shaper from
 * `targets` into `duties`; `heatFromInput` steps every network from `thermalInput` into `thermalOutput`. Both return false on a
 * non-zero status (see `lastStatus`) and then leave their outputs unchanged.
 */
export class BetMotorV2 {
  readonly targets: Float64Array;
  readonly duties: Float64Array;
  readonly thermalInput: Float64Array;
  readonly thermalOutput: Float64Array;
  readonly shaped: number;
  readonly heated: number;
  readonly dtS: number;
  lastStatus = 0;
  private readonly memory: WebAssembly.Memory;
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly shaperAt: number;
  private readonly thermalAt: number;
  private readonly heat: readonly MotorHeat[];
  private readonly nativeShape: (...args: number[]) => number;
  private readonly nativeHeat: (...args: number[]) => number;
  constructor(module: WebAssembly.Module, shaping: readonly EscShaping[], heat: readonly MotorHeat[], hz: 400 | 800 | 1200 | 4800) {
    if (![400, 800, 1200, 4800].includes(hz)) throw new Error('Invalid motor v2 rate');
    if (shaping.length > ESC_SHAPER_V1.maxRecords || heat.length > MOTOR_THERMAL_V1.maxRecords) throw new Error('Too many motors');
    shaping.forEach(checkShaping); heat.forEach(checkHeat);
    const e = new WebAssembly.Instance(module, {}).exports;
    if (!(e.memory instanceof WebAssembly.Memory) || !(e.__heap_base instanceof WebAssembly.Global) || typeof e.__heap_base.value !== 'number' ||
        !callable(e.bet_esc_shaper_version) || e.bet_esc_shaper_version() !== ESC_SHAPER_V1.version || !callable(e.bet_esc_shaper_step) ||
        !callable(e.bet_motor_thermal_version) || e.bet_motor_thermal_version() !== MOTOR_THERMAL_V1.version || !callable(e.bet_motor_thermal_step)) {
      throw new Error('Missing motor v2 export');
    }
    this.dtS = 1 / hz; this.memory = e.memory; this.nativeShape = e.bet_esc_shaper_step; this.nativeHeat = e.bet_motor_thermal_step;
    this.shaped = shaping.length; this.heated = heat.length; this.heat = heat;
    this.shaperAt = Math.ceil(e.__heap_base.value / 64) * 64;
    this.thermalAt = this.shaperAt + Math.max(1, shaping.length) * ESC_SHAPER_V1.recordBytes;
    const end = this.thermalAt + Math.max(1, heat.length) * MOTOR_THERMAL_V1.recordBytes;
    if (this.memory.buffer.byteLength < end) this.memory.grow(Math.ceil((end - this.memory.buffer.byteLength) / 65536));
    this.buffer = this.memory.buffer; this.view = new DataView(this.buffer);
    new Uint8Array(this.buffer, this.shaperAt, end - this.shaperAt).fill(0);
    this.targets = new Float64Array(shaping.length); this.duties = new Float64Array(shaping.length);
    this.thermalInput = new Float64Array(heat.length * ThermalInput.Stride); this.thermalOutput = new Float64Array(heat.length * ThermalOutput.Stride);
    const v = this.view, S = ESC_SHAPER_V1.offset, T = MOTOR_THERMAL_V1.offset;
    shaping.forEach((s, i) => {
      const at = this.shaperAt + i * ESC_SHAPER_V1.recordBytes;
      v.setUint32(at + S.version, ESC_SHAPER_V1.version, true); v.setUint32(at + S.latencyFrames, s.latencyFrames, true);
      v.setFloat64(at + S.framePeriod, s.framePeriodS, true); v.setFloat64(at + S.rampPerS, s.rampPerS, true);
      v.setFloat64(at + S.startDuty, s.startDuty, true); v.setUint32(at + S.throttleSteps, s.throttleSteps, true);
    });
    heat.forEach((h, i) => {
      const at = this.thermalAt + i * MOTOR_THERMAL_V1.recordBytes;
      v.setUint32(at + T.version, MOTOR_THERMAL_V1.version, true);
      const values = [h.windingHeatCapacityJPerK, h.housingHeatCapacityJPerK, h.windingToHousingKPerW, h.housingToAirKPerW, h.airflowCoolingPerMps,
        h.resistance20cOhm, h.torqueConstant20cNmPerA, h.noLoadCurrentA];
      values.forEach((x, k) => v.setFloat64(at + T.windingCapacity + 8 * k, x, true));
    });
    this.reset(20);
  }
  get memoryStable(): boolean { return this.memory.buffer === this.buffer; }
  /**
   * Every shaper back to rest, and every motor at `airC`, with its output at that temperature. Cold: it may box `airC`.
   */
  reset(airC: number): void {
    if (!Number.isFinite(airC) || airC < -60 || airC > 250) throw new Error('Invalid motor reset temperature');
    const v = this.view, S = ESC_SHAPER_V1.offset, T = MOTOR_THERMAL_V1.offset;
    for (let i = 0; i < this.shaped; i++) {
      const at = this.shaperAt + i * ESC_SHAPER_V1.recordBytes;
      new Uint8Array(this.buffer, at + S.running, S.target + 8 - S.running).fill(0);
      this.targets[i] = 0; this.duties[i] = 0;
    }
    for (let i = 0; i < this.heated; i++) {
      const at = this.thermalAt + i * MOTOR_THERMAL_V1.recordBytes, h = this.heat[i]!, o = i * ThermalOutput.Stride;
      v.setFloat64(at + T.windingTemperature, airC, true); v.setFloat64(at + T.housingTemperature, airC, true);
      // The record's own laws: R₂₀·(1 + 0.00393·ΔT) and k₂₀·(1 − 0.0012·ΔT), as the native step writes them after each step.
      const r = h.resistance20cOhm * (1 + 0.00393 * (airC - 20)), k = h.torqueConstant20cNmPerA * (1 - 0.0012 * (airC - 20));
      const out = this.thermalOutput;
      out[o + ThermalOutput.WindingC] = airC; out[o + ThermalOutput.HousingC] = airC; out[o + ThermalOutput.ResistanceOhm] = r;
      out[o + ThermalOutput.TorqueConstantNmPerA] = k; out[o + ThermalOutput.NoLoadTorqueNm] = k * h.noLoadCurrentA; out[o + ThermalOutput.IronLossW] = 0;
    }
  }
  /** Every shaper's step from `targets` into `duties`; allocation-free. */
  shapeFromInput(): boolean {
    if (this.shaped === 0) return true;
    if (!this.memoryStable) { this.lastStatus = -5; return false; }
    const v = this.view, S = ESC_SHAPER_V1.offset, n = this.shaped;
    for (let i = 0; i < n; i++) v.setFloat64(this.shaperAt + i * ESC_SHAPER_V1.recordBytes + S.target, this.targets[i]!, true);
    const status = this.nativeShape(this.shaperAt, n, this.dtS);
    this.lastStatus = status;
    if (status !== 0) return false;
    for (let i = 0; i < n; i++) this.duties[i] = v.getFloat64(this.shaperAt + i * ESC_SHAPER_V1.recordBytes + S.duty, true);
    return true;
  }
  /** Every network's step from `thermalInput` into `thermalOutput`; allocation-free. */
  heatFromInput(): boolean {
    if (this.heated === 0) return true;
    if (!this.memoryStable) { this.lastStatus = -5; return false; }
    const v = this.view, T = MOTOR_THERMAL_V1.offset, n = this.heated, input = this.thermalInput, out = this.thermalOutput;
    for (let i = 0; i < n; i++) {
      const at = this.thermalAt + i * MOTOR_THERMAL_V1.recordBytes, b = i * ThermalInput.Stride;
      v.setFloat64(at + T.copperLoss, input[b + ThermalInput.CopperLossW]!, true); v.setFloat64(at + T.shaftSpeed, input[b + ThermalInput.ShaftSpeedRadS]!, true);
      v.setFloat64(at + T.airTemperature, input[b + ThermalInput.AirC]!, true); v.setFloat64(at + T.airspeed, input[b + ThermalInput.AirspeedMps]!, true);
    }
    const status = this.nativeHeat(this.thermalAt, n, this.dtS);
    this.lastStatus = status;
    if (status !== 0) return false;
    for (let i = 0; i < n; i++) {
      const at = this.thermalAt + i * MOTOR_THERMAL_V1.recordBytes, o = i * ThermalOutput.Stride;
      out[o + ThermalOutput.WindingC] = v.getFloat64(at + T.windingTemperature, true);
      out[o + ThermalOutput.HousingC] = v.getFloat64(at + T.housingTemperature, true);
      out[o + ThermalOutput.ResistanceOhm] = v.getFloat64(at + T.resistance, true);
      out[o + ThermalOutput.TorqueConstantNmPerA] = v.getFloat64(at + T.torqueConstant, true);
      out[o + ThermalOutput.NoLoadTorqueNm] = v.getFloat64(at + T.noLoadTorque, true);
      out[o + ThermalOutput.IronLossW] = v.getFloat64(at + T.ironLoss, true);
    }
    return true;
  }
}
