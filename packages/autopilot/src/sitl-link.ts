// Browser physics as the ArduPilot JSON lockstep backend (TASK-153).
//
// SitlJsonLink sits between the launcher's WebSocket bridge (TASK-040,
// TASK-151) and one PhysicsSessionV2 in `sitl-lockstep` mode, in the thread
// that owns the session (the physics Worker in the application). Bridge
// records carry three channels: 1 MAVLink both ways, 2 JSON state lines to
// SITL, 3 servo packets from SITL. For each new servo frame the link writes
// one ActuatorFrameV2 for the session's next tick into the session's actuator
// queue; once the session has published that tick it encodes the JSON state
// line from the published state into a bridge record. A resent frame is
// answered with the stored reply and never steps again; a lost frame is
// counted and the next one steps once (ExternalSitlLockstep).
//
// After construction nothing here allocates: inbound records are copied into
// a preallocated buffer and outbound records are written into `outbound`.
// The owner sends `outbound` bytes [0, length) and forwards MAVLink bytes
// [mavlinkOffset, mavlinkOffset + mavlinkLength) of `inbound`.
import { DELIVERY_GNSS_FROZEN, DELIVERY_IMU_FROZEN, DELIVERY_MAG_FROZEN, ActuatorFlagV2, ActuatorFrameCodecV2, SpscProducer, StateReaderV2, newActuatorFrameV2, newFlightStateV2,
  type FlightStateV2 } from "@mirage/protocol";
import { ExternalSitlLockstep, MAX_STATE_LINE_BYTES, SERVO_PACKET_16_BYTES, SERVO_PACKET_32_BYTES, newSitlPhysicsState,
  type ExternalSitlStats } from "./external-sitl.ts";

/** Bridge record framing of apps/bridge/src/framing.ts: version 1, 16-byte little-endian header. */
export const BRIDGE_RECORD_VERSION = 1;
export const BRIDGE_HEADER_BYTES = 16;
export const MAX_BRIDGE_PAYLOAD_BYTES = 4096;
export const BridgeChannel = { Mavlink: 1, State: 2, Servo: 3 } as const;
/** Largest actuator channel count of an ActuatorFrameV2 (MAX_ACTUATORS). */
const ACTUATOR_SLOTS = 16;

/**
 * What one inbound record was: `step` wrote an actuator frame (call poll()
 * after pumping the session), `resend` left a stored reply in `outbound`,
 * `mavlink` left a MAVLink chunk in `inbound`, `restart` means SITL started
 * again at frame 0 (the owner starts a new epoch and calls reset()), `held`
 * means a frame arrived while the previous one was still unanswered, and
 * `dropped` covers lost, stale and invalid records and a full actuator queue.
 */
export type LinkEvent = "step" | "resend" | "mavlink" | "restart" | "held" | "dropped";

export interface SitlLinkOptions {
  /** Bridge epoch of the run (the launcher's run number). */
  readonly bridgeEpoch: number;
  /** 1-based servo channel of every rotor, in rotor order: the manifest's motorChannel + 1. */
  readonly motorChannels: readonly number[];
  /** Motor map ID the dynamics expect in actuator frames (the profile's model ID). */
  readonly motorMapId: number;
  readonly pwmMinUs?: number;
  readonly pwmMaxUs?: number;
  /**
   * The session's wind (TASK-093), read at every reply: while a weather.set is in effect its NED wind, m/s, goes to SITL
   * as velocity_wind. The object stays the same; its fields change in place.
   */
  readonly wind?: { readonly nedMps: Float64Array; readonly active: boolean };
  /**
   * What the link holds back or drops (TASK-168), read at every reply; the session's delivery object, whose mask changes in place
   * at tick boundaries. Only what is delivered changes: truth stays in the session.
   */
  readonly delivery?: {
    readonly mask: number;
    /** TASK-169: added to the north and east position and velocity ArduPilot receives, while `gnssActive`. */
    readonly gnssActive?: boolean;
    readonly gnssOffsetNedM?: Float64Array;
    readonly gnssVelocityNedMps?: Float64Array;
    /** TASK-169: the rotation of its magnetometer reading, w x y z, while `magActive`. SITL makes that reading from the attitude on this line. */
    readonly magActive?: boolean;
    readonly magRotationWxyz?: Float64Array;
  };
}

export interface SitlLinkStats {
  recordsIn: number; badRecords: number; wrongEpoch: number; queueFull: number; held: number;
  replies: number; invalidStates: number; mavlinkIn: number; mavlinkOut: number;
}

