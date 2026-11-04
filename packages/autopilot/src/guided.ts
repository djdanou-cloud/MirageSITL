// A flight task's commands as MAVLink (TASK-172): what FlightTaskRunner asks
// for, packed by the ground station, and ArduCopter's mode number as the
// runner's mode name. A route's upload runs through MissionUpload instead.
import { CopterMode, type GroundStation } from "./ground-station.ts";
import type { AutopilotModeName, FlightTaskCommand } from "../../scenarios/src/flight-tasks.ts";

export function autopilotModeName(mode: number | null): AutopilotModeName {
  switch (mode) {
    case CopterMode.Guided: return "guided";
    case CopterMode.Auto: return "auto";
    case CopterMode.Land: return "land";
    default: return "other";
  }
}
/** The bytes of a command into `out`, and their length; 0 for a route upload, which is not one message. */
export function taskCommandInto(command: FlightTaskCommand, gcs: GroundStation, out: Uint8Array): number {
  switch (command.kind) {
    case "set-mode": return gcs.setModeInto(command.mode === "guided" ? CopterMode.Guided : command.mode === "auto" ? CopterMode.Auto : CopterMode.Land, out);
    case "arm": return gcs.armInto(true, out);
    case "takeoff": return gcs.takeoffInto(command.heightM, out);
    case "target": return gcs.positionTargetInto(command.target, out);
    case "attitude": return gcs.attitudeTargetInto(command.target, out);
    case "upload-route": return 0;
    default: { const never: never = command; throw new Error(`Unhandled task command ${String(never)}`); }
  }
}
