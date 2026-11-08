import type { SkySatellite } from "./gnss.ts";
import { GNSS_BROADCAST, GNSS_BROADCAST_SOURCE } from "./gnss-broadcast.ts";
import { GPS_ALMANAC } from "./gps-almanac.ts";

// TASK-117 (SPECS_SIMULATION_ENGINES "Multi-GNSS broadcast sky"): the run's sky and the logged statistics' model. GPS is the YUMA
// almanac of week 2444; Galileo, GLONASS and BeiDou are the broadcast records of 2026-11-07 nearest 12:00:00 GPS time, the sky's
// epoch. A run's simulated time 0 is that epoch, so every system is used within a day of its data.

/** Every satellite of the sky: 32 GPS, then the Galileo, GLONASS and BeiDou records. */
export const GNSS_SKY: readonly SkySatellite[] = Object.freeze<SkySatellite[]>([...GPS_ALMANAC, ...GNSS_BROADCAST]);
/** The sky's epoch, GPS week and seconds of week: 2026-11-07 12:00:00 GPS time. */
export const GNSS_SKY_EPOCH = Object.freeze({ week: GNSS_BROADCAST_SOURCE.referenceWeek, secondsOfWeek: GNSS_BROADCAST_SOURCE.referenceSecondsOfWeek });
