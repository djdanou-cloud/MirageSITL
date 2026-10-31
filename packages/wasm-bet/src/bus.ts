/** Shared battery bus record (TASK-092) over `bet_bus_step`; no hot-path host objects or views. */

/** Byte offsets of the 128-byte input and output records (SPECS_SIMULATION_ENGINES.md). */
export const BUS_V1 = {
  version: 1, inputBytes: 128, outputBytes: 128, flagPowerLimited: 1, flagChargeLimited: 2,
  input: { version: 0, openCircuitFull: 8, openCircuitEmpty: 16, internalResistance: 24, capacityCoulomb: 32,
    currentLimit: 40, stateOfCharge: 48, motorPower: 56, housePower: 64 },
  output: { stateOfCharge: 0, voltage: 8, current: 16, deliveredPower: 24, internalLoss: 32, sourcePower: 40, flags: 48 },
} as const;

/** Linear open-circuit voltage pack; SI units, capacity in ampere-hours. */
export interface BusBattery {
  readonly openCircuitFullV: number; readonly openCircuitEmptyV: number; readonly internalResistanceOhm: number;
  readonly capacityAh: number; readonly currentLimitA: number;
}

function callable(value: unknown): value is (...args: number[]) => number { return typeof value === 'function'; }

/**
 * One shared bus in its own WASM instance. `stepInto` advances the charge by
 * one tick for a signed motor power (negative while regenerating) and a house
 * load, and writes the bus state into `output`:
 * [soc, voltage V, current A, delivered W, internal loss W, source W, flags].
 */
export class BetBus {
  readonly output = new Float64Array(7);
  readonly dtS: number;
  lastStatus = 0;
  private readonly memory: WebAssembly.Memory;
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly inputAt: number;
  private readonly outputAt: number;
  private readonly nativeStep: (...args: number[]) => number;
  constructor(module: WebAssembly.Module, battery: BusBattery, hz: 400 | 800 | 1200 | 4800) {
    if (![400, 800, 1200, 4800].includes(hz)) throw new Error('Invalid bus rate');
    const values = [battery.openCircuitFullV, battery.openCircuitEmptyV, battery.internalResistanceOhm, battery.capacityAh, battery.currentLimitA];
    if (!values.every(Number.isFinite) || battery.openCircuitEmptyV <= 0 || battery.openCircuitFullV < battery.openCircuitEmptyV ||
        battery.internalResistanceOhm < 0 || battery.capacityAh <= 0 || battery.currentLimitA <= 0) throw new Error('Invalid bus battery');
    const e = new WebAssembly.Instance(module, {}).exports;
    if (!(e.memory instanceof WebAssembly.Memory) || !(e.__heap_base instanceof WebAssembly.Global) ||
        typeof e.__heap_base.value !== 'number' || !callable(e.bet_bus_version) || e.bet_bus_version() !== BUS_V1.version ||
        !callable(e.bet_bus_step)) throw new Error('Missing shared bus export');
    this.dtS = 1 / hz; this.memory = e.memory; this.nativeStep = e.bet_bus_step;
    this.inputAt = Math.ceil(e.__heap_base.value / 64) * 64; this.outputAt = this.inputAt + BUS_V1.inputBytes;
    const end = this.outputAt + BUS_V1.outputBytes;
    if (this.memory.buffer.byteLength < end) this.memory.grow(Math.ceil((end - this.memory.buffer.byteLength) / 65536));
    this.buffer = this.memory.buffer; this.view = new DataView(this.buffer);
    new Uint8Array(this.buffer, this.inputAt, BUS_V1.inputBytes).fill(0);
    const v = this.view, at = this.inputAt, I = BUS_V1.input;
    v.setUint32(at, BUS_V1.version, true);
    v.setFloat64(at + I.openCircuitFull, battery.openCircuitFullV, true); v.setFloat64(at + I.openCircuitEmpty, battery.openCircuitEmptyV, true);
    v.setFloat64(at + I.internalResistance, battery.internalResistanceOhm, true);
    v.setFloat64(at + I.capacityCoulomb, battery.capacityAh * 3600, true); v.setFloat64(at + I.currentLimit, battery.currentLimitA, true);
  }
  get memoryStable(): boolean { return this.memory.buffer === this.buffer; }
  /** Open-circuit voltage at a charge, the bus voltage with no load. */
  openCircuitV(soc: number): number {
    const v = this.view, at = this.inputAt, I = BUS_V1.input;
    const full = v.getFloat64(at + I.openCircuitFull, true), empty = v.getFloat64(at + I.openCircuitEmpty, true);
    return soc <= 0 ? 0 : empty + (full - empty) * soc;
  }
  /** One allocation-free bus step; false on a non-zero status (see `lastStatus`), leaving `output` unchanged. */
  stepInto(soc: number, motorPowerW: number, housePowerW: number): boolean {
    if (!this.memoryStable) { this.lastStatus = -5; return false; }
    const v = this.view, at = this.inputAt, I = BUS_V1.input;
    v.setFloat64(at + I.stateOfCharge, soc, true); v.setFloat64(at + I.motorPower, motorPowerW, true);
    v.setFloat64(at + I.housePower, housePowerW, true);
    const status = this.nativeStep(at, this.outputAt, this.dtS);
    this.lastStatus = status;
    if (status !== 0) return false;
    for (let i = 0; i < 6; i++) this.output[i] = v.getFloat64(this.outputAt + i * 8, true);
    this.output[6] = v.getUint32(this.outputAt + BUS_V1.output.flags, true);
    return true;
  }
}
