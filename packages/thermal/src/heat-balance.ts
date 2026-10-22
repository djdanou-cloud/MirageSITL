// Surface thermal state (TASK-070): a one-layer slab per surface element,
// integrated on the CPU at a fixed thermal step outside any shader.
//
//   C dT/dt = alpha (DNI max(0, n.s) (1 - shadow) + DHI V)                absorbed solar
//           + eps (V eps_sky + (1 - V)) sigma T_air^4                     longwave in
//           - eps sigma T^4                                                longwave out
//           - h (T - T_air)                                                convection
//           - G (T - T_deep)                                               conduction
//           - LE                                                           latent (evaporation)
//
// C areal heat capacity (J/m^2/K), alpha solar absorptance, eps emissivity,
// V sky-view factor (0..1), shadow the blocked fraction of the direct beam,
// h = 5.7 + 3.8 v (McAdams forced-convection fit, W/m^2/K, v wind m/s),
// G conductance to a deep layer at T_deep. Ambient occlusion enters only as
// V in these explicit radiative terms (occluded sky is replaced by
// surroundings at air temperature); it is never a substitute heat solver.
//
// Latent heat (TASK-073 P5) uses a big-leaf Penman-Monteith form for surfaces
// with a surface resistance r_s (vegetation, open water); other surfaces have
// none and do not evaporate:
//   LE   = (rho c_p / gamma) max(0, e_s(T) - RH e_s(T_air)) / (r_a + r_s)
//   r_a  = rho c_p / h        (heat and vapour share the convective transfer)
//   e_s  = 610.8 exp(17.27 T_c / (T_c + 237.3)) Pa, T_c in deg C (FAO-56 eq. 11)
//   gamma = 0.665e-3 P        (psychrometric constant, Pa/K, FAO-56 eq. 8)
// rho c_p = 1.2 kg/m^3 x 1005 J/kg/K. Dew (negative LE) is not modelled.
// r_s: 70 s/m for grass and crops (FAO-56 reference surface), 100 s/m for
// tree canopy (assumed, well-watered; uncalibrated), 0 for open water.
// A tall rough canopy (props.canopyHeightM) exchanges heat far better than
// the flat-plate McAdams fit: its r_a follows the FAO-56 log profile (eq. 4)
//   r_a = ln((z - d) / z_om) ln((z - d) / z_oh) / (k^2 u),
//   d = 2/3 H, z_om = 0.123 H, z_oh = 0.1 z_om, k = 0.41, z = H + 2 m,
// with the weather wind taken at z and floored at 0.5 m/s (FAO-56), and
// h = rho c_p / r_a replaces the McAdams h for both sensible and latent heat.
// Integration: Heun (explicit second order) with automatic substeps below the
// linearised stability limit. Material properties below are typical,
// uncalibrated values: measured validation is pending.
//
// HeatSurface (end of file) is the single-surface reference solver from the
// parallel implementation: it takes the forcing as temperatures and an
// absorbed-solar flux directly and integrates with an A-stable implicit
// trapezoid. The two solvers are cross-checked in tests/thermal-energy.test.ts.
import type { Atmosphere } from "@mirage/physics/atmosphere";
import { STEFAN_BOLTZMANN, skyEmissivity } from "./solar.ts";
export { STEFAN_BOLTZMANN } from "./solar.ts";

export interface SurfaceThermalProps {
  solarAbsorptance: number;
  emissivity: number;
  arealHeatCapacityJM2K: number;
  deepConductanceWM2K: number;
  /** Bulk surface (stomatal) resistance to evaporation, s/m; absent for surfaces that do not evaporate. */
  surfaceResistanceSM?: number;
  /** Height of a rough canopy, m: selects the FAO-56 log-profile aerodynamic resistance instead of McAdams. */
  canopyHeightM?: number;
}

/** Volumetric heat capacity of air, J/m^3/K (1.2 kg/m^3 x 1005 J/kg/K). */
export const AIR_RHO_CP = 1.2 * 1005;
/** Relative humidity used when the weather does not state one. */
export const DEFAULT_RELATIVE_HUMIDITY = 0.5;

