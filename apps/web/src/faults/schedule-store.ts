import { EMPTY_FAULT_SCHEDULE, parseFaultSchedule, type FaultSchedule } from "@mirage/scenarios/fault-schedule";
import type { ProjectStore } from "@mirage/project/store";

// The schedule the next run of a project applies (TASK-169), kept in the store's local settings so it survives a reload, like the Logging
// tab's rates. A run copies it into its experiment record, and that copy is what a repeat flies. Cold path.

/** A setting key's segment starts with a letter and holds at most 32 characters; a project's UUID without its dashes has 32 hexadecimal digits. */
const settingKey = (projectId: string): string => `fault-schedule.p${projectId.replaceAll("-", "").slice(0, 31)}`;

export async function loadFaultSchedule(store: ProjectStore, projectId: string): Promise<FaultSchedule> {
  try {
    const stored = await store.readSetting(settingKey(projectId));
    return stored === undefined ? EMPTY_FAULT_SCHEDULE : parseFaultSchedule(stored);
  } catch {
    // A damaged setting costs only this draft; the next save replaces it.
    return EMPTY_FAULT_SCHEDULE;
  }
}
export async function saveFaultSchedule(store: ProjectStore, projectId: string, schedule: FaultSchedule): Promise<void> {
  await store.writeSetting(settingKey(projectId), parseFaultSchedule(schedule));
}
