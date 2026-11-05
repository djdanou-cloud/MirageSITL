import { MAX_ROUTE_POINTS, MIN_ROUTE_POINTS } from "@mirage/scenarios/flight-tasks";
import { emptyRouteRow, type RouteRow } from "./flight-task-form";

// The route of a flight task (TASK-172, S10): each point's position from the
// pad, its height above the pad and the ground speed of the leg that reaches
// it. A route goes to ArduPilot as a mission, so these are the numbers
// ArduPilot receives. Points are added, removed and reordered here.

const FIELDS = [["northM", "north (m)"], ["eastM", "east (m)"], ["altitudeM", "altitude (m)"], ["speedMps", "speed (m/s)"]] as const;

export function RouteEditor({ rows, onChange }: { rows: readonly RouteRow[]; onChange: (rows: readonly RouteRow[]) => void }) {
  const set = (index: number, key: keyof RouteRow, value: string) => onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  const move = (index: number, by: number) => {
    const next = [...rows], [row] = next.splice(index, 1);
    if (row) next.splice(index + by, 0, row);
    onChange(next);
  };
  return (
    <div className="route-editor">
      <h4 id="route-heading">Route points</h4>
      <p className="hint">North and east count from the pad; altitude is above the pad; speed is the ground speed of the leg that reaches the point. A route has {MIN_ROUTE_POINTS} to {MAX_ROUTE_POINTS} points.</p>
      <table className="sensor-table" aria-labelledby="route-heading">
        <thead><tr><th scope="col">Point</th>{FIELDS.map(([key, label]) => <th key={key} scope="col">{label}</th>)}<th scope="col">Order</th></tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} data-testid={`route-point-${index + 1}`}>
              <th scope="row">{index + 1}</th>
              {FIELDS.map(([key, label]) => (
                <td key={key}>
                  <input type="text" inputMode="decimal" aria-label={`Point ${index + 1} ${label}`} value={row[key]} onChange={event => set(index, key, event.target.value)} />
                </td>
              ))}
              <td>
                <button type="button" aria-label={`Move point ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>Up</button>
                <button type="button" aria-label={`Move point ${index + 1} down`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>Down</button>
                <button type="button" aria-label={`Remove point ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" disabled={rows.length >= MAX_ROUTE_POINTS} onClick={() => onChange([...rows, emptyRouteRow()])}>Add point</button>
    </div>
  );
}