/** Saturation vapour pressure over water, Pa (FAO-56 eq. 11, Tetens form). */
export function saturationVapourPressurePa(tK: number): number {
  const c = tK - 273.15;
  return 610.8 * Math.exp((17.27 * c) / (c + 237.3));
}
/** Psychrometric constant, Pa/K (FAO-56 eq. 8). */
export function psychrometricPaK(pressurePa: number): number {
  return 0.665e-3 * pressurePa;
}
/** Saturation slope de_s/dT at 400 K, Pa/K: bounds the latent term's linearised conductance. */
const SATURATION_SLOPE_400K = (4098 * saturationVapourPressurePa(400)) / (400 - 273.15 + 237.3) ** 2;
const VON_KARMAN = 0.41;
/** Wind-independent part of the FAO-56 eq. 4 aerodynamic resistance, r_a u (m). */
export function canopyLogFactor(heightM: number): number {
  const d = (2 / 3) * heightM, zom = 0.123 * heightM, zoh = 0.1 * zom, z = heightM + 2;
  return (Math.log((z - d) / zom) * Math.log((z - d) / zoh)) / (VON_KARMAN * VON_KARMAN);
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
  "vegetation-grass": { solarAbsorptance: 0.75, emissivity: 0.96, arealHeatCapacityJM2K: 1.25e5, deepConductanceWM2K: 10, surfaceResistanceSM: 70 },
  "vegetation-tree": { solarAbsorptance: 0.85, emissivity: 0.97, arealHeatCapacityJM2K: 2.0e4, deepConductanceWM2K: 1, surfaceResistanceSM: 100, canopyHeightM: 10 },
  "bare-soil": { solarAbsorptance: 0.75, emissivity: 0.93, arealHeatCapacityJM2K: 1.1e5, deepConductanceWM2K: 8 },
  "water": { solarAbsorptance: 0.92, emissivity: 0.97, arealHeatCapacityJM2K: 4.18e6, deepConductanceWM2K: 50, surfaceResistanceSM: 0 },
  "synthetic-ground": { solarAbsorptance: 0.75, emissivity: 0.93, arealHeatCapacityJM2K: 1.1e5, deepConductanceWM2K: 8 },
});

export interface ThermalWeather {
  airTemperatureK: number;
  windSpeedMps: number;
  cloudFraction: number;
  deepTemperatureK: number;
  /** Relative humidity of the air, 0..1 (DEFAULT_RELATIVE_HUMIDITY when absent). */
  relativeHumidity?: number;
  /** Surface air pressure, Pa (101325 when absent). */
  pressurePa?: number;
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
export interface FluxBreakdown { absorbedSolar: number; longwaveIn: number; longwaveOut: number; convection: number; conduction: number; latent: number; net: number }

export function validateProps(p: SurfaceThermalProps): void {
  if (!(p.solarAbsorptance >= 0 && p.solarAbsorptance <= 1 && p.emissivity >= 0 && p.emissivity <= 1 &&
    p.arealHeatCapacityJM2K >= 1e3 && p.arealHeatCapacityJM2K <= 1e8 && p.deepConductanceWM2K >= 0 && p.deepConductanceWM2K <= 1e3 &&
    (p.surfaceResistanceSM === undefined || (p.surfaceResistanceSM >= 0 && p.surfaceResistanceSM <= 1e5)) &&
    (p.canopyHeightM === undefined || (p.canopyHeightM >= 0.5 && p.canopyHeightM <= 100)))) {
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
  /** Surface resistance r_s, s/m; Infinity where the surface does not evaporate. */
  private readonly rs: Float64Array;
  /** FAO-56 r_a u factor (m) for rough canopies; 0 selects the McAdams h. */
  private readonly canopyLog: Float64Array;
  // Weather-dependent per-element coefficients, refreshed by setWeather() so the step loop only reads arrays:
  /** Sensible transfer coefficient h, W/m^2/K. */
  private readonly h: Float64Array;
  /** (rho c_p / gamma) / (r_a + r_s), W/m^2/Pa; 0 where the surface does not evaporate. */
  private readonly leCoef: Float64Array;
  /** [0] = actual vapour pressure of the air RH e_s(T_air), Pa. */
  private readonly vapour = new Float64Array(1);
  private readonly weather: Required<ThermalWeather>;
  private readonly scratch = { net: 0.5 };
  /** [0] = surface temperature passed to netInto(): a double argument of a non-inlined call is boxed. */
  private readonly tIn = new Float64Array(1);

  constructor(elements: readonly { props: SurfaceThermalProps; normalEnu?: readonly [number, number, number]; shadowFraction?: number; skyViewFactor?: number }[],
    weather: ThermalWeather, initialTemperatureK: number) {
    const n = elements.length;
    if (n < 1 || n > 1_000_000) throw new Error("Element count out of range");
    this.count = n;
    this.temperatureK = new Float64Array(n).fill(initialTemperatureK);
    this.energyJM2 = new Float64Array(n);
    this.alpha = new Float64Array(n); this.eps = new Float64Array(n); this.cap = new Float64Array(n); this.gDeep = new Float64Array(n);
    this.normal = new Float64Array(3 * n); this.shadow = new Float64Array(n); this.skyView = new Float64Array(n);
    this.rs = new Float64Array(n); this.canopyLog = new Float64Array(n); this.h = new Float64Array(n); this.leCoef = new Float64Array(n);
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
      this.rs[i] = e.props.surfaceResistanceSM ?? Infinity;
      this.canopyLog[i] = e.props.canopyHeightM === undefined ? 0 : canopyLogFactor(e.props.canopyHeightM);
    });
    if (!(initialTemperatureK > 150 && initialTemperatureK < 400)) throw new Error("Initial temperature out of range");
    this.weather = { airTemperatureK: 288, windSpeedMps: 0, cloudFraction: 0, deepTemperatureK: 288, relativeHumidity: DEFAULT_RELATIVE_HUMIDITY, pressurePa: 101325 };
    this.setWeather(weather);
  }

