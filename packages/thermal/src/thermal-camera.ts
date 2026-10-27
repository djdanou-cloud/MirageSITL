// Thermal camera model (TASK-071): surface temperature -> in-band radiance ->
// apparent radiance through the atmosphere -> display palette.
//
//   L_band(T)  = integral over [lambda1, lambda2] of Planck B_lambda(T) d lambda
//   L_app      = tau(d) [eps L(T_s) + (1 - eps) L(T_refl)] + (1 - tau(d)) L(T_air)
//   tau(d)     = exp(-k d)          (Beer-Lambert, k extinction per metre)
//   level      = (L_app - L(T_min)) / (L(T_max) - L(T_min)), clamped to [0, 1]
//
// The radiance table is built on the CPU once per profile; shaders/thermal.glsl
// evaluates the same chain per pixel from a G-buffer (temperature, emissivity,
// distance). apparentLevel() is the float64 CPU mirror used by tests.
//
// Instrument profiles are synthetic training profiles, approximated profiles
// built from a public data sheet (TASK-073 P5), or measured profiles with a
// calibration data hash. Only a measured profile may claim parity with a real
// instrument (e.g. CADEX); synthetic and approximated profiles never do.

export const PLANCK_H = 6.62607015e-34;
export const LIGHT_C = 299792458;
export const BOLTZMANN_K = 1.380649e-23;
const C1 = 2 * PLANCK_H * LIGHT_C * LIGHT_C; // W m^2 / sr
const C2 = (PLANCK_H * LIGHT_C) / BOLTZMANN_K; // m K

export interface InstrumentProfile {
  id: string;
  /** Native sensor resolution, pixels. */
  resolution: readonly [number, number];
  /** Spectral band, micrometres (e.g. LWIR 8-14). Flat response inside the band. */
  spectralBandUm: readonly [number, number];
  /** Noise-equivalent temperature difference, K. */
  netdK: number;
  calibrationSource:
    | { kind: "synthetic"; note: string }
    | { kind: "approximated"; instrument: string; sources: readonly string[]; note: string }
    | { kind: "measured"; instrument: string; dataSha256: string };
  /** Sensor frame rate, Hz (optional for legacy profiles). */
  frameHz?: number;
  /** Selected lens: effective focal length and horizontal field of view. */
  optics?: { focalLengthMm: number; horizontalFovRad: number };
}

export const SYNTHETIC_LWIR_640: Readonly<InstrumentProfile> = Object.freeze({
  id: "synthetic-lwir-640",
  resolution: Object.freeze([640, 512] as const),
  spectralBandUm: Object.freeze([8, 14] as const),
  netdK: 0.05,
  calibrationSource: Object.freeze({ kind: "synthetic" as const, note: "Generic uncooled LWIR training profile; not calibrated against any instrument." }),
});

/**
 * FLIR Boson 640 with the 8.7 mm, 50 deg HFOV lens at 60 Hz, approximated from
 * public Teledyne FLIR data sheet values (TASK-073 P5): 640 x 512 array, LWIR
 * 8-14 um, NETD < 50 mK (Professional grade), 60 Hz baseline. The lens is a
 * selected configuration (docs/needed_for_task073.md section 9.2). No raw
 * frames of a real Boson were used: this profile claims no instrument parity.
 */
export const BOSON_640_50DEG: Readonly<InstrumentProfile> = Object.freeze({
  id: "boson-640-50deg-approx",
  resolution: Object.freeze([640, 512] as const),
  spectralBandUm: Object.freeze([8, 14] as const),
  netdK: 0.05,
  frameHz: 60,
  optics: Object.freeze({ focalLengthMm: 8.7, horizontalFovRad: (50 * Math.PI) / 180 }),
  calibrationSource: Object.freeze({
    kind: "approximated" as const,
    instrument: "FLIR Boson 640",
    // Citations only: this package holds no network addresses (tests/material-map.test.ts).
    sources: Object.freeze(["Teledyne FLIR Boson data sheet, rev. 2023-10-24", "Teledyne FLIR Boson family FOV comparison (OEM web page)"]),
    note: "Data sheet values only; fixed-pattern noise and drift are generated, not measured.",
  }),
});

