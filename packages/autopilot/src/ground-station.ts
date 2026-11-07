// Ground-station commands for an integrated SITL session (TASK-153): the
// application's own MAVLink2 heartbeat and COMMAND_LONG requests, and the
// parameter requests of the TASK-154 read-back and the TASK-159 parameter
// service, packed with the TASK-150
// codec. Cold path: one call per user action or per second, never inside the
// physics step. Command and mode numbers are those of the pinned
// ardupilotmega.xml/common.xml (MAVLink 2e2b6af99084e4fde9bb304c84bb9253a1a98b6f)
// and of ArduCopter's mode table at fb773567896014da007bca58358704d4a0d8516f
// (ArduCopter/mode.h).
import { encodeInto } from "@mirage/mavlink/codec";
import { packInto } from "@mirage/mavlink/messages";
import { RcOverride } from "@mirage/mavlink/rc-override";
import type { AttitudeTarget, GuidedTarget } from "../../scenarios/src/flight-tasks.ts";
import type { MissionItem } from "./mission.ts";

export const MavCommand = {
  NavTakeoff: 22, NavLand: 21, DoSetMode: 176, DoMotorTest: 209, ComponentArmDisarm: 400, SetMessageInterval: 511, RequestMessage: 512,
} as const;
/** MOTOR_TEST_THROTTLE_TYPE (common.xml): a raw PWM value, which ArduCopter accepts without the RC calibration check (motor_test.cpp). */
const MOTOR_TEST_THROTTLE_PWM = 1;
/** ArduCopter custom modes (ArduCopter/mode.h, enum class Mode::Number). */
export const CopterMode = { Stabilize: 0, AltHold: 2, Auto: 3, Guided: 4, Loiter: 5, Land: 9 } as const;
/** MAV_MODE_FLAG_CUSTOM_MODE_ENABLED. */
const CUSTOM_MODE_ENABLED = 1;
/** MAVLink message IDs. */
const HEARTBEAT = 0, PARAM_REQUEST_READ = 20, PARAM_REQUEST_LIST = 21, PARAM_SET = 23, MISSION_COUNT = 44, RC_CHANNELS_OVERRIDE = 70, MISSION_ITEM_INT = 73, COMMAND_LONG = 76, SET_ATTITUDE_TARGET = 82, SET_POSITION_TARGET_LOCAL_NED = 84;
/** ATTITUDE_TARGET_TYPEMASK: all three body rates ignored, the attitude and the thrust field used. */
const ATTITUDE_ONLY = 7;
/** SET_ATTITUDE_TARGET's thrust field while GUID_OPTIONS bit 3 is clear: a climb rate, where exactly 0.5 is none (GCS_MAVLink_Copter.cpp). */
const HOLD_HEIGHT = 0.5;
/** MAV_FRAME_LOCAL_NED; the acceleration fields of SET_POSITION_TARGET_LOCAL_NED ignored (POSITION_TARGET_TYPEMASK_AX, AY and AZ_IGNORE). */
const FRAME_LOCAL_NED = 1, USE_EVERY_FIELD = 0;
/** An ArduPilot parameter name: 1 to 16 (AP_MAX_NAME_SIZE) printable ASCII characters, no space. */
const PARAMETER_NAME = /^[\x21-\x7e]{1,16}$/;
/** MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID, MAV_STATE_ACTIVE. */
const GCS_TYPE = 6, NO_AUTOPILOT = 8, ACTIVE = 4;

export class GroundStation {
  private sequence = 0;
  private readonly heartbeatPayload = new Uint8Array(9);
  private readonly commandPayload = new Uint8Array(33);
  private readonly listPayload = new Uint8Array(2);
  private readonly readPayload = new Uint8Array(20);
  private readonly setPayload = new Uint8Array(23);
  private readonly targetPayload = new Uint8Array(53);
  private readonly attitudePayload = new Uint8Array(51);
  private readonly countPayload = new Uint8Array(9);
  private readonly itemPayload = new Uint8Array(38);
  private readonly rcOverride = new RcOverride();

  /**
   * @param systemId the ground station's system ID (255, as Mission Planner and pymavlink use)
   * @param targetSystem the autopilot's system ID (SYSID_THISMAV, 1 by default)
   */
  constructor(readonly systemId = 255, readonly componentId = 190, readonly targetSystem = 1, readonly targetComponent = 1) {
    for (const id of [systemId, targetSystem]) if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error("Invalid MAVLink system ID");
    for (const id of [componentId, targetComponent]) if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error("Invalid MAVLink component ID");
  }

  /** The 1 Hz GCS heartbeat ArduPilot needs before it treats this link as a ground station (failsafe, streams). */
  heartbeatInto(out: Uint8Array): number {
    if (!packInto(HEARTBEAT, { type: GCS_TYPE, autopilot: NO_AUTOPILOT, base_mode: 0, custom_mode: 0, system_status: ACTIVE,
      mavlink_version: 3 }, this.heartbeatPayload)) return 0;
    return this.frame(HEARTBEAT, this.heartbeatPayload, out);
  }

