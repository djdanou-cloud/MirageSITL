import { expect, it } from "vitest";
import {
  SerialTransport,
  type SerialPortLike,
} from "../packages/autopilot/src/serial-transport";
function mockPort() {
  let input: ReadableStreamDefaultController<Uint8Array> | undefined;
  const writes: Uint8Array[] = [];
  let opens = 0,
    closes = 0;
  const port: SerialPortLike = {
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        input = c;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        writes.push(bytes.slice());
      },
    }),
    open: () => {
      opens++;
      return Promise.resolve();
    },
    close: () => {
      closes++;
      return Promise.resolve();
    },
  };
  return {
    port,
    writes,
    push: (data: Uint8Array) => input?.enqueue(data),
    fail: () => input?.error(new Error("Disconnected")),
    counts: () => ({ opens, closes }),
  };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
it("owns one reader, handles arbitrary chunks and releases streams on close", async () => {
  const p = mockPort(),
    received: Uint8Array[] = [],
    errors: unknown[] = [],
    a = new SerialTransport(
      (x) => {
        received.push(x.slice());
      },
      (e) => errors.push(e),
    ),
    b = new SerialTransport(
      () => undefined,
      () => undefined,
    );
  await a.open(p.port);
  await expect(b.open(p.port)).rejects.toThrow("busy");
  p.push(new Uint8Array([253]));
  p.push(new Uint8Array([2, 3]));
  await flush();
  expect(received.map((x) => Array.from(x))).toEqual([[253], [2, 3]]);
  expect(await a.write(new Uint8Array([4, 5]))).toBe(true);
  expect(p.writes).toEqual([new Uint8Array([4, 5])]);
  await Promise.all([a.close(), a.close()]);
  expect(p.port.readable?.locked).toBe(false);
  expect(p.port.writable?.locked).toBe(false);
  expect(p.counts()).toEqual({ opens: 1, closes: 1 });
  expect(errors).toEqual([]);
  expect(await a.write(new Uint8Array(1))).toBe(false);
});
it("cleans up on disconnect, failed open and a close racing with open", async () => {
  const p = mockPort(),
    errors: unknown[] = [],
    a = new SerialTransport(
      () => undefined,
      (e) => errors.push(e),
    );
  await a.open(p.port);
  p.fail();
  await flush();
  await a.close();
  expect(a.status).toBe("closed");
  expect(errors).toHaveLength(1);
  const q = mockPort();
  q.port.open = () => Promise.reject(new Error("Permission denied"));
  await expect(a.open(q.port)).rejects.toThrow("Permission denied");
  expect(a.status).toBe("closed");
  let complete: (() => void) | undefined;
  const r = mockPort();
  r.port.open = () =>
    new Promise<void>((done) => {
      complete = done;
    });
  const opening = a.open(r.port);
  const closing = a.close();
  complete?.();
  await opening;
  await closing;
  expect(a.status).toBe("closed");
  expect(r.port.readable?.locked).toBe(false);
});
it("bounds writes under backpressure instead of creating an unbounded output queue", async () => {
  const p = mockPort();
  let release: (() => void) | undefined;
  Object.defineProperty(p.port, "writable", {
    value: new WritableStream<Uint8Array>({
      write: () =>
        new Promise<void>((done) => {
          release = done;
        }),
    }),
  });
  const a = new SerialTransport(
    () => undefined,
    () => undefined,
  );
  await a.open(p.port);
  const first = a.write(new Uint8Array([1]));
  await flush();
  expect(await a.write(new Uint8Array([2]))).toBe(false);
  expect(await a.write(new Uint8Array(4097))).toBe(false);
  release?.();
  expect(await first).toBe(true);
  await a.close();
});
it("releases port ownership after a rejected cancel and supports explicit reopen with fresh streams", async () => {
  const p = mockPort();
  Object.defineProperty(p.port, "readable", {
    value: new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(new Error("Cancel failed"));
      },
    }),
  });
  const errors: unknown[] = [],
    a = new SerialTransport(
      () => undefined,
      (e) => errors.push(e),
    );
  await a.open(p.port);
  await a.close();
  expect(a.status).toBe("closed");
  expect(errors).toHaveLength(1);
  expect(p.port.readable?.locked).toBe(false);
  expect(p.port.writable?.locked).toBe(false);
  Object.defineProperty(p.port, "readable", {
    value: new ReadableStream<Uint8Array>(),
  });
  Object.defineProperty(p.port, "writable", {
    value: new WritableStream<Uint8Array>(),
  });
  await a.open(p.port);
  await a.close();
  expect(p.counts()).toEqual({ opens: 2, closes: 2 });
});
