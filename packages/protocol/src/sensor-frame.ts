import { SLOT_GEO, SLOT_VALUES, SPSC_SLOT_WORDS, SlotOffsetV2 } from './spsc-v2.ts';
import { F32_ROUNDING_LIMIT, isValidTick, type TickId } from './state-v2.ts';

// Sensor queue frames (docs/SPECS_SHARED_MEMORY.md section 5). Values travel
// as f32; GNSS position travels as f64 degrees/metres MSL in geo_lat_lon_alt.

export const SensorKindV2 = { Imu: 1, Gnss: 2, Magnetometer: 3, Barometer: 4, Airspeed: 5 } as const;
export type SensorKind = typeof SensorKindV2[keyof typeof SensorKindV2];
/** Required value_count per kind. */
export const SENSOR_VALUE_COUNT: Readonly<Record<SensorKind, number>> = { 1: 6, 2: 8, 3: 3, 4: 3, 5: 1 };

export const SensorValidityV2 = {
  PayloadValid: 1 << 0, PositionFixValid: 1 << 1, CourseValid: 1 << 2, TimestampValid: 1 << 3,
  EncodingClipped: 1 << 4, SourceStale: 1 << 5, HdopValid: 1 << 6, VdopValid: 1 << 7,
  VelocityValid: 1 << 8, SatellitesValid: 1 << 9,
} as const;
const COMMON_VALIDITY = SensorValidityV2.PayloadValid | SensorValidityV2.TimestampValid |
  SensorValidityV2.EncodingClipped | SensorValidityV2.SourceStale;
/** Bits that apply only to GNSS; inapplicable bits must be zero. */
const GNSS_VALIDITY = SensorValidityV2.PositionFixValid | SensorValidityV2.CourseValid | SensorValidityV2.HdopValid |
  SensorValidityV2.VdopValid | SensorValidityV2.VelocityValid | SensorValidityV2.SatellitesValid;

/** GNSS value indices: vN/vE/vD m/s, HDOP, VDOP, fix_type, satellites, course rad. */
export const GnssValue = { VnMps: 0, VeMps: 1, VdMps: 2, Hdop: 3, Vdop: 4, FixType: 5, Satellites: 6, CourseRad: 7 } as const;

export interface SensorFrameV2 {
  kind: number; epoch: number; tickId: TickId; sampleTimeUs: TickId;
  validityFlags: number; valueCount: number;
  /** IMU: FRD specific force m/s^2 [0..2], gyro rad/s [3..5]; MAG: FRD gauss; BARO: Pa, m, K; AIRSPEED: Pa. */
  values: Float64Array;
  /** GNSS only: latitude deg, longitude deg, altitude m MSL; zero for other kinds. */
  geoLatLonAlt: Float64Array;
  sourceId: number;
}
export function newSensorFrameV2(): SensorFrameV2 {
  return { kind: 0, epoch: 0, tickId: { lo: 0, hi: 0 }, sampleTimeUs: { lo: 0, hi: 0 }, validityFlags: 0, valueCount: 0,
    values: new Float64Array(SLOT_VALUES), geoLatLonAlt: new Float64Array(SLOT_GEO), sourceId: 0 };
}

function isSensorKind(kind: number): kind is SensorKind {
  return kind === 1 || kind === 2 || kind === 3 || kind === 4 || kind === 5;
}
/**
 * Contract check shared by producer (before encoding) and consumer (after decoding).
 * Allocation-free; inline comparisons only (see isValidTick in state-v2.ts).
 */