  /** COMMAND_LONG with up to seven parameters; returns the wire length, or 0 on an invalid value. */
  commandInto(command: number, params: readonly number[], out: Uint8Array): number {
    if (params.length > 7) return 0;
    const values: Record<string, number> = { command, target_system: this.targetSystem, target_component: this.targetComponent, confirmation: 0 };
    for (let i = 0; i < 7; i++) values[`param${i + 1}`] = params[i] ?? 0;
    if (!packInto(COMMAND_LONG, values, this.commandPayload)) return 0;
    return this.frame(COMMAND_LONG, this.commandPayload, out);
  }

  setModeInto(customMode: number, out: Uint8Array): number {
    return this.commandInto(MavCommand.DoSetMode, [CUSTOM_MODE_ENABLED, customMode], out);
  }
  armInto(arm: boolean, out: Uint8Array): number {
    return this.commandInto(MavCommand.ComponentArmDisarm, [arm ? 1 : 0], out);
  }
  /** NAV_TAKEOFF to `altitudeM` above home (GUIDED mode). */
  takeoffInto(altitudeM: number, out: Uint8Array): number {
    return this.commandInto(MavCommand.NavTakeoff, [0, 0, 0, 0, 0, 0, altitudeM], out);
  }
  landInto(out: Uint8Array): number {
    return this.commandInto(MavCommand.NavLand, [], out);
  }
  /** Requests `messageId` every `intervalUs` microseconds (SET_MESSAGE_INTERVAL). */
  messageIntervalInto(messageId: number, intervalUs: number, out: Uint8Array): number {
    return this.commandInto(MavCommand.SetMessageInterval, [messageId, intervalUs], out);
  }

  /**
   * MAV_CMD_DO_MOTOR_TEST of one motor: ArduCopter spins the frame motor whose
   * test order is `testOrder` at `pwmUs` for `timeoutS` (AP_MotorsMatrix::output_test_seq).
   */
  motorTestInto(testOrder: number, pwmUs: number, timeoutS: number, out: Uint8Array): number {
    if (!Number.isInteger(testOrder) || testOrder < 1 || testOrder > 32 || !(pwmUs >= 1000 && pwmUs <= 2000) || !(timeoutS > 0 && timeoutS <= 10)) return 0;
    return this.commandInto(MavCommand.DoMotorTest, [testOrder, MOTOR_TEST_THROTTLE_PWM, pwmUs, timeoutS, 1, 0], out);
  }

  /** Requests one message by ID (MAV_CMD_REQUEST_MESSAGE), for example AUTOPILOT_VERSION (148). */
  requestMessageInto(messageId: number, out: Uint8Array): number {
    return this.commandInto(MavCommand.RequestMessage, [messageId], out);
  }

  /** PARAM_REQUEST_LIST: the autopilot answers with every parameter as PARAM_VALUE, by index. */
  paramRequestListInto(out: Uint8Array): number {
    if (!packInto(PARAM_REQUEST_LIST, { target_system: this.targetSystem, target_component: this.targetComponent }, this.listPayload)) return 0;
    return this.frame(PARAM_REQUEST_LIST, this.listPayload, out);
  }
  /**
   * PARAM_REQUEST_READ of one parameter by name (param_index -1); returns 0 for
   * a name that is not 1 to 16 printable ASCII characters. A control character
   * is refused because a NUL would cut the name short on the wire and so read
   * another parameter.
   */
  paramRequestReadInto(name: string, out: Uint8Array): number {
    if (!PARAMETER_NAME.test(name)) return 0;
    if (!packInto(PARAM_REQUEST_READ, { target_system: this.targetSystem, target_component: this.targetComponent, param_id: name,
      param_index: -1 }, this.readPayload)) return 0;
    return this.frame(PARAM_REQUEST_READ, this.readPayload, out);
  }

  /**
   * PARAM_REQUEST_READ of the list entry at `index` (param_id empty), which
   * ArduPilot answers with that entry's PARAM_VALUE and index; returns 0 for
   * an index outside 0..32767 (param_index is int16 on the wire).
   */
  paramRequestReadIndexInto(index: number, out: Uint8Array): number {
    if (!Number.isInteger(index) || index < 0 || index > 32767) return 0;
    if (!packInto(PARAM_REQUEST_READ, { target_system: this.targetSystem, target_component: this.targetComponent, param_id: "",
      param_index: index }, this.readPayload)) return 0;
    return this.frame(PARAM_REQUEST_READ, this.readPayload, out);
  }
  /**
   * PARAM_SET of one parameter: `value` is sent as its float32 with the
   * MAV_PARAM_TYPE the autopilot reported for it. Returns 0 for an invalid
   * name (as paramRequestReadInto), a type outside 1..10 or a value that is
   * not finite as a float32.
   */
  paramSetInto(name: string, value: number, paramType: number, out: Uint8Array): number {
    if (!PARAMETER_NAME.test(name) || !Number.isInteger(paramType) || paramType < 1 || paramType > 10) return 0;
    if (!packInto(PARAM_SET, { target_system: this.targetSystem, target_component: this.targetComponent, param_id: name,
      param_value: value, param_type: paramType }, this.setPayload)) return 0;
    return this.frame(PARAM_SET, this.setPayload, out);
  }

