import { useEffect, useRef, useState } from "react";
import type { StoredVersion } from "@mirage/project/schema";
import { CopterMode } from "@mirage/autopilot/ground-station";
import { SimulationRuntime } from "../runtime";
import type { StoreState } from "../shell/AppShell";
import { DEFAULT_LAUNCHER_PORT } from "../shell/FirstRun";
import { LauncherClient, SitlRun, prepareVehicle, type RunView } from "../sitl/sitl-run";

// Run tab, ArduPilot SITL backend (TASK-153): an aircraft profile version of
// the open project flies with native ArduPilot started by the local launcher.
// The launcher token is typed or pasted for this page only, as on the
// Project tab: it is never stored, logged or put in a URL.

const MODE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(CopterMode).map(([name, value]) => [value, name.toUpperCase()]));
const STAGE_TEXT: Readonly<Record<RunView["stage"], string>> = {
  idle: "Not started", preparing: "Preparing the vehicle", warming: "Waiting for the autopilot (EKF warmup)", ready: "READY",
  arming: "Arming", climbing: "Taking off", flying: "Flying", landing: "Landing", landed: "Landed", stopped: "Stopped", failed: "Failed",
};

interface Telemetry { altitudeM: number; simTimeS: number }

export function SitlFlight({ storeState, project, visible }: { storeState: StoreState; project: StoredVersion | null; visible: boolean }) {
  const runtime = useRef<SimulationRuntime | null>(null);
  const run = useRef<SitlRun | null>(null);
  const [error, setError] = useState("");
  const [profiles, setProfiles] = useState<readonly StoredVersion[]>([]);
  const [profileSha, setProfileSha] = useState("");
  const [port, setPort] = useState(String(DEFAULT_LAUNCHER_PORT));
  const [token, setToken] = useState("");
  const [speedup, setSpeedup] = useState(1);
  const [altitude, setAltitude] = useState("5");
  const [view, setView] = useState<RunView | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry>({ altitudeM: 0, simTimeS: 0 });
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;

  useEffect(() => {
    if (typeof SharedArrayBuffer === "undefined" || !crossOriginIsolated) {
      setError("This page is not cross-origin isolated, so the physics Worker cannot share memory.");
      return;
    }
    runtime.current = new SimulationRuntime(() => undefined);
    return () => {
      void run.current?.stop();
      run.current = null;
      runtime.current?.dispose();
      runtime.current = null;
    };
  }, []);
  useEffect(() => {
    if (!store || !projectId) { setProfiles([]); return; }
    let cancelled = false;
    store.listItems(projectId, "aircraft-profile").then(list => {
      if (cancelled) return;
      setProfiles(list);
      setProfileSha(current => list.some(stored => stored.sha256 === current) ? current : list[0]?.sha256 ?? "");
    }, (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [store, projectId, visible]);
  useEffect(() => {
    const timer = setInterval(() => {
      const state = runtime.current?.current;
      if (state) setTelemetry({ altitudeM: -state.downM, simTimeS: state.simTimeS });
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const stage = view?.stage ?? "idle";
  const active = stage !== "idle" && stage !== "stopped" && stage !== "failed";
  const start = () => {
    setError("");
    const stored = profiles.find(entry => entry.sha256 === profileSha);
    if (!store || !stored || !runtime.current) { setError("Open a project and choose an aircraft profile."); return; }
    let launcher: LauncherClient;
    try { launcher = new LauncherClient(Number(port), token.trim()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    // A new run needs a fresh session: the previous run's model and epoch stay with the old Worker.
    if (run.current) {
      runtime.current.dispose();
      runtime.current = new SimulationRuntime(() => undefined);
    }
    const next = new SitlRun(runtime.current, launcher, setView);
    run.current = next;
    void prepareVehicle(store, stored).then(vehicle => next.start(vehicle, speedup), (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const status = view?.status ?? null;
  return (
    <section className="sitl-flight" aria-labelledby="sitl-heading">
      <h3 id="sitl-heading">ArduPilot SITL</h3>
      <p className="hint">
        Native ArduCopter, started by the local launcher, flies the chosen aircraft profile. The physics runs in this page in lockstep
        with the autopilot at 800 Hz. READY comes only from the autopilot's own EKF diagnostics in this run.
      </p>
      <div className="sitl-form">
        <label htmlFor="sitl-profile">Aircraft profile</label>
        <select id="sitl-profile" value={profileSha} disabled={active} onChange={event => setProfileSha(event.target.value)}>
          {profiles.length === 0 && <option value="">No aircraft profile in this project</option>}
          {profiles.map(entry => <option key={entry.sha256} value={entry.sha256}>{entry.record.name} (version {entry.record.version})</option>)}
        </select>
        <label htmlFor="sitl-port">Launcher port</label>
        <input id="sitl-port" type="text" inputMode="numeric" value={port} disabled={active} onChange={event => setPort(event.target.value)} />
        <label htmlFor="sitl-token">Launcher token</label>
        <input id="sitl-token" type="password" autoComplete="off" spellCheck={false} value={token} disabled={active} onChange={event => setToken(event.target.value)} />
        <label htmlFor="sitl-speed">Speed</label>
        <select id="sitl-speed" value={speedup} disabled={active} onChange={event => setSpeedup(Number(event.target.value))}>
          {[1, 2, 4].map(value => <option key={value} value={value}>{value === 1 ? "Real time" : `Up to ${value}×`}</option>)}
        </select>
      </div>
      <div className="sitl-actions">
        <button type="button" onClick={start} disabled={active || !profileSha}>Start SITL run</button>
        <label htmlFor="sitl-altitude">Take-off altitude, m</label>
        <input id="sitl-altitude" type="text" inputMode="decimal" value={altitude} onChange={event => setAltitude(event.target.value)} />
        <button type="button" onClick={() => run.current?.takeOff(Number(altitude))} disabled={stage !== "ready" && stage !== "landed"}>Take off</button>
        <button type="button" onClick={() => run.current?.land()} disabled={stage !== "climbing" && stage !== "flying"}>Land</button>
        <button type="button" onClick={() => void run.current?.stop()} disabled={!active}>Stop run</button>
      </div>
      <dl className="sitl-status">
        <dt>Stage</dt><dd data-testid="sitl-stage">{STAGE_TEXT[stage]}</dd>
        <dt>Autopilot admission</dt>
        <dd data-testid="sitl-ready">{status?.ready ? "READY" : "Not ready"}{status && !status.ready ? `: ${status.reason}` : ""}</dd>
        <dt>Autopilot mode</dt>
        <dd data-testid="sitl-mode">{view?.mode === null || view?.mode === undefined ? "No heartbeat" : MODE_NAMES[view.mode] ?? `Mode ${view.mode}`}</dd>
        <dt>Armed</dt><dd data-testid="sitl-armed">{view?.armed ? "Armed" : "Disarmed"}</dd>
        <dt>Altitude above the pad</dt><dd data-testid="sitl-altitude">{telemetry.altitudeM.toFixed(2)} m</dd>
        <dt>Simulated time</dt><dd data-testid="sitl-sim-time">{telemetry.simTimeS.toFixed(1)} s{status && status.speed > 0 ? ` (${status.speed.toFixed(2)}× real time)` : ""}</dd>
        <dt>Lockstep frames</dt>
        <dd data-testid="sitl-frames">{status ? `${status.steps} stepped, ${status.droppedFrames} lost, ${status.duplicates} resent, ${status.held} held` : "None"}</dd>
      </dl>
      {view && view.statusText.length > 0 && (
        <ul className="sitl-text" aria-label="Autopilot messages">{view.statusText.map((text, index) => <li key={index}>{text}</li>)}</ul>
      )}
      {(error || view?.message) && <p className={stage === "failed" || error ? "alert" : "hint"} role={stage === "failed" || error ? "alert" : "status"}>{error || view?.message}</p>}
    </section>
  );
}
