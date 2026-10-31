import { definition, type MavFrame, type MessageDefinition } from "./codec.ts";
/** HIL_ACTUATOR_CONTROLS only. Actual mapping/signing/firmware admission belongs to HITL gates. */
export interface HilActuators {
  timeLoUs: number;
  timeHiUs: number;
  flagsLo: number;
  flagsHi: number;
  mode: number;
  controls: Float64Array;
}
export function actuatorInto(frame: MavFrame, out: HilActuators): boolean {
  if (
    frame.id !== 93 ||
    frame.view.byteLength < 81 ||
    out.controls.length !== 16
  )
    return false;
  const v = frame.view;
  for (let i = 0; i < 16; i++) {
    const x = v.getFloat32(16 + i * 4, true);
    if (!Number.isFinite(x) || x < -1 || x > 1) return false;
  }
  out.timeLoUs = v.getUint32(0, true);
  out.timeHiUs = v.getUint32(4, true);
  out.flagsLo = v.getUint32(8, true);
  out.flagsHi = v.getUint32(12, true);
  out.mode = v.getUint8(80);
  for (let i = 0; i < 16; i++) out.controls[i] = v.getFloat32(16 + i * 4, true);
  return true;
}

/**
 * All TASK-150 messages use the pinned XML field names and wire units.
 * Resolve field arrays once during initialization; retain them for tick use.
 * u64/i64 fields are pairs of unsigned low/high words, never BigInt or doubles.
 * Character fields are ASCII byte codes, not JavaScript strings on the hot path.
 */
export class MessagePayload {
  readonly definition: MessageDefinition;
  readonly payload: Uint8Array;
  private readonly view: DataView;
  private readonly fields = new Map<string, Float64Array>();
  private readonly slots: readonly Float64Array[];

  constructor(id: number) {
    const d = definition(id);
    if (!d) throw new RangeError("Unsupported MAVLink message ID");
    this.definition = d;
    this.payload = new Uint8Array(d.length);
    this.view = new DataView(this.payload.buffer);
    const slots: Float64Array[] = [];
    for (const field of d.fields) {
      const values = new Float64Array(field.count * (is64(field.type) ? 2 : 1));
      this.fields.set(field.name, values);
      slots.push(values);
    }
    this.slots = slots;
  }

  /** Cold lookup; keep the returned fixed-size array for repeated access. */
  field(name: string): Float64Array {
    const values = this.fields.get(name);
    if (!values) throw new RangeError("Unknown MAVLink field");
    return values;
  }

  /** Cold ASCII helper. Rejects overflow/non-ASCII instead of truncating a name. */
  setText(name: string, text: string): boolean {
    const index = this.definition.fields.findIndex((field) => field.name === name);
    const field = this.definition.fields[index];
    const out = this.slots[index];
    if (!field || field.type !== "char" || !out || text.length > out.length) return false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 32 || code > 126) return false;
    }
    out.fill(0);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return true;
  }

  /**
   * Encode into owned storage. Invalid integer/range input leaves bytes unchanged.
   * Floats preserve MAVLink NaN/Infinity sentinels; finite f32 overflow is rejected.
   */
  pack(): boolean {
    const fields = this.definition.fields;
    for (let i = 0; i < fields.length; i++) {
      // slots and fields are built together in the constructor and never resized.
      const field = fields[i]!;
      const values = this.slots[i]!;
      for (let j = 0; j < values.length; j++) {
        if (!validValue(field.type, values[j]!)) return false;
      }
    }
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const values = this.slots[i]!;
      const size = width(field.type);
      if (is64(field.type)) {
        for (let j = 0; j < field.count; j++) {
          this.view.setUint32(field.offset + j * 8, values[j * 2]!, true);
          this.view.setUint32(field.offset + j * 8 + 4, values[j * 2 + 1]!, true);
        }
      } else {
        for (let j = 0; j < field.count; j++) {
          writeValue(this.view, field.type, field.offset + j * size, values[j]!);
        }
      }
    }
    return true;
  }

  /**
   * Decode a CRC-validated, zero-padded MavParser frame into these same arrays.
   * A mismatched ID/short target leaves all fields unchanged. No unit conversions.
   */
  decode(frame: MavFrame): boolean {
    if (frame.id !== this.definition.id || frame.view.byteLength < this.definition.length) return false;
    const fields = this.definition.fields;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const out = this.slots[i]!;
      const size = width(field.type);
      if (is64(field.type)) {
        for (let j = 0; j < field.count; j++) {
          out[j * 2] = frame.view.getUint32(field.offset + j * 8, true);
          out[j * 2 + 1] = frame.view.getUint32(field.offset + j * 8 + 4, true);
        }
      } else {
        for (let j = 0; j < field.count; j++) {
          out[j] = readValue(frame.view, field.type, field.offset + j * size);
        }
      }
    }
    return true;
  }
}

