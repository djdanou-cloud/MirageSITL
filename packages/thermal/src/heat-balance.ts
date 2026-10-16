// Surface thermal state (TASK-070): a one-layer slab per surface element,
// integrated on the CPU at a fixed thermal step outside any shader.
//
//   C dT/dt = alpha (DNI max(0, n.s) (1 - shadow) + DHI V)                absorbed solar
//           + eps (V eps_sky + (1 - V)) sigma T_air^4                     longwave in
//           - eps sigma T^4                                                longwave out
//           - h (T - T_air)                                                convection
//           - G (T - T_deep)                                               conduction
//
// C areal heat capacity (J/m^2/K), alpha solar absorptance, eps emissivity,
// V sky-view factor (0..1), shadow the blocked fraction of the direct beam,
// h = 5.7 + 3.8 v (McAdams forced-convection fit, W/m^2/K, v wind m/s),
// G conductance to a deep layer at T_deep. Ambient occlusion enters only as
// V in these explicit radiative terms (occluded sky is replaced by
// surroundings at air temperature); it is never a substitute heat solver.
// Integration: Heun (explicit second order) with automatic substeps below the
// linearised stability limit. Material properties below are typical,
// uncalibrated values: measured validation is pending.
import type { Atmosphere } from "@mirage/physics/atmosphere";
import { STEFAN_BOLTZMANN, skyEmissivity } from "./solar.ts";

export interface SurfaceThermalProps {
  solarAbsorptance: number;
  emissivity: number;
  arealHeatCapacityJM2K: number;
  deepConductanceWM2K: number;
}

/**
 * Typical, uncalibrated properties for TASK-069 material ids (effective layer
 * depth times volumetric heat capacity; conductance to a layer below). They
 * are synthetic training values, not measurements.
 */
export const TYPICAL_SURFACE_PROPS: Readonly<Record<string, Readonly<SurfaceThermalProps>>> = Object.freeze({
  "asphalt": { solarAbsorptance: 0.9, emissivity: 0.95, arealHeatCapacityJM2K: 9.5e4, deepConductanceWM2K: 15 },
  "built-up": { solarAbsorptance: 0.7, emissivity: 0.9, arealHeatCapacityJM2K: 1.0e5, deepConductanceWM2K: 15 },
  "roof-generic": { solarAbsorptance: 0.7, emissivity: 0.9, arealHeatCapacityJM2K: 2.0e4, deepConductanceWM2K: 2 },
  "roof-metal": { solarAbsorptance: 0.6, emissivity: 0.3, arealHeatCapacityJM2K: 3.6e3, deepConductanceWM2K: 2 },
  "vegetation-grass": { solarAbsorptance: 0.75, emissivity: 0.96, arealHeatCapacityJM2K: 1.25e5, deepConductanceWM2K: 10 },
  "vegetation-tree": { solarAbsorptance: 0.85, emissivity: 0.97, arealHeatCapacityJM2K: 2.0e4, deepConductanceWM2K: 1 },
  "bare-soil": { solarAbsorptance: 0.75, emissivity: 0.93, arealHeatCapacityJM2K: 1.1e5, deepConductanceWM2K: 8 },
  "water": { solarAbsorptance: 0.92, emissivity: 0.97, arealHeatCapacityJM2K: 4.18e6, deepConductanceWM2K: 50 },
  "synthetic-ground": { solarAbsorptance: 0.75, emissivity: 0.93, arealHeatCapacityJM2K: 1.1e5, deepConductanceWM2K: 8 },
});

export interface ThermalWeather {
  airTemperatureK: number;
  windSpeedMps: number;
  cloudFraction: number;
  deepTemperatureK: number;
}

/** Per-step forcing shared by all elements (fields, so no float arguments are boxed). */
export interface ThermalForcing {
  /** Unit vector towards the sun, ENU (any value when the sun is down). */
  sunEast: number; sunNorth: number; sunUp: number;
  directNormalWm2: number;
  diffuseHorizontalWm2: number;
  dtS: number;
}

/** Element flux breakdown, W/m^2 (positive into the surface). */
export interface FluxBreakdown { absorbedSolar: number; longwaveIn: number; longwaveOut: number; convection: number; conduction: number; net: number }

