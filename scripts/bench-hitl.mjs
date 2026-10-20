import { cli, exact, finite, provenance, percentile, report, text } from "./validation/evidence.mjs";
/**
 * Firmware already shown to lack HIL_SENSOR / HIL_ACTUATOR_CONTROLS.
 * A trace that names one of these builds cannot pass the physical bench.
 */
export const UNSUPPORTED_HIL_FIRMWARE = new Set([
  "fa37bf619bce116d410931f1b7d24ea72ed444ba529379df0db9738742ecb186",
  "556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38",
]);
/** Offline analysis of an operator-recorded hardware bench; does not request a Serial port. */
export function assessHitl(v) {
  exact(v, ["schemaVersion", "provenance", "board", "hz", "durationS", "samples", "overflow", "lost", "unplugActuatorsDisabled"]);
  if (v.schemaVersion !== 1 || (v.hz !== 200 && v.hz !== 400)) throw new Error("Unsupported HITL rate/version");
  provenance(v.provenance, "hardware"); text(v.board);
  finite(v.durationS, 60, 3600); finite(v.overflow, 0); finite(v.lost, 0);
  if (!Array.isArray(v.samples) || v.samples.length !== Math.floor(v.durationS * v.hz)) throw new Error("Incomplete 60-second sample stream");
  let prevActuator = -1, maxDelay = 0;
  const late = [];
  for (let i = 0; i < v.samples.length; i++) {
    const s = v.samples[i]; exact(s, ["sequence", "scheduledUs", "sentUs", "actuatorUs"]);
    if (s.sequence !== i || s.scheduledUs !== i * 1e6 / v.hz) throw new Error("HITL sequence/timestamp gap");
    finite(s.sentUs, s.scheduledUs); finite(s.actuatorUs, s.sentUs, s.sentUs + 100000);
    if (s.actuatorUs <= prevActuator) throw new Error("Actuator time reversal");
    prevActuator = s.actuatorUs; late.push((s.sentUs - s.scheduledUs) / 1000);
    maxDelay = Math.max(maxDelay, (s.actuatorUs - s.sentUs) / 1000);
  }
  const p99LatenessMs = percentile(late, .99);
  const unsupported = UNSUPPORTED_HIL_FIRMWARE.has(v.provenance.firmwareSha256);
  const timingOk = p99LatenessMs <= (v.hz === 200 ? 5 : 2.5) && v.overflow === 0 && v.lost === 0 && v.unplugActuatorsDisabled === true;
  const ok = timingOk && !unsupported;
  const reasons = [];
  if (!timingOk) reasons.push("Timing, loss, overflow or unplug failsafe gate failed");
  if (unsupported) reasons.push("Firmware has no HIL sensor/actuator path; TASK-050 keeps this build unsupported");
  return report("hitl-report", ok ? "PASS" : "FAIL", reasons, { p99LatenessMs, maxActuatorDelayMs: maxDelay, count: v.samples.length, hilFirmware: unsupported ? "unsupported" : "unlisted" });
}
cli(import.meta.url, "hitl-report", assessHitl);
