/** Bound-rotor step interface v2 (TASK-088) on v1 arenas; no hot-path host objects or views. */
import { encodeBoundRotor, type BoundRotorDefinition } from './rotor.ts';
import { BUS_V1, openCircuitV, writeBusInput, type BusBattery } from './bus.ts';

/** Byte offsets of the 256-byte input and output records (SPECS_SIMULATION_ENGINES.md). */
export const BOUND_V2 = {
  version: 2, inputBytes: 256, outputBytes: 256, unsupported: -8,
  input: { version: 0, flags: 4, driveMode: 8, density: 16, viscosity: 24, soundSpeed: 32, airVelocityHub: 40,
    bodyRateHub: 64, collective: 88, cyclicCos: 96, cyclicSin: 104, motorTorque: 112, escDuty: 120,
    busVoltage: 128, externalWakeHub: 136, groundNormalHub: 160, groundDistance: 184,
    // TASK-092 drive mode 1: seven f64 parameters, then the drive flags word.
    motorResistance: 192, motorTorqueConstant: 200, motorCurrentLimit: 208, motorBrakeCurrentLimit: 216,
    motorNoLoadTorque: 224, escCommandTau: 232, escUpdatePeriod: 240, driveFlags: 248 },
  output: { forceHub: 0, airMomentHub: 24, transmittedMomentHub: 48, omega: 72, aerodynamicShaftTorque: 80,
    shaftPower: 88, inducedAxial: 96, coneAngle: 104, flags: 112, validity: 116, angularMomentumAxial: 120,
    inflowCos: 128, inflowSin: 136, motorCurrent: 144, busCurrent: 152, electricalPower: 160, copperLoss: 168 },
  groundPlane: 1, driveTorque: 0, driveEscDuty: 1, drivePowerCut: 1, flagCurrentLimited: 32,
  validElectrical: 1, validInflowHarmonics: 2, validGroundEffect: 4, validExternalWake: 8,
} as const;
/** Input row: the 22 f64 fields at record bytes 16..191, in record order. */
export const BOUND_V2_INPUT_DOUBLES = 22;
/** Output row: f64 bytes 0..111, flags, validity, then f64 bytes 120..175. */
export const BOUND_V2_OUTPUT_SLOTS = 23;
export const BOUND_V2_OUTPUT_FLAGS_SLOT = 14;
export const BOUND_V2_OUTPUT_VALIDITY_SLOT = 15;
/** Drive row: the seven f64 drive-mode-1 parameters at record bytes 192..247, in record order. */
export const BOUND_V2_DRIVE_DOUBLES = 7;

/**
 * The ESC drive step `bet_drive_step` (TASK-092): every drive-mode-1 rotor and
 * the shared bus in one call. The output record repeats the shared bus output
 * in bytes 0..51 and adds the motors' supply voltage and summed terminal power.
 */
export const DRIVE_V1 = {
  version: 1, tableEntryBytes: 12, outputBytes: 128, maxRotors: 32, flagPowerLimited: 1, flagChargeLimited: 2,
  output: { stateOfCharge: 0, voltage: 8, current: 16, deliveredPower: 24, internalLoss: 32, sourcePower: 40, flags: 48,
    supplyVoltage: 56, motorPower: 64 },
} as const;
/** `busOutput` slots: the shared bus output, its flags, then the supply voltage and the summed terminal power. */
export const DriveBusSlot = Object.freeze({ StateOfCharge: 0, VoltageV: 1, CurrentA: 2, DeliveredW: 3, InternalLossW: 4, SourceW: 5,
  Flags: 6, SupplyVoltageV: 7, MotorPowerW: 8, length: 9 });

function callable(value: unknown): value is (...args: number[]) => number { return typeof value === 'function'; }

/**
 * A dedicated WASM instance owns up to 32 bound rotors stepped through
 * interface v2. Fields owned by later tasks must stay neutral; a step that
 * returns a status leaves `output` partially updated only for earlier rotors
 * and records the status in `lastStatus`. With a battery, `stepBusInto` steps
 * every rotor in drive mode 1 and the shared bus together (TASK-092).
 */
