import { expect, test } from "vitest";
import { newFlightStateV2 } from "@mirage/protocol";
import { AarRecord } from "../packages/aar/src/record";
import { exportArchive, importArchive } from "../packages/aar/src/archive";
const m = {
  formatVersion: 1,
  recordBytes: 512,
  modelSha256: "a".repeat(64),
  firmwareSha256: null,
  seed: 7,
  physicsHz: 400,
  recordHz: 10,
  durationS: 1800,
  clock: "simulation",
  source: "demo-decimated",
};
test("archive roundtrip preserves records/provenance/loss and rejects mutation and unknown metadata", async () => {
  const r = new AarRecord();
  r.encode(newFlightStateV2(), new Float64Array(4), null, null);
  const a = await exportArchive(m, r.bytes, {
      queueLost: 3,
      evicted: 2,
      storageDropped: 1,
    }),
    b = await importArchive(a);
  expect(b.manifest).toEqual(m);
  expect(b.records).toEqual(r.bytes);
  expect(b.loss).toEqual({ queueLost: 3, evicted: 2, storageDropped: 1 });
  const redacted = await exportArchive(
    { ...m, apiKey: "private-api-key", serialIdentifier: "private-serial-id" },
    r.bytes,
    undefined,
    "omit-extra-metadata",
  );
  expect((await importArchive(redacted)).manifest).toEqual(m);
  expect(new TextDecoder().decode(redacted)).not.toContain("private-api-key");
  expect(new TextDecoder().decode(redacted)).not.toContain("private-serial-id");
  a[a.length - 1]! ^= 1;
  await expect(importArchive(a)).rejects.toThrow("hash");
  await expect(
    exportArchive({ ...m, apiKey: "secret" }, r.bytes),
  ).rejects.toThrow();
});
test("size/header/format bounds rejected before attacker-controlled payload copies", async () => {
  const input = new Uint8Array(64),
    v = new DataView(input.buffer);
  v.setUint32(0, 0x4d415241, true);
  v.setUint32(4, 1, true);
  v.setUint32(8, 0xffffffff, true);
  await expect(importArchive(input)).rejects.toThrow("header");
  await expect(
    importArchive(new Uint8Array(32 * 1024 * 1024 + 1)),
  ).rejects.toThrow("size");
});
