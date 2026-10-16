import {
  copyGpsInto,
  validGps,
  type GpsSample,
} from "../../mavlink/src/samples.ts";
/** Version 1 synthetic receiver preset. Severity evolves only on the physics clock. */
export class GnssJamming {
  private filtered = 0;
  private readonly input = new Float64Array(1);
  private denied = false;
  constructor(
    private readonly tauS = 0.5,
    private readonly jamSatellites = 1,
    private readonly jamDop = 99,
  ) {
    if (
      !Number.isFinite(tauS) ||
      tauS <= 0 ||
      !Number.isInteger(jamSatellites) ||
      jamSatellites < 0 ||
      jamSatellites > 3 ||
      !Number.isFinite(jamDop) ||
      jamDop < 50 ||
      jamDop > 99
    )
      throw new Error("Invalid jamming preset");
  }
  reset(): void {
    this.filtered = 0;
    this.denied = false;
  }
  /** Low-rate scalar convenience; use advanceInto in the high-rate pipeline. */
  advance(severity: number, dtS: number): boolean {
    this.input[0] = severity;
    return this.advanceInto(this.input, dtS);
  }
  advanceInto(severityInput: Float64Array, dtS: number): boolean {
    if (severityInput.length !== 1) return false;
    const severity = severityInput[0]!;
    if (
      !Number.isFinite(severity) ||
      severity < 0 ||
      severity > 1 ||
      !Number.isFinite(dtS) ||
      dtS <= 0 ||
      dtS > 0.01
    )
      return false;
    this.filtered += (severity - this.filtered) * -Math.expm1(-dtS / this.tauS);
    // Satellite-dependent denial is also checked at observation time.
    if (this.filtered >= 0.8) this.denied = true;
    return true;
  }
  distortInto(s: GpsSample, t: GpsSample): boolean {
    if (s === t || !validGps(s)) return false;
    copyGpsInto(s, t);
    const q = this.filtered;
    if (q === 0 && !this.denied) return true;
    if (s.satellitesValid)
      t.satellites = Math.min(
        s.satellites,
        Math.round((1 - q) * s.satellites + q * this.jamSatellites),
      );
    if (s.hdopValid)
      t.hdop = Math.max(s.hdop, (1 - q) * s.hdop + q * this.jamDop);
    if (s.vdopValid)
      t.vdop = Math.max(s.vdop, (1 - q) * s.vdop + q * this.jamDop);
    if (q >= 0.8 || (s.satellitesValid && t.satellites < 4)) this.denied = true;
    else if (q < 0.6 && s.satellitesValid && t.satellites >= 4)
      this.denied = false;
    if (this.denied) t.fixType = 0;
    return true;
  }
}