export class BetRotorEngineV2 {
  readonly count: number;
  readonly input: Float64Array;
  /** Input flags word per rotor (bit 0: ground plane, TASK-100). */
  readonly inputFlags: Uint32Array;
  /** Drive mode per rotor (0 torque; 1 ESC duty, TASK-092). */
  readonly driveMode: Uint32Array;
  /** Drive-mode-1 parameters per rotor (TASK-092); zero in drive mode 0. */
  readonly drive: Float64Array;
  /** Drive flags per rotor (bit 0: power cut, TASK-092). */
  readonly driveFlags: Uint32Array;
  readonly output: Float64Array;
  /**
   * [state of charge, house load W] that `stepBusInto` reads; the caller writes
   * them before each step. A typed array, not call arguments: V8 can box a
   * double passed to a call it does not inline. Empty without a battery.
   */
  readonly busInput: Float64Array;
  /** The last `stepBusInto` bus record (`DriveBusSlot` order); empty without a battery. */
  readonly busOutput: Float64Array;
  readonly dtS: number;
  lastStatus = 0;
  private readonly memory: WebAssembly.Memory;
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly handles: Uint32Array;
  private readonly inputs: Uint32Array;
  private readonly outputs: Uint32Array;
  private readonly initial: Float64Array;
  private readonly nativeStep: (...args: number[]) => number;
  private readonly nativeReset: (...args: number[]) => number;
  private readonly nativeDispose: (...args: number[]) => number;
  private readonly nativeDriveStep: ((...args: number[]) => number) | null;
  private readonly battery: BusBattery | null;
  /** Byte addresses of the drive table and the bus input and output records; 0 without a battery. */
  private readonly tableAt: number;
  private readonly busInputAt: number;
  private readonly busOutputAt: number;
  private disposed = false;
  /** With `battery`, the instance also holds a shared bus for `stepBusInto`. */
  constructor(module: WebAssembly.Module, definitions: readonly BoundRotorDefinition[], hz: 400 | 800 | 1200 | 4800, battery?: BusBattery) {
    if (![400, 800, 1200, 4800].includes(hz) || definitions.length < 1 || definitions.length > 32) throw new Error('Invalid bound rotor count/rate');
    const e = new WebAssembly.Instance(module, {}).exports;
    if (!(e.memory instanceof WebAssembly.Memory) || !(e.__heap_base instanceof WebAssembly.Global) ||
        typeof e.__heap_base.value !== 'number' || !callable(e.bet_bound_version) || e.bet_bound_version() !== 1 ||
        !callable(e.bet_bound_v2_version) || e.bet_bound_v2_version() !== BOUND_V2.version ||
        !callable(e.bet_bound_init) || !callable(e.bet_bound_step_v2) || !callable(e.bet_bound_reset) || !callable(e.bet_bound_dispose))
      throw new Error('Missing bound rotor step interface v2');
    if (battery && (!callable(e.bet_drive_version) || e.bet_drive_version() !== DRIVE_V1.version || !callable(e.bet_drive_step) ||
        !callable(e.bet_bus_version) || e.bet_bus_version() !== BUS_V1.version)) throw new Error('Missing ESC drive step');
    this.nativeDriveStep = battery && callable(e.bet_drive_step) ? e.bet_drive_step : null;
    this.battery = battery ?? null; this.busOutput = new Float64Array(battery ? DriveBusSlot.length : 0);
    this.busInput = new Float64Array(battery ? 2 : 0);
    this.count = definitions.length; this.dtS = 1 / hz; this.memory = e.memory;
    this.nativeStep = e.bet_bound_step_v2; this.nativeReset = e.bet_bound_reset; this.nativeDispose = e.bet_bound_dispose;
    this.handles = new Uint32Array(this.count); this.inputs = new Uint32Array(this.count); this.outputs = new Uint32Array(this.count);
    this.initial = new Float64Array(this.count); this.inputFlags = new Uint32Array(this.count); this.driveMode = new Uint32Array(this.count);
    this.drive = new Float64Array(this.count * BOUND_V2_DRIVE_DOUBLES); this.driveFlags = new Uint32Array(this.count);
    this.input = new Float64Array(this.count * BOUND_V2_INPUT_DOUBLES); this.output = new Float64Array(this.count * BOUND_V2_OUTPUT_SLOTS);
    const payloads = definitions.map(d => encodeBoundRotor(d, this.dtS));
    let at = Math.ceil(e.__heap_base.value / 64) * 64;
    const configs: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const bytes = payloads[i]!; configs.push(at); at += Math.ceil(bytes.length / 64) * 64;
      this.handles[i] = at; at += Math.ceil((bytes.length + 64) / 64) * 64;
      this.inputs[i] = at; at += BOUND_V2.inputBytes; this.outputs[i] = at; at += BOUND_V2.outputBytes;
      this.initial[i] = definitions[i]!.initialOmegaRadS;
      const row = i * BOUND_V2_INPUT_DOUBLES;
      this.input[row] = 1.225; this.input[row + 1] = 1.789e-5; this.input[row + 2] = 340;
    }
    this.tableAt = battery ? at : 0; at += battery ? Math.ceil(this.count * DRIVE_V1.tableEntryBytes / 64) * 64 : 0;
    this.busInputAt = battery ? at : 0; at += battery ? BUS_V1.inputBytes : 0;
    this.busOutputAt = battery ? at : 0; at += battery ? DRIVE_V1.outputBytes : 0;
    if (at > 64 * 1024 * 1024) throw new Error('Bound rotor memory budget exceeded');
    if (this.memory.buffer.byteLength < at) this.memory.grow(Math.ceil((at - this.memory.buffer.byteLength) / 65536));
    this.buffer = this.memory.buffer; this.view = new DataView(this.buffer);
    for (let i = 0; i < this.count; i++) {
      const bytes = payloads[i]!, cp = configs[i]!, handle = this.handles[i]!;
      new Uint8Array(this.buffer, cp, bytes.length).set(bytes);
      const status = e.bet_bound_init(cp, bytes.length, handle, bytes.length + 64);
      if (status !== 0) throw new Error(`Invalid bound rotor configuration: ${status}`);
      const ip = this.inputs[i]!;
      new Uint8Array(this.buffer, ip, BOUND_V2.inputBytes).fill(0);
      this.view.setUint32(ip, BOUND_V2.version, true);
      this.output[i * BOUND_V2_OUTPUT_SLOTS + 9] = this.initial[i]!;
    }
    if (battery) {
      writeBusInput(this.view, this.busInputAt, battery);
      for (let i = 0; i < this.count; i++) {
        const entry = this.tableAt + i * DRIVE_V1.tableEntryBytes;
        this.view.setUint32(entry, this.handles[i]!, true); this.view.setUint32(entry + 4, this.inputs[i]!, true);
        this.view.setUint32(entry + 8, this.outputs[i]!, true);
      }
    }
  }
  get memoryStable(): boolean { return this.memory.buffer === this.buffer; }
  /** Open-circuit voltage of the engine's pack at a charge (cold); 0 without a battery. */
  openCircuitV(soc: number): number { return this.battery ? openCircuitV(this.battery, soc) : 0; }
  get memoryBytes(): number { return this.buffer.byteLength; }
  /** One allocation-free step of every rotor; false on any non-zero status (see `lastStatus`). */
  stepInto(): boolean {
    if (!this.inputsValid()) return false;
    for (let i = 0; i < this.count; i++) {
      this.writeRecord(i);
      const status = this.nativeStep(this.handles[i]!, this.inputs[i]!, this.outputs[i]!, this.dtS);
      this.lastStatus = status;
      if (status !== 0) return false;
      this.readRecord(i);
    }
    return true;
  }
  /**
   * One allocation-free ESC drive step (TASK-092): every rotor in drive mode 1
   * at the bus voltage of its input row, all rows holding the same voltage, and
   * the shared bus at the charge and house load in `busInput`. The bus record
   * goes to `busOutput`. False on a non-zero status (see `lastStatus`), which
   * leaves the arenas, `output` and `busOutput` unchanged.
   */
  stepBusInto(): boolean {
    const nativeDriveStep = this.nativeDriveStep;
    if (nativeDriveStep === null) { this.lastStatus = -3; return false; }
    if (!this.inputsValid()) return false;
    for (let i = 0; i < this.count; i++) this.writeRecord(i);
    const v = this.view, at = this.busInputAt, I = BUS_V1.input, b = this.busInput;
    v.setFloat64(at + I.stateOfCharge, b[0]!, true); v.setFloat64(at + I.motorPower, 0, true); v.setFloat64(at + I.housePower, b[1]!, true);
    const status = nativeDriveStep(this.tableAt, this.count, this.busInputAt, this.busOutputAt, this.dtS);
    this.lastStatus = status;
    if (status !== 0) return false;
    for (let i = 0; i < this.count; i++) this.readRecord(i);
    const o = this.busOutput, op = this.busOutputAt, O = DRIVE_V1.output;
    for (let i = 0; i < 6; i++) o[i] = v.getFloat64(op + i * 8, true);
    o[DriveBusSlot.Flags] = v.getUint32(op + O.flags, true);
    o[DriveBusSlot.SupplyVoltageV] = v.getFloat64(op + O.supplyVoltage, true);
    o[DriveBusSlot.MotorPowerW] = v.getFloat64(op + O.motorPower, true);
    return true;
  }
  private inputsValid(): boolean {
    if (this.disposed || !this.memoryStable) return false;
    for (let i = 0; i < this.input.length; i++) if (!Number.isFinite(this.input[i])) { this.lastStatus = -3; return false; }
    for (let i = 0; i < this.drive.length; i++) if (!Number.isFinite(this.drive[i])) { this.lastStatus = -3; return false; }
    return true;
  }
  private writeRecord(i: number): void {
    const ip = this.inputs[i]!, row = i * BOUND_V2_INPUT_DOUBLES, v = this.view;
    v.setUint32(ip + BOUND_V2.input.flags, this.inputFlags[i]!, true);
    v.setUint32(ip + BOUND_V2.input.driveMode, this.driveMode[i]!, true);
    for (let j = 0; j < BOUND_V2_INPUT_DOUBLES; j++) v.setFloat64(ip + 16 + j * 8, this.input[row + j]!, true);
    const drive = i * BOUND_V2_DRIVE_DOUBLES;
    for (let j = 0; j < BOUND_V2_DRIVE_DOUBLES; j++) v.setFloat64(ip + BOUND_V2.input.motorResistance + j * 8, this.drive[drive + j]!, true);
    v.setUint32(ip + BOUND_V2.input.driveFlags, this.driveFlags[i]!, true);
  }
  private readRecord(i: number): void {
    const op = this.outputs[i]!, out = i * BOUND_V2_OUTPUT_SLOTS, v = this.view;
    for (let j = 0; j < 14; j++) this.output[out + j] = v.getFloat64(op + j * 8, true);
    this.output[out + BOUND_V2_OUTPUT_FLAGS_SLOT] = v.getUint32(op + BOUND_V2.output.flags, true);
    this.output[out + BOUND_V2_OUTPUT_VALIDITY_SLOT] = v.getUint32(op + BOUND_V2.output.validity, true);
    for (let j = 0; j < 7; j++) this.output[out + 16 + j] = v.getFloat64(op + 120 + j * 8, true);
  }
  reset(): void {
    if (this.disposed || !this.memoryStable) throw new Error('Cannot reset an invalid bound rotor engine');
    this.output.fill(0);
    for (let i = 0; i < this.count; i++) {
      if (this.nativeReset(this.handles[i]!) !== 0) throw new Error('Bound rotor reset failed');
      this.output[i * BOUND_V2_OUTPUT_SLOTS + 9] = this.initial[i]!;
    }
  }
  dispose(): void {
    if (!this.disposed && this.memoryStable) for (let i = 0; i < this.count; i++) this.nativeDispose(this.handles[i]!);
    this.disposed = true;
  }
}
