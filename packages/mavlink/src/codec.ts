/** Pinned common/ardupilotmega-dialect subset. No signing keys: signed frames fail closed. */
export interface MessageDefinition {
  readonly id: number;
  readonly name: string;
  readonly crcExtra: number;
  readonly length: number;
}
const RC = Object.freeze({
  id: 70,
  name: "RC_CHANNELS_OVERRIDE",
  crcExtra: 124,
  length: 38,
});
const ACTUATOR = Object.freeze({
  id: 93,
  name: "HIL_ACTUATOR_CONTROLS",
  crcExtra: 47,
  length: 81,
});
const SENSOR = Object.freeze({
  id: 107,
  name: "HIL_SENSOR",
  crcExtra: 108,
  length: 65,
});
const GPS = Object.freeze({
  id: 113,
  name: "HIL_GPS",
  crcExtra: 124,
  length: 39,
});
const HEARTBEAT = Object.freeze({id:0,name:"HEARTBEAT",crcExtra:50,length:9});
const EKF = Object.freeze({id:193,name:"EKF_STATUS_REPORT",crcExtra:71,length:26});
// Independent pymavlink 2.4.50 wire oracle: warmup-sensors.json.
const GPS_RAW = Object.freeze({id:24,name:"GPS_RAW_INT",crcExtra:24,length:52});
const RAW_IMU = Object.freeze({id:27,name:"RAW_IMU",crcExtra:144,length:29});
const HIGHRES_IMU = Object.freeze({id:105,name:"HIGHRES_IMU",crcExtra:93,length:63});
// Independent pymavlink 2.4.50 oracle: wasm-parameters.json.
const PARAM_READ=Object.freeze({id:20,name:'PARAM_REQUEST_READ',crcExtra:214,length:20});
const PARAM_VALUE=Object.freeze({id:22,name:'PARAM_VALUE',crcExtra:220,length:25});
const PARAM_SET=Object.freeze({id:23,name:'PARAM_SET',crcExtra:168,length:23});
export function definition(id: number): MessageDefinition | null {
  switch (id) {
    case 20:return PARAM_READ;
    case 22:return PARAM_VALUE;
    case 23:return PARAM_SET;
    case 24: return GPS_RAW;
    case 27: return RAW_IMU;
    case 105: return HIGHRES_IMU;
    case 0: return HEARTBEAT;
    case 193: return EKF;
    case 70:
      return RC;
    case 93:
      return ACTUATOR;
    case 107:
      return SENSOR;
    case 113:
      return GPS;
    default:
      return null;
  }
}
export function crcByte(crc: number, byte: number): number {
  let t = (byte ^ (crc & 255)) & 255;
  t ^= (t << 4) & 255;
  return ((crc >>> 8) ^ (t << 8) ^ (t << 3) ^ (t >>> 4)) & 65535;
}
export interface MavFrame {
  id: number;
  sequence: number;
  systemId: number;
  componentId: number;
  payload: Uint8Array;
  view: DataView;
}
export function newMavFrame(): MavFrame {
  const payload = new Uint8Array(255);
  return {
    id: 0,
    sequence: 0,
    systemId: 0,
    componentId: 0,
    payload,
    view: new DataView(payload.buffer),
  };
}
/** Caller owns payload and output; returns exact wire byte count or zero on invalid input. */
export function encodeInto(
  id: number,
  payload: Uint8Array,
  sequence: number,
  systemId: number,
  componentId: number,
  out: Uint8Array,
): number {
  const d = definition(id);
  if (
    !d ||
    payload.length !== d.length ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    sequence > 255 ||
    !Number.isInteger(systemId) ||
    systemId < 1 ||
    systemId > 255 ||
    !Number.isInteger(componentId) ||
    componentId < 0 ||
    componentId > 255 ||
    out.buffer === payload.buffer
  )
    return 0;
  let count = payload.length;
  while (count > 1 && payload[count - 1] === 0) count--;
  if (out.length < count + 12) return 0;
  out[0] = 253;
  out[1] = count;
  out[2] = out[3] = 0;
  out[4] = sequence;
  out[5] = systemId;
  out[6] = componentId;
  out[7] = id & 255;
  out[8] = (id >>> 8) & 255;
  out[9] = (id >>> 16) & 255;
  let crc = 65535;
  for (let i = 1; i < 10; i++) crc = crcByte(crc, out[i]!);
  for (let i = 0; i < count; i++) {
    out[10 + i] = payload[i]!;
    crc = crcByte(crc, payload[i]!);
  }
  crc = crcByte(crc, d.crcExtra);
  out[10 + count] = crc & 255;
  out[11 + count] = crc >>> 8;
  return count + 12;
}
/** A delivered frame is reused; consume it synchronously or copy it on the I/O thread. */
export class MavParser {
  readonly frame = newMavFrame();
  private readonly buffer = new Uint8Array(280);
  private length = 0;
  private readonly sequences = new Uint16Array(65536);
  frames = 0;
  badCrc = 0;
  unsupported = 0;
  duplicates = 0;
  outOfOrder = 0;
  sequenceGaps = 0;
  private readonly receive: (frame: MavFrame) => void;
  constructor(receive: (frame: MavFrame) => void) {
    this.receive = receive;
    this.sequences.fill(65535);
  }
  reset(): void {
    this.length = 0;
    this.sequences.fill(65535);
  }
  /** Drop an incomplete frame on link timeout; chunks themselves never imply boundaries. */
  discardPartial(): void {
    this.length = 0;
  }
  push(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.pushByte(bytes[i]!);
  }
  pushByte(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 255) return;
    if (this.length === 0 && value !== 253) return;
    this.buffer[this.length++] = value;
    this.process();
  }
  private process(): void {
    while (this.length >= 3) {
      const n = this.buffer[1]!,
        signed = (this.buffer[2]! & 1) !== 0,
        total = n + 12 + (signed ? 13 : 0);
      if (this.length < total) return;
      const id =
          this.buffer[7]! + this.buffer[8]! * 256 + this.buffer[9]! * 65536,
        d = definition(id);
      let good = false;
      if (
        !d ||
        this.buffer[2] !== 0 ||
        this.buffer[3] !== 0 ||
        n < 1 ||
        n > d.length ||
        this.buffer[5] === 0
      ) {
        this.unsupported++;
      } else {
        let crc = 65535;
        for (let i = 1; i < n + 10; i++) crc = crcByte(crc, this.buffer[i]!);
        crc = crcByte(crc, d.crcExtra);
        good = crc === (this.buffer[n + 10]! | (this.buffer[n + 11]! << 8));
        if (!good) this.badCrc++;
      }
      if (good) {
        const f = this.frame;
        f.id = id;
        f.sequence = this.buffer[4]!;
        f.systemId = this.buffer[5]!;
        f.componentId = this.buffer[6]!;
        f.payload.fill(0);
        for (let i = 0; i < n; i++) f.payload[i] = this.buffer[10 + i]!;
        const key = f.systemId * 256 + f.componentId,
          last = this.sequences[key]!;
        if (last !== 65535) {
          const delta = (f.sequence - last + 256) % 256;
          if (delta === 0) this.duplicates++;
          else if (delta > 128) this.outOfOrder++;
          else this.sequenceGaps += delta - 1;
        }
        this.sequences[key] = f.sequence;
        this.frames++;
        this.length = 0;
        this.receive(f);
        return;
      }
      // Search a bounded rejected record for the next possible frame start.
      let next = 1;
      while (next < this.length && this.buffer[next] !== 253) next++;
      this.buffer.copyWithin(0, next, this.length);
      this.length -= next;
    }
  }
}
