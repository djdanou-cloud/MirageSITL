import { CHUNK_BYTES, CHUNK_HEADER_BYTES, paddedRowBytes } from "@mirage/aar/format-v2";
import { payloadBytes, type PlannedSignal, type RatePlan } from "@mirage/aar/signal-catalog";

// Recording size estimate (TASK-163, S13): what a rate plan of recorder v2
// (TASK-162) writes per second of simulated time, from the signal catalog
// and the format's sizes. Every row has a fixed width: a 40-byte header and
// all of its signal's channels, padded to 8 bytes. A physics signal keeps
// exactly its effective rate of samples per simulated second; an aperiodic
// one at most its effective rate, which the estimate takes as reached, so for
// those it is an upper bound. Rows fill 64 KiB chunks behind a 48-byte header.
// Events (parameters, weather, faults, pauses, accidents) are not estimated:
// they come when they come. Cold path.

/** Which sources of a run produce samples; a source that produces none writes no rows (its samples are counted absent). */
export interface ProducedSources {
  /** Per-motor and battery telemetry: a dynamics with an electrical drive (every profile flight). */
  readonly power: boolean;
  /** Actuator frames every tick: an autopilot in lockstep. */
  readonly actuators: boolean;
  /** MirageSITL sensor frames; an external SITL computes its own sensors from the physics state, so a Run-tab run has none. */
  readonly sensors: boolean;
  /** Autopilot telemetry over MAVLink. */
  readonly telemetry: boolean;
}
/** A Run-tab run: a profile flight with ArduPilot SITL in lockstep. */
export const RUN_TAB_SOURCES: ProducedSources = Object.freeze({ power: true, actuators: true, sensors: false, telemetry: true });

export interface SignalEstimate {
  readonly name: string;
  readonly rowsPerSimS: number;
  readonly rowBytes: number;
  readonly bytesPerSimS: number;
  /** False for a signal whose source produces nothing in such a run. */
  readonly produced: boolean;
  /** True when the rate is an upper bound: an aperiodic source may deliver fewer samples. */
  readonly upperBound: boolean;
}
export interface SizeEstimate {
  readonly signals: readonly SignalEstimate[];
  /** Row bytes per simulated second, chunk headers excluded. */
  readonly rowBytesPerSimS: number;
  /** Bytes per simulated second with the chunk headers. */
  readonly bytesPerSimS: number;
  readonly bytesPerSimHour: number;
  /** True when part of the total is an upper bound. */
  readonly upperBound: boolean;
}

function produced(signal: PlannedSignal, sources: ProducedSources): boolean {
  switch (signal.group) {
    case "motors": case "battery": return sources.power;
    case "actuators": return sources.actuators;
    case "sensors": return sources.sensors;
    case "autopilot": return sources.telemetry;
    case "truth": case "pilot": return true;
    case "events": return false;
    default: { const never: never = signal.group; return never; }
  }
}

/** Chunk bytes that `rowBytes` of rows fill: whole 64 KiB chunks, each with its header. */
export function chunkedBytes(rowBytes: number): number {
  if (rowBytes <= 0) return 0;
  return rowBytes + Math.ceil(rowBytes / (CHUNK_BYTES - CHUNK_HEADER_BYTES)) * CHUNK_HEADER_BYTES;
}

export function estimateRecording(plan: RatePlan, sources: ProducedSources): SizeEstimate {
  const signals = plan.signals.filter(signal => signal.source !== "event").map((signal): SignalEstimate => {
    const isProduced = produced(signal, sources), rowsPerSimS = isProduced ? signal.effectiveHz ?? 0 : 0;
    const rowBytes = paddedRowBytes(payloadBytes(signal));
    return { name: signal.name, rowsPerSimS, rowBytes, bytesPerSimS: rowsPerSimS * rowBytes, produced: isProduced, upperBound: signal.aperiodic && rowsPerSimS > 0 };
  });
  const rowBytesPerSimS = signals.reduce((sum, signal) => sum + signal.bytesPerSimS, 0);
  const bytesPerSimS = rowBytesPerSimS * (1 + CHUNK_HEADER_BYTES / (CHUNK_BYTES - CHUNK_HEADER_BYTES));
  return { signals, rowBytesPerSimS, bytesPerSimS, bytesPerSimHour: chunkedBytes(rowBytesPerSimS * 3600), upperBound: signals.some(signal => signal.upperBound) };
}

/** Bytes of a recording of `simulatedS` seconds, chunk headers included. */
export function estimatedBytes(estimate: SizeEstimate, simulatedS: number): number {
  return chunkedBytes(estimate.rowBytesPerSimS * Math.max(0, simulatedS));
}

/** Megabytes (10⁶ bytes), as the tab shows them. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 2 : 1)} MB`;
}
