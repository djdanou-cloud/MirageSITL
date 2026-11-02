// Integrated SITL session in the physics Worker (TASK-153): SitlJsonLink
// between the launcher's per-run bridge and the PhysicsSessionV2 in
// sitl-lockstep, and the live EKF admission (LiveEkfWarmup) of this run. The
// Worker owns the WebSocket and feeds its records to receive(); MAVLink chunks
// go to Main, which runs the ground-station functions, and Main's MAVLink
// comes back through sendMavlink(). READY is never set here from anything but
// this run's acknowledged JSON IMU samples and CRC-checked autopilot
// diagnostics, and it is re-evaluated at the status rate, so stale
// diagnostics revoke it.
//
// Per servo record the work is receive, pump, poll and send; the status,
// session events and readiness check run every `statusEverySteps` steps,
// because they create messages.
import { LiveEkfWarmup } from "@mirage/autopilot/live-warmup";
import { BRIDGE_HEADER_BYTES, SitlJsonLink, type LinkEvent, type SitlLinkOptions } from "@mirage/autopilot/sitl-link";

/** What Main sees of the integrated session, posted at the status rate and on every change of state. */
export interface SitlStatus {
  type: "sitl.status";
  state: "connecting" | "open" | "closed" | "fault";
  ready: boolean;
  reason: string;
  simTimeS: number;
  steps: number; duplicates: number; gaps: number; droppedFrames: number; held: number; restarts: number; clampedPwm: number;
  /** Simulated seconds per wall second since the socket opened. */
  speed: number;
  message: string;
}
export type SitlNotice = SitlStatus | { type: "sitl.mavlink"; bytes: Uint8Array };

export interface SitlBridgeHost {
  /** Runs due session ticks (PhysicsSessionV2.pump). */
  pump(): void;
  /** Posts session events after a batch (the Worker's flush). */
  flush(): void;
  post(message: SitlNotice): void;
  /** Sends one record on the bridge socket. */
  send(record: Uint8Array): void;
  /** Closes the bridge socket. */
  close(reason: string): void;
  nowMs(): number;
}

export interface SitlConnectOptions extends SitlLinkOptions {
  /** The session epoch whose diagnostics may admit READY. */
  readonly sessionEpoch: number;
  readonly speedup: number;
}

/** The bridge URL and WebSocket subprotocols of a run; the token travels as a subprotocol, never in the URL (TASK-040). */
export function bridgeSocketArguments(port: number, token: string): [string, string[]] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid bridge port");
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("The launcher token must be 64 lower-case hexadecimal characters");
  return [`ws://127.0.0.1:${port}/`, ["mirage-v1", `session.${token}`]];
}

export class SitlBridgeClient {
  readonly link: SitlJsonLink;
  readonly warmup: LiveEkfWarmup;
  private readonly host: SitlBridgeHost;
  private readonly statusEverySteps: number;
  private readonly mavlinkOut = new Uint8Array(BRIDGE_HEADER_BYTES + 4096);
  private stepsSinceStatus = 0;
  private state: SitlStatus["state"] = "connecting";
  private message = "";
  private openedAtMs = 0;
  private openedAtSimS = 0;
  private hasOpened = false;

  constructor(stateBuffer: SharedArrayBuffer, actuatorBuffer: SharedArrayBuffer, options: SitlConnectOptions, host: SitlBridgeHost,
    statusEverySteps = 80) {
    if (!Number.isInteger(statusEverySteps) || statusEverySteps < 1) throw new Error("Invalid status rate");
    this.link = new SitlJsonLink(stateBuffer, actuatorBuffer, options);
    this.warmup = new LiveEkfWarmup("external-sitl", options.sessionEpoch, 0, host.nowMs(), options.speedup, { imuSource: "json-lockstep" });
    this.host = host;
    this.statusEverySteps = statusEverySteps;
    this.report();
  }

  get isOpen(): boolean { return this.state === "open"; }
  get ready(): boolean { return this.state === "open" && this.warmup.warmup.ready; }