/** Vertical field of view (rad) of a pinhole with the profile's horizontal FOV and aspect. */
export function verticalFovRad(p: InstrumentProfile): number {
  if (!p.optics) throw new Error("Profile has no optics");
  const [w, h] = p.resolution;
  return 2 * Math.atan(Math.tan(p.optics.horizontalFovRad / 2) * (h / w));
}

export function validateProfile(p: InstrumentProfile): void {
  const [w, h] = p.resolution, [l1, l2] = p.spectralBandUm;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id) || !Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > 4096 || h > 4096 ||
    !(l1 > 0.5 && l2 > l1 && l2 <= 30) || !(p.netdK >= 0 && p.netdK <= 1)) throw new Error("Invalid instrument profile");
  if (p.frameHz !== undefined && !(p.frameHz > 0 && p.frameHz <= 240)) throw new Error("Invalid instrument frame rate");
  if (p.optics !== undefined && !(p.optics.focalLengthMm > 0 && p.optics.horizontalFovRad > 0 && p.optics.horizontalFovRad < 0.9 * Math.PI)) {
    throw new Error("Invalid instrument optics");
  }
  const c = p.calibrationSource;
  if (c.kind === "measured") {
    if (!c.instrument.trim() || !/^[a-f0-9]{64}$/.test(c.dataSha256)) throw new Error("Measured profiles need an instrument name and calibration data hash");
  } else if (c.kind === "approximated") {
    if (!c.instrument.trim() || c.sources.length < 1 || !c.sources.every(s => s.trim().length >= 8)) {
      throw new Error("Approximated profiles need an instrument name and public sources");
    }
  } else if (c.kind !== "synthetic") throw new Error("Unknown calibration source");
}

/** True only for a measured profile of exactly that instrument. */
export function claimsParityWith(p: InstrumentProfile, instrument: string): boolean {
  return p.calibrationSource.kind === "measured" && p.calibrationSource.instrument.toLowerCase() === instrument.toLowerCase();
}

/** Planck spectral radiance B_lambda(T), W / (m^2 sr m). */
export function planckSpectral(lambdaM: number, tK: number): number {
  return C1 / (lambdaM ** 5 * Math.expm1(C2 / (lambdaM * tK)));
}

/** In-band radiance (W / m^2 / sr) by composite Simpson in wavelength. */
export function bandRadiance(tK: number, bandUm: readonly [number, number], intervals = 512): number {
  if (!(tK > 0)) return 0;
  const a = bandUm[0] * 1e-6, b = bandUm[1] * 1e-6, n = intervals % 2 === 0 ? intervals : intervals + 1, step = (b - a) / n;
  let sum = planckSpectral(a, tK) + planckSpectral(b, tK);
  for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * planckSpectral(a + i * step, tK);
  return (sum * step) / 3;
}

/** Radiance lookup over [minK, maxK] in 1 K steps (float32, for the shader texture). */
export interface RadianceTable { minK: number; maxK: number; values: Float32Array }
export function radianceTable(band: readonly [number, number], minK = 150, maxK = 405): RadianceTable {
  const values = new Float32Array(maxK - minK + 1);
  for (let i = 0; i < values.length; i++) values[i] = bandRadiance(minK + i, band);
  return { minK, maxK, values };
}
/** Linear interpolation in the table (clamped), the same as the shader. */
export function tableRadiance(table: RadianceTable, tK: number): number {
  const x = Math.min(table.maxK - table.minK, Math.max(0, tK - table.minK));
  const i = Math.min(table.values.length - 2, Math.floor(x)), f = x - i;
  return table.values[i]! * (1 - f) + table.values[i + 1]! * f; // i + 1 < length
}

