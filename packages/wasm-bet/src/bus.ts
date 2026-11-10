/** Shared battery bus record (TASK-092) over `bet_bus_step`; no hot-path host objects or views. */

/** Byte offsets of the 128-byte input and output records (SPECS_SIMULATION_ENGINES.md). */
export const BUS_V1 = {
  version: 1, inputBytes: 128, outputBytes: 128, flagPowerLimited: 1, flagChargeLimited: 2,
  input: { version: 0, openCircuitFull: 8, openCircuitEmpty: 16, internalResistance: 24, capacityCoulomb: 32,
    currentLimit: 40, stateOfCharge: 48, motorPower: 56, housePower: 64 },
  output: { stateOfCharge: 0, voltage: 8, current: 16, deliveredPower: 24, internalLoss: 32, sourcePower: 40, flags: 48 },
} as const;

/** Byte offsets of the 384-byte input v2 and the 128-byte output v2 (TASK-104, SPECS_SIMULATION_ENGINES "Battery v2"). */
export const BUS_V2 = {
  version: 2, inputBytes: 384, outputBytes: 128, tablePoints: 21,
  input: { branch1Voltage: 72, branch2Voltage: 80, temperature: 88, airTemperature: 96, airspeed: 104, branch1Resistance: 112,
    branch1Capacitance: 120, branch2Resistance: 128, branch2Capacitance: 136, activationTemperature: 144, referenceTemperature: 152,
    heatCapacity: 160, stillAirConductance: 168, airflowConductance: 176, entropicCoefficient: 184, capacityRetention: 192,
    resistanceGrowth: 200, openCircuitTable: 208 },
  output: { branch1Voltage: 56, branch2Voltage: 64, temperature: 72, heat: 80, openCircuitVoltage: 88 },
} as const;

/** Input v3 (TASK-104, second increment): input v2 with the series resistance's charge table at byte 376. */
export const BUS_V3 = { version: 3, inputBytes: 576, seriesResistanceTable: 376 } as const;

/** One RC branch of a dynamic pack (TASK-104). */
export interface BusBatteryBranch { readonly resistanceOhm: number; readonly capacitanceF: number }
/** The second-order Thevenin pack of TASK-104; SI units. */
export interface BusBatteryDynamics {
  /** Pack open-circuit voltage V at the reference temperature at charges 0, 0.05, ..., 1; first and last are the empty and full voltages. */
  readonly openCircuitTableV: readonly number[];
  /** Zero to two RC branches. */
  readonly branches: readonly BusBatteryBranch[];
  /** Arrhenius activation temperature of the series resistance, E_a/R_gas, K. */
  readonly activationK: number;
  /** Temperature the resistances and the table are given at, K. */
  readonly referenceK: number;
  /** m*c_p, J/K; 0 holds the temperature. */
  readonly heatCapacityJPerK: number;
  readonly stillAirConductanceWPerK: number;
  /** Forced conductance at 1 m/s, W/K, scaled by the square root of the airspeed. */
  readonly airflowConductanceWPerK: number;
  readonly entropicVPerK: number;
  /** Share of the rated capacity still held, (0, 1]. */
  readonly capacityRetention: number;
  /** Growth of every resistance, at least 1. */
  readonly resistanceGrowth: number;
  /** The series resistance's multiplier at charges 0, 0.05, ..., 1, each above 0; present, the records are version 3. */
  readonly seriesResistanceTable?: readonly number[];
}

/** Linear open-circuit voltage pack; SI units, capacity in ampere-hours. With `dynamics`, the TASK-104 pack. */
export interface BusBattery {
  readonly openCircuitFullV: number; readonly openCircuitEmptyV: number; readonly internalResistanceOhm: number;
  readonly capacityAh: number; readonly currentLimitA: number;
  readonly dynamics?: BusBatteryDynamics;
}

