import { useEffect, useState } from "react";
import { newPowerSnapshotV1, type PowerReaderV1, type PowerSnapshotV1 } from "@mirage/protocol";
import type { LimitEvent, LimitKind, LimitQuantity } from "@mirage/physics/limit-monitor";

// TASK-146 Run-tab power panel. It reads power telemetry v1 at display rate
// and the Worker's limit events, and keeps a rating warning (physics
// unchanged) visibly apart from a limit the model applies.

const QUANTITY_TEXT: Readonly<Record<LimitQuantity, string>> = {
  "motor-current": "motor current above the motor rating",
  "motor-power": "motor power above the motor rating",
  "esc-current": "motor current above the ESC rating",
  "esc-voltage": "bus voltage above the ESC rating",
  rpm: "speed above the rating",
  "battery-voltage": "pack voltage below its empty voltage",
  "current-limit": "motor current at the drive's limit",
  "pack-current-limit": "pack current at its limit",
  "charge-limit": "regeneration into a full pack",
};
const UNIT: Readonly<Record<LimitQuantity, string>> = {
  "motor-current": "A", "motor-power": "W", "esc-current": "A", "esc-voltage": "V", rpm: "rev/min",
  "battery-voltage": "V", "current-limit": "A", "pack-current-limit": "A", "charge-limit": "",
};
const KIND_LABEL: Readonly<Record<LimitKind, string>> = { warning: "Warning", limited: "Limited" };
const MOTOR_WARNINGS: readonly (readonly [number, LimitQuantity])[] = [
  [1, "motor-current"], [2, "motor-power"], [4, "esc-current"], [8, "esc-voltage"], [16, "rpm"]];
const MOTOR_LIMITS: readonly (readonly [number, LimitQuantity])[] = [[1, "current-limit"]];
const BATTERY_WARNINGS: readonly (readonly [number, LimitQuantity])[] = [[1, "battery-voltage"]];
const BATTERY_LIMITS: readonly (readonly [number, LimitQuantity])[] = [[1, "pack-current-limit"], [2, "charge-limit"]];
/** Events kept for display. */
export const EVENT_LOG_SIZE = 50;