  /** Air temperature and pressure from a TASK-032 atmosphere state. */
  static weatherFrom(atmosphere: Atmosphere, windSpeedMps: number, cloudFraction: number, deepTemperatureK: number,
    relativeHumidity = DEFAULT_RELATIVE_HUMIDITY): ThermalWeather {
    return { airTemperatureK: atmosphere.temperatureK, windSpeedMps, cloudFraction, deepTemperatureK, relativeHumidity, pressurePa: atmosphere.pressurePa };
  }

  setWeather(w: ThermalWeather): void {
    if (!(w.airTemperatureK > 180 && w.airTemperatureK < 330 && w.windSpeedMps >= 0 && w.windSpeedMps <= 60 &&
      w.cloudFraction >= 0 && w.cloudFraction <= 1 && w.deepTemperatureK > 180 && w.deepTemperatureK < 350 &&
      (w.relativeHumidity === undefined || (w.relativeHumidity >= 0 && w.relativeHumidity <= 1)) &&
      (w.pressurePa === undefined || (w.pressurePa > 3e4 && w.pressurePa < 1.2e5)))) throw new Error("Invalid thermal weather");
    Object.assign(this.weather, w);
    this.weather.relativeHumidity = w.relativeHumidity ?? DEFAULT_RELATIVE_HUMIDITY;
    this.weather.pressurePa = w.pressurePa ?? 101325;
    const u = this.weather.windSpeedMps, rhoCpOverGamma = AIR_RHO_CP / psychrometricPaK(this.weather.pressurePa);
    for (let i = 0; i < this.count; i++) {
      const log = this.canopyLog[i]!, rs = this.rs[i]!; // i < count
      const h = log > 0 ? (AIR_RHO_CP * (u > 0.5 ? u : 0.5)) / log : 5.7 + 3.8 * u;
      this.h[i] = h;
      this.leCoef[i] = rs === Infinity ? 0 : rhoCpOverGamma / (AIR_RHO_CP / h + rs);
    }
    this.vapour[0] = this.weather.relativeHumidity * saturationVapourPressurePa(this.weather.airTemperatureK);
  }

  setShadowFraction(index: number, fraction: number): void {
    if (!(Number.isInteger(index) && index >= 0 && index < this.count) || !(fraction >= 0 && fraction <= 1)) throw new Error("Invalid shadow update");
    this.shadow[index] = fraction;
  }

