// The identity a running ArduPilot reports about itself (TASK-155): its
// AUTOPILOT_VERSION, answered to MAV_CMD_REQUEST_MESSAGE. At ArduPilot
// 8ab6afde107a91df1b5f60ade8f333cb8a61b190 (GCS_Common.cpp
// send_autopilot_version, AP_FWVersionDefine.h) flight_sw_version packs
// major, minor, patch and the FIRMWARE_VERSION_TYPE from the high byte down,
// and flight_custom_version holds the first 8 characters of the source's git
// hash (GIT_VERSION), all zero in a build made without git. That hash names
// the source commit only: a binary built from a changed working tree reports
// the same hash. Cold path: once per connection.
import type { MavFrame } from "@mirage/mavlink/codec";
import { fieldOf, readNumber } from "@mirage/mavlink/messages";

/** MAVLink AUTOPILOT_VERSION. */
export const AUTOPILOT_VERSION = 148;
/** FIRMWARE_VERSION_TYPE (common.xml) as ArduPilot's version strings spell it. */
const VERSION_TYPES: ReadonlyMap<number, string> = new Map([[0, "dev"], [64, "alpha"], [128, "beta"], [192, "rc"], [255, "official"]]);

function layout(name: string, type: string, count = 0) {
  const field = fieldOf(AUTOPILOT_VERSION, name);
  if (!field || field.type !== type || field.count !== count) throw new Error(`MAVLink table changed ${AUTOPILOT_VERSION}.${name}`);
  return field;
}
const SOFTWARE = layout("flight_sw_version", "uint32_t"), CUSTOM = layout("flight_custom_version", "uint8_t", 8);

export interface ReportedVersion {
  /** major.minor.patch, with the release type unless it is official (for example "4.7.0-dev"). */
  readonly firmwareVersion: string;
  /** The 8 lowercase hexadecimal characters of flight_custom_version, or null when they are not a git hash. */
  readonly gitHash: string | null;
}

/** The version in an AUTOPILOT_VERSION frame; null for any other message. */
export function readAutopilotVersion(frame: MavFrame): ReportedVersion | null {
  if (frame.id !== AUTOPILOT_VERSION) return null;
  const software = readNumber(frame.view, SOFTWARE);
  const type = software & 255;
  const release = `${software >>> 24}.${(software >>> 16) & 255}.${(software >>> 8) & 255}`;
  const typeName = VERSION_TYPES.get(type) ?? `type ${type}`;
  let hash = "";
  for (let i = 0; i < CUSTOM.count; i++) hash += String.fromCharCode(frame.payload[CUSTOM.offset + i] ?? 0);
  return { firmwareVersion: type === 255 ? release : `${release}-${typeName}`, gitHash: /^[0-9a-f]{8}$/.test(hash) ? hash : null };
}

/** The verified commit whose first 8 characters are `gitHash`, or null; a prefix shared by two commits matches neither. */
export function verifiedCommit(gitHash: string | null, commits: readonly string[]): string | null {
  if (gitHash === null) return null;
  const matches = commits.filter(commit => commit.startsWith(gitHash));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
