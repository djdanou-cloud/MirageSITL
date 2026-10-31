// MirageSITL experiment records as a DataFlash log (TASK-178, S14/S15): truth,
// motor telemetry, events and parameter changes, in self-describing records
// that DataFlash readers and the log viewer open. Every MirageSITL message
// name is one the pinned ArduPilot source never logs (checked by the tests),
// so these records are never mistaken for autopilot data. Cold code: records
// are appended after the compute batch, never inside a physics step.

export type ParameterStatus = "requested" | "confirmed" | "rejected";
interface MessageSpec {
  readonly type: number;
  readonly name: string;
  readonly format: string;
  readonly columns: string;
  /** One UNIT ID per column. */
  readonly units: string;
  /** One MULT ID per column. */
  readonly mults: string;
}
/** UNIT IDs and labels as ArduPilot logs them. */
const UNITS: readonly (readonly [string, string])[] = [
  ["-", ""], ["#", "instance"], ["s", "s"], ["m", "m"], ["n", "m/s"], ["A", "A"], ["v", "V"], ["O", "degC"], ["q", "rpm"], ["Y", "us"],
];
/** MULT IDs as ArduPilot logs them; '-' is no multiplier. */
const MULTS: readonly (readonly [string, number])[] = [["-", 0], ["0", 1], ["F", 1e-6]];
const FMT = 0x80;
const META: readonly MessageSpec[] = [
  { type: FMT, name: "FMT", format: "BBnNZ", columns: "Type,Length,Name,Format,Columns", units: "-----", mults: "-----" },
  { type: 0x81, name: "UNIT", format: "QbZ", columns: "TimeUS,Id,Label", units: "s--", mults: "F--" },
  { type: 0x82, name: "MULT", format: "Qbd", columns: "TimeUS,Id,Mult", units: "s--", mults: "F--" },
  { type: 0x83, name: "FMTU", format: "QBNN", columns: "TimeUS,FmtType,UnitIds,MultIds", units: "s---", mults: "F---" },
];
/** MirageSITL messages. Quaternions are body-to-NED, scalar first. */
export const MIRAGE_MESSAGES: readonly MessageSpec[] = [
  { type: 0xc8, name: "MTRU", format: "Qdddfffffff", columns: "TimeUS,PN,PE,PD,VN,VE,VD,QW,QX,QY,QZ", units: "smmmnnn----", mults: "F000000----" },
  { type: 0xc9, name: "MMOT", format: "QBHfffff", columns: "TimeUS,Instance,PWM,Thr,RPM,Curr,Volt,Temp", units: "s#Y-qAvO", mults: "F-0-0000" },
  { type: 0xca, name: "MEVT", format: "QHZ", columns: "TimeUS,Id,Text", units: "s--", mults: "F--" },
  { type: 0xcb, name: "MPRM", format: "QNffBZ", columns: "TimeUS,Name,Req,Conf,Stat,Text", units: "s-----", mults: "F-----" },
];
/** MPRM Stat values. */
export const PARAMETER_STATUS: Readonly<Record<ParameterStatus, number>> = { requested: 0, confirmed: 1, rejected: 2 };
const SIZE: Readonly<Record<string, number>> = { b: 1, B: 1, H: 2, f: 4, d: 8, n: 4, N: 16, Z: 64, Q: 8 };
const MAX_TIME_US = Number.MAX_SAFE_INTEGER;

function recordLength(spec: MessageSpec): number {
  let length = 3;
  for (const char of spec.format) length += SIZE[char]!;
  return length;
}
function ascii(value: string, size: number, label: string): string {
  if (value.length > size || /[^\x20-\x7e]/.test(value)) throw new Error(`${label} must be printable ASCII of at most ${size} characters`);
  return value;
}

