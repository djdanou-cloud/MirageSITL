import { RecorderV2Host, type RowTime } from "@mirage/aar/recorder-v2-host";
import type { ExperimentRecording } from "@mirage/aircraft/experiment";
import type { MavFrame } from "@mirage/mavlink/codec";
import type { FlightTaskStep } from "@mirage/scenarios/flight-tasks";
import { accidentRows, type AccidentEvent } from "@mirage/physics/accident";
import { limitDroppedRow, limitEventRow, limitMonitorRow, type LimitEvent } from "@mirage/physics/limit-monitor";
import { newFlightStateV2, type FlightStateV2 } from "@mirage/protocol";
import type { RecordingPort, RecordingStart } from "../run/session-controller";
import { planOf, type LoggingSettings } from "./logging-settings";
import { recordingMonitor, type LiveRecording } from "./recording-monitor";
import { parseLimitEventsMessage } from "../run/PowerPanel";

// The Run tab's recording (TASK-163): recorder v2 (TASK-162) on a run of the
// integrated SITL session. The controller starts it once the run's experiment
// record exists and before the autopilot's first frame, with the Logging
// tab's settings: the recorder Worker opens the record, and the physics
// Worker's producer (the full-rate fan-out of TASK-162) is armed on the
// session. Main then adds the autopilot's telemetry, the parameter snapshot
// and the run's events (TASK-149 accidents, TASK-156 pauses, the requests of a
// TASK-172 flight task) at the latest physics tick, and publishes the recording's growth to the Logging tab once
// a second.

/** What the recorder needs of the page's simulation runtime. */
export interface RecorderRuntime {
  postToWorker(message: Record<string, unknown>): void;
  listen(listener: (data: unknown) => void): () => void;
  /** The latest published physics state into `out`; false when none could be read. */
  latestInto(out: FlightStateV2): boolean;
}

const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);

export class RunRecorder implements RecordingPort {
  private host: RecorderV2Host | null = null;
  /** Rows go to the host only once it records: before that its Worker refuses them (a connection's MAVLink flows earlier). */
  private recording = false;
  private stopStatus: (() => void) | null = null;
  private stopLimits: (() => void) | null = null;
  /** The monitor counts what it could not hold from its start: only what is new goes in the recording. */
  private limitsDropped = 0;
  private live: LiveRecording | null = null;
  private readonly state = newFlightStateV2();

  constructor(private readonly runtime: RecorderRuntime, private readonly settings: LoggingSettings, private readonly physicsHz: number,
    private readonly nowMs: () => number = () => performance.now()) {}

  /** The record of this run, created before `start` so the experiment record can name it with its settings. */
  prepare(identity: RecordingStart): ExperimentRecording {
    if (this.host) throw new Error("The run's recording is already prepared");
    this.host = new RecorderV2Host(planOf(this.settings, this.physicsHz), {
      experimentId: identity.experimentId, modelSha256: identity.modelSha256, firmware: identity.firmware,
    });
    const { commonHz, groups, signals, durationMin, reserveMb } = this.settings;
    return { recordId: this.host.recordId, commonHz, groups: { ...groups }, signals: { ...signals }, durationMin, reserveMb };
  }

  async start(): Promise<void> {
    const host = this.host;
    if (!host) throw new Error("The run's recording is not prepared");
    await host.started();
    await new Promise<void>((resolve, reject) => {
      const stop = this.runtime.listen(data => {
        const type = field(data, "type");
        if (type === "recording-v2.armed") { stop(); resolve(); }
        if (type === "recording-v2.reject") { stop(); reject(new Error(String(field(data, "message")))); }
      });
      this.runtime.postToWorker(host.armMessage());
    });
    this.recording = true;
    const at = this.at();
    // TASK-177: from here the recording holds the limit monitor's events, and says so even if there are none.
    host.event("limit", limitMonitorRow(), at);
    this.stopLimits = this.runtime.listen(data => {
      const limits = parseLimitEventsMessage(data);
      if (limits) this.limits(limits.events, limits.dropped);
    });
    this.live = { recordId: host.recordId, experimentId: host.header.experimentId ?? "", state: "recording", simTimeS: at.simTimeS, startSimTimeS: at.simTimeS,
      wallMs: this.nowMs(), startWallMs: this.nowMs(), bytes: 0, rows: {}, lostRows: 0, droppedChunks: 0, error: "" };
    recordingMonitor.publish(this.live);
    const timer = setInterval(() => { void this.refresh(); }, 1000);
    this.stopStatus = () => clearInterval(timer);
  }