  /** The socket opened. */
  opened(): void {
    this.state = "open";
    this.hasOpened = true;
    this.openedAtMs = this.host.nowMs();
    this.openedAtSimS = Math.max(0, this.link.state.simTimeS);
    this.report();
  }

  /** The socket closed; READY ends with it. */
  closed(code: number, reason: string): void {
    if (this.state !== "fault") { this.state = "closed"; this.message = `Bridge closed (${code}${reason ? `: ${reason}` : ""})`; }
    this.warmup.dispose();
    this.report();
  }

  /** One inbound record. */
  receive(record: Uint8Array): LinkEvent {
    const link = this.link, event = link.receive(record);
    switch (event) {
      case "step": {
        // The new frame acknowledges the previous reply: its IMU sample reached SITL.
        this.warmup.acknowledgeJsonImu(link.lockstep.lastFrameCount, link.repliedFrame, link.replyTimeS);
        this.host.pump();
        const n = link.poll();
        if (n > 0) this.host.send(link.outbound.subarray(0, n));
        if (++this.stepsSinceStatus >= this.statusEverySteps) {
          this.stepsSinceStatus = 0;
          this.warmup.observe(link.state.simTimeS, this.host.nowMs());
          this.host.flush();
          this.report();
        }
        return event;
      }
      case "resend":
        this.host.send(link.outbound.subarray(0, BRIDGE_HEADER_BYTES + new DataView(link.outbound.buffer).getUint32(12, true)));
        return event;
      case "mavlink": {
        const bytes = link.inbound.slice(link.mavlinkOffset, link.mavlinkOffset + link.mavlinkLength);
        this.warmup.ingest(bytes, Math.max(0, link.state.simTimeS));
        this.host.post({ type: "sitl.mavlink", bytes });
        return event;
      }
      case "restart":
        // A restarted SITL is a new autopilot run: this session's diagnostics no longer apply.
        this.fail("SITL restarted; start a new run");
        return event;
      case "held": case "dropped":
        return event;
      default: { const never: never = event; throw new Error(`Unhandled link event ${String(never)}`); }
    }
  }

  /**
   * Sends the reply to the frame the session stepped outside a `step` event: after a pause (TASK-149,
   * TASK-156) the autopilot's frame waits, held, until a resumed pump steps it. Nothing without one.
   */
  answer(): void {
    if (this.state !== "open") return;
    const n = this.link.poll();
    if (n > 0) this.host.send(this.link.outbound.subarray(0, n));
  }

  /** Sends one MAVLink chunk from Main's ground station; false while the socket is not open. */
  sendMavlink(bytes: Uint8Array): boolean {
    if (this.state !== "open") return false;
    const n = this.link.mavlinkRecordInto(bytes, this.mavlinkOut);
    if (n === 0) return false;
    this.host.send(this.mavlinkOut.subarray(0, n));
    return true;
  }

  /** Ends the session from this side. */
  close(): void {
    if (this.state === "connecting" || this.state === "open") this.host.close("Session ended");
    this.warmup.dispose();
  }

  private fail(message: string): void {
    this.state = "fault";
    this.message = message;
    this.warmup.dispose();
    this.host.close(message);
    this.report();
  }

  private report(): void {
    const s = this.link.lockstep.stats, simTimeS = this.link.state.simTimeS;
    const wallS = (this.host.nowMs() - this.openedAtMs) / 1000;
    this.host.post({
      type: "sitl.status", state: this.state, ready: this.ready, reason: this.warmup.warmup.reason,
      simTimeS, steps: s.steps, duplicates: s.duplicates, gaps: s.gaps, droppedFrames: s.droppedFrames, held: this.link.stats.held,
      restarts: s.restarts, clampedPwm: s.clampedPwm, speed: this.hasOpened && wallS > 0 ? (simTimeS - this.openedAtSimS) / wallS : 0,
      message: this.message,
    });
  }
}
