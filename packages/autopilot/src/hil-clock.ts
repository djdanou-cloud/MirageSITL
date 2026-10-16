// HIL stream clock (TASK-049). Derives which HIL observations are due on each
// physics tick with integer phase (SensorScheduler), so 60 s at 400/800/1200 Hz
// produces exact counts and timestamps with no accumulated drift. Sample time
// is the physics tick time, never a send or wall time.
import { SensorScheduler } from "@mirage/sensors/scheduler";

export type PhysicsHz = 400 | 800 | 1200;
export interface HilRates {
  physicsHz: PhysicsHz;
  /** HIL_SENSOR rate: 200 or 400 Hz (accelerometer and gyro update each message). */
  imuHz: 200 | 400;
  /** Magnetometer update rate, Hz (integer, <= imuHz). */
  magHz: number;
  /** Barometer/temperature update rate, Hz (integer, <= imuHz). */
  baroHz: number;
  /** HIL_GPS rate: 5 or 10 Hz. */
  gnssHz: 5 | 10;
}

/** Per-tick decision, overwritten by advance(). */
export interface HilDue {
  imu: boolean; mag: boolean; baro: boolean; gnss: boolean;
  /** Sample time in microseconds as two uint32 words. */
  readonly time: { lo: number; hi: number };
}

export class HilClock {
  readonly due: HilDue = { imu: false, mag: false, baro: false, gnss: false, time: { lo: 0, hi: 0 } };
  private readonly imu: SensorScheduler;
  private readonly mag: SensorScheduler;
  private readonly baro: SensorScheduler;
  private readonly gnss: SensorScheduler;

  constructor(readonly rates: HilRates) {
    const { physicsHz, imuHz, magHz, baroHz, gnssHz } = rates;
    if (![400, 800, 1200].includes(physicsHz) || (imuHz !== 200 && imuHz !== 400) || (gnssHz !== 5 && gnssHz !== 10) ||
      !Number.isInteger(magHz) || magHz < 1 || magHz > imuHz || imuHz % magHz !== 0 ||
      !Number.isInteger(baroHz) || baroHz < 1 || baroHz > imuHz || imuHz % baroHz !== 0) {
      throw new Error("Invalid HIL rates");
    }
    this.imu = new SensorScheduler(physicsHz, imuHz);
    // Mag/baro run on the physics clock too; dividing imuHz keeps them aligned with IMU samples.
    this.mag = new SensorScheduler(physicsHz, magHz);
    this.baro = new SensorScheduler(physicsHz, baroHz);
    this.gnss = new SensorScheduler(physicsHz, gnssHz);
  }

  /** Call exactly once per physics tick; fills `due`. Allocation-free. */
  advance(): HilDue {
    const d = this.due;
    d.imu = this.imu.advance();
    d.mag = this.mag.advance();
    d.baro = this.baro.advance();
    d.gnss = this.gnss.advance();
    this.imu.timeInto(d.time);
    return d;
  }

  reset(): void {
    this.imu.reset(); this.mag.reset(); this.baro.reset(); this.gnss.reset();
    const d = this.due;
    d.imu = d.mag = d.baro = d.gnss = false;
    d.time.lo = 0; d.time.hi = 0;
  }
}
