// A DataFlash log written here, byte by byte, from message definitions and rows (TASK-184 tests): FMT records, then one record per
// row in time order. Formats Q (uint64 microseconds), B (uint8), f (float32) and N (char[16]) only. Not a MirageSITL writer: it
// writes ArduPilot's own message names (ATT, RATE, XKF1, BAT, RCOU, PARM), as a real or SITL flight log holds them.

export interface SyntheticMessage { readonly type: number; readonly name: string; readonly format: string; readonly columns: readonly string[] }
export type SyntheticValue = number | string;
const SIZES: Readonly<Record<string, number>> = { Q: 8, B: 1, f: 4, N: 16 };
const length = (format: string) => 3 + [...format].reduce((sum, c) => { const size = SIZES[c]; if (size === undefined) throw new Error(`Unsupported format ${c}`); return sum + size; }, 0);
const encoder = new TextEncoder();

function fmt(message: SyntheticMessage): Uint8Array {
  const out = new Uint8Array(89);
  out.set([0xa3, 0x95, 128, message.type, length(message.format)]);
  encoder.encodeInto(message.name, out.subarray(5, 9));
  encoder.encodeInto(message.format, out.subarray(9, 25));
  encoder.encodeInto(message.columns.join(","), out.subarray(25, 89));
  return out;
}
function row(message: SyntheticMessage, values: readonly SyntheticValue[]): Uint8Array {
  const out = new Uint8Array(length(message.format)), view = new DataView(out.buffer);
  out.set([0xa3, 0x95, message.type]);
  let at = 3;
  [...message.format].forEach((c, i) => {
    const value = values[i];
    if (c === "Q") view.setBigUint64(at, BigInt(Math.round(Number(value))), true);
    else if (c === "B") view.setUint8(at, Number(value));
    else if (c === "f") view.setFloat32(at, Number(value), true);
    else encoder.encodeInto(String(value), out.subarray(at, at + 16));
    at += SIZES[c] ?? 0;
  });
  return out;
}

/** The FMT message's own definition, then each message's FMT, then the rows sorted by their first value (TimeUS). */
export function syntheticLog(messages: readonly SyntheticMessage[], rows: readonly { readonly message: string; readonly values: readonly SyntheticValue[] }[]): Uint8Array {
  // FMT describes itself with formats n (char[4]) and Z (char[64]) as well: 89 bytes.
  const self = new Uint8Array(89);
  self.set([0xa3, 0x95, 128, 128, 89]);
  encoder.encodeInto("FMT", self.subarray(5, 9)); encoder.encodeInto("BBnNZ", self.subarray(9, 25)); encoder.encodeInto("Type,Length,Name,Format,Columns", self.subarray(25, 89));
  const parts: Uint8Array[] = [self, ...messages.map(fmt)];
  const byName = new Map(messages.map(message => [message.name, message]));
  for (const item of [...rows].sort((a, b) => Number(a.values[0]) - Number(b.values[0]))) {
    const message = byName.get(item.message);
    if (!message) throw new Error(`No message ${item.message}`);
    parts.push(row(message, item.values));
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export const ARDUPILOT_MESSAGES: readonly SyntheticMessage[] = Object.freeze([
  { type: 64, name: "PARM", format: "QNff", columns: ["TimeUS", "Name", "Value", "Default"] },
  { type: 65, name: "ATT", format: "Qffffff", columns: ["TimeUS", "DesRoll", "Roll", "DesPitch", "Pitch", "DesYaw", "Yaw"] },
  { type: 66, name: "RATE", format: "Qffffff", columns: ["TimeUS", "RDes", "R", "PDes", "P", "YDes", "Y"] },
  { type: 67, name: "XKF1", format: "QBffffff", columns: ["TimeUS", "C", "VN", "VE", "VD", "PN", "PE", "PD"] },
  { type: 68, name: "BAT", format: "QBffff", columns: ["TimeUS", "Inst", "Volt", "Curr", "CurrTot", "EnrgTot"] },
  { type: 69, name: "RCOU", format: "Qffff", columns: ["TimeUS", "C1", "C2", "C3", "C4"] },
]);
