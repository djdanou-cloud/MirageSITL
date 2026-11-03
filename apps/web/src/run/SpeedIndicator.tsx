import { INTERVAL_S, REAL_TIME_MIN_RATIO, WINDOW_S, type RunSpeedView } from "./run-speed";

// The measured run speed (TASK-175, decision A-05). The numbers are the
// meter's: simulated over running wall time over the last WINDOW_S and over
// the whole run. A real-time run is called real time only while it averages
// at least REAL_TIME_MIN_RATIO, and each dropped interval is listed; an
// accelerated run promises no factor, it reports what the host reached. The
// SITL's start-up before its first heartbeat is shown on its own.

const ratio = (value: number | null) => value === null ? "not measured yet" : `${value.toFixed(3)}×`;

/** The verdict line: what the run's pace is called. */
export function speedVerdict(speed: RunSpeedView): string {
  switch (speed.mode) {
    case "real-time":
      if (speed.realTime === null) return "Real time requested; measuring";
      return speed.realTime ? "Real time" : `Behind real time: it averages ${ratio(speed.averageSpeed)}, below the ${REAL_TIME_MIN_RATIO}× a real-time run needs`;
    case "capped": return `Accelerated, at most ${speed.requestedSpeedup ?? "?"}× real time; the pace is what this computer reaches`;
    case "as-fast-as-possible": return "As fast as possible: the pace is what this computer reaches";
    case "external": return "Set by your SITL's own --speedup";
    default: { const never: never = speed.mode; return never; }
  }
}

export function SpeedIndicator({ speed }: { speed: RunSpeedView }) {
  const dropped = speed.dropped;
  return (
    <>
      <dt>Run speed</dt>
      <dd data-testid="sitl-speed" data-mode={speed.mode} data-real-time={speed.realTime === null ? "unknown" : String(speed.realTime)}
        data-window={speed.windowSpeed ?? ""} data-average={speed.averageSpeed ?? ""} data-sim-elapsed={speed.simElapsedS} data-running-wall={speed.runningWallS}>
        <span data-testid="sitl-speed-verdict">{speedVerdict(speed)}</span>
        {`. ${ratio(speed.windowSpeed)} over the last ${WINDOW_S} s, ${ratio(speed.averageSpeed)} on average (${speed.simElapsedS.toFixed(1)} s simulated in ${speed.runningWallS.toFixed(1)} s of running wall time).`}
        {speed.startup && (
          <span data-testid="sitl-startup">
            {` SITL start-up before the autopilot's first heartbeat, not judged: ${speed.startup.simS.toFixed(2)} s simulated in ${speed.startup.wallS.toFixed(1)} s.`}
          </span>
        )}
        {speed.mode === "real-time" && (
          <span data-testid="sitl-dropped" data-count={dropped.length}>
            {` Dropped intervals: ${dropped.length} of ${speed.intervals}.`}
          </span>
        )}
        {dropped.length > 0 && (
          <details>
            <summary>Dropped intervals of {INTERVAL_S} s</summary>
            <ul data-testid="sitl-dropped-list">
              {dropped.map(d => (
                <li key={d.index}>{`From ${d.startWallS.toFixed(0)} s of running wall time (simulated ${d.startSimS.toFixed(2)} s): ${d.simAdvancedS.toFixed(3)} s simulated`}</li>
              ))}
            </ul>
          </details>
        )}
      </dd>
    </>
  );
}
