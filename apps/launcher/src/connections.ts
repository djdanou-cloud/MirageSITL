import { startBridge } from "../../bridge/src/server.ts";
import { MavlinkRelay, MavlinkTcpRelay, type MavlinkLink } from "./relay.ts";

// Manual connection to a SITL the user started (TASK-155, S02). The launcher
// owns only the bridge and the MAVLink relay of a connection, never the SITL
// process: its ownership is "external", and disconnecting closes the bridge
// and the relay and nothing else. A JSON SITL (`--model JSON`) sends its
// servo packets to the physics port (SITL's `--sim-port-out`, 9002 by
// default), which the bridge binds; MAVLink comes from SITL's TCP server
// (SERIAL0, 5760 by default) or to a UDP port SITL sends to. Before the
// browser attaches, the view already reports the servo packets the bridge
// received and their rate and channel count, so the browser can configure
// physics at SITL's rate. Compatibility (version, frame, home) is judged in
// the browser, which has the MAVLink codec and the profile.

/** Every connection's bridge uses this record epoch. */
export const CONNECTION_BRIDGE_EPOCH = 1;

export interface ConnectionSpec {
  /** The UDP port SITL sends JSON servo packets to. */
  readonly jsonPhysicsPort: number;
  readonly mavlink: { readonly transport: "tcp" | "udp"; readonly port: number };
}
/** open: bridge and relay up; sitl-closed: SITL ended the TCP connection; disconnected: released by the user. */
export type ConnectionState = "open" | "sitl-closed" | "disconnected";

/** The JSON servo packets the bridge received: counts, and the latest packet's rate and channel count (null before the first). */
export interface PhysicsView {
  readonly servoPackets: number; readonly rejected: number; readonly foreignSenders: number;
  readonly rateHz: number | null; readonly channels: number | null;
}
export interface MavlinkView { readonly bytesFromSitl: number; readonly dropped: number }

/** Why a connection could not open, worded for the user; nothing stays open after one. */
export class ConnectionRefused extends Error {}

function code(error: unknown): string {
  const value: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof value === "string" ? value : "";
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExternalConnection {
  state: ConnectionState = "open";
  closedReason: string | null = null;
  private bridge: Awaited<ReturnType<typeof startBridge>> | null;
  private relay: MavlinkLink | null;
  private readonly bridgePortValue: number;

  private constructor(readonly id: string, readonly spec: ConnectionSpec, bridge: Awaited<ReturnType<typeof startBridge>>, relay: MavlinkLink) {
    this.bridge = bridge;
    this.relay = relay;
    this.bridgePortValue = bridge.port;
  }

  /** Opens the relay and the bridge; throws ConnectionRefused with the reason when a port cannot be used. */
  static async open(id: string, spec: ConnectionSpec, auth: { readonly origin: string; readonly token: string }): Promise<ExternalConnection> {
    const holder: { connection: ExternalConnection | null; early: string | null } = { connection: null, early: null };
    const { transport, port } = spec.mavlink;
    let relay: MavlinkLink;
    try {
      relay = transport === "udp" ? await MavlinkRelay.open(port)
        : await MavlinkTcpRelay.open(port, reason => {
          if (holder.connection) void holder.connection.sitlClosed(reason);
          else holder.early = reason;
        });
    } catch (error) {
      if (transport === "udp") {
        throw new ConnectionRefused(code(error) === "EADDRINUSE"
          ? `UDP port ${port} is already in use, for example by a ground station; give SITL another MAVLink output port`
          : `UDP port ${port} cannot receive MAVLink: ${messageOf(error)}`);
      }
      throw new ConnectionRefused(code(error) === "ECONNREFUSED"
        ? `Nothing accepts MAVLink TCP connections on 127.0.0.1:${port}; start SITL first, or give the TCP port of a free SITL serial port`
        : `MAVLink TCP port ${port} did not accept the connection: ${messageOf(error)}`);
    }
    let bridge: Awaited<ReturnType<typeof startBridge>>;
    try {
      // physicsPort is unused in ArduPilot JSON mode; the bridge only requires it to differ from the MAVLink port.
      bridge = await startBridge({ port: 0, origin: auth.origin, token: auth.token, epoch: CONNECTION_BRIDGE_EPOCH,
        udp: { mavlinkPort: relay.bridgePort, physicsPort: spec.jsonPhysicsPort }, ardupilotJson: { localPort: spec.jsonPhysicsPort } });
    } catch (error) {
      relay.close();
      throw new ConnectionRefused(code(error) === "EADDRINUSE"
        ? `UDP port ${spec.jsonPhysicsPort} is already in use: another physics program receives this SITL's JSON physics; stop it, or start SITL with another --sim-port-out`
        : `The bridge did not start: ${messageOf(error)}`);
    }
    // The bridge's MAVLink socket is its only UDP socket in JSON mode.
    relay.attachBridge(bridge.udpLocalPorts[0]!);
    const connection = new ExternalConnection(id, spec, bridge, relay);
    holder.connection = connection;
    if (holder.early !== null) await connection.sitlClosed(holder.early);
    return connection;
  }

  /** The user released the connection: the bridge and the relay close; SITL keeps running. */
  async disconnect(): Promise<void> {
    if (this.state === "open") this.state = "disconnected";
    await this.release();
  }
  /** SITL ended the TCP connection. */
  private async sitlClosed(reason: string): Promise<void> {
    if (this.state !== "open") return;
    this.state = "sitl-closed";
    this.closedReason = reason;
    await this.release();
  }
  private async release(): Promise<void> {
    const bridge = this.bridge, relay = this.relay;
    // The counters stay readable after release, as the diagnostics of a failed connection.
    this.final = { physics: this.physicsView(), mavlink: this.mavlinkView() };
    this.bridge = null;
    this.relay = null;
    relay?.close();
    await bridge?.close();
  }

  private final: { readonly physics: PhysicsView; readonly mavlink: MavlinkView } | null = null;
  private physicsView(): PhysicsView {
    const json = this.bridge?.jsonPhysics;
    if (!json) return this.final?.physics ?? { servoPackets: 0, rejected: 0, foreignSenders: 0, rateHz: null, channels: null };
    const seen = json.stats.servoAccepted > 0;
    return { servoPackets: json.stats.servoAccepted, rejected: json.stats.servoRejected, foreignSenders: json.stats.foreignSender,
      rateHz: seen ? json.servoRateHz : null, channels: seen ? json.servoChannels : null };
  }
  private mavlinkView(): MavlinkView {
    const relay = this.relay;
    return relay ? { bytesFromSitl: relay.bytesFromSitl, dropped: relay.dropped } : this.final?.mavlink ?? { bytesFromSitl: 0, dropped: 0 };
  }

  view() {
    return {
      id: this.id, ownership: "external" as const, state: this.state, closedReason: this.closedReason, endpoints: this.spec,
      ports: this.bridge ? { bridge: this.bridgePortValue, epoch: CONNECTION_BRIDGE_EPOCH } : null,
      physics: this.physicsView(), mavlink: this.mavlinkView(),
    };
  }
}
