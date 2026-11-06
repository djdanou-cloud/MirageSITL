import { EFFECT_CATALOG, effectiveControl, parseEffectControl, type EffectControl, type EffectParameterValue } from "@mirage/protocol";
import { airAtOrigin } from "@mirage/physics/atmosphere";
import { LOCATION_ENVELOPE, STANDARD_SEA_LEVEL_PRESSURE_PA } from "@mirage/sensors/environment";
import type { LocationChoice } from "./location";

// The weather form of the Weather and location tab (TASK-167, S07): what a person types, and the TASK-166 environment controls it
// stands for. A wind is a speed and the bearing it blows from; the air at the ground comes from a sea-level pressure (standard or a
// measured QNH) and an ISA temperature offset at the location's elevation, through TASK-093's airAtOrigin, so the pressure stays
// consistent with the altitude. Pure, so the Node tests check it without the component.

export const WEATHER_EFFECTS = ["wind.mean", "wind.gust", "wind.discrete-gust", "wind.turbulence", "atmosphere"] as const;
export type WeatherEffect = typeof WEATHER_EFFECTS[number];
export const isWeatherEffect = (value: unknown): value is WeatherEffect => typeof value === "string" && (WEATHER_EFFECTS as readonly string[]).includes(value);
/** The largest steady wind the form offers, m/s: the wind model holds 200 m/s per axis. */
export const MAX_WIND_SPEED_MPS = 200;

export interface WeatherForm {
  readonly wind: { readonly speedMps: string; readonly fromDeg: string };
  readonly gust: { readonly rmsMps: string; readonly bandwidthHz: string; readonly seed: string };
  readonly discrete: { readonly amplitudeMps: string; readonly durationS: string; readonly fromDeg: string; readonly upwardDeg: string };
  readonly turbulence: { readonly w20Mps: string; readonly intensity: string; readonly seed: string };
  readonly air: { readonly pressure: "standard" | "measured"; readonly qnhHpa: string; readonly temperatureOffsetK: string };
}
/** A form with the catalog's starting values, and the air of the location. */
export function initialWeatherForm(location: LocationChoice): WeatherForm {
  return {
    wind: { speedMps: "5", fromDeg: "270" },
    gust: { rmsMps: "1", bandwidthHz: "1", seed: "1" },
    discrete: { amplitudeMps: "5", durationS: "4", fromDeg: "270", upwardDeg: "0" },
    turbulence: { w20Mps: "7.7", intensity: "1", seed: "1" },
    air: {
      pressure: location.measuredQnhPa === null ? "standard" : "measured",
      qnhHpa: location.measuredQnhPa === null ? (STANDARD_SEA_LEVEL_PRESSURE_PA / 100).toFixed(2) : String(location.measuredQnhPa / 100),
      temperatureOffsetK: String(location.temperatureOffsetK),
    },
  };
}

/** The air velocity, NED m/s, of a wind of `speedMps` blowing from `fromDeg`: from the west it blows east. */
export function windNedOf(speedMps: number, fromDeg: number): [number, number, number] {
  const from = fromDeg * Math.PI / 180;
  // + 0 makes -0 a plain 0, so a calm wind is written [0, 0, 0].
  return [-speedMps * Math.cos(from) + 0, -speedMps * Math.sin(from) + 0, 0];
}
/** The speed and from-bearing of an air velocity, for showing a mean wind. */
export function windOfNed(ned: readonly number[]): { speedMps: number; fromDeg: number } {
  const [north = 0, east = 0] = ned, speedMps = Math.hypot(north, east);
  return { speedMps, fromDeg: speedMps === 0 ? 0 : ((Math.atan2(-east, -north) * 180 / Math.PI) + 360) % 360 };
}