export class SitlJsonLink {
  readonly lockstep: ExternalSitlLockstep;
  readonly stats: SitlLinkStats = { recordsIn: 0, badRecords: 0, wrongEpoch: 0, queueFull: 0, held: 0, replies: 0,
    invalidStates: 0, mavlinkIn: 0, mavlinkOut: 0 };
  /** Last inbound record; MAVLink bytes are at [mavlinkOffset, mavlinkOffset + mavlinkLength). */
  readonly inbound = new Uint8Array(BRIDGE_HEADER_BYTES + MAX_BRIDGE_PAYLOAD_BYTES);
  readonly mavlinkOffset = BRIDGE_HEADER_BYTES;
  mavlinkLength = 0;
  /** The record to send after `resend` or a positive poll(). */
  readonly outbound = new Uint8Array(BRIDGE_HEADER_BYTES + MAX_STATE_LINE_BYTES);
  /** Servo frame count and simulated time of the last reply, for LiveEkfWarmup.acknowledgeJsonImu. */
  repliedFrame = -1;
  replyTimeS = -1;
  /** The session state the link read last (the stepped tick after a positive poll()); the owner reads it, never writes. */
  readonly state = newFlightStateV2();

  private readonly epoch: number;
  private readonly motorMapId: number;
  private readonly channels: Int32Array;
  private readonly actuatorCount: number;
  private readonly inboundView = new DataView(this.inbound.buffer);
  private readonly outboundView = new DataView(this.outbound.buffer);
  private readonly servo16 = this.inbound.subarray(BRIDGE_HEADER_BYTES, BRIDGE_HEADER_BYTES + SERVO_PACKET_16_BYTES);
  private readonly servo32 = this.inbound.subarray(BRIDGE_HEADER_BYTES, BRIDGE_HEADER_BYTES + SERVO_PACKET_32_BYTES);
  private readonly line = this.outbound.subarray(BRIDGE_HEADER_BYTES);
  private readonly sequence = new Uint32Array(3);
  private readonly throttles = new Float64Array(ACTUATOR_SLOTS);
  private readonly frame = newActuatorFrameV2();
  private readonly codec = new ActuatorFrameCodecV2();
  private readonly producer: SpscProducer;
  private readonly reader: StateReaderV2;
  private readonly physics = newSitlPhysicsState();
  private readonly wind: SitlLinkOptions["wind"] | null;
  private readonly delivery: SitlLinkOptions["delivery"] | null;
  /** The tick the pending actuator frame is for, while its reply is outstanding. */
  private awaitingLo = 0;
  private awaitingHi = 0;
  private awaiting = false;

  constructor(stateBuffer: SharedArrayBuffer, actuatorBuffer: SharedArrayBuffer, options: SitlLinkOptions) {
    if (options.bridgeEpoch >>> 0 !== options.bridgeEpoch || options.motorMapId >>> 0 !== options.motorMapId ||
      options.motorChannels.length > ACTUATOR_SLOTS || options.motorChannels.some(c => c > ACTUATOR_SLOTS)) {
      throw new Error("Invalid SITL link options");
    }
    this.lockstep = new ExternalSitlLockstep({ motorChannels: options.motorChannels,
      ...(options.pwmMinUs === undefined ? {} : { pwmMinUs: options.pwmMinUs }),
      ...(options.pwmMaxUs === undefined ? {} : { pwmMaxUs: options.pwmMaxUs }) });
    this.epoch = options.bridgeEpoch;
    this.motorMapId = options.motorMapId;
    this.channels = Int32Array.from(options.motorChannels);
    this.actuatorCount = Math.max(...options.motorChannels);
    this.producer = new SpscProducer(actuatorBuffer, "actuator", "sitl-would-block");
    this.reader = new StateReaderV2(stateBuffer);
    this.wind = options.wind ?? null;
    this.delivery = options.delivery ?? null;
  }

  get lockstepStats(): ExternalSitlStats { return this.lockstep.stats; }
  /** True while an actuator frame was written and its tick has not been answered. */
  get pending(): boolean { return this.awaiting; }

