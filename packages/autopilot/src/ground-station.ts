// Ground-station commands for an integrated SITL session (TASK-153): the
// application's own MAVLink2 heartbeat and COMMAND_LONG requests, and the
// parameter requests of the TASK-154 read-back, packed with the TASK-150
// codec. Cold path: one call per user action or per second, never inside the
// physics step. Command and mode numbers are those of the pinned
// ardupilotmega.xml/common.xml (MAVLink 2e2b6af99084e4fde9bb304c84bb9253a1a98b6f)
// and of ArduCopter's mode table at 8ab6afde107a91df1b5f60ade8f333cb8a61b190
// (ArduCopter/mode.h).
import { encodeInto } from "@mirage/mavlink/codec";
import { packInto } from "@mirage/mavlink/messages";

export const MavCommand = {
  NavTakeoff: 22, NavLand: 21, DoSetMode: 176, ComponentArmDisarm: 400, SetMessageInterval: 511, RequestMessage: 512,
} as const;
/** ArduCopter custom modes (ArduCopter/mode.h, enum class Mode::Number). */
export const CopterMode = { Stabilize: 0, AltHold: 2, Guided: 4, Loiter: 5, Land: 9 } as const;
/** MAV_MODE_FLAG_CUSTOM_MODE_ENABLED. */
const CUSTOM_MODE_ENABLED = 1;
/** MAVLink message IDs. */
const HEARTBEAT = 0, PARAM_REQUEST_READ = 20, PARAM_REQUEST_LIST = 21, COMMAND_LONG = 76;
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

  private frame(id: number, payload: Uint8Array, out: Uint8Array): number {
    const n = encodeInto(id, payload, this.sequence, this.systemId, this.componentId, out);
    if (n > 0) this.sequence = (this.sequence + 1) & 255;
    return n;
  }
}
