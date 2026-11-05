// The MAVLink mission protocol for a flight task's route (TASK-172): a route as
// mission items, and the upload ArduPilot answers item by item. MISSION_COUNT
// starts it, ArduPilot asks for each item with MISSION_REQUEST_INT (or the older
// MISSION_REQUEST), and MISSION_ACK ends it, so a route counts as uploaded only
// on ArduPilot's own acceptance. Cold path. Numbers are those of the pinned
// common.xml; ArduPilot's seq 0 is its home slot, which an upload fills and it
// ignores, so a route's items start at seq 1.
import type { MavFrame } from "@mirage/mavlink/codec";
import { fieldOf, readNumber } from "@mirage/mavlink/messages";
import type { RoutePoint } from "../../scenarios/src/flight-tasks.ts";

const MAV_CMD_NAV_WAYPOINT = 16, MAV_CMD_DO_CHANGE_SPEED = 178;
const MAV_FRAME_GLOBAL = 0, MAV_FRAME_MISSION = 2, MAV_FRAME_GLOBAL_RELATIVE_ALT = 3;
/** SPEED_TYPE_GROUNDSPEED, and -1: leave the throttle alone. */
const GROUND_SPEED = 1, THROTTLE_UNCHANGED = -1;
const MISSION_REQUEST = 40, MISSION_ITEM_REACHED = 46, MISSION_ACK = 47, MISSION_REQUEST_INT = 51;
/** MAV_MISSION_ACCEPTED, and the names of the refusals ArduPilot may send. */
const MAV_MISSION_ACCEPTED = 0;
const MISSION_RESULTS: readonly string[] = ["accepted", "error", "unsupported frame", "unsupported command", "no space", "invalid item", "invalid parameter 1", "invalid parameter 2",
  "invalid parameter 3", "invalid parameter 4", "invalid x", "invalid y", "invalid z", "invalid sequence", "denied", "operation cancelled"];
/** Metres per 1e-7 degree of latitude: ArduPilot's LOCATION_SCALING_FACTOR (AP_Common/Location.h). */
const LOCATION_SCALING_FACTOR = 0.011131884502145034;

export interface MissionItem {
  readonly seq: number;
  readonly command: number;
  readonly frame: number;
  readonly current: 0 | 1;
  readonly param1: number; readonly param2: number; readonly param3: number; readonly param4: number;
  /** Latitude and longitude, 1e-7 degrees. */
  readonly x: number; readonly y: number;
  /** Metres above home in the relative frame. */
  readonly z: number;
}

/** A point `northM` and `eastM` from `home`, as ArduPilot's Location::offset computes it, so the waypoint and the simulated GPS agree. */
export function offsetLocation(latitudeDeg: number, longitudeDeg: number, northM: number, eastM: number): { readonly latitudeE7: number; readonly longitudeE7: number } {
  const lat = Math.round(latitudeDeg * 1e7), lng = Math.round(longitudeDeg * 1e7);
  const dLat = Math.trunc(northM / LOCATION_SCALING_FACTOR);
  const scale = Math.min(1, Math.max(0.01, Math.cos(((lat + dLat / 2) * 1e-7 * Math.PI) / 180)));
  return { latitudeE7: lat + dLat, longitudeE7: lng + Math.trunc(eastM / LOCATION_SCALING_FACTOR / scale) };
}

/**
 * A route's mission: the home slot, then for each point its speed and its
 * waypoint. `home` is the session's origin, from which north and east count;
 * heights are above the rest height where it will arm.
 */
export function routeMissionItems(points: readonly RoutePoint[], home: { readonly latitudeDeg: number; readonly longitudeDeg: number }, groundAltitudeM: number): readonly MissionItem[] {
  const none = { current: 0, param1: 0, param2: 0, param3: 0, param4: 0, x: 0, y: 0, z: 0 } as const;
  const start = offsetLocation(home.latitudeDeg, home.longitudeDeg, 0, 0);
  const items: MissionItem[] = [{ ...none, seq: 0, command: MAV_CMD_NAV_WAYPOINT, frame: MAV_FRAME_GLOBAL, x: start.latitudeE7, y: start.longitudeE7 }];
  for (const point of points) {
    const at = offsetLocation(home.latitudeDeg, home.longitudeDeg, point.northM, point.eastM);
    items.push({ ...none, seq: items.length, command: MAV_CMD_DO_CHANGE_SPEED, frame: MAV_FRAME_MISSION, param1: GROUND_SPEED, param2: point.speedMps, param3: THROTTLE_UNCHANGED });
    items.push({ ...none, seq: items.length, command: MAV_CMD_NAV_WAYPOINT, frame: MAV_FRAME_GLOBAL_RELATIVE_ALT, x: at.latitudeE7, y: at.longitudeE7, z: point.altitudeM - groundAltitudeM });
  }
  return items;
}
/** The route point a reached waypoint's sequence number is, from 0: each point's waypoint follows its speed item. */
export function routePointOfSequence(seq: number): number { return seq >= 2 ? Math.floor(seq / 2) - 1 : -1; }

