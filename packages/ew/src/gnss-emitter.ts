import { GPS_L1_WAVELENGTH_M } from "@mirage/sensors/gnss";

// TASK-117: a GNSS jammer placed in the world, as an RF emitter (SPECS_SIMULATION_ENGINES "Receiver timing, tracking noise,
// multipath and jammers"). The EW engine's own GNSS jamming is a commanded severity preset and its hazard volumes are dimensionless
// exposure, never an RF link budget; this emitter is the link budget's source. Free space at GPS L1 with an isotropic receiving
// antenna; terrain does not shield it. It changes what the receiver reports, never the truth. Control-loop code.

/** The closest range the free-space loss is evaluated at, m: inside it the loss would fall towards zero. */
export const JAMMER_MIN_RANGE_M = 1;

/** A jammer: its position, m north, east, down from the home, and its effective isotropic radiated power, dBW. */
export interface GnssEmitter {
  readonly positionNedM: readonly [number, number, number];
  readonly eirpDbW: number;
}

/** The free-space path loss at GPS L1 over `rangeM`, dB: 20·log10(4π·max(d, 1 m)/λ). */
export function freeSpaceLossL1Db(rangeM: number): number {
  return 20 * Math.log10((4 * Math.PI * Math.max(JAMMER_MIN_RANGE_M, rangeM)) / GPS_L1_WAVELENGTH_M);
}

/** The power the jammer delivers at a receiver at `northM`, `eastM`, `downM` from the home, dBW. */
export function jammerReceivedPowerDbW(emitter: GnssEmitter, northM: number, eastM: number, downM: number): number {
  const [n, e, d] = emitter.positionNedM;
  return emitter.eirpDbW - freeSpaceLossL1Db(Math.hypot(northM - n, eastM - e, downM - d));
}
