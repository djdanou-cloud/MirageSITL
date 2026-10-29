// ArduPilot JSON SITL lockstep (TASK-041), pinned to ArduPilot commit
// 8ab6afde107a91df1b5f60ade8f333cb8a61b190 libraries/SITL/SIM_JSON.{h,cpp}
// (hashes in tests/fixtures/sitl/json-protocol.json).
//
// Upstream contract:
// * SITL sends a little-endian servo packet {u16 magic, u16 frame_rate,
//   u32 frame_count, u16 pwm[16|32]} (magic 18458 for 16 channels, 29569 for 32).
// * frame_count increments only after SITL receives a valid JSON reply; an
//   unanswered frame is re-sent with the same count after ~1 s; a restarted
//   SITL begins again at 0.
// * The reply is one newline-delimited JSON object. SIM_JSON finds each key
//   with strstr, so the first occurrence of every key's text must be that key
//   (e.g. "velocity" must precede "velocity_wind"). timestamp is absolute
//   physics seconds; it must increase by less than 0.1 s per frame to advance
//   SITL time, and going backwards is treated as a physics reset.
//
// MAVLink does not replace this channel. Everything here is allocation-free
// after construction; I/O (UDP/WebSocket) belongs to the bridge.
import type { StepGate } from "@mirage/physics";

export const SERVO_MAGIC_16 = 18458;
export const SERVO_MAGIC_32 = 29569;
export const SERVO_PACKET_16_BYTES = 40;
export const SERVO_PACKET_32_BYTES = 72;
/** Upper bound of one encoded reply line. */
export const MAX_STATE_LINE_BYTES = 1024;
/** SITL ignores timestamp steps of 0.1 s or more (SIM_JSON.cpp recv_fdm). */
export const MAX_TIMESTAMP_STEP_S = 0.1;

export interface ServoFrame {
  channels: number;
  frameRateHz: number;
  frameCount: number;
  /** PWM in microseconds; entries beyond `channels` are zero. */
  readonly pwmUs: Uint16Array;
}
export function newServoFrame(): ServoFrame {
  return { channels: 0, frameRateHz: 0, frameCount: 0, pwmUs: new Uint16Array(32) };
}