  /** Classifies one inbound bridge record and acts on it; see LinkEvent. */
  receive(record: Uint8Array): LinkEvent {
    this.stats.recordsIn++;
    this.mavlinkLength = 0;
    const length = record.byteLength;
    if (length < BRIDGE_HEADER_BYTES || length > this.inbound.length) { this.stats.badRecords++; return "dropped"; }
    this.inbound.set(record);
    const v = this.inboundView, channel = v.getUint8(1), payload = length - BRIDGE_HEADER_BYTES;
    if (v.getUint8(0) !== BRIDGE_RECORD_VERSION || v.getUint16(2, true) !== 0 || v.getUint32(12, true) !== payload ||
      (channel !== BridgeChannel.Mavlink && channel !== BridgeChannel.Servo)) { this.stats.badRecords++; return "dropped"; }
    if (v.getUint32(4, true) !== this.epoch) { this.stats.wrongEpoch++; return "dropped"; }
    if (channel === BridgeChannel.Mavlink) {
      this.mavlinkLength = payload;
      this.stats.mavlinkIn++;
      return "mavlink";
    }
    if (payload !== SERVO_PACKET_16_BYTES && payload !== SERVO_PACKET_32_BYTES) { this.stats.badRecords++; return "dropped"; }
    // SIM_JSON sends the next frame only after a reply. A frame that arrives while one is unanswered (a resend after
    // SITL's 1 s timeout, or an out-of-protocol frame) is left unclassified: SITL sends it again and it steps then.
    if (this.awaiting) { this.stats.held++; return "held"; }
    const disposition = this.lockstep.receive(payload === SERVO_PACKET_16_BYTES ? this.servo16 : this.servo32);
    switch (disposition) {
      case "duplicate": {
        const n = this.lockstep.resendReplyInto(this.line);
        if (n === 0) return "dropped";
        this.writeHeader(BridgeChannel.State, n);
        return "resend";
      }
      case "restart":
        this.awaiting = false;
        return "restart";
      case "step": case "gap":
        if (this.forward()) return "step";
        // Not delivered: forget the frame counter so SITL's resend of this frame steps instead of counting as a duplicate.
        this.lockstep.reset();
        return "dropped";
      case "stale": case "invalid":
        return "dropped";
      default: { const never: never = disposition; throw new Error(`Unhandled servo disposition ${String(never)}`); }
    }
  }

  /**
   * After the owner pumped the session: when the session has published the
   * tick of the pending actuator frame, writes the JSON state record into
   * `outbound` and returns its length; 0 while that tick has not run.
   */
  poll(): number {
    if (!this.awaiting || !this.reader.latest(this.state)) return 0;
    const s = this.state, t = s.tickId;
    if (t.lo !== this.awaitingLo || t.hi !== this.awaitingHi) return 0;
    this.copyState(s);
    const n = this.lockstep.completeStepInto(this.physics, this.line);
    this.awaiting = false;
    if (n === 0) { this.stats.invalidStates++; return 0; }
    this.repliedFrame = this.lockstep.lastFrameCount;
    this.replyTimeS = s.simTimeS;
    this.stats.replies++;
    return this.writeHeader(BridgeChannel.State, n);
  }

  /** Wraps one outbound MAVLink chunk (cold path: ground-station commands) into a channel 1 record. */
  mavlinkRecordInto(bytes: Uint8Array, out: Uint8Array): number {
    if (bytes.length > MAX_BRIDGE_PAYLOAD_BYTES || out.length < BRIDGE_HEADER_BYTES + bytes.length) return 0;
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    this.headerInto(v, BridgeChannel.Mavlink, bytes.length);
    out.set(bytes, BRIDGE_HEADER_BYTES);
    this.stats.mavlinkOut++;
    return BRIDGE_HEADER_BYTES + bytes.length;
  }

  /** After a SITL restart and a new session epoch: forgets the frame counter and any pending tick. */
  reset(): void {
    this.lockstep.reset();
    this.awaiting = false;
    this.repliedFrame = this.replyTimeS = -1;
  }

  /** Writes the pending servo frame as the actuator frame for the session's next tick. */
  private forward(): boolean {
    if (!this.reader.latest(this.state)) return false;
    const s = this.state, f = this.frame, out = this.throttles;
    if (!this.lockstep.consumeActuatorsInto(out)) return false;
    f.epoch = s.epoch;
    f.tickId.lo = (s.tickId.lo + 1) >>> 0;
    f.tickId.hi = f.tickId.lo === 0 ? (s.tickId.hi + 1) >>> 0 : s.tickId.hi;
    f.actuatorFlags = ActuatorFlagV2.Armed;
    f.actuatorCount = this.actuatorCount;
    f.motorMapId = this.motorMapId;
    f.normalizedActuators.fill(0);
    for (let m = 0; m < this.channels.length; m++) f.normalizedActuators[(this.channels[m] as number) - 1] = out[m] as number;
    if (!this.codec.encode(f) || this.producer.tryPush(this.codec.words) !== "ok") { this.stats.queueFull++; return false; }
    this.awaitingLo = f.tickId.lo;
    this.awaitingHi = f.tickId.hi;
    this.awaiting = true;
    return true;
  }

