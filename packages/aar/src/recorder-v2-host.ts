// Main-side host of recorder v2 (TASK-162). It owns the producer queue and the
// recorder Worker, hands the physics Worker its part of the plan
// (`armMessage`), and turns what Main sees into rows: autopilot telemetry
// (decimated per signal by simulated time), the parameter snapshot and
// changes, and weather, fault, pause and accident events. Rows are batched
// and posted to the recorder Worker; nothing here runs in the physics loop.
import type { MavFrame } from "@mirage/mavlink/codec";
import { attitudeInto, fieldOf, globalPositionIntInto, localPositionNedInto, newAttitude, newGlobalPositionInt, newLocalPositionNed, readNumber } from "@mirage/mavlink/messages";
import { headerFromPlan, type RecordHeaderV2 } from "./format-v2.ts";
import { createRecordingQueueV2, parameterRow, producerPlan, TelemetryDecimator, valueRow, type ProducerPlan } from "./recorder-v2.ts";
import { SignalId, type RatePlan } from "./signal-catalog.ts";
import { IndexedDbRecordingBackend, openRecording, parseCatalogEntry, recordingLockName, recoverInterrupted, type CatalogEntry, type OpenedRecording } from "./stream-storage.ts";

/** Where a row sits in simulated time: the physics tick, its time and the session epoch. */
export interface RowTime { readonly tick: number; readonly simTimeS: number; readonly epoch: number }

function field(id: number, name: string) {
  const layout = fieldOf(id, name);
  if (!layout) throw new Error(`MAVLink table lacks ${id}.${name}`);
  return layout;
}
const GPS = { lat: field(24, "lat"), lon: field(24, "lon"), alt: field(24, "alt"), fix: field(24, "fix_type"), sats: field(24, "satellites_visible"),
  eph: field(24, "eph"), epv: field(24, "epv") };
const EKF = { flags: field(193, "flags"), vel: field(193, "velocity_variance"), horiz: field(193, "pos_horiz_variance"), vert: field(193, "pos_vert_variance"),
  compass: field(193, "compass_variance"), terrain: field(193, "terrain_alt_variance") };

/** Telemetry signal values of one MAVLink frame, or null for a message the catalog does not record. Cold. */
export function telemetryValues(frame: MavFrame): { readonly id: number; readonly values: readonly number[] } | null {
  switch (frame.id) {
    case 30: {
      const a = newAttitude();
      attitudeInto(frame, a);
      return { id: SignalId.AutopilotAttitude, values: [a.rollRad, a.pitchRad, a.yawRad, a.rollRateRadS, a.pitchRateRadS, a.yawRateRadS] };
    }
    case 32: {
      const p = newLocalPositionNed();
      localPositionNedInto(frame, p);
      return { id: SignalId.AutopilotLocalPosition, values: [p.northM, p.eastM, p.downM, p.vnMps, p.veMps, p.vdMps] };
    }
    case 33: {
      const g = newGlobalPositionInt();
      globalPositionIntInto(frame, g);
      return { id: SignalId.AutopilotGlobalPosition, values: [g.latitudeE7 / 1e7, g.longitudeE7 / 1e7, g.altitudeMslMm / 1000, g.relativeAltitudeMm / 1000,
        g.vnCmps / 100, g.veCmps / 100, g.vdCmps / 100, g.headingCdeg / 100] };
    }
    case 24: {
      const v = frame.view;
      return { id: SignalId.AutopilotGps, values: [readNumber(v, GPS.lat) / 1e7, readNumber(v, GPS.lon) / 1e7, readNumber(v, GPS.alt) / 1000,
        readNumber(v, GPS.fix), readNumber(v, GPS.sats), readNumber(v, GPS.eph), readNumber(v, GPS.epv)] };
    }
    case 193: {
      const v = frame.view;
      return { id: SignalId.AutopilotEkf, values: [readNumber(v, EKF.flags), readNumber(v, EKF.vel), readNumber(v, EKF.horiz), readNumber(v, EKF.vert),
        readNumber(v, EKF.compass), readNumber(v, EKF.terrain)] };
    }
    default: return null;
  }
}

export type EventKind = "weather" | "fault" | "pause" | "accident" | "flight-task" | "flight-task-attitude" | "limit";
const EVENT_SIGNAL: Readonly<Record<EventKind, number>> = { weather: SignalId.Weather, fault: SignalId.Fault, pause: SignalId.Pause, accident: SignalId.Accident, "flight-task": SignalId.FlightTaskRequest,
  "flight-task-attitude": SignalId.FlightTaskAttitudeRequest, limit: SignalId.LimitEvent };

function randomRecordId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface RecorderIdentity {
  readonly experimentId: string | null;
  readonly modelSha256: string | null;
  readonly firmware: RecordHeaderV2["firmware"];
}

export class RecorderV2Host {
  readonly header: RecordHeaderV2;
  readonly queue = createRecordingQueueV2();
  readonly producer: ProducerPlan;
  private readonly worker: Worker;
  private readonly decimator: TelemetryDecimator;
  private batch: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ready: Promise<void>;
  private closing: Promise<CatalogEntry> | null = null;
  rejectedRows = 0;
  error = "";

