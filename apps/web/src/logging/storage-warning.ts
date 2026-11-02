import { megabytes } from "./size-estimate";

// Storage warnings of the Logging tab (TASK-163): the browser's quota for this
// origin against what the selected run length needs, before a run and while
// one records. A reserve the user sets stays free for the rest of the
// application. Pure functions; the tab reads the quota with
// navigator.storage.estimate().

export interface StorageState {
  readonly quotaBytes: number;
  readonly usageBytes: number;
}
export interface LiveNeed {
  /** Bytes per simulated second the recording has grown so far. */
  readonly bytesPerSimS: number;
  /** Simulated seconds left of the selected run length. */
  readonly remainingSimS: number;
}

/** The free bytes of a storage estimate, never negative. */
export function freeBytes(storage: StorageState): number {
  return Math.max(0, storage.quotaBytes - storage.usageBytes);
}

/**
 * Every warning that applies: the selected length needs more than is free beyond the reserve; the
 * free storage is already below the reserve; and, while a run records, the rest of the run at its
 * measured growth needs more than is free beyond the reserve.
 */
export function storageWarnings(storage: StorageState, plannedBytes: number, reserveBytes: number, live: LiveNeed | null): string[] {
  const free = freeBytes(storage), room = free - reserveBytes, warnings: string[] = [];
  if (free < reserveBytes) {
    warnings.push(`Only ${megabytes(free)} of storage is free, less than the ${megabytes(reserveBytes)} reserve: a recording may stop when storage runs out.`);
  } else if (!live && plannedBytes > room) {
    warnings.push(`The selected run length needs about ${megabytes(plannedBytes)}, but only ${megabytes(room)} is free beyond the ${megabytes(reserveBytes)} reserve.`);
  }
  if (live && free >= reserveBytes) {
    const need = live.bytesPerSimS * Math.max(0, live.remainingSimS);
    if (need > room) {
      warnings.push(`At its present growth the recording needs about ${megabytes(need)} more for the rest of the run, but only ${megabytes(room)} is free beyond the reserve.`);
    }
  }
  return warnings;
}