export class DataflashWriter {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor() {
    for (const spec of [...META, ...MIRAGE_MESSAGES]) this.write(META[0]!, [spec.type, recordLength(spec), spec.name, spec.format, spec.columns]);
    for (const [id, label] of UNITS) this.write(META[1]!, [0, id.charCodeAt(0), label]);
    for (const [id, mult] of MULTS) this.write(META[2]!, [0, id.charCodeAt(0), mult]);
    for (const spec of [...META.slice(1), ...MIRAGE_MESSAGES]) this.write(META[3]!, [0, spec.type, spec.units, spec.mults]);
  }

  /** Truth state: NED position (m) and velocity (m/s), and the body-to-NED quaternion. */
  truth(timeUs: number, positionNedM: readonly number[], velocityNedMps: readonly number[], quaternionWxyz: readonly number[]): void {
    if (positionNedM.length !== 3 || velocityNedMps.length !== 3 || quaternionWxyz.length !== 4) throw new Error("Truth needs 3 position, 3 velocity and 4 quaternion values");
    this.write(MIRAGE_MESSAGES[0]!, [timeUs, ...positionNedM, ...velocityNedMps, ...quaternionWxyz]);
  }

  /** One motor: output PWM (µs), throttle 0–1, speed (rpm), current (A), voltage (V), temperature (°C); NaN when not modelled. */
  motor(timeUs: number, instance: number, pwmUs: number, throttle: number, rpm: number, currentA: number, voltageV: number, temperatureC: number): void {
    this.write(MIRAGE_MESSAGES[1]!, [timeUs, instance, pwmUs, throttle, rpm, currentA, voltageV, temperatureC]);
  }

  /** An experiment event, such as a fault or a scenario step. */
  event(timeUs: number, id: number, text: string): void {
    this.write(MIRAGE_MESSAGES[2]!, [timeUs, id, ascii(text, 64, "Event text")]);
  }

  /** A parameter change: the requested value, the confirmed one (NaN until confirmed) and its status. */
  parameter(timeUs: number, name: string, requested: number, confirmed: number, status: ParameterStatus, text: string): void {
    if (!/^[A-Z][A-Z0-9_]{0,15}$/.test(name)) throw new Error("Parameter names are 1–16 ArduPilot name characters");
    this.write(MIRAGE_MESSAGES[3]!, [timeUs, name, requested, confirmed, PARAMETER_STATUS[status], ascii(text, 64, "Parameter text")]);
  }

  /** The whole log so far. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [out];
    return out.slice();
  }

  private write(spec: MessageSpec, values: readonly (number | string)[]): void {
    if (values.length !== spec.format.length) throw new Error(`${spec.name} needs ${spec.format.length} values`);
    const record = new Uint8Array(recordLength(spec));
    const view = new DataView(record.buffer);
    record[0] = 0xa3;
    record[1] = 0x95;
    record[2] = spec.type;
    let offset = 3;
    [...spec.format].forEach((char, i) => {
      const value = values[i];
      if (typeof value === "string") {
        if (!"nNZ".includes(char)) throw new Error(`${spec.name} field ${i + 1} is not text`);
        for (let k = 0; k < value.length; k++) record[offset + k] = value.charCodeAt(k);
      } else {
        if (typeof value !== "number" || "nNZ".includes(char)) throw new Error(`${spec.name} field ${i + 1} is not a number`);
        const integer = (min: number, max: number) => {
          if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${spec.name} field ${i + 1} must be an integer from ${min} to ${max}`);
          return value;
        };
        switch (char) {
          case "b": view.setInt8(offset, integer(-128, 127)); break;
          case "B": view.setUint8(offset, integer(0, 255)); break;
          case "H": view.setUint16(offset, integer(0, 65535), true); break;
          case "Q": {
            const time = integer(0, MAX_TIME_US);
            view.setUint32(offset, time % 4294967296, true);
            view.setUint32(offset + 4, Math.floor(time / 4294967296), true);
            break;
          }
          case "f": view.setFloat32(offset, value, true); break;
          default: view.setFloat64(offset, value, true);
        }
      }
      offset += SIZE[char]!;
    });
    this.chunks.push(record);
    this.size += record.length;
  }
}