  constructor(plan: RatePlan, identity: RecorderIdentity) {
    this.header = headerFromPlan(plan, { recordId: randomRecordId(), startedAt: new Date().toISOString(), ...identity });
    this.producer = producerPlan(plan);
    this.decimator = new TelemetryDecimator(plan);
    this.worker = new Worker(new URL("./recorder-v2.worker.ts", import.meta.url), { type: "module", name: "mirage-recorder-v2" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (typeof data !== "object" || data === null || !("type" in data)) return;
        if (data.type === "ready") resolve();
        else if (data.type === "row-rejected") this.rejectedRows++;
        else if (data.type === "error") {
          this.error = "message" in data && typeof data.message === "string" ? data.message : "Recording failed";
          reject(new Error(this.error));
        }
      };
      this.worker.onerror = event => { this.error = event.message; reject(new Error(event.message)); };
    });
    this.worker.postMessage({ type: "init", queue: this.queue, header: this.header });
  }
  get recordId(): string { return this.header.recordId; }
  /** Resolves when the record exists in storage and the Worker drains the queue. */
  started(): Promise<void> { return this.ready; }
  /** The message that arms the producer in the physics Worker. */
  armMessage(): { type: "recording-v2.arm"; queue: SharedArrayBuffer; plan: ProducerPlan } {
    return { type: "recording-v2.arm", queue: this.queue, plan: this.producer };
  }

  /** Records a telemetry frame if the catalog has it and its decimation keeps it; returns whether it was kept. */
  telemetry(frame: MavFrame, at: RowTime): boolean {
    const decoded = telemetryValues(frame);
    if (!decoded || !this.decimator.keep(decoded.id, at.simTimeS)) return false;
    this.add(valueRow(decoded.id, decoded.values, at.tick, at.simTimeS, at.epoch));
    return true;
  }
  /** The parameter snapshot at the start of the recording. */
  parameterSnapshot(parameters: readonly { readonly name: string; readonly value: number }[], at: RowTime): void {
    for (const parameter of parameters) this.add(parameterRow(parameter.name, parameter.value, true, at.tick, at.simTimeS, at.epoch));
  }
  parameterChange(name: string, value: number, at: RowTime): void {
    this.add(parameterRow(name, value, false, at.tick, at.simTimeS, at.epoch));
  }
  /** An event's numbers, in its catalog channels (pause: [1] paused, [0] resumed; weather, fault and accident a registry code and arguments). */
  event(kind: EventKind, values: readonly (number | null)[], at: RowTime): void {
    this.add(valueRow(EVENT_SIGNAL[kind], values, at.tick, at.simTimeS, at.epoch));
  }

  private add(row: Uint8Array): void {
    this.batch.push(row);
    this.flushTimer ??= setTimeout(() => this.flushRows(), 20);
  }
  private flushRows(): void {
    this.flushTimer = null;
    if (this.batch.length === 0) return;
    const rows = this.batch;
    this.batch = [];
    this.worker.postMessage({ type: "rows", rows });
  }

  /** The record's catalog entry so far (TASK-163: the Logging tab's growth and gaps). */
  status(timeoutMs = 5000): Promise<CatalogEntry> {
    return this.ready.then(() => new Promise<CatalogEntry>((resolve, reject) => {
      const timer = setTimeout(() => { this.worker.removeEventListener("message", listener); reject(new Error("The recorder did not answer in time")); }, timeoutMs);
      const listener = ({ data }: MessageEvent<unknown>): void => {
        if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "status" || !("entry" in data)) return;
        clearTimeout(timer);
        this.worker.removeEventListener("message", listener);
        try { resolve(parseCatalogEntry(data.entry)); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      };
      this.worker.addEventListener("message", listener);
      this.worker.postMessage({ type: "status" });
    }));
  }

  /** Seals the last chunk, marks the record closed and ends the Worker; resolves with the catalog entry. */
  close(timeoutMs = 10000): Promise<CatalogEntry> {
    this.closing ??= this.ready.then(() => new Promise<CatalogEntry>((resolve, reject) => {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushRows();
      const timer = setTimeout(() => { this.worker.terminate(); reject(new Error("The recorder did not close in time")); }, timeoutMs);
      this.worker.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (typeof data !== "object" || data === null || !("type" in data)) return;
        if (data.type === "closed" && "entry" in data) {
          clearTimeout(timer);
          resolve(parseCatalogEntry(data.entry));
        } else if (data.type === "error") {
          clearTimeout(timer);
          reject(new Error("message" in data && typeof data.message === "string" ? data.message : "Recording failed"));
        }
      };
      this.worker.postMessage({ type: "close" });
    }));
    return this.closing;
  }
}

/** The names of the Web Locks recorders hold now. */
async function heldRecordingLocks(): Promise<Set<string>> {
  const snapshot = await navigator.locks.query();
  return new Set((snapshot.held ?? []).map(lock => lock.name ?? ""));
}
/** Every stored record after marking the ones a restart cut off as `interrupted`. */
export async function listRecordings(): Promise<CatalogEntry[]> {
  const backend = await IndexedDbRecordingBackend.open();
  try {
    const held = await heldRecordingLocks();
    await recoverInterrupted(backend, id => held.has(recordingLockName(id)));
    return await backend.listEntries();
  } finally {
    backend.close();
  }
}
export async function reopenRecording(recordId: string): Promise<OpenedRecording> {
  const backend = await IndexedDbRecordingBackend.open();
  try {
    return await openRecording(backend, recordId);
  } finally {
    backend.close();
  }
}