/** Writes a bus input record for `battery` at `at`: version 1, or version 2 with its dynamics; charge, powers and state left zero. */
export function writeBusRecord(view: DataView, at: number, battery: BusBattery): number {
  const d = battery.dynamics, table = d?.seriesResistanceTable, I = BUS_V1.input;
  const bytes = table ? BUS_V3.inputBytes : d ? BUS_V2.inputBytes : BUS_V1.inputBytes;
  new Uint8Array(view.buffer, at, bytes).fill(0);
  view.setUint32(at, table ? BUS_V3.version : d ? BUS_V2.version : BUS_V1.version, true);
  view.setFloat64(at + I.openCircuitFull, battery.openCircuitFullV, true); view.setFloat64(at + I.openCircuitEmpty, battery.openCircuitEmptyV, true);
  view.setFloat64(at + I.internalResistance, battery.internalResistanceOhm, true);
  view.setFloat64(at + I.capacityCoulomb, battery.capacityAh * 3600, true); view.setFloat64(at + I.currentLimit, battery.currentLimitA, true);
  if (d) {
    const J = BUS_V2.input;
    if (d.openCircuitTableV.length !== BUS_V2.tablePoints || d.branches.length > 2) throw new Error('Invalid bus battery dynamics');
    const b1 = d.branches[0], b2 = d.branches[1];
    view.setFloat64(at + J.branch1Resistance, b1?.resistanceOhm ?? 0, true); view.setFloat64(at + J.branch1Capacitance, b1?.capacitanceF ?? 0, true);
    view.setFloat64(at + J.branch2Resistance, b2?.resistanceOhm ?? 0, true); view.setFloat64(at + J.branch2Capacitance, b2?.capacitanceF ?? 0, true);
    view.setFloat64(at + J.activationTemperature, d.activationK, true); view.setFloat64(at + J.referenceTemperature, d.referenceK, true);
    view.setFloat64(at + J.heatCapacity, d.heatCapacityJPerK, true); view.setFloat64(at + J.stillAirConductance, d.stillAirConductanceWPerK, true);
    view.setFloat64(at + J.airflowConductance, d.airflowConductanceWPerK, true); view.setFloat64(at + J.entropicCoefficient, d.entropicVPerK, true);
    view.setFloat64(at + J.capacityRetention, d.capacityRetention, true); view.setFloat64(at + J.resistanceGrowth, d.resistanceGrowth, true);
    for (let i = 0; i < BUS_V2.tablePoints; i++) view.setFloat64(at + J.openCircuitTable + 8 * i, d.openCircuitTableV[i]!, true);
    if (table) {
      if (table.length !== BUS_V2.tablePoints) throw new Error('Invalid bus battery dynamics');
      for (let i = 0; i < BUS_V2.tablePoints; i++) view.setFloat64(at + BUS_V3.seriesResistanceTable + 8 * i, table[i]!, true);
    }
  }
  return bytes;
}

function callable(value: unknown): value is (...args: number[]) => number { return typeof value === 'function'; }

/**
 * One shared bus in its own WASM instance. `stepInto` advances the charge by
 * one tick for a signed motor power (negative while regenerating) and a house
 * load, and writes the bus state into `output`:
 * [soc, voltage V, current A, delivered W, internal loss W, source W, flags,
 *  branch 1 V, branch 2 V, temperature K, heat W, open-circuit V]; the last five are 0 for a pack without dynamics.
 */