export interface ThermalScene {
  /** Reflected (sky/surroundings) temperature, K. */
  reflectedK: number;
  /** Path (air) temperature, K. */
  airK: number;
  /** Atmospheric extinction coefficient in the band, 1/m. */
  extinctionPerM: number;
  /** Display span: temperatures mapped to level 0 and 1. */
  spanMinK: number;
  spanMaxK: number;
}

/** Apparent in-band radiance at the sensor (W/m^2/sr), float64 with the exact band integral. */
export function apparentRadiance(tK: number, emissivity: number, distanceM: number, scene: ThermalScene, band: readonly [number, number]): number {
  const tau = Math.exp(-scene.extinctionPerM * Math.max(0, distanceM));
  return tau * (emissivity * bandRadiance(tK, band) + (1 - emissivity) * bandRadiance(scene.reflectedK, band)) + (1 - tau) * bandRadiance(scene.airK, band);
}

/** Apparent in-band radiance with the shader's table (float64 mirror of one G-buffer subsample). */
export function apparentTableRadiance(table: RadianceTable, tK: number, emissivity: number, distanceM: number, scene: ThermalScene): number {
  const tau = Math.exp(-scene.extinctionPerM * Math.max(0, distanceM));
  return tau * (emissivity * tableRadiance(table, tK) + (1 - emissivity) * tableRadiance(table, scene.reflectedK)) + (1 - tau) * tableRadiance(table, scene.airK);
}

/** Display level in [0, 1] of an apparent radiance (e.g. the mean over a sensor pixel's subsamples). */
export function levelFromRadiance(table: RadianceTable, radiance: number, scene: ThermalScene): number {
  const lo = tableRadiance(table, scene.spanMinK), hi = tableRadiance(table, scene.spanMaxK);
  return Math.min(1, Math.max(0, (radiance - lo) / (hi - lo)));
}

/** Display level in [0, 1] for one pixel, using the same table as the shader. */
export function apparentLevel(table: RadianceTable, tK: number, emissivity: number, distanceM: number, scene: ThermalScene): number {
  return levelFromRadiance(table, apparentTableRadiance(table, tK, emissivity, distanceM, scene), scene);
}

export type ThermalPalette = "white-hot" | "black-hot" | "ironbow";
/** Ironbow control points (level, r, g, b in 0..1), black -> purple -> red -> orange -> yellow -> white. */
export const IRONBOW: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0], [0.25, 0.35, 0, 0.55], [0.5, 0.8, 0.1, 0.25], [0.7, 1, 0.5, 0], [0.88, 1, 0.85, 0.15], [1, 1, 1, 1],
];
/** Palette colour (0..1 RGB) for a display level; the shader uses the same mapping. */
export function paletteColor(palette: ThermalPalette, level: number, out: Float64Array): void {
  const x = Math.min(1, Math.max(0, level));
  if (palette === "white-hot" || palette === "black-hot") {
    const v = palette === "white-hot" ? x : 1 - x;
    out[0] = v; out[1] = v; out[2] = v;
    return;
  }
  for (let i = 1; i < IRONBOW.length; i++) {
    const p = IRONBOW[i - 1]!, q = IRONBOW[i]!; // i < length
    if (x <= q[0]) {
      const f = (x - p[0]) / (q[0] - p[0]);
      out[0] = p[1] + f * (q[1] - p[1]); out[1] = p[2] + f * (q[2] - p[2]); out[2] = p[3] + f * (q[3] - p[3]);
      return;
    }
  }
}

export function paletteIndex(palette: ThermalPalette): number {
  switch (palette) {
    case "white-hot": return 0;
    case "black-hot": return 1;
    case "ironbow": return 2;
    default: { const never: never = palette; throw new Error(`Unknown palette ${String(never)}`); }
  }
}