/** Decodes one servo datagram; false (output untouched) on wrong size or magic. */
export function decodeServoPacketInto(bytes: Uint8Array, out: ServoFrame): boolean {
  const length = bytes.byteLength;
  if (length !== SERVO_PACKET_16_BYTES && length !== SERVO_PACKET_32_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  const magic = view.getUint16(0, true);
  const channels = magic === SERVO_MAGIC_16 ? 16 : magic === SERVO_MAGIC_32 ? 32 : 0;
  if (channels === 0 || length !== 8 + 2 * channels) return false;
  out.channels = channels;
  out.frameRateHz = view.getUint16(2, true);
  out.frameCount = view.getUint32(4, true);
  for (let i = 0; i < 32; i++) out.pwmUs[i] = i < channels ? view.getUint16(8 + 2 * i, true) : 0;
  return true;
}

export type ServoDisposition = "step" | "gap" | "duplicate" | "restart" | "stale" | "invalid";

export interface ExternalSitlOptions {
  /** 1-based servo channel per motor, in motor order (e.g. ArduCopter quad X: [1, 2, 3, 4]). */
  motorChannels: readonly number[];
  /** PWM mapped to 0 throttle; matches MOT_PWM_MIN (SITL default 1000). */
  pwmMinUs?: number;
  /** PWM mapped to full throttle; matches MOT_PWM_MAX (SITL default 2000). */
  pwmMaxUs?: number;
}

/** Physics state for one reply; vectors are length 3 (quaternion 4, w x y z body-to-NED). */
export interface SitlPhysicsState {
  timestampS: number;
  readonly gyroBodyRadS: Float64Array;
  /** Specific force (accelerometer) in body FRD, m/s^2. */
  readonly accelBodyMps2: Float64Array;
  readonly positionNedM: Float64Array;
  readonly velocityNedMps: Float64Array;
  readonly quaternionWxyz: Float64Array;
  /** NED wind, m/s; written as velocity_wind when `windValid`. */
  readonly windNedMps: Float64Array;
  windValid: boolean;
  /** Measured pack voltage and current (TASK-147); written as the battery section when `batteryValid`. */
  batteryVoltageV: number;
  batteryCurrentA: number;
  batteryValid: boolean;
}
export function newSitlPhysicsState(): SitlPhysicsState {
  return { timestampS: 0, gyroBodyRadS: new Float64Array(3), accelBodyMps2: new Float64Array(3),
    positionNedM: new Float64Array(3), velocityNedMps: new Float64Array(3),
    quaternionWxyz: new Float64Array([1, 0, 0, 0]), windNedMps: new Float64Array(3), windValid: false,
    batteryVoltageV: 0, batteryCurrentA: 0, batteryValid: false };
}

export interface ExternalSitlStats {
  steps: number; duplicates: number; gaps: number; droppedFrames: number;
  restarts: number; stale: number; invalid: number; repliesResent: number; clampedPwm: number;
}

const ENC_LIMIT = 1e6;
const SCALE = 1e9; // nine decimals: |v| <= 1e6 keeps v * SCALE below 2^53
const ASCII = (text: string): Uint8Array => new TextEncoder().encode(text);
const KEY = {
  open: ASCII('\n{"timestamp":'), gyro: ASCII(',"imu":{"gyro":['), accel: ASCII('],"accel_body":['),
  position: ASCII(']},"position":['), velocity: ASCII('],"velocity":['), quaternion: ASCII('],"quaternion":['),
  wind: ASCII('],"velocity_wind":['), close: ASCII("]}\n"),
  // SIM_JSON finds "battery" and then each key after it; neither text occurs earlier in the line.
  battery: ASCII('],"battery":{"voltage":'), current: ASCII(',"current":'), batteryClose: ASCII("}}\n"),
};

/**
 * Lockstep between one external ArduPilot SITL and the physics loop. Each new
 * frame_count authorizes exactly one physics tick; resends, reordered or
 * stale datagrams never step twice. While no frame is pending, ready() is
 * false and the caller keeps servicing commands (pause stays responsive).
 */
export class ExternalSitlLockstep implements StepGate {
  readonly stats: ExternalSitlStats = { steps: 0, duplicates: 0, gaps: 0, droppedFrames: 0, restarts: 0,
    stale: 0, invalid: 0, repliesResent: 0, clampedPwm: 0 };
  private readonly frame = newServoFrame();
  private readonly motorChannels: Int32Array;
  private readonly pwmMinUs: number;
  private readonly pwmSpanUs: number;
  private readonly pending = new Uint16Array(32);
  private hasPending = false;
  private lastFrame = -1;
  private replyFrame = -1;
  private readonly reply = new Uint8Array(MAX_STATE_LINE_BYTES);
  private replyLength = 0;
  private lastTimestampS = -Infinity;
  /** Set by receive() when SITL restarted; the owner resets the vehicle and clears it. */
  restartRequested = false;

  constructor(options: ExternalSitlOptions) {
    const min = options.pwmMinUs ?? 1000, max = options.pwmMaxUs ?? 2000;
    if (options.motorChannels.length < 1 || options.motorChannels.length > 32 ||
      !options.motorChannels.every(c => Number.isInteger(c) && c >= 1 && c <= 32) ||
      new Set(options.motorChannels).size !== options.motorChannels.length ||
      !Number.isInteger(min) || !Number.isInteger(max) || min < 800 || max > 2200 || max - min < 100) {
      throw new Error("Invalid external SITL servo mapping");
    }
    this.motorChannels = Int32Array.from(options.motorChannels);
    this.pwmMinUs = min;
    this.pwmSpanUs = max - min;
  }

  get motorCount(): number { return this.motorChannels.length; }
  get lastFrameCount(): number { return this.lastFrame; }

  /** Classifies one servo datagram from SITL. */
  receive(bytes: Uint8Array): ServoDisposition {
    const f = this.frame;
    if (!decodeServoPacketInto(bytes, f)) { this.stats.invalid++; return "invalid"; }
    const count = f.frameCount, last = this.lastFrame;
    if (last >= 0 && count === last) {
      this.stats.duplicates++;
      return "duplicate"; // resent: answered by resendReply(), never a second step
    }
    if (last >= 0 && count < last) {
      if (count !== 0) { this.stats.stale++; return "stale"; }
      this.stats.restarts++;
      this.restartRequested = true;
      this.lastTimestampS = -Infinity;
      this.replyFrame = -1; this.replyLength = 0;
    }
    let disposition: ServoDisposition = "step";
    if (last >= 0 && count > last + 1) {
      this.stats.gaps++;
      this.stats.droppedFrames += count - last - 1;
      disposition = "gap"; // one step only: lost frames are never replayed
    }
    if (count < last) disposition = "restart";
    this.pending.set(f.pwmUs);
    this.hasPending = true;
    this.lastFrame = count;
    return disposition;
  }

  /** StepGate: a tick may run only while an unconsumed servo frame is pending. */
  ready(): boolean { return this.hasPending; }

  /** Normalized motor throttles [0, 1] from the pending frame; consumes it (one step per frame). */
  consumeActuatorsInto(out: Float64Array): boolean {
    if (!this.hasPending || out.length < this.motorChannels.length) return false;
    for (let m = 0; m < this.motorChannels.length; m++) {
      const pwm = this.pending[(this.motorChannels[m] as number) - 1] as number; // channel validated 1..32
      let t = (pwm - this.pwmMinUs) / this.pwmSpanUs;
      if (t < 0 || t > 1) { this.stats.clampedPwm++; t = t < 0 ? 0 : 1; }
      out[m] = t;
    }
    this.hasPending = false;
    this.stats.steps++;
    return true;
  }

  /**
   * Encodes the reply for the frame just stepped and keeps a copy for
   * resends. Returns the byte length written to `out`, or 0 if the state is
   * invalid (non-finite, |value| > 1e6, zero quaternion, or a timestamp that
   * does not increase by less than 0.1 s).
   */
  completeStepInto(state: SitlPhysicsState, out: Uint8Array): number {
    const dt = state.timestampS - this.lastTimestampS;
    if (!(dt > 0) || (this.lastTimestampS > -Infinity && !(dt < MAX_TIMESTAMP_STEP_S))) return 0;
    const n = encodeStateLineInto(state, this.reply);
    if (n === 0 || out.length < n) return 0;
    out.set(this.reply.subarray(0, n));
    this.replyLength = n;
    this.replyFrame = this.lastFrame;
    this.lastTimestampS = state.timestampS;
    return n;
  }

  /** Copies the last reply for a duplicate frame; 0 if that frame has not been answered yet. */
  resendReplyInto(out: Uint8Array): number {
    if (this.replyFrame !== this.lastFrame || this.replyLength === 0 || out.length < this.replyLength) return 0;
    out.set(this.reply.subarray(0, this.replyLength));
    this.stats.repliesResent++;
    return this.replyLength;
  }

  /** Clears lockstep state after the owner reset the vehicle (e.g. on restartRequested). */
  reset(): void {
    this.hasPending = false;
    this.lastFrame = -1;
    this.replyFrame = -1;
    this.replyLength = 0;
    this.lastTimestampS = -Infinity;
    this.restartRequested = false;
  }
}

function put(out: Uint8Array, at: number, bytes: Uint8Array): number {
  if (at + bytes.length > out.length) return -1;
  out.set(bytes, at);
  return at + bytes.length;
}

/** Writes a finite |v| <= 1e6 with exactly nine decimals ("-0.000000001"); -1 on overflow. */
function writeNumber(out: Uint8Array, at: number, value: number): number {
  if (!(Math.abs(value) <= ENC_LIMIT)) return -1;
  let scaled = Math.round(Math.abs(value) * SCALE);
  let digits = 1;
  for (let probe = scaled; probe >= 10; probe = Math.floor(probe / 10)) digits++;
  if (digits < 10) digits = 10; // at least "0." plus nine decimals
  const negative = value < 0 && scaled !== 0;
  const length = digits + 1 + (negative ? 1 : 0);
  if (at + length > out.length) return -1;
  let pos = at + length - 1;
  for (let d = 0; d < digits; d++) {
    if (d === 9) out[pos--] = 46; // "."
    out[pos--] = 48 + (scaled % 10);
    scaled = Math.floor(scaled / 10);
  }
  if (negative) out[pos] = 45; // "-"
  return at + length;
}
function writeVector(out: Uint8Array, at: number, v: Float64Array, count: number, scale: number): number {
  let p = at;
  for (let i = 0; i < count && p >= 0; i++) {
    if (i > 0) { if (p >= out.length) return -1; out[p++] = 44; } // ","
    p = writeNumber(out, p, (v[i] as number) * scale); // i < count <= v.length (validated by caller)
  }
  return p;
}

/**
 * Encodes one reply line: "\n{...}\n". Key order keeps every key's first
 * textual occurrence unique for SIM_JSON's strstr parser. The quaternion is
 * normalized. Returns bytes written, or 0 on invalid input or overflow.
 */
export function encodeStateLineInto(state: SitlPhysicsState, out: Uint8Array): number {
  const q = state.quaternionWxyz;
  if (state.gyroBodyRadS.length < 3 || state.accelBodyMps2.length < 3 || state.positionNedM.length < 3 ||
    state.velocityNedMps.length < 3 || q.length < 4 || state.windNedMps.length < 3) return 0;
  const norm = Math.sqrt((q[0] as number) ** 2 + (q[1] as number) ** 2 + (q[2] as number) ** 2 + (q[3] as number) ** 2);
  if (!(norm > 1e-9) || !Number.isFinite(norm)) return 0;
  let p = put(out, 0, KEY.open);
  if (p >= 0) p = writeNumber(out, p, state.timestampS);
  if (p >= 0) p = put(out, p, KEY.gyro);
  if (p >= 0) p = writeVector(out, p, state.gyroBodyRadS, 3, 1);
  if (p >= 0) p = put(out, p, KEY.accel);
  if (p >= 0) p = writeVector(out, p, state.accelBodyMps2, 3, 1);
  if (p >= 0) p = put(out, p, KEY.position);
  if (p >= 0) p = writeVector(out, p, state.positionNedM, 3, 1);
  if (p >= 0) p = put(out, p, KEY.velocity);
  if (p >= 0) p = writeVector(out, p, state.velocityNedMps, 3, 1);
  if (p >= 0) p = put(out, p, KEY.quaternion);
  if (p >= 0) p = writeVector(out, p, q, 4, 1 / norm);
  if (p >= 0 && state.windValid) {
    p = put(out, p, KEY.wind);
    if (p >= 0) p = writeVector(out, p, state.windNedMps, 3, 1);
  }
  if (p >= 0 && state.batteryValid) {
    p = put(out, p, KEY.battery);
    if (p >= 0) p = writeNumber(out, p, state.batteryVoltageV);
    if (p >= 0) p = put(out, p, KEY.current);
    if (p >= 0) p = writeNumber(out, p, state.batteryCurrentA);
    if (p >= 0) p = put(out, p, KEY.batteryClose);
  } else if (p >= 0) p = put(out, p, KEY.close);
  return p > 0 ? p : 0;
}