  /**
   * SET_POSITION_TARGET_LOCAL_NED (TASK-172): a position in ArduPilot's own
   * frame, its velocity and acceleration as feed-forward, and a yaw with its
   * rate. ArduCopter takes it in GUIDED, carries it forward with those between
   * messages, and holds position when it stops coming (GUID_TIMEOUT).
   */
  positionTargetInto(target: GuidedTarget, out: Uint8Array): number {
    if (!packInto(SET_POSITION_TARGET_LOCAL_NED, { time_boot_ms: 0, x: target.northM, y: target.eastM, z: target.downM, vx: target.northMps, vy: target.eastMps, vz: target.downMps,
      afx: target.northMps2, afy: target.eastMps2, afz: target.downMps2, yaw: target.yawRad, yaw_rate: target.yawRateRadS, type_mask: USE_EVERY_FIELD,
      target_system: this.targetSystem, target_component: this.targetComponent, coordinate_frame: FRAME_LOCAL_NED }, this.targetPayload)) return 0;
    return this.frame(SET_POSITION_TARGET_LOCAL_NED, this.targetPayload, out);
  }
  /**
   * SET_ATTITUDE_TARGET (TASK-173): an attitude to hold in GUIDED, with the height held where it is. ArduPilot shapes the change
   * within its own limits, and levels the aircraft if it stops coming (GUID_TIMEOUT). The quaternion is Quaternion::from_euler's.
   */
  attitudeTargetInto(target: AttitudeTarget, out: Uint8Array): number {
    const cr = Math.cos(target.rollRad / 2), sr = Math.sin(target.rollRad / 2), cp = Math.cos(target.pitchRad / 2), sp = Math.sin(target.pitchRad / 2), cy = Math.cos(target.yawRad / 2), sy = Math.sin(target.yawRad / 2);
    const q = [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
    if (!packInto(SET_ATTITUDE_TARGET, { time_boot_ms: 0, q, body_roll_rate: 0, body_pitch_rate: 0, body_yaw_rate: 0, thrust: HOLD_HEIGHT, target_system: this.targetSystem,
      target_component: this.targetComponent, type_mask: ATTITUDE_ONLY }, this.attitudePayload)) return 0;
    return this.frame(SET_ATTITUDE_TARGET, this.attitudePayload, out);
  }
  /** MISSION_COUNT of a waypoint mission (TASK-172), which starts an upload. */
  missionCountInto(count: number, out: Uint8Array): number {
    if (!packInto(MISSION_COUNT, { count, target_system: this.targetSystem, target_component: this.targetComponent, mission_type: 0, opaque_id: 0 }, this.countPayload)) return 0;
    return this.frame(MISSION_COUNT, this.countPayload, out);
  }
  /** MISSION_ITEM_INT of a waypoint mission (TASK-172), as ArduPilot asked for it. */
  missionItemInto(item: MissionItem, out: Uint8Array): number {
    if (!packInto(MISSION_ITEM_INT, { param1: item.param1, param2: item.param2, param3: item.param3, param4: item.param4, x: item.x, y: item.y, z: item.z, seq: item.seq,
      command: item.command, target_system: this.targetSystem, target_component: this.targetComponent, frame: item.frame, current: item.current, autocontinue: 1,
      mission_type: 0 }, this.itemPayload)) return 0;
    return this.frame(MISSION_ITEM_INT, this.itemPayload, out);
  }

  /**
   * RC_CHANNELS_OVERRIDE of 18 channels (TASK-174): PWM 800..2200 us, or the
   * TASK-038 sentinels (65535 ignore; 0 release for channels 1-8, 65534 for
   * 9-18). Returns 0 for a value outside them.
   */
  rcOverrideInto(channels: Uint16Array, out: Uint8Array): number {
    if (!this.rcOverride.into(channels, this.targetSystem, this.targetComponent)) return 0;
    return this.frame(RC_CHANNELS_OVERRIDE, this.rcOverride.payload, out);
  }

  private frame(id: number, payload: Uint8Array, out: Uint8Array): number {
    const n = encodeInto(id, payload, this.sequence, this.systemId, this.componentId, out);
    if (n > 0) this.sequence = (this.sequence + 1) & 255;
    return n;
  }
}
