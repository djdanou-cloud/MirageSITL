import { createSocket, type Socket } from "node:dgram";

// MAVLink between native SITL and the bridge (TASK-151). SITL's
// `udpclient:` serial port sends from an ephemeral source port, and the
// bridge's MAVLink socket is connected to one fixed port, so neither can
// reach the other directly. The relay binds one loopback port for SITL and
// one for the bridge, learns SITL's source port from its first datagram, and
// forwards datagrams unchanged in both directions. Loopback senders only.

export class MavlinkRelay {
  private sitlPeer = -1;
  private bridgePeer = -1;
  /** Datagrams dropped: foreign sender, or no peer known yet. */
  dropped = 0;

  private readonly sitl: Socket;
  private readonly bridge: Socket;

  private constructor(sitl: Socket, bridge: Socket) {
    this.sitl = sitl;
    this.bridge = bridge;
    sitl.on("message", (bytes, remote) => {
      if (remote.address !== "127.0.0.1") { this.dropped++; return; }
      this.sitlPeer = remote.port; // a restarted SITL may use a new source port
      if (this.bridgePeer < 0) { this.dropped++; return; }
      bridge.send(bytes, this.bridgePeer, "127.0.0.1");
    });
    bridge.on("message", (bytes, remote) => {
      if (remote.address !== "127.0.0.1" || remote.port !== this.bridgePeer) { this.dropped++; return; }
      if (this.sitlPeer < 0) { this.dropped++; return; }
      sitl.send(bytes, this.sitlPeer, "127.0.0.1");
    });
  }

  static async open(): Promise<MavlinkRelay> {
    const bind = (socket: Socket) => new Promise<void>((done, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => { socket.off("error", reject); done(); });
    });
    const sitl = createSocket("udp4"), bridge = createSocket("udp4");
    await bind(sitl);
    await bind(bridge);
    return new MavlinkRelay(sitl, bridge);
  }

  /** The port SITL's serial0 sends to. */
  get sitlPort(): number { return this.sitl.address().port; }
  /** The port the bridge's MAVLink socket connects to. */
  get bridgePort(): number { return this.bridge.address().port; }
  /** The bridge's own MAVLink socket port, known once the bridge has started. */
  attachBridge(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid bridge MAVLink port");
    this.bridgePeer = port;
  }

  close(): void {
    this.sitl.close();
    this.bridge.close();
  }
}