export function isValidSensorFrameV2(f: SensorFrameV2): boolean {
  if (!isSensorKind(f.kind) || f.valueCount !== SENSOR_VALUE_COUNT[f.kind] || f.values.length !== SLOT_VALUES ||
    f.geoLatLonAlt.length !== SLOT_GEO || (f.epoch >>> 0) !== f.epoch || !isValidTick(f.tickId) || !isValidTick(f.sampleTimeUs) ||
    (f.sourceId >>> 0) !== f.sourceId || (f.validityFlags >>> 0) !== f.validityFlags) return false;
  const gnss = f.kind === SensorKindV2.Gnss;
  if ((f.validityFlags & ~(COMMON_VALIDITY | (gnss ? GNSS_VALIDITY : 0))) !== 0) return false;
  for (let i = 0; i < SLOT_VALUES; i++) {
    const value = f.values[i]!;
    if (i < f.valueCount ? !(Math.abs(value) < F32_ROUNDING_LIMIT) : value !== 0) return false;
  }
  if (gnss) {
    const lat = f.geoLatLonAlt[0]!, lon = f.geoLatLonAlt[1]!, alt = f.geoLatLonAlt[2]!;
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !Number.isFinite(alt)) return false;
    // Integer quantities carried as f32 must be exact; DOP placeholders are finite and nonnegative.
    // Integers 0..255 are exact in f32; (x >>> 0) === x rejects fractions, negatives, and NaN.
    const fix = f.values[GnssValue.FixType]!, satellites = f.values[GnssValue.Satellites]!;
    if ((fix >>> 0) !== fix || fix > 255 || (satellites >>> 0) !== satellites || satellites > 255) return false;
    if (!(f.values[GnssValue.Hdop]! >= 0) || !(f.values[GnssValue.Vdop]! >= 0)) return false;
  } else {
    for (let i = 0; i < SLOT_GEO; i++) if (f.geoLatLonAlt[i] !== 0) return false;
  }
  return true;
}

const O = SlotOffsetV2;
/** Encodes/decodes one 128-byte sensor slot in a thread-local scratch frame. */
export class SensorFrameCodecV2 {
  readonly words = new Int32Array(SPSC_SLOT_WORDS);
  private readonly view = new DataView(this.words.buffer);

  /** Returns false (scratch untouched) when the frame violates the contract. */
  encode(f: SensorFrameV2): boolean {
    if (!isValidSensorFrameV2(f)) return false;
    const v = this.view;
    v.setUint32(O.kind, f.kind, true); v.setUint32(O.epoch, f.epoch, true);
    v.setUint32(O.tickId, f.tickId.lo, true); v.setUint32(O.tickId + 4, f.tickId.hi, true);
    v.setUint32(O.timeUs, f.sampleTimeUs.lo, true); v.setUint32(O.timeUs + 4, f.sampleTimeUs.hi, true);
    v.setUint32(O.flags, f.validityFlags, true); v.setUint32(O.count, f.valueCount, true);
    for (let i = 0; i < SLOT_VALUES; i++) v.setFloat32(O.values + i * 4, f.values[i]!, true);
    for (let i = 0; i < SLOT_GEO; i++) v.setFloat64(O.geo + i * 8, f.geoLatLonAlt[i]!, true);
    v.setUint32(O.sourceId, f.sourceId, true); v.setUint32(O.reserved, 0, true);
    return true;
  }
  /** Decodes into `out` and validates it; a false result means the frame must be discarded as invalid. */
  decode(out: SensorFrameV2): boolean {
    const v = this.view;
    if (v.getUint32(O.reserved, true) !== 0) return false;
    out.kind = v.getUint32(O.kind, true); out.epoch = v.getUint32(O.epoch, true);
    out.tickId.lo = v.getUint32(O.tickId, true); out.tickId.hi = v.getUint32(O.tickId + 4, true);
    out.sampleTimeUs.lo = v.getUint32(O.timeUs, true); out.sampleTimeUs.hi = v.getUint32(O.timeUs + 4, true);
    out.validityFlags = v.getUint32(O.flags, true); out.valueCount = v.getUint32(O.count, true);
    for (let i = 0; i < SLOT_VALUES; i++) out.values[i] = v.getFloat32(O.values + i * 4, true);
    for (let i = 0; i < SLOT_GEO; i++) out.geoLatLonAlt[i] = v.getFloat64(O.geo + i * 8, true);
    out.sourceId = v.getUint32(O.sourceId, true);
    return isValidSensorFrameV2(out);
  }
}