const QUANTITIES = new Set<string>(Object.keys(QUANTITY_TEXT));
function isQuantity(value: unknown): value is LimitQuantity {
  return typeof value === "string" && QUANTITIES.has(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteOrNaN(value: unknown): value is number {
  return typeof value === "number" && (Number.isFinite(value) || Number.isNaN(value));
}

/** Validates the Worker's `limits.events` message; null for anything else. */
export function parseLimitEventsMessage(data: unknown): { events: LimitEvent[]; dropped: number } | null {
  if (!isRecord(data) || data.type !== "limits.events" || !Array.isArray(data.events) ||
    typeof data.dropped !== "number" || !Number.isSafeInteger(data.dropped) || data.dropped < 0) return null;
  const events: LimitEvent[] = [];
  for (const e of data.events) {
    if (!isRecord(e) || typeof e.tick !== "number" || !Number.isSafeInteger(e.tick) || typeof e.simTimeS !== "number" ||
      !Number.isFinite(e.simTimeS) || !(e.subject === "battery" || (typeof e.subject === "number" && Number.isInteger(e.subject) &&
        e.subject >= 0 && e.subject < 16)) || !isQuantity(e.quantity) || (e.kind !== "warning" && e.kind !== "limited") ||
      (e.edge !== "start" && e.edge !== "end") || !finiteOrNaN(e.value) || !finiteOrNaN(e.limit)) return null;
    events.push({ tick: e.tick, simTimeS: e.simTimeS, subject: e.subject, quantity: e.quantity, kind: e.kind, edge: e.edge,
      value: e.value, limit: e.limit });
  }
  return { events, dropped: data.dropped };
}

function number(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "–";
}
/** One line for an event, e.g. "Motor 2: motor power above the motor rating, 312.4 W (rating 300 W)". */
export function describeLimitEvent(e: LimitEvent): string {
  const who = e.subject === "battery" ? "Battery" : `Motor ${e.subject + 1}`, unit = UNIT[e.quantity];
  const reference = Number.isFinite(e.limit) ? ` (${e.kind === "warning" ? "rating" : "limit"} ${number(e.limit, 2)}${unit ? ` ${unit}` : ""})` : "";
  const what = e.edge === "start" ? QUANTITY_TEXT[e.quantity] : `${QUANTITY_TEXT[e.quantity]} ended`;
  return `${who}: ${what}, ${number(e.value, 2)}${unit ? ` ${unit}` : ""}${reference}`;
}

function Badges({ warning, limited, warnings, limits }: { warning: number; limited: number;
  warnings: readonly (readonly [number, LimitQuantity])[]; limits: readonly (readonly [number, LimitQuantity])[] }) {
  const items = [
    ...limits.filter(([bit]) => (limited & bit) !== 0).map(([, q]) => ["limited", q] as const),
    ...warnings.filter(([bit]) => (warning & bit) !== 0).map(([, q]) => ["warning", q] as const),
  ];
  if (items.length === 0) return <span className="power-ok">Within ratings</span>;
  return (
    <span className="power-badges">
      {items.map(([kind, q]) => (
        <span key={`${kind}-${q}`} className={`power-badge power-${kind}`} data-kind={kind} data-quantity={q}>
          {KIND_LABEL[kind]}: {QUANTITY_TEXT[q]}
        </span>
      ))}
    </span>
  );
}

/**
 * Battery and per-motor electrical values with active warnings and limits,
 * and the most recent limit events (newest first).
 */
export function PowerPanel({ reader, events, refreshMs = 250 }: {
  reader: PowerReaderV1 | null; events: () => readonly LimitEvent[]; refreshMs?: number;
}) {
  const [view, setView] = useState<{ snapshot: PowerSnapshotV1 | null; log: readonly LimitEvent[] }>({ snapshot: null, log: [] });
  useEffect(() => {
    if (!reader) return;
    const update = () => {
      const snapshot = newPowerSnapshotV1();
      setView({ snapshot: reader.latest(snapshot) ? snapshot : null, log: events().slice(-8).reverse() });
    };
    update();
    const timer = setInterval(update, refreshMs);
    return () => clearInterval(timer);
  }, [reader, events, refreshMs]);
  const s = view.snapshot;
  return (
    <section className="power-panel" aria-labelledby="power-panel-title" data-testid="power-panel">
      <div className="panel-heading">
        <span id="power-panel-title">POWER</span>
      </div>
      <div className="control-section">
        {!s || s.motorCount === 0 ? (
          <p data-testid="power-unavailable">
            No electrical model: the active flight backend has no battery or motor drive, so there are no voltage,
            current or limit values to show.
          </p>
        ) : (
          <>
            <p className="power-legend">
              Warning: a component rating is exceeded and the simulation runs on unchanged. Limited: the model itself
              holds the value at a limit.
            </p>
            <dl className="power-battery" data-testid="power-battery">
              <div><dt>Voltage</dt><dd>{number(s.voltageV, 2)} V</dd></div>
              <div><dt>Current</dt><dd>{number(s.currentA, 1)} A</dd></div>
              <div><dt>Power</dt><dd>{number(s.powerW, 0)} W</dd></div>
              <div>
                <dt>Remaining</dt>
                <dd>{number(s.remainingAh, 3)} of {number(s.capacityAh, 2)} Ah ({number(s.stateOfCharge * 100, 1)} %)</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd><Badges warning={s.batteryWarning} limited={s.batteryLimited} warnings={BATTERY_WARNINGS} limits={BATTERY_LIMITS} /></dd>
              </div>
            </dl>
            <table className="power-motors" data-testid="power-motors">
              <caption>Motors</caption>
              <thead>
                <tr><th scope="col">Motor</th><th scope="col">Speed (rev/min)</th><th scope="col">Current (A)</th>
                  <th scope="col">Power (W)</th><th scope="col">Command (%)</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                {Array.from({ length: s.motorCount }, (_, i) => (
                  <tr key={i} data-testid={`power-motor-${i + 1}`}>
                    <th scope="row">{i + 1}</th>
                    <td>{number(s.motors[i * 5] ?? NaN, 0)}</td>
                    <td>{number(s.motors[i * 5 + 1] ?? NaN, 1)}</td>
                    <td>{number(s.motors[i * 5 + 3] ?? NaN, 0)}</td>
                    <td>{number((s.motors[i * 5 + 4] ?? NaN) * 100, 0)}</td>
                    <td><Badges warning={s.motorWarning[i] ?? 0} limited={s.motorLimited[i] ?? 0} warnings={MOTOR_WARNINGS} limits={MOTOR_LIMITS} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.droppedEvents > 0 && <p className="alert" role="status">{s.droppedEvents} limit events were dropped.</p>}
          </>
        )}
        {view.log.length > 0 && (
          <ol className="power-events" aria-label="Recent limit events" data-testid="power-events">
            {view.log.map(e => (
              <li key={`${e.tick}-${String(e.subject)}-${e.quantity}-${e.edge}`} data-kind={e.kind}>
                <span className={`power-badge power-${e.kind}`}>{KIND_LABEL[e.kind]}</span> {number(e.simTimeS, 2)} s{" "}
                {describeLimitEvent(e)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
