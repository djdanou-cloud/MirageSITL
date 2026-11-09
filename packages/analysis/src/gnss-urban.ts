// TASK-117 (SPECS_SIMULATION_ENGINES "Logged urban position errors: smartLoc"): a u-blox EVK-M8T's own fixes against the NovAtel SPAN
// reference of the smartLoc urban scenarios, and the GNSS v2 model's errors at the same place and time of week. Shown, not judged (SA-01).
import { GNSS_CODE_NOISE_STREAM, GNSS_MULTIPATH_STREAM, GnssRangeProcess, gnssSolution, type GnssEffects } from "@mirage/sensors/gnss";
import { GNSS_SKY } from "@mirage/sensors/gnss-sky";
import { percentiles, type Percentiles } from "./gnss-statistics.ts";

/** WGS 84. */
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);
const RAD = Math.PI / 180;

/** Earth-centred, Earth-fixed coordinates of a geodetic point, m. */
export function ecefOf(latDeg: number, lonDeg: number, heightM: number): [number, number, number] {
  const lat = latDeg * RAD, lon = lonDeg * RAD, s = Math.sin(lat), n = A / Math.sqrt(1 - E2 * s * s);
  return [(n + heightM) * Math.cos(lat) * Math.cos(lon), (n + heightM) * Math.cos(lat) * Math.sin(lon), (n * (1 - E2) + heightM) * s];
}
/** A point less a reference, in the reference's local east, north and up, m. */
export function enuOffset(reference: readonly [number, number, number], point: readonly [number, number, number]): [number, number, number] {
  const [lat, lon] = [reference[0] * RAD, reference[1] * RAD];
  const r = ecefOf(reference[0], reference[1], reference[2]), p = ecefOf(point[0], point[1], point[2]);
  const d = [p[0] - r[0], p[1] - r[1], p[2] - r[2]] as const;
  const [sl, cl, so, co] = [Math.sin(lat), Math.cos(lat), Math.sin(lon), Math.cos(lon)];
  return [-so * d[0] + co * d[1], -sl * co * d[0] - sl * so * d[1] + cl * d[2], cl * co * d[0] + cl * so * d[1] + sl * d[2]];
}

/** One `NAV-POSLLH.csv` epoch: the reference and the receiver's own fix, degrees and metres above the ellipsoid. */
export interface UrbanEpoch {
  readonly week: number; readonly secondsOfWeek: number;
  readonly reference: readonly [number, number, number]; readonly receiver: readonly [number, number, number]; readonly hAccM: number;
}
const numberAt = (cells: readonly string[], i: number): number => {
  const value = Number(cells[i]);
  if (!Number.isFinite(value)) throw new Error(`Column ${i + 1} is not a number: ${cells[i] ?? "missing"}`);
  return value;
};
/** Parses smartLoc's `NAV-POSLLH.csv` (semicolon separated, one header line); refuses a header it does not know. */
export function parseNavPosllh(text: string): UrbanEpoch[] {
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  const header = lines[0]?.split(";") ?? [];
  const expect = [[2, "Longitude (GT Lon)"], [4, "Latitude (GT Lat)"], [6, "Height above ellipsoid (GT Height)"], [17, "Longitude (lon)"],
    [18, "Latitude (lat)"], [19, "Height above ellipsoid (height)"], [21, "Horizontal accuracy estimate (hAcc)"]] as const;
  for (const [i, name] of expect) if (!(header[i] ?? "").startsWith(name)) throw new Error(`NAV-POSLLH column ${i + 1} is not ${name}`);
  return lines.slice(1).map(line => {
    const c = line.split(";");
    return { week: numberAt(c, 0), secondsOfWeek: numberAt(c, 1), reference: [numberAt(c, 4), numberAt(c, 2), numberAt(c, 6)],
      receiver: [numberAt(c, 18), numberAt(c, 17), numberAt(c, 19)], hAccM: numberAt(c, 21) };
  });
}
/** The labelled non-line-of-sight share of `RXM-RAWX.csv` (its last column: 1 yes, 0 no, # no information). */
export function nonLineOfSightShare(text: string): { readonly labelled: number; readonly share: number } {
  let yes = 0, no = 0;
  for (const line of text.split(/\r?\n/).slice(1)) {
    const label = line.slice(line.lastIndexOf(";") + 1).trim();
    if (label === "1") yes++; else if (label === "0") no++;
  }
  return { labelled: yes + no, share: yes + no > 0 ? yes / (yes + no) : Number.NaN };
}