  /** Net flux (W/m^2) into element i at temperature tK; writes the breakdown when `out` is given. */
  fluxAt(i: number, tK: number, f: ThermalForcing, out?: FluxBreakdown): number {
    this.tIn[0] = tK;
    this.netInto(i, f);
    if (out) {
      const w = this.weather, eps = this.eps[i]!, v = this.skyView[i]!; // i < count
      const ta4 = w.airTemperatureK ** 4;
      const nx = this.normal[3 * i]!, ny = this.normal[3 * i + 1]!, nz = this.normal[3 * i + 2]!;
      const cosI = Math.max(0, nx * f.sunEast + ny * f.sunNorth + nz * f.sunUp);
      out.absorbedSolar = this.alpha[i]! * (f.directNormalWm2 * cosI * (1 - this.shadow[i]!) + f.diffuseHorizontalWm2 * v);
      out.longwaveIn = eps * (v * skyEmissivity(w.airTemperatureK, w.cloudFraction) + (1 - v)) * STEFAN_BOLTZMANN * ta4;
      out.longwaveOut = -eps * STEFAN_BOLTZMANN * tK ** 4;
      out.convection = -this.h[i]! * (tK - w.airTemperatureK);
      out.conduction = -this.gDeep[i]! * (tK - w.deepTemperatureK);
      const deficit = saturationVapourPressurePa(tK) - this.vapour[0]!; // length-1 array
      out.latent = deficit > 0 ? -this.leCoef[i]! * deficit : 0;
      out.net = this.scratch.net;
    }
    return this.scratch.net;
  }

  /** Net flux at temperature tIn[0] into scratch.net (doubles cross the call through memory, never boxed). */
  private netInto(i: number, f: ThermalForcing): void {
    const tK = this.tIn[0]!; // length-1 array
    const w = this.weather, eps = this.eps[i]!, v = this.skyView[i]!; // i < count
    const nx = this.normal[3 * i]!, ny = this.normal[3 * i + 1]!, nz = this.normal[3 * i + 2]!;
    let cosI = nx * f.sunEast + ny * f.sunNorth + nz * f.sunUp;
    if (cosI < 0) cosI = 0;
    const solar = this.alpha[i]! * (f.directNormalWm2 * cosI * (1 - this.shadow[i]!) + f.diffuseHorizontalWm2 * v);
    const ta = w.airTemperatureK, ta2 = ta * ta, t2 = tK * tK;
    const epsSky = 9.2e-6 * ta2 * (1 + 0.22 * w.cloudFraction * w.cloudFraction);
    const lwIn = eps * (v * (epsSky > 1 ? 1 : epsSky) + (1 - v)) * STEFAN_BOLTZMANN * ta2 * ta2;
    const lwOut = eps * STEFAN_BOLTZMANN * t2 * t2;
    let latent = 0;
    const coef = this.leCoef[i]!;
    if (coef > 0) {
      // e_s inlined (FAO-56 eq. 11): a helper returning a double could be boxed in this loop.
      const c = tK - 273.15;
      const deficit = 610.8 * Math.exp((17.27 * c) / (c + 237.3)) - this.vapour[0]!; // length-1 array
      if (deficit > 0) latent = coef * deficit;
    }
    this.scratch.net = solar + lwIn - lwOut - this.h[i]! * (tK - ta) - this.gDeep[i]! * (tK - w.deepTemperatureK) - latent;
  }

  /** Sensible heat transfer coefficient h of element i, W/m^2/K (McAdams, or FAO-56 log profile for a canopy). */
  convectiveConductance(i: number): number {
    if (!(Number.isInteger(i) && i >= 0 && i < this.count)) throw new Error("Element index out of range");
    return this.h[i]!; // checked above
  }

