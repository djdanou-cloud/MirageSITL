import { useEffect, useState, type RefObject } from "react";
import type { SimulationRuntime } from "../runtime";

// Flight telemetry next to the flight view (TASK-185): the physics session's
// latest state at display rate (every 250 ms), never per physics step. Truth
// of the simulated aircraft, not the autopilot's estimate.

export interface FlightValues {
  readonly altitudeM: number; readonly groundSpeedMps: number; readonly verticalSpeedMps: number;
  readonly rollDeg: number; readonly pitchDeg: number; readonly headingDeg: number; readonly simTimeS: number;
}

/** Altitude above the pad, speeds and Euler angles (ZYX, degrees at this UI boundary) from a NED state with a body-to-NED quaternion. */
export function flightValues(s: { downM: number; vnMps: number; veMps: number; vdMps: number; qw: number; qx: number; qy: number; qz: number;
  simTimeS: number }): FlightValues {
  const { qw: w, qx: x, qy: y, qz: z } = s;
  const degrees = 180 / Math.PI;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { altitudeM: -s.downM, groundSpeedMps: Math.hypot(s.vnMps, s.veMps), verticalSpeedMps: -s.vdMps, rollDeg: roll * degrees,
    pitchDeg: pitch * degrees, headingDeg: (yaw * degrees + 360) % 360, simTimeS: s.simTimeS };
}

export function FlightTelemetry({ runtime, refreshMs = 250 }: { runtime: RefObject<SimulationRuntime | null>; refreshMs?: number }) {
  const [values, setValues] = useState<FlightValues | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const sim = runtime.current;
      setValues(sim ? flightValues(sim.current) : null);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [runtime, refreshMs]);
  const v = values;
  const shown = (value: number | undefined, digits: number, unit: string) => (value === undefined ? "—" : `${value.toFixed(digits)} ${unit}`);
  return (
    <section className="flight-telemetry" aria-labelledby="flight-telemetry-heading" data-testid="flight-telemetry">
      <h4 id="flight-telemetry-heading">Flight</h4>
      <dl>
        <dt>Altitude above the pad</dt><dd data-testid="flight-altitude">{shown(v?.altitudeM, 2, "m")}</dd>
        <dt>Ground speed</dt><dd data-testid="flight-ground-speed">{shown(v?.groundSpeedMps, 2, "m/s")}</dd>
        <dt>Vertical speed</dt><dd data-testid="flight-vertical-speed">{shown(v?.verticalSpeedMps, 2, "m/s")}</dd>
        <dt>Roll, pitch</dt><dd data-testid="flight-attitude">{v ? `${v.rollDeg.toFixed(1)}°, ${v.pitchDeg.toFixed(1)}°` : "—"}</dd>
        <dt>Heading</dt><dd data-testid="flight-heading">{shown(v?.headingDeg, 0, "°")}</dd>
      </dl>
    </section>
  );
}
