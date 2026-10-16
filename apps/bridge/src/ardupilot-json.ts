// ArduPilot JSON physics channel at the bridge I/O boundary (TASK-041).
// Pinned to ArduPilot 8ab6afde107a91df1b5f60ade8f333cb8a61b190
// libraries/SITL/SIM_JSON.{h,cpp}; hashes in tests/fixtures/sitl/json-protocol.json.
//
// SIM_JSON never binds its socket: it sends servo packets from an ephemeral
// port to the physics backend (default UDP 9002) and expects replies at that
// source. JsonPhysicsEndpoint therefore binds the local port, accepts only
// loopback senders, learns the SITL peer from the first valid servo packet,
// and replies there. Datagrams and state lines are validated here so a
// malformed record never reaches either side. MAVLink is a separate channel.
import { createSocket, type Socket } from "node:dgram";
import { decodeServoPacketInto, MAX_STATE_LINE_BYTES, newServoFrame } from "@mirage/autopilot/external-sitl";

/** SIM_JSON.h keytable at the pinned commit: [section, key, required]. */
export const SIM_JSON_KEYTABLE: readonly (readonly [string, string, boolean])[] = [
  ["", "timestamp", true], ["", "latitude", false], ["", "longitude", false], ["", "altitude", false],
  ["imu", "gyro", true], ["imu", "accel_body", true], ["", "position", false], ["", "attitude", false],
  ["", "quaternion", false], ["", "velocity", true], ["", "rng_1", false], ["", "rng_2", false],
  ["", "rng_3", false], ["", "rng_4", false], ["", "rng_5", false], ["", "rng_6", false],
  ["", "velocity_wind", false], ["windvane", "direction", false], ["windvane", "speed", false],
  ["", "airspeed", false], ["", "no_time_sync", false], ["", "no_lockstep", false],
  ["rc", "rc_1", false], ["rc", "rc_2", false], ["rc", "rc_3", false], ["rc", "rc_4", false],
  ["rc", "rc_5", false], ["rc", "rc_6", false], ["rc", "rc_7", false], ["rc", "rc_8", false],
  ["rc", "rc_9", false], ["rc", "rc_10", false], ["rc", "rc_11", false], ["rc", "rc_12", false],
  ["battery", "voltage", false], ["battery", "current", false],
];

const scratchFrame = newServoFrame();
/** True for a well-formed 16- or 32-channel servo packet. */
export function isServoDatagram(bytes: Uint8Array): boolean {
  return decodeServoPacketInto(bytes, scratchFrame);
}

function finiteArray(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(v => typeof v === "number" && Number.isFinite(v));
}

/**
 * Validates one outbound state line ("\n{...}\n"): printable ASCII, a JSON
 * object with the mandatory fields and an attitude, finite numbers, and no
 * key whose text first occurs elsewhere (SIM_JSON resolves keys with strstr).
 * Returns null when valid, otherwise a reason.
 */
export function validateStateLine(bytes: Uint8Array): string | null {
  if (bytes.length < 3 || bytes.length > MAX_STATE_LINE_BYTES) return "line length";
  if (bytes[0] !== 10 || bytes[bytes.length - 1] !== 10) return "line must start and end with newline";
  for (let i = 1; i < bytes.length - 1; i++) {
    const b = bytes[i] as number; // i < length
    if (b < 32 || b > 126) return "non-printable byte";
  }
  const text = new TextDecoder().decode(bytes.subarray(1, bytes.length - 1));
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "invalid JSON"; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "not an object";
  const o = parsed as Record<string, unknown>;
  const imu = o.imu;
  if (typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp) || o.timestamp < 0) return "timestamp";
  if (typeof imu !== "object" || imu === null || !finiteArray((imu as Record<string, unknown>).gyro, 3) ||
    !finiteArray((imu as Record<string, unknown>).accel_body, 3)) return "imu";
  if (!finiteArray(o.velocity, 3)) return "velocity";
  if (o.position !== undefined && !finiteArray(o.position, 3)) return "position";
  if (!finiteArray(o.quaternion, 4) && !finiteArray(o.attitude, 3)) return "attitude or quaternion";
  if (o.velocity_wind !== undefined && !finiteArray(o.velocity_wind, 3)) return "velocity_wind";
  // strstr semantics: the first occurrence of each present key's text must be that key.
  for (const [section, key] of SIM_JSON_KEYTABLE) {
    const sectionAt = section === "" ? 0 : text.indexOf(section);
    if (section !== "" && sectionAt < 0) continue;
    const from = section === "" ? 1 : sectionAt + section.length + 1;
    const found = text.indexOf(key, from);
    if (found < 0) continue;
    const intended = text.indexOf(`"${key}":`, section === "" ? 0 : sectionAt);
    if (intended < 0 || found !== intended + 1) return `ambiguous key ${key}`;
  }
  return null;
}

export interface JsonPhysicsStats { servoAccepted: number; servoRejected: number; foreignSender: number;
  linesSent: number; linesRejected: number; noPeer: number }

/** UDP endpoint SITL sends servo packets to; replies go to the learned loopback peer. */
export class JsonPhysicsEndpoint {
  readonly stats: JsonPhysicsStats = { servoAccepted: 0, servoRejected: 0, foreignSender: 0, linesSent: 0,
    linesRejected: 0, noPeer: 0 };
  private peerPort = -1;
  private constructor(private readonly socket: Socket, readonly localPort: number) {}

  /** Binds 127.0.0.1:localPort (0 picks a free port). `onServo` receives validated datagrams. */
  static async open(localPort: number, onServo: (bytes: Uint8Array) => void, onError: () => void): Promise<JsonPhysicsEndpoint> {
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) throw new Error("Invalid JSON physics port");
    const socket = createSocket("udp4");
    await new Promise<void>((done, reject) => {
      socket.once("error", reject);
      socket.bind(localPort, "127.0.0.1", () => { socket.off("error", reject); done(); });
    });
    const endpoint = new JsonPhysicsEndpoint(socket, socket.address().port);
    socket.on("message", (bytes, remote) => {
      if (remote.address !== "127.0.0.1") { endpoint.stats.foreignSender++; return; }
      if (!isServoDatagram(bytes)) { endpoint.stats.servoRejected++; return; }
      endpoint.peerPort = remote.port; // a restarted SITL may use a new ephemeral port
      endpoint.stats.servoAccepted++;
      onServo(bytes);
    });
    socket.on("error", onError);
    return endpoint;
  }

  get peer(): number { return this.peerPort; }

  /** Sends one validated state line to the SITL peer; false if invalid or no peer is known yet. */
  send(line: Uint8Array, done: (error: Error | null) => void): boolean {
    if (validateStateLine(line) !== null) { this.stats.linesRejected++; return false; }
    if (this.peerPort < 0) { this.stats.noPeer++; return false; }
    this.stats.linesSent++;
    this.socket.send(line, this.peerPort, "127.0.0.1", error => done(error ?? null));
    return true;
  }

  queuedBytes(): number { return this.socket.getSendQueueSize(); }

  close(): void { this.socket.close(); }
}