const number = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));
type Outcome = { readonly control: EffectControl; readonly problem: null } | { readonly control: null; readonly problem: string };
const problem = (message: string): Outcome => ({ control: null, problem: message });
/** A number field, or the problem with it. */
function within(label: string, text: string, min: number, max: number, integer = false): number | string {
  const value = number(text);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return `${label} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`;
  return value;
}
/** The control the form gives for one weather effect, with `id`, enabled, or the problem that keeps it from being one. */
export function weatherControl(form: WeatherForm, effect: WeatherEffect, location: LocationChoice, id: string): Outcome {
  let intensity = 1;
  const parameters: Record<string, EffectParameterValue> = {};
  const take = (key: string, value: number | string): boolean => {
    if (typeof value === "string") return false;
    parameters[key] = value;
    return true;
  };
  const checks: (number | string)[] = [];
  switch (effect) {
    case "wind.mean": {
      const speed = within("Wind speed", form.wind.speedMps, 0, MAX_WIND_SPEED_MPS), from = within("Wind from", form.wind.fromDeg, 0, 360);
      checks.push(speed, from);
      if (typeof speed === "number" && typeof from === "number") parameters.windNedMps = windNedOf(speed, from);
      break;
    }
    case "wind.gust":
      checks.push(within("Gust RMS", form.gust.rmsMps, 0, 50), within("Gust bandwidth", form.gust.bandwidthHz, 0.01, 199), within("Gust seed", form.gust.seed, 0, 0xffffffff, true));
      take("rmsMps", checks[0] ?? ""); take("bandwidthHz", checks[1] ?? ""); take("seed", checks[2] ?? "");
      break;
    case "wind.discrete-gust": {
      const from = within("Gust from", form.discrete.fromDeg, 0, 360);
      checks.push(within("Gust amplitude", form.discrete.amplitudeMps, 0, 50), within("Gust duration", form.discrete.durationS, 0.1, 60), from,
        within("Gust upward angle", form.discrete.upwardDeg, -90, 90));
      take("amplitudeMps", checks[0] ?? ""); take("durationS", checks[1] ?? "");
      // 360° is north again.
      if (typeof from === "number") parameters.fromDeg = from % 360;
      take("upwardDeg", checks[3] ?? "");
      break;
    }
    case "wind.turbulence": {
      const strength = within("Turbulence intensity", form.turbulence.intensity, 0, 10);
      checks.push(within("Mean wind at 6 m (W20)", form.turbulence.w20Mps, 0, 50), strength, within("Turbulence seed", form.turbulence.seed, 0, 0xffffffff, true));
      take("w20Mps", checks[0] ?? ""); take("seed", checks[2] ?? "");
      if (typeof strength === "number") intensity = strength;
      break;
    }
    case "atmosphere": {
      const env = LOCATION_ENVELOPE;
      const qnh = form.air.pressure === "measured" ? within("Measured QNH (hPa)", form.air.qnhHpa, env.minSeaLevelPressurePa / 100, env.maxSeaLevelPressurePa / 100) : STANDARD_SEA_LEVEL_PRESSURE_PA / 100;
      const offset = within("Temperature offset", form.air.temperatureOffsetK, -env.maxTemperatureOffsetK, env.maxTemperatureOffsetK);
      checks.push(qnh, offset);
      if (typeof qnh === "number" && typeof offset === "number") {
        // The air at the ground: the ISA of that sea-level pressure and offset at the location's elevation.
        const air = airAtOrigin(qnh * 100, offset, location.groundElevationMslM);
        parameters.temperatureK = air.temperatureK; parameters.pressurePa = air.pressurePa;
      }
      break;
    }
    default: { const never: never = effect; return problem(`Unknown weather effect ${String(never)}`); }
  }
  const first = checks.find(check => typeof check === "string");
  if (typeof first === "string") return problem(first);
  try {
    const control = parseEffectControl({ schemaVersion: 1, id, effect, enabled: true, intensity, parameters });
    // What the intensity carries past a model's range is refused here, as the session's admission would refuse it.
    effectiveControl(control, { requestId: 0, expectedEpoch: 0, atTick: { lo: 0, hi: 0 }, recovery: "hold-offset" });
    return { control, problem: null };
  } catch (cause) {
    return problem(cause instanceof Error ? cause.message : String(cause));
  }
}

const fixed = (value: EffectParameterValue | undefined, digits: number) => (typeof value === "number" ? value.toFixed(digits) : "?");
/** One line that says what a weather control does, for the schedule, the ledger and what is in effect. */
export function describeWeather(effect: WeatherEffect, parameters: EffectControl["parameters"], intensity = 1): string {
  const p = parameters, label = EFFECT_CATALOG[effect].label, scale = intensity === 1 ? "" : `, intensity ${intensity}`;
  switch (effect) {
    case "wind.mean": {
      const ned = p.windNedMps, { speedMps, fromDeg } = windOfNed(Array.isArray(ned) ? ned : []);
      return `${label}: ${(speedMps * intensity).toFixed(1)} m/s from ${fromDeg.toFixed(0)}°`;
    }
    case "wind.gust": return `${label}: ${fixed(p.rmsMps, 1)} m/s RMS, ${fixed(p.bandwidthHz, 2)} Hz, seed ${String(p.seed)}${scale}`;
    case "wind.discrete-gust": return `${label}: ${fixed(p.amplitudeMps, 1)} m/s from ${fixed(p.fromDeg, 0)}°, ${fixed(p.upwardDeg, 0)}° upward, over ${fixed(p.durationS, 1)} s${scale}`;
    case "wind.turbulence": return `${label}: W20 ${fixed(p.w20Mps, 1)} m/s, seed ${String(p.seed)}${scale}`;
    case "atmosphere": {
      const t = typeof p.temperatureK === "number" ? p.temperatureK - 273.15 : Number.NaN, pressure = typeof p.pressurePa === "number" ? p.pressurePa / 100 : Number.NaN;
      return `${label}: ${t.toFixed(1)} °C and ${pressure.toFixed(2)} hPa at the ground${scale}`;
    }
    default: { const never: never = effect; return String(never); }
  }
}
/** A fresh uint32 seed, for a new realization; the seed is stored with the control, so the run repeats it. */
export function newSeed(random: (array: Uint32Array) => Uint32Array = array => crypto.getRandomValues(array)): number {
  return random(new Uint32Array(1))[0] ?? 0;
}
