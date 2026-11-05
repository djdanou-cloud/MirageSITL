import { EFFECT_RANDOM_STREAMS } from "@mirage/protocol";
import { scheduledEntries, type ScheduledEffect } from "./fault-schedule.ts";

// The weather schedule of the Weather and location tab (TASK-167, S07): which weather a run applies by itself, when and for how long.
// Its entries are TASK-166 environment controls in the form of the fault schedule (TASK-169), counted in simulated seconds from the
// first arming, so a repeat meets its weather at the same point of the flight. It records the random streams its seeded effects draw
// from: a seed repeats its gust and turbulence only with them, so a schedule with other streams is refused. Cold path.

export const WEATHER_SCHEDULE_SCHEMA_VERSION = 1;
/** The streams a schedule of this build records (EFFECT_RANDOM_STREAMS). */
export interface WeatherStreams {
  readonly gust: readonly number[];
  readonly turbulence: readonly number[];
}
export interface WeatherSchedule {
  readonly schemaVersion: typeof WEATHER_SCHEDULE_SCHEMA_VERSION;
  readonly entries: readonly ScheduledEffect[];
  readonly streams: WeatherStreams;
}
export const WEATHER_STREAMS: WeatherStreams = Object.freeze({ gust: EFFECT_RANDOM_STREAMS["wind.gust"], turbulence: EFFECT_RANDOM_STREAMS["wind.turbulence"] });
export const EMPTY_WEATHER_SCHEDULE: WeatherSchedule = Object.freeze({ schemaVersion: WEATHER_SCHEDULE_SCHEMA_VERSION, entries: Object.freeze([]), streams: WEATHER_STREAMS });

const fail = (message: string): never => { throw new Error(`Invalid weather schedule: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sameStreams = (value: unknown, expected: readonly number[]): boolean =>
  Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);

/** A schedule from unknown (a stored value, or a form): environment controls only, no overlap, and this build's random streams. */
export function parseWeatherSchedule(input: unknown): WeatherSchedule {
  if (!isRecord(input) || input.schemaVersion !== WEATHER_SCHEDULE_SCHEMA_VERSION) return fail(`schemaVersion must be ${WEATHER_SCHEDULE_SCHEMA_VERSION}`);
  for (const key of Object.keys(input)) if (!["schemaVersion", "entries", "streams"].includes(key)) fail(`it has an unexpected field ${key}`);
  const streams = input.streams;
  if (!isRecord(streams) || Object.keys(streams).length !== 2 || !sameStreams(streams.gust, WEATHER_STREAMS.gust) || !sameStreams(streams.turbulence, WEATHER_STREAMS.turbulence)) {
    fail("its random streams are not this build's, so its seeds would not repeat the same gusts and turbulence");
  }
  const entries = scheduledEntries(input.entries, ["environment"], "weather schedule");
  return { schemaVersion: WEATHER_SCHEDULE_SCHEMA_VERSION, entries, streams: WEATHER_STREAMS };
}
/** The schedule of these entries with this build's streams, as the tab saves it. */
export function weatherSchedule(entries: readonly ScheduledEffect[]): WeatherSchedule {
  return parseWeatherSchedule({ schemaVersion: WEATHER_SCHEDULE_SCHEMA_VERSION, entries, streams: WEATHER_STREAMS });
}