export function validateProps(p: SurfaceThermalProps): void {
  if (!(p.solarAbsorptance >= 0 && p.solarAbsorptance <= 1 && p.emissivity >= 0 && p.emissivity <= 1 &&
    p.arealHeatCapacityJM2K >= 1e3 && p.arealHeatCapacityJM2K <= 1e8 && p.deepConductanceWM2K >= 0 && p.deepConductanceWM2K <= 1e3)) {
    throw new Error("Invalid surface thermal properties");
  }
}

/**
 * Temperatures for N surface elements with per-element properties, normal and
 * exposure. stepFrom() is allocation-free; configuration is validated once.
 */
export class ThermalField {
  readonly count: number;
  readonly temperatureK: Float64Array;
  /** Cumulative net energy into each element since reset, J/m^2. */
  readonly energyJM2: Float64Array;
  private readonly alpha: Float64Array; private readonly eps: Float64Array;
  private readonly cap: Float64Array; private readonly gDeep: Float64Array;
  private readonly normal: Float64Array; private readonly shadow: Float64Array; private readonly skyView: Float64Array;
  private readonly weather: ThermalWeather;
  private readonly scratch = { net: 0.5 };

  constructor(elements: readonly { props: SurfaceThermalProps; normalEnu?: readonly [number, number, number]; shadowFraction?: number; skyViewFactor?: number }[],
    weather: ThermalWeather, initialTemperatureK: number) {
    const n = elements.length;
    if (n < 1 || n > 1_000_000) throw new Error("Element count out of range");
    this.count = n;
    this.temperatureK = new Float64Array(n).fill(initialTemperatureK);
    this.energyJM2 = new Float64Array(n);
    this.alpha = new Float64Array(n); this.eps = new Float64Array(n); this.cap = new Float64Array(n); this.gDeep = new Float64Array(n);
    this.normal = new Float64Array(3 * n); this.shadow = new Float64Array(n); this.skyView = new Float64Array(n);
    elements.forEach((e, i) => {
      validateProps(e.props);
      const [nx, ny, nz] = e.normalEnu ?? [0, 0, 1];
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 0.999 && len < 1.001)) throw new Error("Surface normal must be a unit vector");
      const shadow = e.shadowFraction ?? 0, sky = e.skyViewFactor ?? 1;
      if (!(shadow >= 0 && shadow <= 1 && sky >= 0 && sky <= 1)) throw new Error("Shadow and sky-view fractions must be in [0, 1]");
      this.alpha[i] = e.props.solarAbsorptance; this.eps[i] = e.props.emissivity;
      this.cap[i] = e.props.arealHeatCapacityJM2K; this.gDeep[i] = e.props.deepConductanceWM2K;
      this.normal[3 * i] = nx; this.normal[3 * i + 1] = ny; this.normal[3 * i + 2] = nz;
      this.shadow[i] = shadow; this.skyView[i] = sky;
    });
    if (!(initialTemperatureK > 150 && initialTemperatureK < 400)) throw new Error("Initial temperature out of range");
    this.weather = { airTemperatureK: 288, windSpeedMps: 0, cloudFraction: 0, deepTemperatureK: 288 };
    this.setWeather(weather);
  }

  /** Air temperature from a TASK-032 atmosphere state. */
  static weatherFrom(atmosphere: Atmosphere, windSpeedMps: number, cloudFraction: number, deepTemperatureK: number): ThermalWeather {
    return { airTemperatureK: atmosphere.temperatureK, windSpeedMps, cloudFraction, deepTemperatureK };
  }

  setWeather(w: ThermalWeather): void {
    if (!(w.airTemperatureK > 180 && w.airTemperatureK < 330 && w.windSpeedMps >= 0 && w.windSpeedMps <= 60 &&
      w.cloudFraction >= 0 && w.cloudFraction <= 1 && w.deepTemperatureK > 180 && w.deepTemperatureK < 350)) throw new Error("Invalid thermal weather");
    Object.assign(this.weather, w);
  }

  setShadowFraction(index: number, fraction: number): void {
    if (!(Number.isInteger(index) && index >= 0 && index < this.count) || !(fraction >= 0 && fraction <= 1)) throw new Error("Invalid shadow update");
    this.shadow[index] = fraction;
  }

  /** Net flux (W/m^2) into element i at temperature tK; writes the breakdown when `out` is given. */
  fluxAt(i: number, tK: number, f: ThermalForcing, out?: FluxBreakdown): number {
    this.netInto(i, tK, f);
    if (out) {
      const w = this.weather, eps = this.eps[i]!, v = this.skyView[i]!; // i < count
      const ta4 = w.airTemperatureK ** 4;
      const nx = this.normal[3 * i]!, ny = this.normal[3 * i + 1]!, nz = this.normal[3 * i + 2]!;
      const cosI = Math.max(0, nx * f.sunEast + ny * f.sunNorth + nz * f.sunUp);
      out.absorbedSolar = this.alpha[i]! * (f.directNormalWm2 * cosI * (1 - this.shadow[i]!) + f.diffuseHorizontalWm2 * v);
      out.longwaveIn = eps * (v * skyEmissivity(w.airTemperatureK, w.cloudFraction) + (1 - v)) * STEFAN_BOLTZMANN * ta4;
      out.longwaveOut = -eps * STEFAN_BOLTZMANN * tK ** 4;
      out.convection = -(5.7 + 3.8 * w.windSpeedMps) * (tK - w.airTemperatureK);
      out.conduction = -this.gDeep[i]! * (tK - w.deepTemperatureK);
      out.net = this.scratch.net;
    }
    return this.scratch.net;
  }

  /** Writes the net flux into scratch.net (a returned double could be boxed in the hot loop). */
  private netInto(i: number, tK: number, f: ThermalForcing): void {
    const w = this.weather, eps = this.eps[i]!, v = this.skyView[i]!; // i < count
    const nx = this.normal[3 * i]!, ny = this.normal[3 * i + 1]!, nz = this.normal[3 * i + 2]!;
    let cosI = nx * f.sunEast + ny * f.sunNorth + nz * f.sunUp;
    if (cosI < 0) cosI = 0;
    const solar = this.alpha[i]! * (f.directNormalWm2 * cosI * (1 - this.shadow[i]!) + f.diffuseHorizontalWm2 * v);
    const ta = w.airTemperatureK, ta2 = ta * ta, t2 = tK * tK;
    const epsSky = 9.2e-6 * ta2 * (1 + 0.22 * w.cloudFraction * w.cloudFraction);
    const lwIn = eps * (v * (epsSky > 1 ? 1 : epsSky) + (1 - v)) * STEFAN_BOLTZMANN * ta2 * ta2;
    const lwOut = eps * STEFAN_BOLTZMANN * t2 * t2;
    const h = 5.7 + 3.8 * w.windSpeedMps;
    this.scratch.net = solar + lwIn - lwOut - h * (tK - ta) - this.gDeep[i]! * (tK - w.deepTemperatureK);
  }

  /**
   * Advances every element by forcing.dtS seconds (Heun). Splits the step into
   * equal substeps when dt exceeds the linearised stability limit of an
   * element. Returns false (state unchanged) for an invalid dt.
   */
  stepFrom(f: ThermalForcing): boolean {
    const dt = f.dtS;
    if (!(dt > 0 && dt <= 3600)) return false;
    const w = this.weather, h = 5.7 + 3.8 * w.windSpeedMps;
    for (let i = 0; i < this.count; i++) {
      let t = this.temperatureK[i]!; // i < count
      const c = this.cap[i]!;
      // Linearised conductance: 4 eps sigma T^3 + h + G (radiation bounded at 400 K).
      const k = 4 * this.eps[i]! * STEFAN_BOLTZMANN * 6.4e7 + h + this.gDeep[i]!;
      const maxDt = c / k; // Heun is stable for dt * k / C <= 2; keep a 2x margin
      const n = dt <= maxDt ? 1 : Math.ceil(dt / maxDt);
      const sub = dt / n;
      let energy = 0;
      for (let s = 0; s < n; s++) {
        this.netInto(i, t, f);
        const f1 = this.scratch.net;
        this.netInto(i, t + (sub * f1) / c, f);
        const avg = 0.5 * (f1 + this.scratch.net);
        t += (sub * avg) / c;
        energy += sub * avg;
      }
      this.temperatureK[i] = t;
      this.energyJM2[i] = this.energyJM2[i]! + energy;
    }
    return true;
  }

  /** Steady-state temperature of element i under constant forcing (bisection on the net flux). */
  equilibriumK(i: number, f: ThermalForcing): number {
    let lo = 150, hi = 400;
    for (let it = 0; it < 200; it++) {
      const mid = 0.5 * (lo + hi);
      if (this.fluxAt(i, mid, f) > 0) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }
}
