import { cli, exact, finite, provenance, percentile, report, text } from "./validation/evidence.mjs";
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
  const ok = p99LatenessMs <= (v.hz === 200 ? 5 : 2.5) && v.overflow === 0 && v.lost === 0 && v.unplugActuatorsDisabled === true;
  return report("hitl-report", ok ? "PASS" : "FAIL", ok ? [] : ["Timing, loss, overflow or unplug failsafe gate failed"], { p99LatenessMs, maxActuatorDelayMs: maxDelay, count: v.samples.length });
}
cli(import.meta.url, "hitl-report", assessHitl);