  telemetry(frame: MavFrame): void { if (this.recording) this.host?.telemetry(frame, this.at()); }
  parameters(list: readonly { readonly name: string; readonly value: number }[]): void {
    if (this.recording) this.host?.parameterSnapshot(list, this.at());
  }
  accidents(events: readonly AccidentEvent[]): void {
    const host = this.host;
    if (!host || !this.recording) return;
    for (const event of events) {
      const at = { tick: event.tick, simTimeS: event.simTimeS, epoch: this.at().epoch };
      for (const values of accidentRows(event)) host.event("accident", values, at);
    }
  }
  /** The limit monitor's events, each at its own tick (TASK-177). */
  private limits(events: readonly LimitEvent[], dropped: number): void {
    const host = this.host;
    if (!host || !this.recording) return;
    const { epoch } = this.at();
    for (const event of events) host.event("limit", limitEventRow(event), { tick: event.tick, simTimeS: event.simTimeS, epoch });
    if (dropped > this.limitsDropped) {
      host.event("limit", limitDroppedRow(dropped - this.limitsDropped), this.at());
      this.limitsDropped = dropped;
    }
  }
  pause(paused: boolean): void { if (this.recording) this.host?.event("pause", [paused ? 1 : 0], this.at()); }
  /** What a flight task requests now (TASK-172), at the latest physics tick, beside the truth the recording keeps at those ticks. */
  flightTask(step: FlightTaskStep): void {
    if (!this.recording) return;
    const { requested: r } = step;
    const at = this.at();
    this.host?.event("flight-task", [step.stageIndex, step.measured ? 1 : 0, step.taskTimeS, r.northM, r.eastM, r.altitudeM, r.speedMps, r.headingDeg, r.verticalSpeedMps], at);
    if (r.rollDeg !== null || r.pitchDeg !== null) this.host?.event("flight-task-attitude", [r.rollDeg, r.pitchDeg], at);
  }

  /** Closes the record: the physics producer stops, the last chunk is sealed and the catalog entry closes. */
  async stop(): Promise<void> {
    const host = this.host;
    if (!host) return;
    this.host = null;
    this.recording = false;
    this.stopStatus?.();
    this.stopStatus = null;
    this.stopLimits?.();
    this.stopLimits = null;
    this.runtime.postToWorker({ type: "recording.stop" });
    try {
      const entry = await host.close();
      this.publish({ state: "closed", bytes: entry.bytes, rows: entry.rows, lostRows: entry.producerLost, droppedChunks: entry.droppedChunks });
    } catch (error) {
      this.publish({ state: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async refresh(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const entry = await host.status().catch(() => null);
    if (!entry || this.host !== host) return;
    this.publish({ bytes: entry.bytes, rows: entry.rows, lostRows: entry.producerLost, droppedChunks: entry.droppedChunks, error: host.error });
  }
  private publish(change: Partial<LiveRecording>): void {
    if (!this.live) return;
    this.live = { ...this.live, simTimeS: this.at().simTimeS, wallMs: this.nowMs(), ...change };
    recordingMonitor.publish(this.live);
  }
  private at(): RowTime {
    const s = this.state;
    this.runtime.latestInto(s);
    return { tick: s.tickId.hi * 2 ** 32 + s.tickId.lo, simTimeS: s.simTimeS, epoch: s.epoch };
  }
}
