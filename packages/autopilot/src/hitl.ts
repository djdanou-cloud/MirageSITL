// HIL sensor/actuator streaming (TASK-049), docs/SPECS_SIMULATION_ENGINES.md
// section 6. On each physics tick the streamer encodes due HIL_SENSOR and
// HIL_GPS frames (pinned MAVLink2 subset) into a bounded byte outbox drained by
// the serial I/O layer, and admits HIL_ACTUATOR_CONTROLS from the autopilot.
//
// * fields_updated reports only the sensor groups updated in that sample:
//   accel+gyro every HIL_SENSOR, mag and baro/temperature at their own rates.
// * The configured link must keep >= 30% headroom at baud/10 bytes per second
//   for worst-case (untruncated) frames, or construction fails.
// * Outbox overflow and actuator dropout latch faults; nothing grows unbounded.
// * MAVLink signing is unsupported (signed frames are rejected by MavParser),
//   so this stream is an unauthenticated diagnostic link.
// Allocation-free after construction.
import { encodeInto, type MavFrame } from "@mirage/mavlink/codec";
import { actuatorInto, type HilActuators } from "@mirage/mavlink/messages";
import type { GpsSample, ImuSample } from "@mirage/mavlink/samples";
import { SensorMapping } from "@mirage/mavlink/sensor-mapping";
import { HilClock, type HilRates } from "./hil-clock.ts";

/** MAVLink2 frame bytes without truncation: 12 + payload. */
export const HIL_SENSOR_MAX_FRAME_BYTES = 12 + 65;
export const HIL_GPS_MAX_FRAME_BYTES = 12 + 39;
/** Required free link capacity (fraction of baud/10). */
export const SERIAL_HEADROOM = 0.3;

/** HIL_SENSOR fields_updated bits (common.xml HIL_SENSOR_UPDATED_FLAGS). */
export const HIL_SENSOR_ACCEL_GYRO = 0x3f; // xacc..zgyro, bits 0..5
export const HIL_SENSOR_MAG = 0x1c0; // bits 6..8
export const HIL_SENSOR_BARO = 0x1e00; // abs_pressure, diff_pressure, pressure_alt, temperature: bits 9..12

export type HilFault = "none" | "queue-overflow" | "actuator-dropout";

export interface HilStreamOptions extends HilRates {
  baud: number;
  systemId: number;
  componentId: number;
  /** Outbox capacity in bytes (the serial writer drains it). */
  outboxBytes?: number;
  /** Fault when no valid actuator frame arrives within this many microseconds once streaming. */
  actuatorTimeoutUs?: number;
}

export interface LinkBudget { bytesPerSecond: number; capacityBytesPerSecond: number; utilization: number }

/** Worst-case outbound load for the configured rates against baud/10 bytes/s. */
export function hilLinkBudget(rates: Pick<HilRates, "imuHz" | "gnssHz">, baud: number): LinkBudget {
  const bytesPerSecond = rates.imuHz * HIL_SENSOR_MAX_FRAME_BYTES + rates.gnssHz * HIL_GPS_MAX_FRAME_BYTES;
  const capacityBytesPerSecond = baud / 10;
  return { bytesPerSecond, capacityBytesPerSecond, utilization: bytesPerSecond / capacityBytesPerSecond };
}

export class HilStreamer {
  readonly clock: HilClock;
  readonly budget: LinkBudget;
  /** Latched until reset(). */
  fault: HilFault = "none";
  readonly stats = { sensorFrames: 0, gpsFrames: 0, bytes: 0, actuatorFrames: 0, actuatorRejected: 0 };
  private readonly mapping = new SensorMapping();
  private readonly outbox: Uint8Array;
  private head = 0;
  private size = 0;
  private readonly frame = new Uint8Array(HIL_SENSOR_MAX_FRAME_BYTES);
  private sequence = 0;
  private readonly timeoutUs: number;
  private lastActuatorUs = -1;
  private streamStartUs = -1;
  private lastActuatorTimeLo = -1;
  private lastActuatorTimeHi = -1;
  private readonly systemId: number;
  private readonly componentId: number;
  private readonly scratch: HilActuators = { timeLoUs: 0, timeHiUs: 0, flagsLo: 0, flagsHi: 0, mode: 0, controls: new Float64Array(16) };

