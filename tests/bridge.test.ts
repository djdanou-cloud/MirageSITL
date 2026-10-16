import { expect, it, vi } from "vitest";
import { createSocket } from "node:dgram";
import { WebSocket } from "ws";
import { startBridge } from "../apps/bridge/src/server";
import { BridgeSession } from "../apps/bridge/src/session";
import { encodeRecord, decodeRecord } from "../apps/bridge/src/framing";
const token = "a".repeat(64),
  origin = "http://localhost:5173";
function connect(port: number, auth = token, site = origin) {
  return new WebSocket(
    `ws://127.0.0.1:${port}`,
    ["mirage-v1", `session.${auth}`],
    { origin: site },
  );
}
function opened(ws: WebSocket) {
  return new Promise<void>((done, reject) => {
    ws.once("open", () => done());
    ws.once("error", reject);
  });
}
function closed(ws: WebSocket) {
  return new Promise<number>((done) => {
    ws.once("close", (code) => done(code));
    ws.on("error", () => undefined);
  });
}
async function udp() {
  const s = createSocket("udp4");
  await new Promise<void>((done) => s.bind(0, "127.0.0.1", () => done()));
  return s;
}
it("checks framing, wrap, epoch, flood limits and rejects coalesced or truncated records", () => {
  const f = {
      channel: 1 as const,
      epoch: 7,
      sequence: 0,
      payload: new Uint8Array([1, 2]),
    },
    bytes = encodeRecord(f);
  expect(decodeRecord(bytes)).toEqual(f);
  expect(decodeRecord(bytes.subarray(0, 17))).toBeNull();
  expect(decodeRecord(new Uint8Array([...bytes, ...bytes]))).toBeNull();
  const s = new BridgeSession(7, 2);
  expect(s.accept({ ...f, sequence: 0xffffffff }, 0)).toBe(true);
  expect(s.accept(f, 0)).toBe(true);
  expect(s.accept({ ...f, sequence: 1 }, 0)).toBe(false);
  expect(s.accept({ ...f, sequence: 1 }, 1000)).toBe(true);
  expect(s.accept({ ...f, epoch: 8, sequence: 2 }, 1000)).toBe(false);
  expect(s.accept({ ...f, sequence: 1 }, 1000)).toBe(false);
});
it("runs real loopback WS/UDP channels, fragmented WS delivery, authentication and reconnect", async () => {
  const mav = await udp(),
    physics = await udp();
  mav.on("message", (msg, peer) => mav.send(msg, peer.port, peer.address));
  physics.on("message", (msg, peer) =>
    physics.send(msg, peer.port, peer.address),
  );
  const b = await startBridge({
    port: 0,
    origin,
    token,
    epoch: 7,
    udp: {
      mavlinkPort: mav.address().port,
      physicsPort: physics.address().port,
    },
  });
  let ws: WebSocket | undefined;
  try {
    const denied = connect(b.port, "b".repeat(64));
    await expect(opened(denied)).rejects.toThrow("403");
    await closedIfNeeded(denied);
    const deniedOrigin = connect(b.port, token, "https://example.org");
    await expect(opened(deniedOrigin)).rejects.toThrow("403");
    await closedIfNeeded(deniedOrigin);
    ws = connect(b.port);
    await opened(ws);
    const busy = connect(b.port);
    await expect(opened(busy)).rejects.toThrow("403");
    await closedIfNeeded(busy);
    const records: unknown[] = [],
      received = new Promise<void>((done) => {
        ws?.on("message", (data) => {
          if (!Buffer.isBuffer(data))
            throw new Error("Unexpected websocket data");
          records.push(decodeRecord(data));
          if (records.length === 2) done();
        });
      });
    const first = encodeRecord({
      channel: 1,
      epoch: 7,
      sequence: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
    ws.send(first.subarray(0, 8), { fin: false });
    ws.send(first.subarray(8), { fin: true });
    ws.send(
      encodeRecord({
        channel: 2,
        epoch: 7,
        sequence: 0,
        payload: new Uint8Array([4, 5]),
      }),
    );
    await received;
    expect(records).toEqual(
      expect.arrayContaining([
        { channel: 1, epoch: 7, sequence: 0, payload: Buffer.from([1, 2, 3]) },
        { channel: 3, epoch: 7, sequence: 0, payload: Buffer.from([4, 5]) },
      ]),
    );
    const end = closed(ws);
    ws.send(
      encodeRecord({
        channel: 1,
        epoch: 6,
        sequence: 1,
        payload: new Uint8Array(),
      }),
    );
    expect(await end).toBe(1008);
    ws = connect(b.port);
    await opened(ws);
    const overflow = closed(ws);
    ws.send(new Uint8Array(5000));
    expect(await overflow).toBe(1009);
  } finally {
    ws?.terminate();
    await b.close();
    mav.close();
    physics.close();
  }
}, 10000);
async function closedIfNeeded(ws: WebSocket) {
  if (ws.readyState !== WebSocket.CLOSED) await closed(ws);
}
it("closes rather than queueing unbounded output when the socket reports backpressure", async () => {
  const mav = await udp(),
    physics = await udp(),
    b = await startBridge({
      port: 0,
      origin,
      token,
      epoch: 1,
      udp: {
        mavlinkPort: mav.address().port,
        physicsPort: physics.address().port,
      },
    }),
    ws = connect(b.port);
  try {
    await opened(ws);
    const ending = closed(ws),
      spy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockReturnValue(1048576);
    try {
      ws.send(
        encodeRecord({
          channel: 1,
          epoch: 1,
          sequence: 0,
          payload: new Uint8Array(),
        }),
      );
      expect(await ending).toBe(1013);
    } finally {
      spy.mockRestore();
    }
  } finally {
    ws.terminate();
    await b.close();
    mav.close();
    physics.close();
  }
}, 10000);
