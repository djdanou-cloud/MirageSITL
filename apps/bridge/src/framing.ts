/** WebSocket records, not raw UDP datagrams: 16-byte little-endian header. */
export const BRIDGE_VERSION = 1,
  MAX_BRIDGE_PAYLOAD = 4096;
export type BridgeChannel = 1 | 2 | 3; // MAVLink / physics sensors JSON / physics servo binary
export interface BridgeRecord {
  channel: BridgeChannel;
  epoch: number;
  sequence: number;
  payload: Uint8Array;
}
export function encodeRecord(record: BridgeRecord): Uint8Array {
  if (
    (record.channel !== 1 && record.channel !== 2 && record.channel !== 3) ||
    record.epoch >>> 0 !== record.epoch ||
    record.sequence >>> 0 !== record.sequence ||
    record.payload.length > MAX_BRIDGE_PAYLOAD
  )
    throw new Error("Invalid bridge record");
  const bytes = new Uint8Array(16 + record.payload.length),
    v = new DataView(bytes.buffer);
  v.setUint8(0, BRIDGE_VERSION);
  v.setUint8(1, record.channel);
  v.setUint16(2, 0, true);
  v.setUint32(4, record.epoch, true);
  v.setUint32(8, record.sequence, true);
  v.setUint32(12, record.payload.length, true);
  bytes.set(record.payload, 16);
  return bytes;
}
export function decodeRecord(bytes: Uint8Array): BridgeRecord | null {
  if (bytes.length < 16 || bytes.length > MAX_BRIDGE_PAYLOAD + 16) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    channel = v.getUint8(1);
  if (
    v.getUint8(0) !== 1 ||
    v.getUint16(2, true) !== 0 ||
    (channel !== 1 && channel !== 2 && channel !== 3) ||
    v.getUint32(12, true) !== bytes.length - 16
  )
    return null;
  return {
    channel,
    epoch: v.getUint32(4, true),
    sequence: v.getUint32(8, true),
    payload: bytes.subarray(16),
  };
}
