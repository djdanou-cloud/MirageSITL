// Recorder storage backpressure (TASK-076 merge): a busy IndexedDB
// transaction queues chunks in a bounded pending list instead of dropping
// them. Uses a minimal in-memory IndexedDB stand-in with a fixed latency.
import { afterEach, beforeEach, expect, test } from "vitest";
import { ChunkStorage } from "../packages/aar/src/storage";

interface FakeTx { oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; error: null; objectStore(): { put(v: Uint8Array, k: number): void; clear(): void } }
let stored: Map<number, Uint8Array>, latencyMs: number, failNext: number, original: unknown;

function fakeIndexedDb() {
  const db = {
    name: "fake",
    close: () => undefined,
    transaction(): FakeTx {
      const fail = failNext > 0 ? (failNext--, true) : false;
      const tx: FakeTx = {
        oncomplete: null, onerror: null, onabort: null, error: null,
        objectStore: () => ({
          put: (v: Uint8Array, k: number) => { setTimeout(() => { if (fail) tx.onerror?.(); else { stored.set(k, v); tx.oncomplete?.(); } }, latencyMs); },
          clear: () => { setTimeout(() => tx.oncomplete?.(), 0); },
        }),
      };
      return tx;
    },
    createObjectStore: () => undefined,
  };
  return {
    open() {
      const req: { result: typeof db; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded: (() => void) | null; error: null } =
        { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, error: null };
      setTimeout(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }, 0);
      return req;
    },
    deleteDatabase: () => undefined,
  };
}
beforeEach(() => { stored = new Map(); latencyMs = 5; failNext = 0; original = Reflect.get(globalThis, "indexedDB"); Reflect.set(globalThis, "indexedDB", fakeIndexedDb()); });
afterEach(() => { Reflect.set(globalThis, "indexedDB", original); });
const chunk = (n: number) => new Uint8Array(512).fill(n);

test("a burst within the pending bound is written completely and in order", async () => {
  const s = await ChunkStorage.open("aar-test", 64, 32768);
  for (let i = 0; i < 9; i++) expect(s.write(chunk(i))).toBe(true); // 1 in flight + 8 pending
  expect(s.pendingChunks).toBe(8);
  await s.settled();
  expect(s.dropped).toBe(0);
  expect([...stored.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect([...stored.values()].map(c => c[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("overflow beyond the pending bound and failed transactions are counted, not silent", async () => {
  const s = await ChunkStorage.open("aar-test", 64, 32768, 2);
  const accepted = Array.from({ length: 6 }, (_, i) => s.write(chunk(i)));
  expect(accepted).toEqual([true, true, true, false, false, false]);
  expect([s.dropped, s.droppedBytes]).toEqual([3, 3 * 512]);
  await s.settled();
  expect(stored.size).toBe(3);
  failNext = 1;
  s.write(chunk(9));
  await s.settled();
  expect([s.dropped, s.failures]).toEqual([4, 1]);
  expect(s.write(new Uint8Array(40000))).toBe(false); // larger than a chunk
  expect(s.dropped).toBe(5);
  await expect(ChunkStorage.open("aar-test", 64, 32768, 65)).rejects.toThrow();
});