export class BetBus {
  readonly output = new Float64Array(12);
  /**
   * The step's inputs for `stepFromInput`: [soc, motor power W, house power W, branch 1 V, branch 2 V, temperature K,
   * air temperature K, airspeed m/s]; the last five only for a pack with dynamics (TASK-104). A hot caller writes them here:
   * V8 boxes a double passed as a call argument when the call is not inlined, which a large caller (the flight step with its
   * weather) cannot rely on.
   */
  readonly input = new Float64Array(8);
  readonly dtS: number;
  /** The pack has TASK-104 dynamics: its records are version 2. */
  readonly dynamic: boolean;
  lastStatus = 0;
  private readonly memory: WebAssembly.Memory;
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly inputAt: number;
  private readonly outputAt: number;
  private readonly table: Float64Array;
  private readonly nativeStep: (...args: number[]) => number;
  constructor(module: WebAssembly.Module, battery: BusBattery, hz: 400 | 800 | 1200 | 4800) {
    if (![400, 800, 1200, 4800].includes(hz)) throw new Error('Invalid bus rate');
    const values = [battery.openCircuitFullV, battery.openCircuitEmptyV, battery.internalResistanceOhm, battery.capacityAh, battery.currentLimitA];
    if (!values.every(Number.isFinite) || battery.openCircuitEmptyV <= 0 || battery.openCircuitFullV < battery.openCircuitEmptyV ||
        battery.internalResistanceOhm < 0 || battery.capacityAh <= 0 || battery.currentLimitA <= 0) throw new Error('Invalid bus battery');
    const e = new WebAssembly.Instance(module, {}).exports;
    this.dynamic = battery.dynamics !== undefined;
    if (!(e.memory instanceof WebAssembly.Memory) || !(e.__heap_base instanceof WebAssembly.Global) ||
        typeof e.__heap_base.value !== 'number' || !callable(e.bet_bus_version) || e.bet_bus_version() !== BUS_V1.version ||
        !callable(e.bet_bus_step) || (this.dynamic && (!callable(e.bet_bus_v2_version) || e.bet_bus_v2_version() !== BUS_V2.version)) ||
        (battery.dynamics?.seriesResistanceTable !== undefined && (!callable(e.bet_bus_v3_version) || e.bet_bus_v3_version() !== BUS_V3.version)))
      throw new Error('Missing shared bus export');
    this.dtS = 1 / hz; this.memory = e.memory; this.nativeStep = e.bet_bus_step;
    this.inputAt = Math.ceil(e.__heap_base.value / 64) * 64; this.outputAt = this.inputAt + BUS_V3.inputBytes;
    const end = this.outputAt + BUS_V1.outputBytes;
    if (this.memory.buffer.byteLength < end) this.memory.grow(Math.ceil((end - this.memory.buffer.byteLength) / 65536));
    this.buffer = this.memory.buffer; this.view = new DataView(this.buffer);
    writeBusRecord(this.view, this.inputAt, battery);
    this.table = Float64Array.from(battery.dynamics?.openCircuitTableV ?? []);
  }
  get memoryStable(): boolean { return this.memory.buffer === this.buffer; }
  /** Open-circuit voltage at a charge (at the reference temperature for a dynamic pack), the bus voltage with no load. */
  openCircuitV(soc: number): number {
    if (soc <= 0) return 0;
    if (this.dynamic) {
      const n = this.table.length - 1, x = Math.min(soc, 1) * n, i = Math.min(Math.floor(x), n - 1);
      return this.table[i]! + (this.table[i + 1]! - this.table[i]!) * (x - i);
    }
    const v = this.view, at = this.inputAt, I = BUS_V1.input;
    const full = v.getFloat64(at + I.openCircuitFull, true), empty = v.getFloat64(at + I.openCircuitEmpty, true);
    return empty + (full - empty) * soc;
  }
  /** One bus step from scalar arguments, through `input`; false on a non-zero status (see `lastStatus`), leaving `output` unchanged. */
  stepInto(soc: number, motorPowerW: number, housePowerW: number): boolean {
    const input = this.input;
    input[0] = soc; input[1] = motorPowerW; input[2] = housePowerW;
    return this.stepFromInput();
  }
  /** One allocation-free bus step from `input`; false on a non-zero status (see `lastStatus`), leaving `output` unchanged. */
  stepFromInput(): boolean {
    if (!this.memoryStable) { this.lastStatus = -5; return false; }
    const v = this.view, at = this.inputAt, I = BUS_V1.input, input = this.input;
    v.setFloat64(at + I.stateOfCharge, input[0]!, true); v.setFloat64(at + I.motorPower, input[1]!, true);
    v.setFloat64(at + I.housePower, input[2]!, true);
    if (this.dynamic) {
      const J = BUS_V2.input;
      v.setFloat64(at + J.branch1Voltage, input[3]!, true); v.setFloat64(at + J.branch2Voltage, input[4]!, true);
      v.setFloat64(at + J.temperature, input[5]!, true); v.setFloat64(at + J.airTemperature, input[6]!, true);
      v.setFloat64(at + J.airspeed, input[7]!, true);
    }
    const status = this.nativeStep(at, this.outputAt, this.dtS);
    this.lastStatus = status;
    if (status !== 0) return false;
    for (let i = 0; i < 6; i++) this.output[i] = v.getFloat64(this.outputAt + i * 8, true);
    this.output[6] = v.getUint32(this.outputAt + BUS_V1.output.flags, true);
    for (let i = 0; i < 5; i++) this.output[7 + i] = this.dynamic ? v.getFloat64(this.outputAt + BUS_V2.output.branch1Voltage + i * 8, true) : 0;
    return true;
  }
}
