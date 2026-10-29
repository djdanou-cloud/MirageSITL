import { createServer } from "node:http";
import { createSocket, type Socket as DatagramSocket } from "node:dgram";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  decodeRecord,
  encodeRecord,
  MAX_BRIDGE_PAYLOAD,
  type BridgeChannel,
} from "./framing.ts";
import { BridgeSession } from "./session.ts";
import { JsonPhysicsEndpoint } from "./ardupilot-json.ts";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export interface BridgeOptions {
  port?: number;
  origin: string;
  token: string;
  epoch: number;
  udp?: { mavlinkPort: number; physicsPort: number };
  /**
   * ArduPilot JSON physics (TASK-041): bind this local UDP port (SITL default
   * 9002; 0 picks one) and reply to the learned loopback SITL peer instead of
   * connecting physicsPort. Servo datagrams and state lines are validated.
   */
  ardupilotJson?: { localPort: number };
  maxBufferedBytes?: number;
}
/** Local explicit token handoff; never accept a token in URLs, logs or persisted browser state. */
export async function startBridge(options: BridgeOptions) {
  const allowed = new URL(options.origin);
  if (
    !["http:", "https:"].includes(allowed.protocol) ||
    allowed.origin !== options.origin ||
    !["localhost", "127.0.0.1", "[::1]"].includes(allowed.hostname) ||
    !/^[a-f0-9]{64}$/.test(options.token) ||
    options.epoch >>> 0 !== options.epoch
  )
    throw new Error("Invalid bridge origin/session configuration");
  const maxBuffered = options.maxBufferedBytes ?? 65536;
  if (
    !Number.isInteger(maxBuffered) ||
    maxBuffered < 1 ||
    maxBuffered > 1048576
  )
    throw new Error("Invalid bridge buffer budget");
  if (
    options.udp &&
    (!Number.isInteger(options.udp.mavlinkPort) ||
      options.udp.mavlinkPort < 1 ||
      options.udp.mavlinkPort > 65535 ||
      !Number.isInteger(options.udp.physicsPort) ||
      options.udp.physicsPort < 1 ||
      options.udp.physicsPort > 65535 ||
      options.udp.physicsPort === options.udp.mavlinkPort)
  )
    throw new Error("Invalid UDP channels");
  const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    }),
    wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BRIDGE_PAYLOAD + 16,
      perMessageDeflate: false,
      handleProtocols: () => "mirage-v1",
    });
  let client: WebSocket | null = null;
  const sockets: DatagramSocket[] = [];
  let jsonPhysics: JsonPhysicsEndpoint | null = null;
  const outboundSequence = new Uint32Array(3);
  function forward(channel: BridgeChannel, bytes: Uint8Array) {
    if (
      !client ||
      client.readyState !== WebSocket.OPEN ||
      bytes.length > MAX_BRIDGE_PAYLOAD
    )
      return;
    if (client.bufferedAmount + bytes.length + 16 > maxBuffered) {
      client.close(1013, "Bridge backpressure");
      return;
    }
    client.send(
      encodeRecord({
        channel,
        epoch: options.epoch,
        sequence: outboundSequence[channel - 1]!,
        payload: bytes,
      }),
    );
    outboundSequence[channel - 1] = (outboundSequence[channel - 1]! + 1) >>> 0;
  }
  if (options.udp) {
    try {
      for (const [channel, port] of options.ardupilotJson
        ? ([[1, options.udp.mavlinkPort]] as const)
        : ([
            [1, options.udp.mavlinkPort],
            [3, options.udp.physicsPort],
          ] as const)) {
        const socket = createSocket("udp4");
        sockets.push(socket);
        await new Promise<void>((done, reject) => {
          socket.once("error", reject);
          socket.connect(port, "127.0.0.1", () => {
            socket.off("error", reject);
            done();
          });
        });
        socket.on("message", (bytes) => forward(channel, bytes));
        socket.on("error", () => {
          client?.close(1011, "UDP link failed");
        });
      }
      if (options.ardupilotJson)
        jsonPhysics = await JsonPhysicsEndpoint.open(
          options.ardupilotJson.localPort,
          (bytes) => forward(3, bytes),
          () => client?.close(1011, "UDP link failed"),
        );
    } catch (error) {
      for (const socket of sockets) socket.close();
      throw error;
    }
  }
  server.on("upgrade", (request, socket, head) => {
    const raw = request.headers["sec-websocket-protocol"];
    const protocols =
      typeof raw === "string" ? raw.split(",").map((x) => x.trim()) : [];
    const supplied =
      protocols.find((x) => x.startsWith("session."))?.slice(8) ?? "";
    const valid =
      /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(options.token));
    const address = server.address();
    const actualPort =
      address && typeof address === "object" ? address.port : -1;
    if (
      request.url !== "/" ||
      request.headers.origin !== options.origin ||
      (request.headers.host !== `127.0.0.1:${actualPort}` &&
        request.headers.host !== `localhost:${actualPort}`) ||
      !protocols.includes("mirage-v1") ||
      !valid ||
      client
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("error", () => {
        ws.close(1011, "WebSocket transport failed");
      });
      client = ws;
      outboundSequence.fill(0);
      const session = new BridgeSession(options.epoch);
      // Physics payload silence is expected during a lockstep pause.
      // WebSocket pong proves transport liveness independently of simulated time.
      let lastPongTime = performance.now();
      ws.on("pong", () => { lastPongTime = performance.now(); });
      ws.on("message", (data, isBinary) => {
        if (!isBinary || !Buffer.isBuffer(data)) {
          ws.close(1003, "Binary record required");
          return;
        }
        const record = decodeRecord(data);
        if (!record || !session.accept(record, performance.now())) {
          ws.close(1008, "Invalid, stale or flooded record");
          return;
        }
        if (ws.bufferedAmount > maxBuffered) {
          ws.close(1013, "Bridge backpressure");
          return;
        }
        if (!options.udp) {
          ws.close(1011, "UDP endpoints not configured");
          return;
        }
        if (record.channel === 3) {
          ws.close(1008, "Servo channel is receive-only");
          return;
        }
        if (record.channel === 2 && jsonPhysics) {
          if (jsonPhysics.queuedBytes() + record.payload.length > maxBuffered) {
            ws.close(1013, "UDP backpressure");
            return;
          }
          // A malformed state line closes the session; before SITL's first servo packet there is no peer yet.
          const sent = jsonPhysics.send(record.payload, (error) => {
            if (error) ws.close(1011, "UDP send failed");
          });
          if (!sent && jsonPhysics.peer >= 0)
            ws.close(1008, "Invalid ArduPilot JSON state line");
          return;
        }
        const endpoint = sockets[record.channel === 1 ? 0 : 1]!;
        if (endpoint.getSendQueueSize() + record.payload.length > maxBuffered) {
          ws.close(1013, "UDP backpressure");
          return;
        }
        endpoint.send(record.payload, (error) => {
          if (error) ws.close(1011, "UDP send failed");
        });
      });
      const timeout = setInterval(() => {
        if (performance.now() - lastPongTime > 5000) {
          ws.close(1008, "Bridge peer unresponsive");
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 1000);
      timeout.unref();
      ws.once("close", () => {
        clearInterval(timeout);
        if (client === ws) client = null;
      });
    });
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 9002, "127.0.0.1", () => {
        server.off("error", reject);
        done();
      });
    });
  } catch (error) {
    for (const s of sockets) s.close();
    jsonPhysics?.close();
    wss.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  return {
    port: address.port,
    udpLocalPorts: sockets.map((s) => s.address().port),
    jsonPhysics,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      for (const s of sockets) s.close();
      jsonPhysics?.close();
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Token delivery is explicitly via environment; never print a generated secret.
  const token = process.env.MIRAGE_BRIDGE_TOKEN;
  if (!token)
    throw new Error(
      "Set MIRAGE_BRIDGE_TOKEN through local environment settings before starting the bridge",
    );
  const mavlinkPort = Number(process.env.MIRAGE_MAVLINK_PORT ?? 14550),
    physicsPort = Number(process.env.MIRAGE_PHYSICS_PORT ?? 9003),
    jsonPort = process.env.MIRAGE_ARDUPILOT_JSON_PORT;
  void startBridge({
    origin: process.env.MIRAGE_BRIDGE_ORIGIN ?? "http://localhost:5173",
    token,
    epoch: 1,
    udp: { mavlinkPort, physicsPort },
    // ArduPilot JSON SITL sends to UDP 9002 by default (TASK-041).
    ...(jsonPort === undefined ? {} : { ardupilotJson: { localPort: Number(jsonPort) } }),
  }).then(({ port }) =>
    console.log(`Loopback bridge listening on port ${port}`),
  );
}
