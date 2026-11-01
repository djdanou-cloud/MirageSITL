// TASK-155 (S02): the launcher's connections to a SITL the user started.
// In-process peers stand in for SITL's MAVLink TCP server, its UDP MAVLink
// output and its JSON servo packets: refusals that leave nothing open, both
// directions of both transports through the bridge, the servo rate and
// channel count reported before a browser attaches, disconnect, and SITL
// closing its TCP connection. The real pinned ArduCopter (TASK-127), when
// present, is started here as a user would start it, and connect and
// disconnect cycles leave its process running.
import { spawn } from "node:child_process";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeRecord, encodeRecord, type BridgeRecord } from "../apps/bridge/src/framing.ts";
import { writeCatalogEntry } from "../apps/launcher/src/catalog.ts";
import { ensureToken, startLauncher } from "../apps/launcher/src/server.ts";
import sitlLock from "../scripts/sitl.lock.json" with { type: "json" };
import { writeFakeFirmware } from "./support/fake-firmware.ts";

const ORIGIN = "http://127.0.0.1:5173";
const ROOT = new URL("..", import.meta.url).pathname;
const REAL_BINARY = join(ROOT, ".cache/task-127/build-stock/sitl/bin/arducopter");
const REAL_DEFAULTS = join(ROOT, ".cache/task-127/ardupilot/Tools/autotest/default_params/copter.parm");
const scratch = mkdtempSync(join(tmpdir(), "mirage-connections-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Launcher = Awaited<ReturnType<typeof startLauncher>>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fake = writeFakeFirmware(scratch, { modeFile: join(scratch, "fake-mode") });
const fakeDefaults = join(scratch, "copter.parm");
writeFileSync(fakeDefaults, "SYSID_THISMAV 1\n");

/** A launcher in a new home with one fake firmware entry ("fake"); any executable is admitted. */
async function launcher(): Promise<{ launcher: Launcher; token: string }> {
  const home = mkdtempSync(join(scratch, "home-"));
  const token = ensureToken(home);
  writeCatalogEntry(home, { id: "fake", firmwareVersion: "ArduCopter V4.8.0-dev", commit: sitlLock.commit, binaryPath: fake.binary,
    binarySha256: sha256(fake.binary), defaultParametersPath: fakeDefaults, defaultParametersSha256: sha256(fakeDefaults) });
  const started = await startLauncher({ home, origin: ORIGIN, port: 0, python: "/nonexistent/python", admit: path => Buffer.from(path) });
  cleanups.push(() => started.close());
  return { launcher: started, token };
}
async function call(l: Launcher, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${l.port}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === "" ? null : JSON.parse(text) as unknown };
}
function field(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  return current;
}
function number(value: unknown): number {
  if (typeof value !== "number") throw new Error(`Expected a number, got ${String(value)}`);
  return value;
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(done => setTimeout(done, 25));
  }
}
/** A free loopback UDP port, released at once. */
async function freeUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>(done => socket.bind(0, "127.0.0.1", () => done()));
  const { port } = socket.address();
  await new Promise<void>(done => socket.close(() => done()));
  return port;
}
async function udp(port = 0): Promise<UdpSocket> {
  const socket = createSocket("udp4");
  await new Promise<void>((done, reject) => { socket.once("error", reject); socket.bind(port, "127.0.0.1", () => done()); });
  cleanups.push(() => new Promise<void>(done => socket.close(() => done())));
  return socket;
}
/** A TCP server standing in for SITL's SERIAL0; `peers` holds every accepted connection. */
async function tcpServer(): Promise<{ server: Server; port: number; peers: Socket[]; received: Buffer[] }> {
  const peers: Socket[] = [], received: Buffer[] = [];
  const server = createServer(socket => { peers.push(socket); socket.on("data", bytes => received.push(bytes)); socket.on("error", () => undefined); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  cleanups.push(() => new Promise<void>(done => { for (const peer of peers) peer.destroy(); server.close(() => done()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return { server, port: address.port, peers, received };
}
/** A 16-channel JSON servo packet (SIM_JSON.h servo_packet_16). */
function servoPacket(frameCount: number, rateHz: number, channels: 16 | 32 = 16): Buffer {
  const packet = Buffer.alloc(8 + 2 * channels);
  packet.writeUInt16LE(channels === 16 ? 18458 : 29569, 0);
  packet.writeUInt16LE(rateHz, 2);
  packet.writeUInt32LE(frameCount, 4);
  for (let i = 0; i < channels; i++) packet.writeUInt16LE(1000, 8 + 2 * i);
  return packet;
}
async function bridgeClient(port: number, token: string): Promise<{ socket: WebSocket; records: BridgeRecord[]; closed: Promise<number> }> {
  const records: BridgeRecord[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, ["mirage-v1", `session.${token}`], { origin: ORIGIN });
  socket.on("message", (data: Buffer) => { const record = decodeRecord(new Uint8Array(data)); if (record) records.push(record); });
  const closed = new Promise<number>(done => socket.once("close", code => done(code)));
  await new Promise<void>((done, reject) => { socket.once("open", () => done()); socket.once("error", reject); });
  cleanups.push(() => { socket.terminate(); });
  return { socket, records, closed };
}
const body = (jsonPhysicsPort: number, transport: "tcp" | "udp", port: number) => ({ jsonPhysicsPort, mavlink: { transport, port } });

describe("launcher connections to an external SITL", () => {
  test("refuses requests and ports it cannot use, leaving nothing open or registered", async () => {
    const { launcher: l, token } = await launcher();
    const jsonPort = await freeUdpPort();
    for (const [request, message] of [
      [{ jsonPhysicsPort: jsonPort }, "Expected jsonPhysicsPort and mavlink"],
      [body(jsonPort, "tcp", 0), "mavlink.port must be a number from 1 to 65535"],
      [{ jsonPhysicsPort: jsonPort, mavlink: { transport: "serial", port: 5760 } }, "mavlink.transport must be tcp or udp"],
      [body(jsonPort, "udp", jsonPort), "must differ"],
      [body(jsonPort + 0.5, "tcp", 5760), "Ports must be integers"],
    ] as const) {
      const refused = await call(l, token, "POST", "/v1/connections", request);
      expect(refused.status).toBe(400);
      expect(String(field(refused.json, "error"))).toContain(message);
    }
    // Nothing accepts TCP on a port just released.
    const closedPort = await freeUdpPort();
    const noServer = await call(l, token, "POST", "/v1/connections", body(jsonPort, "tcp", closedPort));
    expect(noServer.status).toBe(409);
    expect(String(field(noServer.json, "error"))).toContain(`Nothing accepts MAVLink TCP connections on 127.0.0.1:${closedPort}`);
    // The JSON physics port is held by another program.
    const sitl = await tcpServer();
    const holder = await udp();
    const held = await call(l, token, "POST", "/v1/connections", body(holder.address().port, "tcp", sitl.port));
    expect(held.status).toBe(409);
    expect(String(field(held.json, "error"))).toContain(`UDP port ${holder.address().port} is already in use: another physics program`);
    // The relay's TCP connection was released again.
    await until(() => sitl.peers.length === 1 && sitl.peers[0]!.destroyed, 5000, "the refused relay's TCP connection to close");
    // The UDP MAVLink port is held, for example by a ground station.
    const groundStation = await udp();
    const busy = await call(l, token, "POST", "/v1/connections", body(jsonPort, "udp", groundStation.address().port));
    expect(busy.status).toBe(409);
    expect(String(field(busy.json, "error"))).toContain("already in use, for example by a ground station");
    expect(field((await call(l, token, "GET", "/v1/status")).json, "connections")).toEqual([]);
    // After every refusal the JSON port is free again.
    const free = await udp(jsonPort);
    expect(free.address().port).toBe(jsonPort);
  });

  test("relays TCP MAVLink and JSON servo packets, reports the servo rate, and releases on disconnect", async () => {
    const { launcher: l, token } = await launcher();
    const sitl = await tcpServer(), jsonPort = await freeUdpPort();
    const opened = await call(l, token, "POST", "/v1/connections", body(jsonPort, "tcp", sitl.port));
    expect(opened.status).toBe(201);
    expect(opened.json).toMatchObject({ ownership: "external", state: "open", closedReason: null, endpoints: body(jsonPort, "tcp", sitl.port),
      ports: { epoch: 1 }, physics: { servoPackets: 0, rateHz: null, channels: null } });
    const id = String(field(opened.json, "id"));
    expect(id).toMatch(/^[0-9]{17}-[0-9a-f]{8}$/);
    await until(() => sitl.peers.length === 1, 5000, "the relay's TCP connection");
    // Before a browser attaches, the view reports SITL's servo packets.
    const servo = await udp();
    for (let frame = 0; frame < 3; frame++) servo.send(servoPacket(frame, 1200, 32), jsonPort, "127.0.0.1");
    await until(async () => field((await call(l, token, "GET", `/v1/connections/${id}`)).json, "physics", "servoPackets") === 3, 5000, "three servo packets");
    expect(field((await call(l, token, "GET", `/v1/connections/${id}`)).json, "physics")).toMatchObject({ rateHz: 1200, channels: 32, rejected: 0 });
    // An owned run cannot start while the connection is open, nor a second connection open.
    expect((await call(l, token, "POST", "/v1/connections", body(await freeUdpPort(), "tcp", sitl.port))).status).toBe(409);
    const start = await call(l, token, "POST", "/v1/experiments", { firmwareId: "fake", parameters: [], frameScript: null, speedup: 1, rateHz: 800,
      home: [-35.363261, 149.16523, 584, 0] });
    expect(start.status).toBe(409);
    expect(String(field(start.json, "error"))).toContain("A connection to an external SITL is open");

    const client = await bridgeClient(number(field(opened.json, "ports", "bridge")), token);
    // A TCP chunk larger than one bridge datagram arrives whole, in order, split into datagrams.
    const stream = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    sitl.peers[0]!.write(stream);
    await until(() => client.records.filter(r => r.channel === 1).reduce((n, r) => n + r.payload.length, 0) >= stream.length, 5000, "the TCP stream");
    const relayed = Buffer.concat(client.records.filter(r => r.channel === 1).map(r => r.payload));
    expect(relayed.equals(stream)).toBe(true);
    expect(client.records.filter(r => r.channel === 1).every(r => r.payload.length <= 2048)).toBe(true);
    // The browser's MAVLink reaches SITL's TCP server.
    client.socket.send(encodeRecord({ channel: 1, epoch: 1, sequence: 0, payload: new Uint8Array([0xfd, 1, 2, 3]) }));
    await until(() => Buffer.concat(sitl.received).equals(Buffer.from([0xfd, 1, 2, 3])), 5000, "MAVLink at SITL");
    // A servo packet now reaches the browser as a channel 3 record.
    servo.send(servoPacket(3, 1200, 32), jsonPort, "127.0.0.1");
    await until(() => client.records.some(r => r.channel === 3), 5000, "a servo record");

    const released = await call(l, token, "POST", `/v1/connections/${id}/disconnect`);
    expect(released.json).toMatchObject({ state: "disconnected", ports: null, physics: { servoPackets: 4, rateHz: 1200 } });
    expect(number(field(released.json, "mavlink", "bytesFromSitl"))).toBe(stream.length);
    await client.closed;
    await until(() => sitl.peers[0]!.destroyed || sitl.peers[0]!.readableEnded, 5000, "the relay to end its TCP connection");
    // SITL's side is untouched: its server still accepts, and the ports are free for the next connection.
    expect(sitl.server.listening).toBe(true);
    const again = await call(l, token, "POST", "/v1/connections", body(jsonPort, "tcp", sitl.port));
    expect(again.status).toBe(201);
    expect(field(again.json, "id")).not.toBe(id);
    expect((await call(l, token, "POST", `/v1/connections/${String(field(again.json, "id"))}/disconnect`)).status).toBe(200);
    // Disconnecting twice is harmless.
    expect((await call(l, token, "POST", `/v1/connections/${id}/disconnect`)).json).toMatchObject({ state: "disconnected" });
  });

  test("relays UDP MAVLink from the port SITL sends to", async () => {
    const { launcher: l, token } = await launcher();
    const mavlinkPort = await freeUdpPort(), jsonPort = await freeUdpPort();
    const opened = await call(l, token, "POST", "/v1/connections", body(jsonPort, "udp", mavlinkPort));
    expect(opened.status).toBe(201);
    const client = await bridgeClient(number(field(opened.json, "ports", "bridge")), token);
    const sitl = await udp();
    const fromBrowser: Buffer[] = [];
    sitl.on("message", bytes => fromBrowser.push(bytes));
    sitl.send(Buffer.from([0xfd, 9, 9]), mavlinkPort, "127.0.0.1");
    await until(() => client.records.some(r => r.channel === 1), 5000, "SITL's MAVLink at the browser");
    // Once SITL's source port is known, the browser's MAVLink goes back to it.
    client.socket.send(encodeRecord({ channel: 1, epoch: 1, sequence: 0, payload: new Uint8Array([0xfd, 4]) }));
    await until(() => fromBrowser.length === 1, 5000, "the browser's MAVLink at SITL");
    expect([...fromBrowser[0]!]).toEqual([0xfd, 4]);
    await call(l, token, "POST", `/v1/connections/${String(field(opened.json, "id"))}/disconnect`);
  });

  test("marks the connection sitl-closed when SITL ends its TCP connection, and closes the bridge", async () => {
    const { launcher: l, token } = await launcher();
    const sitl = await tcpServer(), jsonPort = await freeUdpPort();
    const opened = await call(l, token, "POST", "/v1/connections", body(jsonPort, "tcp", sitl.port));
    const id = String(field(opened.json, "id"));
    const client = await bridgeClient(number(field(opened.json, "ports", "bridge")), token);
    await until(() => sitl.peers.length === 1, 5000, "the relay's TCP connection");
    sitl.peers[0]!.end();
    await client.closed;
    expect((await call(l, token, "GET", `/v1/connections/${id}`)).json).toMatchObject({
      state: "sitl-closed", closedReason: "SITL closed its MAVLink TCP connection", ports: null });
    // A later disconnect keeps the reason.
    expect((await call(l, token, "POST", `/v1/connections/${id}/disconnect`)).json).toMatchObject({ state: "sitl-closed" });
  });
});

// The real pinned ArduCopter, started the way a user would: JSON physics, its
// own TCP SERIAL0 and a SITL instance whose ports are unlikely to be in use.
const realSitl = existsSync(REAL_BINARY) && existsSync(REAL_DEFAULTS);
describe.skipIf(!realSitl)("launcher connections to the real ArduCopter SITL", () => {
  test("connect and disconnect cycles leave the external SITL process running", async () => {
    const { launcher: l, token } = await launcher();
    const instance = 23, tcpPort = 5760 + 10 * instance, jsonPort = 9002 + 10 * instance;
    const cwd = mkdtempSync(join(scratch, "user-sitl-"));
    const child = spawn(REAL_BINARY, ["--model", "JSON:127.0.0.1", "-I", String(instance), "--speedup", "1", "--defaults", REAL_DEFAULTS,
      "--home", "-35.363261,149.16523,584,0"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
    child.stderr.on("data", (bytes: Buffer) => { output += bytes.toString(); });
    const exited = new Promise<number | null>(done => child.once("exit", code => done(code)));
    cleanups.push(async () => { child.kill("SIGKILL"); await exited; });
    await until(() => output.includes("Waiting for connection"), 30000, "SITL to wait for its SERIAL0 connection");
    const pid = child.pid!;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let cycle = 1; cycle <= 3; cycle++) {
      const opened = await call(l, token, "POST", "/v1/connections", body(jsonPort, "tcp", tcpPort));
      expect(opened.status, `cycle ${cycle}: ${JSON.stringify(opened.json)}`).toBe(201);
      const id = String(field(opened.json, "id"));
      // Once its SERIAL0 is connected, SITL sends servo packets at its default 1200 Hz with 16 channels, and resends an unanswered one.
      await until(async () => number(field((await call(l, token, "GET", `/v1/connections/${id}`)).json, "physics", "servoPackets")) > 0, 30000,
        `cycle ${cycle}: SITL's servo packets`);
      expect(field((await call(l, token, "GET", `/v1/connections/${id}`)).json, "physics")).toMatchObject({ rateHz: 1200, channels: 16 });
      // No physics peer answers here, so SITL's scheduler waits in JSON lockstep and sends no MAVLink yet;
      // tests/browser/manual-connect.spec.ts flies the whole chain.
      expect((await call(l, token, "POST", `/v1/connections/${id}/disconnect`)).json).toMatchObject({ state: "disconnected" });
      // The process the launcher never owned keeps running.
      await new Promise(done => setTimeout(done, 1500));
      expect(alive(), `cycle ${cycle}: SITL exited:\n${output.slice(-2000)}`).toBe(true);
    }
  }, 180000);
});
