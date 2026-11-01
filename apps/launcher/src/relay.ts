import { createSocket, type Socket } from "node:dgram";
import { connect, type Socket as TcpSocket } from "node:net";

// MAVLink between native SITL and the bridge (TASK-151). SITL's
// `udpclient:` serial port sends from an ephemeral source port, and the
// bridge's MAVLink socket is connected to one fixed port, so neither can
// reach the other directly. The relay binds one loopback port for SITL and
// one for the bridge, learns SITL's source port from its first datagram, and
// forwards datagrams unchanged in both directions. Loopback senders only.
//
// A SITL the user started (TASK-155) reaches MAVLink either the same way, on a
// UDP port it sends to (`--serial0 udpclient:127.0.0.1:14550`, or MAVProxy's
// `--out`), so the relay binds that fixed port, or on ArduPilot's default
// TCP server (SERIAL0 on 5760), which MavlinkTcpRelay connects to.

/** What the launcher needs of either relay. */
export interface MavlinkLink {
  /** The port the bridge's MAVLink socket connects to. */
  readonly bridgePort: number;
  /** Datagrams dropped: foreign sender, or no peer known yet. */
  readonly dropped: number;
  /** Bytes received from SITL. */
  readonly bytesFromSitl: number;
  attachBridge(port: number): void;
  close(): void;
}

function checkPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${label}`);
}
function bindLoopback(socket: Socket, port: number): Promise<void> {
  return new Promise<void>((done, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => { socket.off("error", reject); done(); });
  });
}

export class MavlinkRelay implements MavlinkLink {
  private sitlPeer = -1;
  private bridgePeer = -1;
  /** Datagrams dropped: foreign sender, or no peer known yet. */
  dropped = 0;
  bytesFromSitl = 0;

  private readonly sitl: Socket;
  private readonly bridge: Socket;

  private constructor(sitl: Socket, bridge: Socket) {
    this.sitl = sitl;
    this.bridge = bridge;
    sitl.on("message", (bytes, remote) => {
      if (remote.address !== "127.0.0.1") { this.dropped++; return; }
      this.sitlPeer = remote.port; // a restarted SITL may use a new source port
      this.bytesFromSitl += bytes.length;
      if (this.bridgePeer < 0) { this.dropped++; return; }
      bridge.send(bytes, this.bridgePeer, "127.0.0.1");
    });
    bridge.on("message", (bytes, remote) => {
      if (remote.address !== "127.0.0.1" || remote.port !== this.bridgePeer) { this.dropped++; return; }
      if (this.sitlPeer < 0) { this.dropped++; return; }
      sitl.send(bytes, this.sitlPeer, "127.0.0.1");
    });
  }

  /** Binds the SITL side to `sitlPort` (0 picks a free port, for a SITL the launcher starts) and the bridge side to a free port. */
  static async open(sitlPort = 0): Promise<MavlinkRelay> {
    if (sitlPort !== 0) checkPort(sitlPort, "SITL MAVLink port");
    const sitl = createSocket("udp4"), bridge = createSocket("udp4");
    try {
      await bindLoopback(sitl, sitlPort);
      await bindLoopback(bridge, 0);
    } catch (error) {
      sitl.close();
      bridge.close();
      throw error;
    }
    return new MavlinkRelay(sitl, bridge);
  }

  /** The port SITL's serial0 sends to. */
  get sitlPort(): number { return this.sitl.address().port; }
  /** The port the bridge's MAVLink socket connects to. */
  get bridgePort(): number { return this.bridge.address().port; }
  /** The bridge's own MAVLink socket port, known once the bridge has started. */
  attachBridge(port: number): void {
    checkPort(port, "bridge MAVLink port");
    this.bridgePeer = port;
  }

  close(): void {
    this.sitl.close();
    this.bridge.close();
  }
}

/** Bridge datagrams stay below the bridge record payload limit (MAX_BRIDGE_PAYLOAD, 4096 bytes). */
const MAX_DATAGRAM = 2048;

/**
 * MAVLink between ArduPilot's TCP server (a SITL the user started) and the
 * bridge. TCP is a byte stream: SITL's bytes go to the bridge in datagrams of
 * at most MAX_DATAGRAM bytes, whatever the frame boundaries (the browser
 * parses a stream), and the bridge's datagrams are written to the stream in
 * order. `onClosed` reports the first end of the TCP connection, with SITL's
 * close or the socket error as the reason.
 */
export class MavlinkTcpRelay implements MavlinkLink {
  private bridgePeer = -1;
  dropped = 0;
  bytesFromSitl = 0;
  private closed = false;

  private constructor(private readonly sitl: TcpSocket, private readonly bridge: Socket, onClosed: (reason: string) => void) {
    sitl.on("data", (bytes: Buffer) => {
      this.bytesFromSitl += bytes.length;
      if (this.bridgePeer < 0) { this.dropped++; return; }
      for (let at = 0; at < bytes.length; at += MAX_DATAGRAM) bridge.send(bytes.subarray(at, at + MAX_DATAGRAM), this.bridgePeer, "127.0.0.1");
    });
    const end = (reason: string) => {
      if (this.closed) return;
      this.closed = true;
      onClosed(reason);
    };
    sitl.on("error", error => end(`the TCP connection to SITL failed: ${error.message}`));
    sitl.on("close", () => end("SITL closed its MAVLink TCP connection"));
    bridge.on("message", (bytes, remote) => {
      if (remote.address !== "127.0.0.1" || remote.port !== this.bridgePeer) { this.dropped++; return; }
      if (!this.closed) sitl.write(bytes);
    });
  }

  /** Connects to 127.0.0.1:`port`; rejects when nothing accepts the connection within 5 s. */
  static async open(port: number, onClosed: (reason: string) => void): Promise<MavlinkTcpRelay> {
    checkPort(port, "SITL MAVLink TCP port");
    const bridge = createSocket("udp4");
    await bindLoopback(bridge, 0);
    let sitl: TcpSocket;
    try {
      sitl = await new Promise<TcpSocket>((done, reject) => {
        const socket = connect({ host: "127.0.0.1", port, noDelay: true });
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("no answer within 5 s")); }, 5000);
        const fail = (error: Error) => { clearTimeout(timer); reject(error); };
        socket.once("error", fail);
        socket.once("connect", () => { clearTimeout(timer); socket.off("error", fail); done(socket); });
      });
    } catch (error) {
      bridge.close();
      throw error;
    }
    return new MavlinkTcpRelay(sitl, bridge, onClosed);
  }

  get bridgePort(): number { return this.bridge.address().port; }
  attachBridge(port: number): void {
    checkPort(port, "bridge MAVLink port");
    this.bridgePeer = port;
  }
  /** Ends the TCP connection and the bridge socket; SITL keeps running. */
  close(): void {
    this.closed = true;
    this.sitl.destroy();
    this.bridge.close();
  }
}
