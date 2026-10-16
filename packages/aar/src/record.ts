import {
  StateCodecV2,
  SensorFrameCodecV2,
  ActuatorFrameCodecV2,
  newFlightStateV2,
  newSensorFrameV2,
  newActuatorFrameV2,
  isValidFlightStateV2,
  type FlightStateV2,
  type SensorFrameV2,
  type ActuatorFrameV2,
} from "@mirage/protocol";
import { RECORD_BYTES, RecordFlag, recordCrc } from "./format.ts";
export class AarRecord {
  readonly bytes = new Uint8Array(RECORD_BYTES);
  readonly words = new Int32Array(this.bytes.buffer);
  readonly view = new DataView(this.bytes.buffer);
  private readonly truth = new StateCodecV2();
  private readonly sensor = new SensorFrameCodecV2();
  private readonly actuator = new ActuatorFrameCodecV2();
  readonly state = newFlightStateV2();
  readonly observation = newSensorFrameV2();
  readonly controls = newActuatorFrameV2();
  readonly pilot = new Float32Array(4);
  /** Producer fanout. Inputs are preallocated and never modified. Missing streams have zero payloads.
   * eventCode is a bounded numeric registry ID; explanatory strings stay outside the loop.
   */
  encode(
    state: FlightStateV2,
    pilot: Float64Array,
    sensor: SensorFrameV2 | null,
    actuator: ActuatorFrameV2 | null,
    eventCode = 0,
    lost = 0,
    decimated = false,
  ): boolean {
    if (
      !isValidFlightStateV2(state) ||
      pilot.length !== 4 ||
      pilot.buffer === this.bytes.buffer ||
      eventCode >>> 0 !== eventCode ||
      lost >>> 0 !== lost
    )
      return false;
    for (let i = 0; i < 4; i++)
      if (!(Math.abs(pilot[i]!) <= 1) || (i === 3 && pilot[i]! < 0))
        return false;
    if (sensor && (sensor.epoch !== state.epoch || !this.sensor.encode(sensor)))
      return false;
    if (
      actuator &&
      (actuator.epoch !== state.epoch || !this.actuator.encode(actuator))
    )
      return false;
    this.bytes.fill(0);
    const v = this.view;
    v.setUint32(0, 0x4d415252, true);
    v.setUint32(4, 1, true);
    v.setUint32(8, RECORD_BYTES, true);
    v.setUint32(12, state.epoch, true);
    v.setUint32(16, state.tickId.lo, true);
    v.setUint32(20, state.tickId.hi, true);
    v.setFloat64(24, state.simTimeS, true);
    for (let i = 0; i < 4; i++) v.setFloat32(32 + 4 * i, pilot[i]!, true);
    v.setUint32(
      48,
      RecordFlag.Truth |
        RecordFlag.Pilot |
        (sensor ? RecordFlag.Sensor : 0) |
        (actuator ? RecordFlag.Actuator : 0) |
        (eventCode ? RecordFlag.Event : 0) |
        (decimated ? RecordFlag.Decimated : 0),
      true,
    );
    v.setUint32(52, eventCode, true);
    v.setUint32(56, lost, true);
    this.truth.words[0] = 0;
    this.truth.pack(state);
    for (let i = 0; i < 48; i++) this.words[16 + i] = this.truth.words[i]!;
    if (sensor)
      for (let i = 0; i < 32; i++) this.words[64 + i] = this.sensor.words[i]!;
    if (actuator)
      for (let i = 0; i < 32; i++) this.words[96 + i] = this.actuator.words[i]!;
    v.setUint32(60, recordCrc(this.bytes), true);
    return true;
  }
  decode(): boolean {
    const v = this.view,
      flags = v.getUint32(48, true);
    if (
      v.getUint32(0, true) !== 0x4d415252 ||
      v.getUint32(4, true) !== 1 ||
      v.getUint32(8, true) !== RECORD_BYTES ||
      (flags & ~63) !== 0 ||
      (flags & 3) !== 3 ||
      v.getUint32(60, true) !== recordCrc(this.bytes) ||
      Boolean(flags & 16) !== Boolean(v.getUint32(52, true))
    )
      return false;
    for (let i = 0; i < 48; i++) this.truth.words[i] = this.words[16 + i]!;
    this.truth.unpack(this.state);
    if (
      !isValidFlightStateV2(this.state) ||
      this.words[16] !== 0 ||
      this.words[63] !== 0 ||
      this.state.epoch !== v.getUint32(12, true) ||
      this.state.tickId.lo !== v.getUint32(16, true) ||
      this.state.tickId.hi !== v.getUint32(20, true) ||
      this.state.simTimeS !== v.getFloat64(24, true) ||
      this.state.simTimeS < 0
    )
      return false;
    for (let i = 0; i < 4; i++) {
      this.pilot[i] = v.getFloat32(32 + 4 * i, true);
      if (!(Math.abs(this.pilot[i]!) <= 1) || (i === 3 && this.pilot[i]! < 0))
        return false;
    }
    for (let i = 0; i < 32; i++) {
      if (
        (!(flags & 4) && this.words[64 + i] !== 0) ||
        (!(flags & 8) && this.words[96 + i] !== 0)
      )
        return false;
      this.sensor.words[i] = this.words[64 + i]!;
      this.actuator.words[i] = this.words[96 + i]!;
    }
    if (
      flags & 4 &&
      (!this.sensor.decode(this.observation) ||
        this.observation.epoch !== this.state.epoch)
    )
      return false;
    if (
      flags & 8 &&
      (!this.actuator.decode(this.controls) ||
        this.controls.epoch !== this.state.epoch)
    )
      return false;
    return true;
  }
}
