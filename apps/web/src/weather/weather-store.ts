import { EMPTY_WEATHER_SCHEDULE, parseWeatherSchedule, type WeatherSchedule } from "@mirage/scenarios/weather-schedule";
import type { ProjectStore } from "@mirage/project/store";

// The weather schedule the next run of a project applies (TASK-167), kept in the store's local settings so it survives a reload, as
// the fault schedule is (TASK-169). A run copies it into its experiment record, and that copy is what a repeat flies. Cold path.

/** A setting key's segment starts with a letter and holds at most 32 characters; a project's UUID without its dashes has 32 hexadecimal digits. */
const settingKey = (projectId: string): string => `weather-schedule.p${projectId.replaceAll("-", "").slice(0, 31)}`;

export async function loadWeatherSchedule(store: ProjectStore, projectId: string): Promise<WeatherSchedule> {
  try {
    const stored = await store.readSetting(settingKey(projectId));
    return stored === undefined ? EMPTY_WEATHER_SCHEDULE : parseWeatherSchedule(stored);
  } catch {
    // A damaged setting costs only this draft; the next save replaces it.
    return EMPTY_WEATHER_SCHEDULE;
  }
}
export async function saveWeatherSchedule(store: ProjectStore, projectId: string, schedule: WeatherSchedule): Promise<void> {
  await store.writeSetting(settingKey(projectId), parseWeatherSchedule(schedule));
}