  private copyState(s: FlightStateV2): void {
    const p = this.physics;
    p.timestampS = s.simTimeS;
    // TASK-168: what is frozen is what `p` still holds from the last reply.
    const mask = this.delivery?.mask ?? 0;
    if ((mask & DELIVERY_IMU_FROZEN) === 0) {
      p.gyroBodyRadS[0] = s.pRadS; p.gyroBodyRadS[1] = s.qRadS; p.gyroBodyRadS[2] = s.rRadS;
      p.accelBodyMps2[0] = s.specificForceXBodyMps2; p.accelBodyMps2[1] = s.specificForceYBodyMps2; p.accelBodyMps2[2] = s.specificForceZBodyMps2;
    }
    const delivery = this.delivery, offset = delivery?.gnssOffsetNedM, velocity = delivery?.gnssVelocityNedMps;
    if ((mask & DELIVERY_GNSS_FROZEN) === 0) {
      // TASK-169: an interference offset, only on north and east: the height on this line also feeds SITL's barometer.
      if (delivery?.gnssActive === true && offset && velocity) {
        p.positionNedM[0] = s.northM + (offset[0] as number); p.positionNedM[1] = s.eastM + (offset[1] as number); // length 3
        p.velocityNedMps[0] = s.vnMps + (velocity[0] as number); p.velocityNedMps[1] = s.veMps + (velocity[1] as number);
      } else {
        p.positionNedM[0] = s.northM; p.positionNedM[1] = s.eastM;
        p.velocityNedMps[0] = s.vnMps; p.velocityNedMps[1] = s.veMps;
      }
    }
    p.positionNedM[2] = s.downM;
    p.velocityNedMps[2] = s.vdMps;
    if ((mask & DELIVERY_MAG_FROZEN) === 0) {
      const r = delivery?.magRotationWxyz;
      if (delivery?.magActive === true && r) {
        // q ⊗ conj(r): the body field SITL computes, dcmᵀ·B, becomes R·dcmᵀ·B, the reading turned by R. The IMU keys stay as they are.
        const a = r[0] as number, b = r[1] as number, c = r[2] as number, d = r[3] as number; // length 4
        p.quaternionWxyz[0] = s.qw * a + s.qx * b + s.qy * c + s.qz * d;
        p.quaternionWxyz[1] = -s.qw * b + s.qx * a - s.qy * d + s.qz * c;
        p.quaternionWxyz[2] = -s.qw * c + s.qx * d + s.qy * a - s.qz * b;
        p.quaternionWxyz[3] = -s.qw * d - s.qx * c + s.qy * b + s.qz * a;
      } else {
        p.quaternionWxyz[0] = s.qw; p.quaternionWxyz[1] = s.qx; p.quaternionWxyz[2] = s.qy; p.quaternionWxyz[3] = s.qz;
      }
    }
    // A bus-driven model publishes its pack voltage and current; a model without a bus publishes 0 V and sends none.
    p.batteryValid = s.batteryVoltage > 0;
    p.batteryVoltageV = s.batteryVoltage; p.batteryCurrentA = s.batteryCurrentA;
    // TASK-093: the weather's wind, as velocity_wind; without one the line carries no wind.
    const wind = this.wind;
    p.windValid = wind?.active === true;
    if (wind?.active === true) p.windNedMps.set(wind.nedMps);
  }

  private writeHeader(channel: number, payload: number): number {
    this.headerInto(this.outboundView, channel, payload);
    return BRIDGE_HEADER_BYTES + payload;
  }

  private headerInto(v: DataView, channel: number, payload: number): void {
    const i = channel - 1, sequence = this.sequence[i] as number; // channel is 1..3
    v.setUint8(0, BRIDGE_RECORD_VERSION); v.setUint8(1, channel); v.setUint16(2, 0, true);
    v.setUint32(4, this.epoch, true); v.setUint32(8, sequence, true); v.setUint32(12, payload, true);
    this.sequence[i] = (sequence + 1) >>> 0;
  }
}
