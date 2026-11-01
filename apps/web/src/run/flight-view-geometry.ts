import type { AircraftLayout } from '@mirage/aircraft/layout';
import type { CameraConfig } from '@mirage/cameras/fpv-camera';
import { schemeDimensions } from '../aircraft/scheme-geometry';

// Geometry of the Run tab's flight view (TASK-185): the trajectory ring, the
// external chase camera and the onboard camera, all from the aircraft layout.
// Everything a frame calls writes into storage allocated once; the scene reads
// interpolated state only and never steps or changes the physics.

/** Seconds of trajectory kept, and its sampling interval in simulated seconds. */
export const TRAIL_SECONDS = 120, TRAIL_INTERVAL_S = 0.1;
export const TRAIL_CAPACITY = Math.round(TRAIL_SECONDS / TRAIL_INTERVAL_S);

/**
 * The last TRAIL_CAPACITY render-space positions, oldest first when written
 * out. A sample is taken when simulated time has moved TRAIL_INTERVAL_S past
 * the last one; a new session epoch or time running backwards starts again.
 */
export class TrailBuffer {
  private readonly ring = new Float32Array(TRAIL_CAPACITY * 3);
  private start = 0;
  private countValue = 0;
  private lastTimeS = Number.NEGATIVE_INFINITY;
  private epoch = -1;

  get count(): number { return this.countValue; }

  /** Offers a position at simulated time `timeS`; returns true when it was kept. */
  offer(epoch: number, timeS: number, x: number, y: number, z: number): boolean {
    if (epoch !== this.epoch || timeS < this.lastTimeS) this.clear(epoch);
    // A nanosecond of slack: simulated times are sums of steps, so 0.3 - 0.2 may come out just below 0.1.
    if (!(timeS - this.lastTimeS >= TRAIL_INTERVAL_S - 1e-9) || !Number.isFinite(x + y + z)) return false;
    const slot = (this.start + this.countValue) % TRAIL_CAPACITY;
    if (this.countValue < TRAIL_CAPACITY) this.countValue++;
    else this.start = (this.start + 1) % TRAIL_CAPACITY;
    this.ring[slot * 3] = x;
    this.ring[slot * 3 + 1] = y;
    this.ring[slot * 3 + 2] = z;
    this.lastTimeS = timeS;
    return true;
  }

  /** Writes the kept positions, oldest first, into `out` (at least TRAIL_CAPACITY * 3 long); returns the count. */
  writeInto(out: Float32Array): number {
    for (let i = 0; i < this.countValue; i++) {
      const slot = ((this.start + i) % TRAIL_CAPACITY) * 3;
      out[i * 3] = this.ring[slot] ?? 0;
      out[i * 3 + 1] = this.ring[slot + 1] ?? 0;
      out[i * 3 + 2] = this.ring[slot + 2] ?? 0;
    }
    return this.countValue;
  }

  clear(epoch = this.epoch): void {
    this.start = 0;
    this.countValue = 0;
    this.lastTimeS = Number.NEGATIVE_INFINITY;
    this.epoch = epoch;
  }
}

/** Render-space offset of the external camera from the aircraft: behind (+z), right and above, scaled to its span. */
export function chaseOffset(layout: AircraftLayout): readonly [number, number, number] {
  const scale = Math.max(1, schemeDimensions(layout).span * 2.2);
  return [scale * 0.8, scale * 0.6, scale];
}

/**
 * The onboard camera: TASK-067's mounted camera at the front of the drawn
 * body, looking along body forward, with a plain 90° lens: no fisheye and no
 * analog effects (TASK-185).
 */
export function onboardCamera(layout: AircraftLayout): CameraConfig {
  const { span } = schemeDimensions(layout);
  return {
    lens: { fovHorizontalRad: Math.PI / 2, distortion: { model: 'none' } },
    mount: { offsetFrdM: [span * 0.09, 0, 0], uptiltRad: 0 },
    nearM: 0.02, farM: 2000,
  };
}

/**
 * Visual turning rate of a drawn rotor, rad/s: a fixed fraction of its speed,
 * so the display never aliases into a backwards spin. Zero when the motor is
 * stopped or its speed is unknown.
 */
export function drawnSpinRadS(rpm: number): number {
  if (!(rpm > 0)) return 0;
  return Math.min(rpm, 12000) / 12000 * 4 * Math.PI;
}