export interface MissionLink {
  sendCount(count: number): void;
  sendItem(item: MissionItem): void;
}
export type MissionUploadState = "idle" | "uploading" | "accepted" | "failed";
/** MISSION_COUNT repeats this often, simulated time, until ArduPilot asks for an item, at most MAX_ATTEMPTS times. */
const RETRY_S = 1, MAX_ATTEMPTS = 5;
/** Once started, ArduPilot's next request or acknowledgement is due within this, simulated time. */
const QUIET_LIMIT_S = 5;

const number = (frame: MavFrame, id: number, name: string): number => {
  const field = fieldOf(id, name);
  if (!field) throw new Error(`Message ${id} has no field ${name}`);
  return readNumber(frame.view, field);
};

/** One upload: `start`, then every frame from the autopilot and regular `tick`s. */
export class MissionUpload {
  stateValue: MissionUploadState = "idle";
  reason = "";
  /** How many items ArduPilot asked for, repeats included. */
  requests = 0;
  private attempts = 0;
  private lastSendS = 0;
  private asked = false;
  constructor(private readonly items: readonly MissionItem[], private readonly link: MissionLink) {}

  get state(): MissionUploadState { return this.stateValue; }
  start(simTimeS: number): void {
    this.stateValue = "uploading";
    this.attempts = 1;
    this.asked = false;
    this.lastSendS = simTimeS;
    this.link.sendCount(this.items.length);
  }
  tick(simTimeS: number): void {
    if (this.stateValue !== "uploading") return;
    if (this.asked) {
      if (simTimeS - this.lastSendS > QUIET_LIMIT_S) this.fail(`ArduPilot stopped asking for mission items after ${QUIET_LIMIT_S} s of simulated time`);
    } else if (simTimeS - this.lastSendS >= RETRY_S) {
      if (this.attempts >= MAX_ATTEMPTS) { this.fail(`ArduPilot did not answer MISSION_COUNT after ${MAX_ATTEMPTS} attempts`); return; }
      this.attempts++;
      this.lastSendS = simTimeS;
      this.link.sendCount(this.items.length);
    }
  }
  /** Takes the upload's messages; true when this frame was one of them. */
  frame(frame: MavFrame, simTimeS: number): boolean {
    if (this.stateValue !== "uploading") return false;
    if (frame.id === MISSION_REQUEST_INT || frame.id === MISSION_REQUEST) {
      const item = this.items[number(frame, frame.id, "seq")];
      this.asked = true;
      this.requests++;
      this.lastSendS = simTimeS;
      if (!item) this.fail(`ArduPilot asked for mission item ${number(frame, frame.id, "seq")} of ${this.items.length}`);
      else this.link.sendItem(item);
      return true;
    }
    if (frame.id === MISSION_ACK) {
      const result = number(frame, MISSION_ACK, "type");
      if (result === MAV_MISSION_ACCEPTED) this.stateValue = "accepted";
      else this.fail(`ArduPilot refused the mission: ${MISSION_RESULTS[result] ?? `result ${result}`}`);
      return true;
    }
    return false;
  }
  private fail(reason: string): void {
    this.stateValue = "failed";
    this.reason = reason;
  }
}
/** The route point a MISSION_ITEM_REACHED names, from 0, or null for any other frame or item. */
export function routePointReached(frame: MavFrame): number | null {
  if (frame.id !== MISSION_ITEM_REACHED) return null;
  const point = routePointOfSequence(number(frame, MISSION_ITEM_REACHED, "seq"));
  return point >= 0 ? point : null;
}
