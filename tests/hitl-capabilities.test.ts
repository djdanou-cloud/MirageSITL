import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FIRMWARE_SOURCE_EVIDENCE,
  MAV_MODE_FLAG_HIL_ENABLED,
  evaluateHitlCapability,
  isIssuedHitlReady,
  parseHitlProfile,
  type HitlBoardProfile,
  type HitlObservation,
} from "@mirage/autopilot/hitl-capabilities";
import { AutopilotSession } from "@mirage/autopilot/state-machine";

// TASK-050. Oracle: source findings at the pinned commits recorded in
// docs/hardware/hitl-matrix.md, and the three-evidence rule stated there.
const px4Sha = "4d7e4de77742c3ae8187ffc998ed6d04629c611b";
const verified = { date: "2026-10-16", operator: "test operator", evidenceSha256: "a".repeat(64) };
const px4: HitlBoardProfile = { id: "px4-test", board: "test board", firmware: { stack: "px4", version: "test",
  gitSha: px4Sha, buildFlags: [] }, verification: verified };
const live: HitlObservation = { firmwareGitSha: px4Sha, heartbeatBaseMode: MAV_MODE_FLAG_HIL_ENABLED | 128, actuatorAgeMs: 20 };

describe("HITL capability gate", () => {
  it("is BLOCKED_EXTERNAL with exact requirements when no profile or observation exists", () => {
    const none = evaluateHitlCapability(null, null, true); // SITL being available changes nothing
    expect(none.status).toBe("BLOCKED_EXTERNAL");
    expect(none.status === "BLOCKED_EXTERNAL" && none.requirements.join(" ")).toMatch(/verified board profile.*MAV_MODE_FLAG_HIL_ENABLED/s);
    expect(isIssuedHitlReady(none)).toBe(false);
  });

  it("marks ArduPilot UNSUPPORTED from pinned source evidence, even with a verified profile and live data", () => {
    const ardupilot: HitlBoardProfile = { ...px4, id: "ap", firmware: { ...px4.firmware, stack: "ardupilot",
      gitSha: FIRMWARE_SOURCE_EVIDENCE.ardupilot.commit } };
    const verdict = evaluateHitlCapability(ardupilot, { ...live, firmwareGitSha: ardupilot.firmware.gitSha }, true);
    expect(verdict.status).toBe("UNSUPPORTED");
    expect(verdict.status === "UNSUPPORTED" && verdict.reasons).toHaveLength(3);
    expect(FIRMWARE_SOURCE_EVIDENCE.ardupilot).toMatchObject({ consumesHilSensor: false, consumesHilGps: false,
      emitsHilActuatorControls: false });
  });

  it("requires every piece of PX4 evidence before READY", () => {
    const cases: [HitlBoardProfile, HitlObservation | null, RegExp][] = [
      [{ ...px4, verification: null }, live, /not been verified on hardware/],
      [px4, null, /No live autopilot observation/],
      [px4, { ...live, firmwareGitSha: "b".repeat(40) }, /reports firmware/],
      [px4, { ...live, firmwareGitSha: null }, /reports firmware unknown/],
      [px4, { ...live, heartbeatBaseMode: 128 }, /MAV_MODE_FLAG_HIL_ENABLED/],
      [px4, { ...live, heartbeatBaseMode: null }, /MAV_MODE_FLAG_HIL_ENABLED/],
      [px4, { ...live, actuatorAgeMs: 101 }, /HIL_ACTUATOR_CONTROLS within 100 ms/],
      [px4, { ...live, actuatorAgeMs: null }, /HIL_ACTUATOR_CONTROLS/],
    ];
    for (const [profile, observation, why] of cases) {
      const verdict = evaluateHitlCapability(profile, observation, true);
      expect(verdict.status, why.source).toBe("BLOCKED_EXTERNAL");
      expect(verdict.status === "BLOCKED_EXTERNAL" && verdict.requirements.join(" "), why.source).toMatch(why);
    }
    const ready = evaluateHitlCapability(px4, live);
    expect(ready).toEqual({ status: "READY", profileId: "px4-test", firmwareGitSha: px4Sha });
    expect(isIssuedHitlReady(ready)).toBe(true);
    expect(Object.isFrozen(ready)).toBe(true);
  });

  it("lets AutopilotSession enter HITL only with an issued READY verdict", () => {
    const session = new AutopilotSession();
    expect(session.connect("hitl", 1, 0)).toBe(false);
    expect(session.connect("hitl", 1, 0, evaluateHitlCapability(null, null, true))).toBe(false);
    expect(session.connect("hitl", 1, 0, { status: "READY", profileId: "px4-test", firmwareGitSha: px4Sha })).toBe(false);
    expect(session.state).toBe("disconnected");
    expect(session.connect("external-sitl", 1, 0)).toBe(true); // SITL needs no HITL verdict
    session.disconnect();
    expect(session.connect("hitl", 1, 0, evaluateHitlCapability(px4, live))).toBe(true);
  });

  it("validates profiles from unknown input", () => {
    expect(parseHitlProfile(JSON.parse(JSON.stringify(px4)))).toEqual(px4);
    const bad: unknown[] = [null, {}, { ...px4, firmware: { ...px4.firmware, stack: "inav" } },
      { ...px4, firmware: { ...px4.firmware, gitSha: "abc" } }, { ...px4, verification: { ...verified, evidenceSha256: "x" } },
      { ...px4, verification: { ...verified, date: "yesterday" } }, { ...px4, firmware: { ...px4.firmware, buildFlags: [1] } }];
    for (const value of bad) expect(() => parseHitlProfile(value), JSON.stringify(value)).toThrow();
  });

  it("keeps the matrix document consistent with the recorded source evidence", () => {
    const matrix = readFileSync(new URL("../docs/hardware/hitl-matrix.md", import.meta.url), "utf8");
    for (const stack of ["ardupilot", "px4"] as const) {
      const evidence = FIRMWARE_SOURCE_EVIDENCE[stack];
      expect(matrix).toContain(evidence.commit);
      for (const file of evidence.files) expect(matrix).toContain(file.split(" sha256 ")[1]);
    }
    expect(matrix).toMatch(/Status: BLOCKED_EXTERNAL/);
  });
});
