/**
 * Battery and propulsion limits (TASK-146).
 *
 * `PowerTelemetry` holds the per-motor and battery electrical values of the
 * last step in preallocated arrays. `LimitMonitor` compares them with the
 * component ratings and with the clamps the model applied, and keeps two
 * masks apart: a `warning` bit means a rating is exceeded while physics runs
 * on unchanged; a `limited` bit means the model itself clamped the value.
 * Each mask bit that changes adds a `start` or `end` event to a bounded
 * outbox. `evaluate` allocates nothing; `drain` builds event objects and runs
 * only after the compute batch.
 */

export const LIMIT_RATINGS_SCHEMA_VERSION = 1;
/** Motor rows per telemetry record; the vehicle manifest allows at most 16 motors. */
export const MAX_MOTORS = 16;

/** One motor's component ratings; null where the card states none. Never checked when null. */
export interface MotorRatings {
  /** Motor card maximum current, A. */
  readonly motorCurrentA: number | null;
  /** Motor card maximum electrical power, W. */
  readonly motorPowerW: number | null;
  /** ESC card maximum current, A, compared with the motor current. */
  readonly escCurrentA: number | null;
  /** ESC card maximum input voltage, V, compared with the bus voltage. */
  readonly escVoltageV: number | null;
  /** Maximum speed, rev/min; component card schema 1 has no such field. */
  readonly rpm: number | null;
}
export interface BatteryRatings {
  /** Pack voltage at the empty cell voltage, V; the bus voltage below it is an under-voltage warning. */
  readonly emptyVoltageV: number | null;
}
/** Limit ratings v1: one entry per motor in rotor order, and the battery. */
export interface LimitRatings {
  readonly schemaVersion: 1;
  readonly motors: readonly MotorRatings[];
  readonly battery: BatteryRatings;
}

/** Warning bits of a motor: a rating is exceeded; physics is unchanged. */
export const MotorWarning = Object.freeze({ MotorCurrent: 1, MotorPower: 2, EscCurrent: 4, EscVoltage: 8, Rpm: 16 });
/** Limited bits of a motor: the drive clamped its current (bound-rotor v2 output flag 32). */
export const MotorLimited = Object.freeze({ CurrentLimit: 1 });
/** Warning bits of the battery. */
export const BatteryWarning = Object.freeze({ UnderVoltage: 1 });
/**
 * Limited bits of the battery: shared bus flag 1 (the pack current limit, discharging or
 * regenerating) and flag 2 (regeneration into a full pack).
 */
export const BatteryLimited = Object.freeze({ PackCurrent: 1, Charge: 2 });

export type LimitQuantity =
  | 'motor-current' | 'motor-power' | 'esc-current' | 'esc-voltage' | 'rpm' | 'battery-voltage'
  | 'current-limit' | 'pack-current-limit' | 'charge-limit';
export type LimitKind = 'warning' | 'limited';

/** One change of an exceedance, built by `drain`. */
export interface LimitEvent {
  readonly tick: number;
  readonly simTimeS: number;
  /** Motor index in rotor order, or 'battery'. */
  readonly subject: number | 'battery';
  readonly quantity: LimitQuantity;
  readonly kind: LimitKind;
  readonly edge: 'start' | 'end';
  /** The value at the change, in the quantity's unit (A, W, V, rev/min, or the state of charge). */
  readonly value: number;
  /** The rating or modeled limit it is compared with; NaN when the model states none. */
  readonly limit: number;
}

/** Per-motor telemetry columns, `stride` doubles per motor. */
export const MotorColumn = Object.freeze({ Rpm: 0, MotorCurrentA: 1, BusCurrentA: 2, ElectricalPowerW: 3, Command: 4, stride: 5 });
/** Battery telemetry slots. */
export const BatteryColumn = Object.freeze({ StateOfCharge: 0, VoltageV: 1, CurrentA: 2, PowerW: 3, RemainingAh: 4, CapacityAh: 5, length: 6 });

