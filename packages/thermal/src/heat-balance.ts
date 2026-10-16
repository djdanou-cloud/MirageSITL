/** Synthetic lumped surface model, SI per square metre. Not a measured camera/soil model. */
export interface ThermalMaterial {
  heatCapacityJm2K: number;
  absorptivity: number;
  emissivity: number;
  convectionWm2K: number;
  conductionWm2K: number;
}
export interface ThermalForcing {
  airK: number;
  skyK: number;
  substrateK: number;
  solarWm2: number;
}
export const STEFAN_BOLTZMANN = 5.670374419e-8;
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
  private netFlux(t: number, f: ThermalForcing): number {
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
  advance(dtS: number, f: ThermalForcing): void {
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
