export const RECORD_BYTES = 512;
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export interface AarManifest {
  formatVersion: 1;
  recordBytes: 512;
  modelSha256: string;
  firmwareSha256: string | null;
  seed: number;
  physicsHz: 400 | 800 | 1200;
  recordHz: number;
  durationS: number;
  clock: "simulation";
  source: "demo-decimated" | "producer";
}
export function parseManifest(v: unknown): AarManifest {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error("Invalid AAR manifest");
  const x = v as Record<string, unknown>;
  if (
    Object.keys(x).sort().join() !==
      [
        "formatVersion",
        "recordBytes",
        "modelSha256",
        "firmwareSha256",
        "seed",
        "physicsHz",
        "recordHz",
        "durationS",
        "clock",
        "source",
      ]
        .sort()
        .join() ||
    x.formatVersion !== 1 ||
    x.recordBytes !== RECORD_BYTES ||
    typeof x.modelSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(x.modelSha256) ||
    !(
      x.firmwareSha256 === null ||
      (typeof x.firmwareSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(x.firmwareSha256))
    ) ||
    typeof x.seed !== "number" ||
    x.seed >>> 0 !== x.seed ||
    !(x.physicsHz === 400 || x.physicsHz === 800 || x.physicsHz === 1200) ||
    typeof x.recordHz !== "number" ||
    !Number.isInteger(x.recordHz) ||
    x.recordHz < 1 ||
    x.recordHz > 1200 ||
    typeof x.durationS !== "number" ||
    !Number.isInteger(x.durationS) ||
    x.durationS < 1 ||
    x.durationS > 1800 ||
    x.recordHz * x.durationS * RECORD_BYTES > MAX_ARCHIVE_BYTES - 8192 ||
    x.clock !== "simulation" ||
    !(x.source === "demo-decimated" || x.source === "producer")
  )
    throw new Error("Unsupported AAR manifest or capacity");
  return {
    formatVersion: 1,
    recordBytes: 512,
    modelSha256: x.modelSha256,
    firmwareSha256: x.firmwareSha256,
    seed: x.seed,
    physicsHz: x.physicsHz,
    recordHz: x.recordHz,
    durationS: x.durationS,
    clock: x.clock,
    source: x.source,
  };
}
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let crc = n;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  CRC_TABLE[n] = crc;
}
/** CRC-32/ISO-HDLC; skip record checksum word at bytes 60..63. */
export function recordCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    if (i >= 60 && i < 64) continue;
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]!) & 255]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export const RecordFlag = {
  Truth: 1,
  Pilot: 2,
  Sensor: 4,
  Actuator: 8,
  Event: 16,
  Decimated: 32,
} as const;