  /**
   * Advances every element by forcing.dtS seconds (Heun). Splits the step into
   * equal substeps when dt exceeds the linearised stability limit of an
   * element. Returns false (state unchanged) for an invalid dt.
   */
  stepFrom(f: ThermalForcing): boolean {
    const dt = f.dtS;
    if (!(dt > 0 && dt <= 3600)) return false;
    for (let i = 0; i < this.count; i++) {
      let t = this.temperatureK[i]!; // i < count
      const c = this.cap[i]!;
      // Linearised conductance: 4 eps sigma T^3 + h + G + dLE/dT (radiation and saturation slope bounded at 400 K).
      const k = 4 * this.eps[i]! * STEFAN_BOLTZMANN * 6.4e7 + this.h[i]! + this.gDeep[i]! + this.leCoef[i]! * SATURATION_SLOPE_400K;
      const maxDt = c / k; // Heun is stable for dt * k / C <= 2; keep a 2x margin
      const n = dt <= maxDt ? 1 : Math.ceil(dt / maxDt);
      const sub = dt / n;
      let energy = 0;
      for (let s = 0; s < n; s++) {
        this.tIn[0] = t;
        this.netInto(i, f);
        const f1 = this.scratch.net;
        this.tIn[0] = t + (sub * f1) / c;
        this.netInto(i, f);
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

// ---- Single-surface reference solver -------------------------------------------

/** Synthetic lumped surface model, SI per square metre. Not a measured camera/soil model. */
export interface ThermalMaterial {
  heatCapacityJm2K: number;
  absorptivity: number;
  emissivity: number;
  convectionWm2K: number;
  conductionWm2K: number;
}
/** Forcing of a single HeatSurface: temperatures and absorbed-solar input. */
export interface SurfaceForcing {
  airK: number;
  skyK: number;
  substrateK: number;
  solarWm2: number;
}
export class HeatSurface {
  temperatureK: number;
  readonly material: Readonly<ThermalMaterial>;
  constructor(material: ThermalMaterial, initialK: number) {
    if (
      !Object.values(material).every(Number.isFinite) ||
      material.heatCapacityJm2K < 1 ||
      material.heatCapacityJm2K > 1e9 ||
      material.absorptivity < 0 ||
      material.absorptivity > 1 ||
      material.emissivity < 0 ||
      material.emissivity > 1 ||
      material.convectionWm2K < 0 ||
      material.convectionWm2K > 1e5 ||
      material.conductionWm2K < 0 ||
      material.conductionWm2K > 1e5 ||
      !Number.isFinite(initialK) ||
      initialK < 100 ||
      initialK > 1000
    )
      throw new RangeError("Invalid thermal material or initial temperature");
    this.material = Object.freeze({ ...material });
    this.temperatureK = initialK;
  }
  private netFlux(t: number, f: SurfaceForcing): number {
    const m = this.material;
    return (
      m.absorptivity * f.solarWm2 -
      m.convectionWm2K * (t - f.airK) -
      m.emissivity * STEFAN_BOLTZMANN * (t ** 4 - f.skyK ** 4) -
      m.conductionWm2K * (t - f.substrateK)
    );
  }
  /** Low-rate thermal update outside physics/shaders; implicit trapezoid is A-stable.
   * A bounded bisection avoids explicit-Euler runaway for thin materials.
   */
  advance(dtS: number, f: SurfaceForcing): void {
    if (
      !Number.isFinite(dtS) ||
      dtS <= 0 ||
      dtS > 60 ||
      !Object.values(f).every(Number.isFinite) ||
      f.airK < 100 ||
      f.airK > 1000 ||
      f.skyK < 100 ||
      f.skyK > 1000 ||
      f.substrateK < 100 ||
      f.substrateK > 1000 ||
      f.solarWm2 < 0 ||
      f.solarWm2 > 2000
    )
      throw new RangeError("Invalid thermal timestep or forcing");
    const t = this.temperatureK,
      half = dtS / (2 * this.material.heatCapacityJm2K),
      initialFlux = this.netFlux(t, f);
    let lo = 100,
      hi = 1000;
    const residual = (candidate: number) =>
      candidate - t - half * (initialFlux + this.netFlux(candidate, f));
    if (residual(lo) > 0 || residual(hi) < 0)
      throw new RangeError("Thermal state outside model envelope");
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (residual(mid) > 0) hi = mid;
      else lo = mid;
    }
    this.temperatureK = (lo + hi) / 2;
    // Preserve exact equilibrium and constant-flux analytic update.
    if (initialFlux === 0) this.temperatureK = t;
    else if (
      this.material.emissivity === 0 &&
      this.material.convectionWm2K === 0 &&
      this.material.conductionWm2K === 0
    )
      this.temperatureK =
        t + (dtS * initialFlux) / this.material.heatCapacityJm2K;
  }
}
