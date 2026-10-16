// HITL firmware capability gate (TASK-050). HITL is READY only when three
// independent kinds of evidence agree:
//   1. firmware source evidence that the stack consumes HIL_SENSOR/HIL_GPS and
//      emits HIL_ACTUATOR_CONTROLS (pinned commits below);
//   2. a verified board profile (board, firmware git SHA, build flags,
//      operator, evidence hash) recorded in docs/hardware/hitl-matrix.md;
//   3. live observation from that autopilot: matching firmware SHA, the HIL
//      mode flag in HEARTBEAT base_mode, and fresh HIL_ACTUATOR_CONTROLS.
// SITL availability is not evidence of HITL support and is ignored. Verdicts
// are produced only here; AutopilotSession accepts nothing else for "hitl".

/** MAV_MODE_FLAG_HIL_ENABLED (common.xml): HEARTBEAT base_mode bit 5. */
export const MAV_MODE_FLAG_HIL_ENABLED = 32;

export type FirmwareStack = "ardupilot" | "px4";

/** Source evidence at pinned commits (file SHA-256 of the files inspected). */
export const FIRMWARE_SOURCE_EVIDENCE = Object.freeze({
  ardupilot: Object.freeze({
    commit: "8ab6afde107a91df1b5f60ade8f333cb8a61b190",
    consumesHilSensor: false,
    consumesHilGps: false,
    emitsHilActuatorControls: false,
    files: Object.freeze([
      "libraries/GCS_MAVLink/GCS_Common.cpp sha256 345233ce691a29f21e66d50b81ce75db9672eb29e9d39ac2d0e9e139e92836ec",
    ]),
    finding: "No HIL_SENSOR, HIL_GPS or HIL_ACTUATOR_CONTROLS handler in GCS_Common, Copter/Plane GCS handlers, GCS.h or AP_InertialSensor; external GNSS uses GPS_INPUT. Use the JSON SITL backend instead.",
  }),
  px4: Object.freeze({
    commit: "4d7e4de77742c3ae8187ffc998ed6d04629c611b",
    consumesHilSensor: true,
    consumesHilGps: true,
    emitsHilActuatorControls: true,
    files: Object.freeze([
      "src/modules/mavlink/mavlink_receiver.cpp sha256 2e22f0d3e22a48f2793202f7e9dba3526afbb5da8221ab3a78d461008364571b",
      "src/modules/mavlink/streams/HIL_ACTUATOR_CONTROLS.hpp sha256 1ac5017c301c73801d1e8329024fb5f54183fbe58292e56ef29b2bc6b6b903b7",
    ]),
    finding: "HIL_SENSOR is decoded only while HIL mode is enabled; HIL_GPS while HIL mode is enabled or use_hil_gps is set; HIL_ACTUATOR_CONTROLS is a mavlink stream.",
  }),
});

export interface HitlBoardProfile {
  id: string;
  board: string;
  firmware: { stack: FirmwareStack; version: string; gitSha: string; buildFlags: readonly string[] };
  /** Null until a person verifies the board on hardware and records the evidence. */
  verification: { date: string; operator: string; evidenceSha256: string } | null;
}

/** Decoded from the connected autopilot (HEARTBEAT, AUTOPILOT_VERSION, HIL_ACTUATOR_CONTROLS). */
export interface HitlObservation {
  firmwareGitSha: string | null;
  heartbeatBaseMode: number | null;
  /** Age of the newest HIL_ACTUATOR_CONTROLS, ms; null if none was seen. */
  actuatorAgeMs: number | null;
}

export type HitlCapability =
  | { readonly status: "READY"; readonly profileId: string; readonly firmwareGitSha: string }
  | { readonly status: "UNSUPPORTED"; readonly reasons: readonly string[] }
  | { readonly status: "BLOCKED_EXTERNAL"; readonly requirements: readonly string[] };

const issuedReady = new WeakSet<object>();
/** True only for a READY verdict issued by evaluateHitlCapability (not a hand-made object). */
export function isIssuedHitlReady(value: unknown): boolean {
  return typeof value === "object" && value !== null && issuedReady.has(value);
}

const HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200; }

