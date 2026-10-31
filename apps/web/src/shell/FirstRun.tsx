import { useState, type FormEvent } from "react";

// First-run check (TASK-152, S01/S02): connects to the local launcher
// (TASK-151) and shows each prerequisite with what is missing and how to fix
// it. The launcher token is typed or pasted here for this page only: it is
// sent in the Authorization header, never put in a URL or stored.

export const DEFAULT_LAUNCHER_PORT = 47800;
type CheckStatus = "ok" | "missing" | "failed";
interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix: string;
}
type Outcome =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "unreachable"; readonly port: number }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "checked"; readonly checks: readonly Check[] };

function isCheck(value: unknown): value is Check {
  if (typeof value !== "object" || value === null) return false;
  const status: unknown = Reflect.get(value, "status");
  return ["id", "title", "detail", "fix"].every(key => typeof Reflect.get(value, key) === "string") &&
    (status === "ok" || status === "missing" || status === "failed");
}
/** The checks of a /v1/prerequisites response, or null when it is not one. */
export function parseChecks(body: unknown): Check[] | null {
  const checks: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "checks") : null;
  if (!Array.isArray(checks)) return null;
  const list: readonly unknown[] = checks;
  return list.every(isCheck) ? [...list.filter(isCheck)] : null;
}

const STATUS_LABEL: Readonly<Record<CheckStatus, string>> = { ok: "OK", missing: "Missing", failed: "Needs attention" };

export function FirstRun() {
  const [port, setPort] = useState(String(DEFAULT_LAUNCHER_PORT));
  const [token, setToken] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const tokenValid = /^[0-9a-f]{64}$/.test(token.trim());

  const check = (event: FormEvent) => {
    event.preventDefault();
    if (!portValid || !tokenValid) return;
    setOutcome({ kind: "checking" });
    void (async () => {
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${portNumber}/v1/prerequisites`, { headers: { authorization: `Bearer ${token.trim()}` }, cache: "no-store" });
      } catch {
        setOutcome({ kind: "unreachable", port: portNumber });
        return;
      }
      if (response.status === 401) {
        setOutcome({ kind: "refused", message: "The launcher refused this token. Copy the token again from the file named token in the launcher folder; the launcher prints that file's path when it starts." });
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const checks = response.ok ? parseChecks(body) : null;
      if (!checks) {
        setOutcome({ kind: "refused", message: `The launcher answered with status ${response.status} and no prerequisite list. Restart it from this MirageSITL folder.` });
        return;
      }
      setOutcome({ kind: "checked", checks });
    })();
  };

  const attention = outcome.kind === "checked" ? outcome.checks.filter(item => item.status !== "ok").length : 0;
  return (
    <section className="project-section first-run" aria-labelledby="first-run-heading">
      <h3 id="first-run-heading">Setup: local launcher and prerequisites</h3>
      <p className="hint">
        MirageSITL starts ArduPilot SITL through the local launcher. Install with <code>node scripts/install-macos.mjs</code>, start the
        launcher with <code>npm run start -w @mirage/launcher</code>, then paste the token from the token file it names.
      </p>
      <form className="inline-form first-run-form" onSubmit={check}>
        <div className="field">
          <label htmlFor="launcher-port">Launcher port</label>
          <input id="launcher-port" type="text" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="launcher-token">Launcher token</label>
          <input id="launcher-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} />
        </div>
        <button type="submit" disabled={!portValid || !tokenValid || outcome.kind === "checking"}>Check setup</button>
      </form>
      {!portValid && <p className="form-errors">The port is a whole number from 1 to 65535.</p>}
      {token !== "" && !tokenValid && <p className="form-errors">The token is 64 characters, digits 0–9 and letters a–f.</p>}
      <div role="status" data-testid="first-run-status">
        {outcome.kind === "checking" && <p>Checking…</p>}
        {outcome.kind === "unreachable" && (
          <p className="form-errors">
            No launcher answered on 127.0.0.1:{outcome.port}. Start it with <code>npm run start -w @mirage/launcher</code>; if it is running, it
            accepts another web origin than this page ({window.location.origin}) or listens on another port.
          </p>
        )}
        {outcome.kind === "refused" && <p className="form-errors">{outcome.message}</p>}
        {outcome.kind === "checked" && (
          <p>{attention === 0 ? "Every prerequisite is met." : `${attention} of ${outcome.checks.length} prerequisites need attention.`}</p>
        )}
      </div>
      {outcome.kind === "checked" && (
        <ul className="card-list" aria-label="Prerequisites">
          {outcome.checks.map(item => (
            <li key={item.id} data-check={item.id} data-status={item.status}>
              <span className="card-name">{item.title}: <strong>{STATUS_LABEL[item.status]}</strong></span>
              <span>{item.detail}</span>
              {item.fix && <span className="hint">To fix: {item.fix}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