  constructor(options: HilStreamOptions) {
    this.clock = new HilClock(options);
    if (!Number.isInteger(options.baud) || options.baud < 9600 || options.baud > 12_000_000) throw new Error("Invalid baud");
    this.budget = hilLinkBudget(options, options.baud);
    if (this.budget.utilization > 1 - SERIAL_HEADROOM) {
      throw new Error(`HIL stream needs ${this.budget.bytesPerSecond} B/s, above ${Math.round((1 - SERIAL_HEADROOM) * 100)}% of ${this.budget.capacityBytesPerSecond} B/s`);
    }
    const outboxBytes = options.outboxBytes ?? 4096;
    const timeoutUs = options.actuatorTimeoutUs ?? 100_000;
    if (!Number.isInteger(outboxBytes) || outboxBytes < HIL_SENSOR_MAX_FRAME_BYTES || outboxBytes > 1 << 20 ||
      !Number.isInteger(timeoutUs) || timeoutUs < 1000 || timeoutUs > 1_000_000 ||
      !Number.isInteger(options.systemId) || options.systemId < 1 || options.systemId > 255 ||
      !Number.isInteger(options.componentId) || options.componentId < 0 || options.componentId > 255) {
      throw new Error("Invalid HIL stream options");
    }
    this.outbox = new Uint8Array(outboxBytes);
    this.timeoutUs = timeoutUs;
    this.systemId = options.systemId;
    this.componentId = options.componentId;
  }

  /** Bytes waiting for the serial writer. */
  get queuedBytes(): number { return this.size; }

  /**
   * One physics tick: encodes due observations. `imu` and `gps` are this
   * tick's model observations (their sample time is overwritten with the
   * tick time). Returns false once a fault is latched.
   */
  tick(imu: ImuSample, gps: GpsSample): boolean {
    if (this.fault !== "none") return false;
    const due = this.clock.advance();
    if (due.imu) {
      imu.timeLoUs = due.time.lo; imu.timeHiUs = due.time.hi;
      imu.updatedMask = HIL_SENSOR_ACCEL_GYRO | (due.mag ? HIL_SENSOR_MAG : 0) | (due.baro ? HIL_SENSOR_BARO : 0);
      if (!this.mapping.sensorInto(imu) || !this.enqueue(107, this.mapping.sensor)) return false;
      this.stats.sensorFrames++;
    }
    if (due.gnss) {
      gps.timeLoUs = due.time.lo; gps.timeHiUs = due.time.hi;
      if (!this.mapping.gpsInto(gps) || !this.enqueue(113, this.mapping.gps)) return false;
      this.stats.gpsFrames++;
    }
    return true;
  }

  private enqueue(id: number, payload: Uint8Array): boolean {
    const n = encodeInto(id, payload, this.sequence, this.systemId, this.componentId, this.frame);
    if (n === 0) return false;
    if (this.size + n > this.outbox.length) { this.fault = "queue-overflow"; return false; }
    for (let i = 0; i < n; i++) {
      this.outbox[(this.head + this.size + i) % this.outbox.length] = this.frame[i] as number; // i < n <= frame.length
    }
    this.size += n;
    this.stats.bytes += n;
    this.sequence = (this.sequence + 1) & 255;
    return true;
  }

  /** Moves up to out.length queued bytes into `out` for the serial writer; returns the count. */
  drainInto(out: Uint8Array): number {
    const n = Math.min(out.length, this.size), cap = this.outbox.length;
    for (let i = 0; i < n; i++) out[i] = this.outbox[(this.head + i) % cap] as number; // index < cap
    this.head = (this.head + n) % cap;
    this.size -= n;
    return n;
  }

  /**
   * Admits a parsed HIL_ACTUATOR_CONTROLS frame received at monotonic `nowUs`.
   * Rejects out-of-range controls and non-increasing autopilot timestamps.
   */
  acceptActuator(frame: MavFrame, nowUs: number, out: HilActuators): boolean {
    if (this.fault !== "none") return false;
    const a = this.scratch; // decode privately: a rejected frame never touches `out`
    if (!actuatorInto(frame, a) || out.controls.length !== 16) { this.stats.actuatorRejected++; return false; }
    const newer = a.timeHiUs > this.lastActuatorTimeHi ||
      (a.timeHiUs === this.lastActuatorTimeHi && a.timeLoUs > this.lastActuatorTimeLo);
    if (!newer) { this.stats.actuatorRejected++; return false; }
    out.timeLoUs = a.timeLoUs; out.timeHiUs = a.timeHiUs; out.flagsLo = a.flagsLo; out.flagsHi = a.flagsHi; out.mode = a.mode;
    out.controls.set(a.controls);
    this.lastActuatorTimeLo = a.timeLoUs;
    this.lastActuatorTimeHi = a.timeHiUs;
    this.lastActuatorUs = nowUs;
    this.stats.actuatorFrames++;
    return true;
  }

  /** Checks actuator freshness at monotonic `nowUs`; latches actuator-dropout. */
  poll(nowUs: number): HilFault {
    if (this.fault !== "none") return this.fault;
    if (this.streamStartUs < 0) this.streamStartUs = nowUs;
    const since = this.lastActuatorUs >= 0 ? this.lastActuatorUs : this.streamStartUs;
    if (nowUs - since > this.timeoutUs) this.fault = "actuator-dropout";
    return this.fault;
  }

  reset(): void {
    this.clock.reset();
    this.fault = "none";
    this.head = this.size = 0;
    this.sequence = 0;
    this.lastActuatorUs = this.streamStartUs = -1;
    this.lastActuatorTimeLo = this.lastActuatorTimeHi = -1;
  }
}