export interface ErrorStatistics {
  readonly horizontalM: Percentiles; readonly verticalAbsM: Percentiles; readonly accuracyM: Percentiles;
}
/** The measured statistics of a scenario: its receiver's error against the reference, and its reported accuracy. */
export function measuredStatistics(epochs: readonly UrbanEpoch[]): ErrorStatistics {
  const errors = epochs.map(e => enuOffset(e.reference, e.receiver));
  return { horizontalM: percentiles(errors.map(([east, north]) => Math.hypot(east, north))), verticalAbsM: percentiles(errors.map(([, , up]) => Math.abs(up))),
    accuracyM: percentiles(epochs.map(e => e.hAccM)) };
}

/** The declared model: the run's defaults of each effect that applies, at intensity 1; terrain off (no building model). */
export const URBAN_MODEL = Object.freeze({ maskDeg: 10, uereM: 1.5, ionosphereResidual: 0.5, troposphereResidual: 0.1, dllBandwidthHz: 0.5,
  correlatorSpacingChips: 1, multipathFloorM: 0.13, multipathLowElevationM: 0.53, multipathElevationScaleDeg: 10, multipathCorrelationS: 10,
  skyWeek: 2444, stepS: 1, seed: 117 });

/** The model's statistics at a place over `durationS` from GPS seconds of week `startS`, in the sky's own week. */
export function modelStatistics(place: readonly [number, number, number], startS: number, durationS: number): ErrorStatistics & { readonly samples: number; readonly fixes: number } {
  const m = URBAN_MODEL, count = GNSS_SKY.length;
  const code = new GnssRangeProcess(count, m.seed, GNSS_CODE_NOISE_STREAM), multipath = new GnssRangeProcess(count, m.seed, GNSS_MULTIPATH_STREAM);
  const effects: GnssEffects = {
    constellation: { maskRad: m.maskDeg * RAD, uereM: m.uereM },
    atmosphere: { ionosphereResidual: m.ionosphereResidual, troposphereResidual: m.troposphereResidual },
    terrain: null, jamming: null,
    codeNoise: { bandwidthHz: m.dllBandwidthHz, spacingChips: m.correlatorSpacingChips, scale: 1, unit: code.values },
    multipath: { floorM: m.multipathFloorM, lowElevationM: m.multipathLowElevationM, elevationScaleRad: m.multipathElevationScaleDeg * RAD, unit: multipath.values },
  };
  const codePhi = Math.exp(-m.stepS / (1 / (4 * m.dllBandwidthHz))), multipathPhi = Math.exp(-m.stepS / m.multipathCorrelationS);
  const receiver = { latRad: place[0] * RAD, lonRad: place[1] * RAD, heightM: place[2], eastM: 0, northM: 0 };
  const horizontal: number[] = [], vertical: number[] = [], accuracy: number[] = [];
  let samples = 0;
  for (let t = 0; t <= durationS; t += m.stepS) {
    if (t > 0) { code.advance(1, codePhi); multipath.advance(1, multipathPhi); }
    const solution = gnssSolution(GNSS_SKY, receiver, m.skyWeek, startS + t, effects);
    samples++;
    if (!solution.fix || solution.accuracyM === null) continue;
    const [east, north, up] = solution.errorEnuM;
    horizontal.push(Math.hypot(east, north)); vertical.push(Math.abs(up)); accuracy.push(solution.accuracyM);
  }
  return { horizontalM: percentiles(horizontal), verticalAbsM: percentiles(vertical), accuracyM: percentiles(accuracy), samples, fixes: horizontal.length };
}