/** Validates a profile from unknown input (e.g. the matrix JSON); throws on malformed data. */
export function parseHitlProfile(value: unknown): HitlBoardProfile {
  if (typeof value !== "object" || value === null) throw new Error("Invalid HITL profile");
  const v = value as Record<string, unknown>, fw = v.firmware as Record<string, unknown> | null | undefined;
  if (!text(v.id) || !text(v.board) || typeof fw !== "object" || fw === null ||
    (fw.stack !== "ardupilot" && fw.stack !== "px4") || !text(fw.version) || typeof fw.gitSha !== "string" ||
    !HEX40.test(fw.gitSha) || !Array.isArray(fw.buildFlags) || !(fw.buildFlags as unknown[]).every(text)) {
    throw new Error("Invalid HITL profile");
  }
  let verification: HitlBoardProfile["verification"] = null;
  if (v.verification !== null) {
    const ver = v.verification as Record<string, unknown> | undefined;
    if (typeof ver !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(String(ver.date)) || !text(ver.operator) ||
      typeof ver.evidenceSha256 !== "string" || !HEX64.test(ver.evidenceSha256)) throw new Error("Invalid HITL verification");
    verification = { date: String(ver.date), operator: ver.operator, evidenceSha256: ver.evidenceSha256 };
  }
  return { id: v.id, board: v.board, firmware: { stack: fw.stack, version: fw.version, gitSha: fw.gitSha,
    buildFlags: (fw.buildFlags as string[]).slice() }, verification };
}

/**
 * Evaluates HITL availability. `sitlAvailable` is accepted only to make the
 * rule explicit: it never contributes to the verdict.
 */
export function evaluateHitlCapability(profile: HitlBoardProfile | null, observation: HitlObservation | null,
  sitlAvailable = false, maxActuatorAgeMs = 100): HitlCapability {
  void sitlAvailable;
  if (!profile) {
    return Object.freeze({ status: "BLOCKED_EXTERNAL", requirements: Object.freeze([
      "A verified board profile (board, firmware stack/version/git SHA, build flags, operator, evidence SHA-256) in docs/hardware/hitl-matrix.md",
      "Live autopilot observation: AUTOPILOT_VERSION git SHA, HEARTBEAT with MAV_MODE_FLAG_HIL_ENABLED, fresh HIL_ACTUATOR_CONTROLS",
    ]) });
  }
  const source = FIRMWARE_SOURCE_EVIDENCE[profile.firmware.stack];
  const unsupported: string[] = [];
  if (!source.consumesHilSensor) unsupported.push(`${profile.firmware.stack} at ${source.commit} does not consume HIL_SENSOR`);
  if (!source.consumesHilGps) unsupported.push(`${profile.firmware.stack} at ${source.commit} does not consume HIL_GPS`);
  if (!source.emitsHilActuatorControls) unsupported.push(`${profile.firmware.stack} at ${source.commit} does not emit HIL_ACTUATOR_CONTROLS`);
  if (unsupported.length > 0) return Object.freeze({ status: "UNSUPPORTED", reasons: Object.freeze(unsupported) });
  const blocked: string[] = [];
  if (!profile.verification) blocked.push(`Board ${profile.board} (${profile.id}) has not been verified on hardware`);
  if (!observation) {
    blocked.push("No live autopilot observation");
  } else {
    if (observation.firmwareGitSha !== profile.firmware.gitSha) {
      blocked.push(`Autopilot reports firmware ${observation.firmwareGitSha ?? "unknown"}, profile requires ${profile.firmware.gitSha}`);
    }
    if (observation.heartbeatBaseMode === null || (observation.heartbeatBaseMode & MAV_MODE_FLAG_HIL_ENABLED) === 0) {
      blocked.push("HEARTBEAT does not report MAV_MODE_FLAG_HIL_ENABLED");
    }
    if (observation.actuatorAgeMs === null || !(observation.actuatorAgeMs >= 0 && observation.actuatorAgeMs <= maxActuatorAgeMs)) {
      blocked.push(`No HIL_ACTUATOR_CONTROLS within ${maxActuatorAgeMs} ms`);
    }
  }
  if (blocked.length > 0) return Object.freeze({ status: "BLOCKED_EXTERNAL", requirements: Object.freeze(blocked) });
  const ready = Object.freeze({ status: "READY" as const, profileId: profile.id, firmwareGitSha: profile.firmware.gitSha });
  issuedReady.add(ready);
  return ready;
}
