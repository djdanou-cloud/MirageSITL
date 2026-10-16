import { useMemo, useState } from "react";
import type { SnapshotReplay } from "@mirage/aar/replay";
import { AarRecord } from "@mirage/aar/record";
import { responseSeries, seriesPath } from "./series";
export function Review({ replay }: { replay: SnapshotReplay }) {
  const points = useMemo(() => responseSeries(replay), [replay]),
    epochs = useMemo(() => [...new Set(points.map((p) => p.epoch))], [points]);
  const [selected, setSelected] = useState<number | null>(null),
    [seek, setSeek] = useState(0);
  const epoch =
    selected !== null && epochs.includes(selected)
      ? selected
      : (epochs[0] ?? 0);
  const epochPoints = points.filter((p) => p.epoch === epoch),
    end = epochPoints[epochPoints.length - 1]?.timeS ?? 0,
    record = new AarRecord();
  const index = replay.seek(epoch, Math.min(seek, end), record);
  return (
    <section
      aria-label="After-action review"
      className="control-section aar-review"
    >
      <h2>After-action review</h2>
      <p>
        Recorded snapshots · {replay.manifest.source} · pilot roll / actuator 1
        / roll rate (rad/s). Missing streams and gaps stay disconnected.
      </p>
      <label>
        Replay epoch
        <select
          aria-label="Replay epoch"
          value={epoch}
          onChange={(e) => {
            setSelected(Number(e.target.value));
            setSeek(0);
          }}
        >
          {epochs.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
      </label>
      <label>
        Replay time (s)
        <input
          aria-label="Replay time"
          type="range"
          min={0}
          max={end || 0.001}
          step={0.01}
          value={Math.min(seek, end)}
          onChange={(e) => setSeek(Number(e.target.value))}
        />
      </label>
      <output data-testid="replay-snapshot">
        {index < 0
          ? "No snapshot at this time"
          : `Snapshot ${index} · epoch ${record.state.epoch} · ${record.state.simTimeS.toFixed(2)} s · N ${record.state.northM.toFixed(2)} m`}
      </output>
      <svg
        viewBox="0 0 600 100"
        role="img"
        aria-label="Pilot roll, actuator 1 and roll rate versus simulation seconds"
      >
        <path className="chart-pilot" d={seriesPath(points, "pilot", epoch)} />
        <path
          className="chart-actuator"
          d={seriesPath(points, "actuator", epoch)}
        />
        <path
          className="chart-response"
          d={seriesPath(points, "responseRadS", epoch)}
        />
      </svg>
      <p className="chart-legend">
        Cyan: pilot [-1,1] · amber: actuator [-1,1] · green: response rad/s
        (display ±2)
      </p>
      <span data-testid="aar-point-count">
        {points.length} points · {replay.count} records · maximum 10000
      </span>
    </section>
  );
}