/** The last step's electrical values and masks; written in place every step. */
export class PowerTelemetry {
  readonly motorCount: number;
  /** `MotorColumn.stride` doubles per motor. */
  readonly motors: Float64Array;
  readonly motorWarning: Uint32Array;
  readonly motorLimited: Uint32Array;
  /** `BatteryColumn` slots. */
  readonly battery = new Float64Array(BatteryColumn.length);
  /** [warning, limited] bits of the battery. */
  readonly batteryMasks = new Uint32Array(2);
  constructor(motorCount: number) {
    if (!Number.isInteger(motorCount) || motorCount < 1 || motorCount > MAX_MOTORS) throw new RangeError('Invalid motor count');
    this.motorCount = motorCount;
    this.motors = new Float64Array(motorCount * MotorColumn.stride);
    this.motorWarning = new Uint32Array(motorCount);
    this.motorLimited = new Uint32Array(motorCount);
  }
  clear(): void {
    this.motors.fill(0); this.motorWarning.fill(0); this.motorLimited.fill(0); this.battery.fill(0); this.batteryMasks.fill(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function rating(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number or null`);
  return value;
}
const MOTOR_KEYS = ['motorCurrentA', 'motorPowerW', 'escCurrentA', 'escVoltageV', 'rpm'] as const;

/** Validates limit ratings v1 from unknown input; `motorCount` must match when given. */
export function parseLimitRatings(value: unknown, motorCount?: number): LimitRatings {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'motors', 'battery']) || value.schemaVersion !== LIMIT_RATINGS_SCHEMA_VERSION) {
    throw new RangeError('Limit ratings must be schema 1 with motors and battery');
  }
  const motors = value.motors, battery = value.battery;
  if (!Array.isArray(motors) || motors.length < 1 || motors.length > MAX_MOTORS) throw new RangeError('Limit ratings need 1 to 16 motors');
  if (motorCount !== undefined && motors.length !== motorCount) throw new RangeError(`Limit ratings list ${motors.length} motors, the model has ${motorCount}`);
  const parsedMotors = motors.map((m: unknown, i): MotorRatings => {
    if (!isRecord(m) || !exactKeys(m, MOTOR_KEYS)) throw new RangeError(`Motor ${i} ratings must have ${MOTOR_KEYS.join(', ')}`);
    return Object.freeze({
      motorCurrentA: rating(m.motorCurrentA, `motor ${i} motorCurrentA`), motorPowerW: rating(m.motorPowerW, `motor ${i} motorPowerW`),
      escCurrentA: rating(m.escCurrentA, `motor ${i} escCurrentA`), escVoltageV: rating(m.escVoltageV, `motor ${i} escVoltageV`),
      rpm: rating(m.rpm, `motor ${i} rpm`),
    });
  });
  if (!isRecord(battery) || !exactKeys(battery, ['emptyVoltageV'])) throw new RangeError('Battery ratings must have emptyVoltageV');
  return Object.freeze({
    schemaVersion: 1, motors: Object.freeze(parsedMotors),
    battery: Object.freeze({ emptyVoltageV: rating(battery.emptyVoltageV, 'battery emptyVoltageV') }),
  });
}

// Event quantity codes, in `LimitQuantity` order; their kind follows from the code.
const QUANTITIES: readonly LimitQuantity[] = ['motor-current', 'motor-power', 'esc-current', 'esc-voltage', 'rpm', 'battery-voltage',
  'current-limit', 'pack-current-limit', 'charge-limit'];
const Q = Object.freeze({ MotorCurrent: 0, MotorPower: 1, EscCurrent: 2, EscVoltage: 3, Rpm: 4, BatteryVoltage: 5,
  CurrentLimit: 6, PackCurrentLimit: 7, ChargeLimit: 8 });
const BATTERY_SUBJECT = -1;
/** Outbox capacity; events beyond it are counted in `dropped`. */
export const LIMIT_OUTBOX_CAPACITY = 256;

/**
 * Compares telemetry with ratings and modeled clamps and records mask edges.
 * `currentLimitA` and `brakeCurrentLimitA` are the drive's per-motor limits for
 * driving and braking current, and `packCurrentLimitA` the pack current limit;
 * each is reported with its `limited` events.
 */
export class LimitMonitor {
  readonly ratings: LimitRatings | null;
  /** Events lost because the outbox was full. */
  dropped = 0;
  private readonly hz: number;
  private readonly limits: Float64Array;
  /** Per motor: [motorCurrentA, motorPowerW, escCurrentA, escVoltageV, rpm], NaN where none. */
  private readonly motorRatings: Float64Array;
  private readonly emptyVoltage: Float64Array;
  private readonly previousMotor: Uint32Array;
  private readonly previousBattery = new Uint32Array(2);
  private readonly tick = new Float64Array(LIMIT_OUTBOX_CAPACITY);
  private readonly subject = new Int8Array(LIMIT_OUTBOX_CAPACITY);
  private readonly quantity = new Uint8Array(LIMIT_OUTBOX_CAPACITY);
  private readonly edge = new Uint8Array(LIMIT_OUTBOX_CAPACITY);
  private readonly value = new Float64Array(LIMIT_OUTBOX_CAPACITY);
  private readonly limit = new Float64Array(LIMIT_OUTBOX_CAPACITY);
  /** [value, limit] of the event being queued. */
  private readonly staged = new Float64Array(2);
  private head = 0;
  private count = 0;

  constructor(motorCount: number, ratings: LimitRatings | null, currentLimitA: readonly number[], brakeCurrentLimitA: readonly number[],
    packCurrentLimitA: number, hz: number) {
    if (ratings && ratings.motors.length !== motorCount) throw new RangeError('Limit ratings do not match the motor count');
    const positive = (values: readonly number[]) => values.length === motorCount && values.every(v => Number.isFinite(v) && v > 0);
    if (!positive(currentLimitA) || !positive(brakeCurrentLimitA) || !Number.isFinite(packCurrentLimitA) || packCurrentLimitA <= 0 ||
      !(hz > 0)) throw new RangeError('Invalid modeled limits');
    this.ratings = ratings; this.hz = hz;
    // Drive limits, then brake limits, then the pack limit.
    this.limits = new Float64Array([...currentLimitA, ...brakeCurrentLimitA, packCurrentLimitA]);
    this.motorRatings = new Float64Array(motorCount * 5).fill(NaN);
    ratings?.motors.forEach((m, i) => MOTOR_KEYS.forEach((key, j) => { this.motorRatings[i * 5 + j] = m[key] ?? NaN; }));
    this.emptyVoltage = new Float64Array([ratings?.battery.emptyVoltageV ?? NaN]);
    this.previousMotor = new Uint32Array(motorCount * 2);
    this.prime(motorCount);
  }

  /**
   * Runs every event branch once on synthetic telemetry, then resets. V8
   * optimizes `evaluate` with the type feedback of the branches it has seen; a
   * branch first taken mid-flight (a pack crossing its empty voltage) would
   * otherwise deoptimize it, and the unoptimized code boxes doubles until it
   * is optimized again. Cold, at construction.
   */
  private prime(motorCount: number): void {
    const t = new PowerTelemetry(motorCount);
    const pass = (current: number, power: number, rpm: number, volts: number, motorLimited: number, batteryLimited: number) => {
      for (let i = 0; i < motorCount; i++) {
        t.motors[i * MotorColumn.stride + MotorColumn.MotorCurrentA] = current;
        t.motors[i * MotorColumn.stride + MotorColumn.ElectricalPowerW] = power;
        t.motors[i * MotorColumn.stride + MotorColumn.Rpm] = rpm;
        t.motorLimited[i] = motorLimited;
      }
      t.battery[BatteryColumn.VoltageV] = volts; t.batteryMasks[1] = batteryLimited;
      this.evaluate(t, 0);
    };
    // Every rating exceeded and every clamp set; then clamps released on a braking current under a low pack; then calm.
    pass(Infinity, Infinity, Infinity, Infinity, MotorLimited.CurrentLimit, BatteryLimited.PackCurrent | BatteryLimited.Charge);
    pass(-1, 0, 0, -Infinity, MotorLimited.CurrentLimit, 0);
    pass(-1, 0, 0, -Infinity, 0, 0);
    pass(0, 0, 0, Infinity, 0, 0);
    this.reset();
  }

  reset(): void {
    this.previousMotor.fill(0); this.previousBattery.fill(0);
    this.head = 0; this.count = 0; this.dropped = 0;
  }

  /**
   * Sets the warning masks of `t` from the ratings (the limited masks are set
   * by the dynamics from the model's flags) and records every changed bit.
   * Allocation-free; NaN ratings compare false, so they are never exceeded.
   */
  evaluate(t: PowerTelemetry, tick: number): void {
    const m = t.motors, r = this.motorRatings, stride = MotorColumn.stride, busV = t.battery[BatteryColumn.VoltageV]!;
    for (let i = 0; i < t.motorCount; i++) {
      const a = i * stride, b = i * 5;
      const signedCurrent = m[a + MotorColumn.MotorCurrentA]!, signedRpm = m[a + MotorColumn.Rpm]!, power = m[a + MotorColumn.ElectricalPowerW]!;
      const current = signedCurrent < 0 ? -signedCurrent : signedCurrent, rpm = signedRpm < 0 ? -signedRpm : signedRpm;
      const warning = (current > r[b]! ? MotorWarning.MotorCurrent : 0) | (power > r[b + 1]! ? MotorWarning.MotorPower : 0) |
        (current > r[b + 2]! ? MotorWarning.EscCurrent : 0) | (busV > r[b + 3]! ? MotorWarning.EscVoltage : 0) |
        (rpm > r[b + 4]! ? MotorWarning.Rpm : 0);
      t.motorWarning[i] = warning;
      this.motorEdges(i, warning, this.previousMotor[i * 2]!, t, tick, false);
      this.motorEdges(i, t.motorLimited[i]!, this.previousMotor[i * 2 + 1]!, t, tick, true);
      this.previousMotor[i * 2] = warning; this.previousMotor[i * 2 + 1] = t.motorLimited[i]!;
    }
    const batteryWarning = busV < this.emptyVoltage[0]! ? BatteryWarning.UnderVoltage : 0;
    t.batteryMasks[0] = batteryWarning;
    const limited = t.batteryMasks[1]!, staged = this.staged, battery = t.battery;
    let changed = batteryWarning ^ this.previousBattery[0]!;
    if (changed & BatteryWarning.UnderVoltage) {
      staged[0] = battery[BatteryColumn.VoltageV]!; staged[1] = this.emptyVoltage[0]!;
      this.push(tick, BATTERY_SUBJECT, Q.BatteryVoltage, batteryWarning !== 0);
    }
    changed = limited ^ this.previousBattery[1]!;
    if (changed & BatteryLimited.PackCurrent) {
      staged[0] = battery[BatteryColumn.CurrentA]!; staged[1] = this.limits[2 * t.motorCount]!;
      this.push(tick, BATTERY_SUBJECT, Q.PackCurrentLimit, (limited & BatteryLimited.PackCurrent) !== 0);
    }
    if (changed & BatteryLimited.Charge) {
      staged[0] = battery[BatteryColumn.StateOfCharge]!; staged[1] = 1;
      this.push(tick, BATTERY_SUBJECT, Q.ChargeLimit, (limited & BatteryLimited.Charge) !== 0);
    }
    this.previousBattery[0] = batteryWarning; this.previousBattery[1] = limited;
  }

  /** Records the changed bits of one motor mask; event values and limits go through `staged`. */
  private motorEdges(i: number, mask: number, previous: number, t: PowerTelemetry, tick: number, limited: boolean): void {
    const changed = mask ^ previous;
    if (changed === 0) return;
    const a = i * MotorColumn.stride, b = i * 5, m = t.motors, r = this.motorRatings, staged = this.staged;
    if (limited) {
      if (changed & MotorLimited.CurrentLimit) {
        // A negative (braking) current sits at the brake limit.
        staged[0] = m[a + MotorColumn.MotorCurrentA]!;
        staged[1] = this.limits[staged[0] < 0 ? t.motorCount + i : i]!;
        this.push(tick, i, Q.CurrentLimit, (mask & MotorLimited.CurrentLimit) !== 0);
      }
      return;
    }
    if (changed & MotorWarning.MotorCurrent) {
      staged[0] = Math.abs(m[a + MotorColumn.MotorCurrentA]!); staged[1] = r[b]!;
      this.push(tick, i, Q.MotorCurrent, (mask & MotorWarning.MotorCurrent) !== 0);
    }
    if (changed & MotorWarning.MotorPower) {
      staged[0] = m[a + MotorColumn.ElectricalPowerW]!; staged[1] = r[b + 1]!;
      this.push(tick, i, Q.MotorPower, (mask & MotorWarning.MotorPower) !== 0);
    }
    if (changed & MotorWarning.EscCurrent) {
      staged[0] = Math.abs(m[a + MotorColumn.MotorCurrentA]!); staged[1] = r[b + 2]!;
      this.push(tick, i, Q.EscCurrent, (mask & MotorWarning.EscCurrent) !== 0);
    }
    if (changed & MotorWarning.EscVoltage) {
      staged[0] = t.battery[BatteryColumn.VoltageV]!; staged[1] = r[b + 3]!;
      this.push(tick, i, Q.EscVoltage, (mask & MotorWarning.EscVoltage) !== 0);
    }
    if (changed & MotorWarning.Rpm) {
      staged[0] = Math.abs(m[a + MotorColumn.Rpm]!); staged[1] = r[b + 4]!;
      this.push(tick, i, Q.Rpm, (mask & MotorWarning.Rpm) !== 0);
    }
  }

  /**
   * Queues one event whose value and limit are in `staged`. V8 can box a double
   * passed as a call argument, so the hot path passes none.
   */
  private push(tick: number, subject: number, quantity: number, start: boolean): void {
    if (this.count === LIMIT_OUTBOX_CAPACITY) { this.dropped++; return; }
    const at = (this.head + this.count) % LIMIT_OUTBOX_CAPACITY;
    this.tick[at] = tick; this.subject[at] = subject; this.quantity[at] = quantity; this.edge[at] = start ? 1 : 0;
    this.value[at] = this.staged[0]!; this.limit[at] = this.staged[1]!;
    this.count++;
  }

  /** Cold: hands every queued event to `sink` in order and empties the outbox. */
  drain(sink: (event: LimitEvent) => void): number {
    const n = this.count;
    for (let k = 0; k < n; k++) {
      const at = (this.head + k) % LIMIT_OUTBOX_CAPACITY, quantity = QUANTITIES[this.quantity[at]!] ?? 'motor-current';
      const code = this.quantity[at]!, subject = this.subject[at]!;
      sink(Object.freeze({
        tick: this.tick[at]!, simTimeS: this.tick[at]! / this.hz, subject: subject === BATTERY_SUBJECT ? 'battery' : subject,
        quantity, kind: code >= Q.CurrentLimit ? 'limited' : 'warning', edge: this.edge[at] === 1 ? 'start' : 'end',
        value: this.value[at]!, limit: this.limit[at]!,
      }));
    }
    this.head = (this.head + n) % LIMIT_OUTBOX_CAPACITY; this.count = 0;
    return n;
  }
}