function is64(type: string): boolean {
  return type === "uint64_t" || type === "int64_t";
}
function width(type: string): number {
  switch (type) {
    case "char": case "uint8_t": case "uint8_t_mavlink_version": case "int8_t": return 1;
    case "uint16_t": case "int16_t": return 2;
    case "uint32_t": case "int32_t": case "float": return 4;
    case "uint64_t": case "int64_t": case "double": return 8;
    default: throw new RangeError("Unsupported pinned MAVLink field type");
  }
}
function validValue(type: string, value: number): boolean {
  switch (type) {
    case "float": return !Number.isFinite(value) || Number.isFinite(Math.fround(value));
    case "double": return true;
    case "char": case "uint8_t": case "uint8_t_mavlink_version": return Number.isInteger(value) && value >= 0 && value <= 255;
    case "int8_t": return Number.isInteger(value) && value >= -128 && value <= 127;
    case "uint16_t": return Number.isInteger(value) && value >= 0 && value <= 65535;
    case "int16_t": return Number.isInteger(value) && value >= -32768 && value <= 32767;
    case "uint32_t": case "uint64_t": case "int64_t": return Number.isInteger(value) && value >= 0 && value <= 4294967295;
    case "int32_t": return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    default: return false;
  }
}
function writeValue(view: DataView, type: string, offset: number, value: number): void {
  switch (type) {
    case "char": case "uint8_t": case "uint8_t_mavlink_version": view.setUint8(offset, value); break;
    case "int8_t": view.setInt8(offset, value); break;
    case "uint16_t": view.setUint16(offset, value, true); break;
    case "int16_t": view.setInt16(offset, value, true); break;
    case "uint32_t": view.setUint32(offset, value, true); break;
    case "int32_t": view.setInt32(offset, value, true); break;
    case "float": view.setFloat32(offset, value, true); break;
    case "double": view.setFloat64(offset, value, true); break;
    default: throw new RangeError("Unsupported pinned MAVLink field type");
  }
}
function readValue(view: DataView, type: string, offset: number): number {
  switch (type) {
    case "char": case "uint8_t": case "uint8_t_mavlink_version": return view.getUint8(offset);
    case "int8_t": return view.getInt8(offset);
    case "uint16_t": return view.getUint16(offset, true);
    case "int16_t": return view.getInt16(offset, true);
    case "uint32_t": return view.getUint32(offset, true);
    case "int32_t": return view.getInt32(offset, true);
    case "float": return view.getFloat32(offset, true);
    case "double": return view.getFloat64(offset, true);
    default: throw new RangeError("Unsupported pinned MAVLink field type");
  }
}

/** Parameter builders are cold requests. Payload IDs and strings are checked before mutation. */
export function parameterListInto(out: MessagePayload, systemId: number, componentId: number): boolean {
  if (out.definition.id !== 21 || !targetValid(systemId, componentId)) return false;
  out.field("target_system")[0] = systemId;
  out.field("target_component")[0] = componentId;
  return out.pack();
}
export function parameterReadInto(out: MessagePayload, systemId: number, componentId: number, name: string, index = -1): boolean {
  if (out.definition.id !== 20 || !targetValid(systemId, componentId) ||
      !Number.isInteger(index) || index < -1 || index > 32767 ||
      (index === -1 && name.length === 0) || !out.setText("param_id", name)) return false;
  out.field("target_system")[0] = systemId;
  out.field("target_component")[0] = componentId;
  out.field("param_index")[0] = index;
  return out.pack();
}
/** param_value is the MAVLink float wire carrier; bytewise parameter encoding is not inferred. */
export function parameterSetInto(out: MessagePayload, systemId: number, componentId: number, name: string, value: number, type: number): boolean {
  if (out.definition.id !== 23 || !targetValid(systemId, componentId) || name.length === 0 ||
      !Number.isInteger(type) || type < 1 || type > 10 ||
      !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || !out.setText("param_id", name)) return false;
  out.field("target_system")[0] = systemId;
  out.field("target_component")[0] = componentId;
  out.field("param_value")[0] = value;
  out.field("param_type")[0] = type;
  return out.pack();
}
function targetValid(systemId: number, componentId: number): boolean {
  return Number.isInteger(systemId) && systemId >= 1 && systemId <= 255 &&
    Number.isInteger(componentId) && componentId >= 0 && componentId <= 255;
}
