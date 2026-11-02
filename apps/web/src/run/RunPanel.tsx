import { useEffect, useMemo, useRef, useState } from "react";
import { createExperimentRecord, experimentRecordName } from "@mirage/aircraft/experiment";
import { deriveLayout, type AircraftLayout } from "@mirage/aircraft/layout";
import { readAircraftProfile } from "@mirage/aircraft/profile";
import { describeAccident } from "@mirage/physics/accident";
import type { LimitEvent } from "@mirage/physics/limit-monitor";
import type { StoredVersion } from "@mirage/project/schema";
import { CopterMode } from "@mirage/autopilot/ground-station";
import { loadLoggingSettings, type LoggingSettings } from "../logging/logging-settings";
import { RunRecorder } from "../logging/run-recorder";
import { SimulationRuntime } from "../runtime";
import type { StoreState } from "../shell/AppShell";
import { DEFAULT_LAUNCHER_PORT } from "../shell/FirstRun";
import { DEFAULT_HOME, LauncherClient, RuntimePhysics, SITL_PHYSICS_HZ, preparedRun, verifiedCommits } from "../sitl/sitl-run";
import { FlightTelemetry } from "./FlightTelemetry";
import { FlightView, type FlightViewProbe } from "./FlightView";
import { CompatibilityList, ManualConnect } from "./ManualConnect";
import { MotorCheckPanel } from "./MotorCheck";
import { PowerPanel } from "./PowerPanel";
import { SessionController, failureText, type CatalogEntry, type ConnectionSpec, type ControllerView, type Ownership, type PauseReason,
  type PreparedRun, type RunState } from "./session-controller";

// Run tab, ArduPilot SITL backend (TASK-153, TASK-154): an aircraft profile
// version of the open project flies with an installed ArduPilot build that the
// local launcher starts. The view renders SessionController's run state; each
// Start, a restart included, is a new experiment with its own record and a
// fresh physics Worker. The launcher token is typed or pasted for this page
// only, as on the Project tab: it is never stored, logged or put in a URL.
// Connect (TASK-155) flies the same profile with a SITL the user started; the
// launcher owns only that connection, and Disconnect leaves the SITL running.
// The flight view (TASK-185) shows the chosen profile's aircraft from the
// moment it is chosen and flies it at the session's pose; the flight and
// per-motor panels read the session at display rate. An accident (TASK-149)
// is listed with its part and contact load; the run, paused on its tick, may
// continue, and is then labelled as not validated for a damaged aircraft.

const MODE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(CopterMode).map(([name, value]) => [value, name.toUpperCase()]));
const STEP_TEXT = { prepare: "preparing the vehicle", firmware: "checking the ArduPilot build", physics: "loading the physics",
  launcher: "starting SITL", record: "saving the experiment record", recording: "opening the recording", connecting: "connecting to SITL",
  probing: "waiting for the SITL's JSON physics packets", version: "checking the SITL's ArduPilot version" } as const;
const FLIGHT_TEXT = { arming: "Arming", climbing: "Taking off", flying: "Flying", landing: "Landing" } as const;
const PAUSE_TEXT: Readonly<Record<PauseReason, string>> = { accident: "accident", user: "by you", visibility: "the tab was hidden", terrain: "no terrain" };
const PAUSE_HINT: Readonly<Record<PauseReason, string>> = {
  accident: "The run paused on the accident's tick, and the autopilot with it. It can continue, but what follows is not validated for a physically damaged aircraft.",
  user: "The physics and the autopilot's simulated time stand still together; position, velocity and the flight are kept. Resume continues both.",
  visibility: "This run paused because its tab was hidden: the browser slows a hidden page's timers, which run the ground station, so a run never goes on there unwatched. Resume when you are back.",
  terrain: "The run paused because no terrain is loaded under the aircraft.",
};
const PAUSABLE_STATES: ReadonlySet<string> = new Set(["loading-parameters", "warming", "ready", "running"]);
const NO_LIMIT_EVENTS = (): readonly LimitEvent[] => [];

/** The rotor layout of a stored profile version, or null when it does not validate. */
function layoutOf(stored: StoredVersion | undefined): AircraftLayout | null {
  if (!stored) return null;
  try { return deriveLayout(readAircraftProfile(stored)); } catch { return null; }
}

/** The arm IDs of a stored profile version in ascending order, which number the standard hull's arm shapes; empty when it does not validate. */
function armIdsOf(stored: StoredVersion | undefined): readonly number[] {
  if (!stored) return [];
  try { return readAircraftProfile(stored).arms.map(arm => arm.id); } catch { return []; }
}

/** The stage line for a run state; a connection says Connecting and Disconnecting. */
export function stateText(state: RunState, ownership: Ownership = "launcher"): string {
  const external = ownership === "external";
  switch (state.name) {
    case "idle": return state.last ?? "Not started";
    case "starting": return external ? `Connecting: ${state.step === "launcher" ? "opening the connection" : STEP_TEXT[state.step]}` : `Starting: ${STEP_TEXT[state.step]}`;
    case "loading-parameters": return `Loading parameters: ${state.received} of ${state.total ?? "?"} received`;
    case "warming": return "Waiting for the autopilot (EKF warmup)";
    case "ready": return "READY";
    case "running": return FLIGHT_TEXT[state.flight];
    case "paused": return `Paused at ${state.atSimTimeS.toFixed(1)} s: ${PAUSE_TEXT[state.reason]}`;
    case "stopping": return external ? "Disconnecting" : "Stopping SITL";
    case "failed": return "Failed";
    default: { const never: never = state; return never; }
  }
}

interface Telemetry { altitudeM: number; simTimeS: number }

export function RunPanel({ storeState, project, visible }: { storeState: StoreState; project: StoredVersion | null; visible: boolean }) {
  const runtime = useRef<SimulationRuntime | null>(null);
  const controller = useRef<SessionController | null>(null);
  const unlisten = useRef<(() => void) | null>(null);
  const [error, setError] = useState("");
  const [profiles, setProfiles] = useState<readonly StoredVersion[]>([]);
  const [profileSha, setProfileSha] = useState("");
  const [port, setPort] = useState(String(DEFAULT_LAUNCHER_PORT));
  const [token, setToken] = useState("");
  const [builds, setBuilds] = useState<readonly CatalogEntry[] | null>(null);
  const [buildId, setBuildId] = useState("");
  const [speedup, setSpeedup] = useState(1);
  const [altitude, setAltitude] = useState("5");
  const [view, setView] = useState<ControllerView | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry>({ altitudeM: 0, simTimeS: 0 });
  const [probe, setProbe] = useState("");
  const [motorRefusal, setMotorRefusal] = useState("");
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;

  useEffect(() => () => {
    void controller.current?.stop();
    unlisten.current?.();
    runtime.current?.dispose();
    runtime.current = controller.current = null;
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
  // TASK-156 visibility policy: a hidden tab pauses an active run, which waits for the user's Resume.
  useEffect(() => {
    const hidden = () => { if (document.hidden) controller.current?.pause("visibility"); };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const state = runtime.current?.current;
      if (state) setTelemetry({ altitudeM: -state.downM, simTimeS: state.simTimeS });
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const state: RunState = view?.state ?? { name: "idle", last: null };
  const active = controller.current?.active ?? false;
  const failed = state.name === "failed" ? state : null;
  const client = (): LauncherClient | null => {
    try { return new LauncherClient(Number(port), token.trim()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; }
  };
  const listBuilds = () => {
    setError("");
    const launcher = client();
    if (!launcher) return;
    launcher.catalog().then(entries => {
      setBuilds(entries);
      setBuildId(current => entries.some(entry => entry.id === current && entry.usable) ? current : entries.find(entry => entry.usable)?.id ?? "");
    }, (cause: unknown) => { setBuilds(null); setError(cause instanceof Error ? cause.message : String(cause)); });
  };
  /** A fresh session for every Start and Connect: the previous run's model and epoch stay with the old Worker. */
  const freshSession = (logging: LoggingSettings): { next: SessionController; prepare: () => Promise<PreparedRun> } | null => {
    setError("");
    const stored = profiles.find(entry => entry.sha256 === profileSha);
    const launcher = client();
    if (!launcher) return null;
    if (!store || !projectId || !stored) { setError("Open a project and choose an aircraft profile."); return null; }
    if (typeof SharedArrayBuffer === "undefined" || !crossOriginIsolated) { setError("This page is not cross-origin isolated, so the physics Worker cannot share memory."); return null; }
    unlisten.current?.();
    runtime.current?.dispose();
    const fresh = new SimulationRuntime(() => undefined);
    runtime.current = fresh;
    const physics = new RuntimePhysics(fresh, launcher.bearer);
    let profileName = stored.record.name;
    const next = new SessionController(launcher, physics, {
      create: payload => {
        const { sitl } = payload;
        const name = experimentRecordName(profileName, sitl.ownership === "external" ? sitl.connectionId : sitl.experimentId, sitl.ownership);
        return createExperimentRecord(store, projectId, { name, payload });
      },
    }, { nowMs: () => performance.now(), every: (ms, callback) => { const timer = setInterval(callback, ms); return () => clearInterval(timer); } }, setView,
    // TASK-163: the run records with the Logging tab's settings.
    new RunRecorder(fresh, logging, SITL_PHYSICS_HZ));
    controller.current = next;
    unlisten.current = fresh.listen(data => next.worker(data));
    return {
      next,
      prepare: async () => {
        const { vehicle, run } = await preparedRun(store, stored);
        physics.use(vehicle);
        profileName = vehicle.profileName;
        return run;
      },
    };
  };
  const logging = async (): Promise<LoggingSettings | null> => {
    if (!store) { setError("Open a project and choose an aircraft profile."); return null; }
    return loadLoggingSettings(store);
  };
  const start = () => {
    void logging().then(settings => {
      const session = settings && freshSession(settings);
      if (session) void session.next.start({ prepare: session.prepare, firmwareId: buildId, speedup, physicsHz: SITL_PHYSICS_HZ, home: DEFAULT_HOME });
    });
  };
  const connect = (endpoints: ConnectionSpec) => {
    void logging().then(settings => {
      const session = settings && freshSession(settings);
      if (session) void session.next.connect({ prepare: session.prepare, endpoints, physicsHz: SITL_PHYSICS_HZ, home: DEFAULT_HOME, verifiedCommits: verifiedCommits() });
    });
  };
  const chosen = profiles.find(entry => entry.sha256 === profileSha);
  const layout = useMemo(() => layoutOf(chosen), [chosen]);
  const armIds = useMemo(() => armIdsOf(chosen), [chosen]);
  const accidents = view?.accidents ?? [];
  const status = view?.status ?? null;
  const stopAgain = failed?.restart.kind === "stop-again";
  const external = view?.ownership === "external";
  const busy = active || stopAgain || state.name === "stopping";
  return (
    <section className="sitl-flight" aria-labelledby="sitl-heading">
      <h3 id="sitl-heading">ArduPilot SITL</h3>
      <p className="hint">
        An installed ArduPilot build, started by the local launcher, flies the chosen aircraft profile. The physics runs in this page in
        lockstep with the autopilot at 800 Hz. READY comes only from the autopilot's own EKF diagnostics in this run. Every start is a new
        experiment with its own record; changing the profile, the build or the speed needs a new start.
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
        <button type="button" onClick={listBuilds} disabled={active}>List ArduPilot builds</button>
        <label htmlFor="sitl-build">ArduPilot build</label>
        <select id="sitl-build" value={buildId} disabled={active || !builds} onChange={event => setBuildId(event.target.value)}>
          {!builds && <option value="">List the launcher's builds first</option>}
          {builds?.map(entry => (
            <option key={entry.id} value={entry.id} disabled={!entry.usable}>
              {entry.firmwareVersion} ({entry.id}){entry.usable ? "" : `: ${entry.reason ?? "unusable"}`}
            </option>
          ))}
        </select>
        <label htmlFor="sitl-speed">Speed</label>
        <select id="sitl-speed" value={speedup} disabled={active} onChange={event => setSpeedup(Number(event.target.value))}>
          {[1, 2, 4].map(value => <option key={value} value={value}>{value === 1 ? "Real time" : `Up to ${value}×`}</option>)}
        </select>
      </div>
      <div className="sitl-actions">
        <button type="button" onClick={start} disabled={busy || !profileSha || !buildId}>
          {failed && !external ? "Start again" : "Start SITL run"}
        </button>
        <label htmlFor="sitl-altitude">Take-off altitude, m</label>
        <input id="sitl-altitude" type="text" inputMode="decimal" value={altitude} onChange={event => setAltitude(event.target.value)} />
        <button type="button" onClick={() => controller.current?.takeOff(Number(altitude))} disabled={state.name !== "ready"}>Take off</button>
        <button type="button" onClick={() => controller.current?.land()}
          disabled={state.name !== "running" || (state.flight !== "climbing" && state.flight !== "flying")}>Land</button>
        <button type="button" onClick={() => controller.current?.pause("user")} disabled={!PAUSABLE_STATES.has(state.name)}>Pause</button>
        <button type="button" onClick={() => controller.current?.resume()} disabled={state.name !== "paused"}>
          {state.name === "paused" && state.reason === "accident" ? "Continue after the accident" : "Resume"}
        </button>
        <button type="button" onClick={() => void controller.current?.stop()} disabled={!active && !stopAgain}>
          {external ? (stopAgain ? "Disconnect again" : "Disconnect") : stopAgain ? "Stop again" : "Stop run"}
        </button>
      </div>
      <ManualConnect disabled={busy || !profileSha} again={Boolean(failed) && external} onConnect={connect} onError={setError} />
      {layout && chosen && (
        <div className="flight-view-area" data-testid="flight-view" data-probe={probe}>
          <FlightView runtime={runtime} layout={layout} name={chosen.record.name} active={visible} ringTurning={view?.motorCheck?.running === true}
            onProbe={(next: FlightViewProbe) => setProbe(JSON.stringify(next))} />
          <div className="flight-view-panels">
            <MotorCheckPanel check={view?.motorCheck ?? null} refusal={motorRefusal}
              disabled={!(state.name === "warming" || state.name === "ready") || view?.armed === true}
              onCheck={() => setMotorRefusal(controller.current?.checkMotors() ?? "No run is active")} />
            <FlightTelemetry runtime={runtime} />
            <PowerPanel reader={runtime.current?.power ?? null} events={runtime.current?.limitEvents ?? NO_LIMIT_EVENTS} />
          </div>
        </div>
      )}
      <dl className="sitl-status">
        <dt>Stage</dt><dd data-testid="sitl-stage" data-state={state.name} data-ownership={view?.ownership ?? "launcher"}>{stateText(state, view?.ownership)}</dd>
        <dt>Autopilot admission</dt>
        <dd data-testid="sitl-ready">{status?.ready ? "READY" : "Not ready"}{status && !status.ready ? `: ${status.reason}` : ""}</dd>
        <dt>Autopilot mode</dt>
        <dd data-testid="sitl-mode">{view?.mode === null || view?.mode === undefined ? "No heartbeat" : MODE_NAMES[view.mode] ?? `Mode ${view.mode}`}</dd>
        <dt>Armed</dt><dd data-testid="sitl-armed">{view?.armed ? "Armed" : "Disarmed"}</dd>
        <dt>Altitude above the pad</dt><dd data-testid="sitl-altitude">{telemetry.altitudeM.toFixed(2)} m</dd>
        <dt>Simulated time</dt><dd data-testid="sitl-sim-time">{telemetry.simTimeS.toFixed(1)} s{status && status.speed > 0 ? ` (${status.speed.toFixed(2)}× real time)` : ""}</dd>
        <dt>Lockstep frames</dt>
        <dd data-testid="sitl-frames">{status ? `${status.steps} stepped, ${status.droppedFrames} lost, ${status.duplicates} resent, ${status.held} held` : "None"}</dd>
        <dt>Experiment record</dt><dd data-testid="sitl-record">{view?.recordSha256 ?? "None"}</dd>
      </dl>
      {external && view && <CompatibilityList checks={view.compatibility} />}
      {state.name === "running" && state.warning && <p className="alert" role="status">{state.warning}</p>}
      {view?.afterAccident && (
        <p className="alert" role="status" data-testid="sitl-after-accident">
          Continued after an accident: the rest of this run is not validated for a physically damaged aircraft.
        </p>
      )}
      {accidents.length > 0 && (
        <div className="sitl-accidents">
          <h4>Accidents</h4>
          <ul data-testid="sitl-accidents">{accidents.map((event, index) => <li key={index}>{describeAccident(event, armIds)}</li>)}</ul>
        </div>
      )}
      {state.name === "paused" && <p className="hint" role="status" data-testid="sitl-pause-hint">{PAUSE_HINT[state.reason]}</p>}
      {view && view.pauses.length > 0 && (
        <div className="sitl-pauses">
          <h4>Pauses</h4>
          <ul data-testid="sitl-pauses">
            {view.pauses.map((pause, index) => (
              <li key={index} data-reason={pause.reason}>
                {`At ${pause.simTimeS.toFixed(2)} s (tick ${pause.tick}), ${PAUSE_TEXT[pause.reason]}: `}
                {pause.resumedWallMs === null ? "paused now" : `resumed after ${((pause.resumedWallMs - pause.pausedWallMs) / 1000).toFixed(1)} s of wall time`}
              </li>
            ))}
          </ul>
          <p className="hint">Simulated time stood still for {(view.pausedWallMs / 1000).toFixed(1)} s of wall time; the run&apos;s simulated duration does not count it.</p>
        </div>
      )}
      {failed && (
        <div className="sitl-failure">
          <p className="alert" role="alert" data-testid="sitl-failure" data-reason={failed.reason.kind}>
            {failed.reason.kind === "incompatible" ? "This SITL cannot be used with this profile:" : failureText(failed.reason)}
          </p>
          {failed.reason.kind === "incompatible" && (
            <ul data-testid="sitl-incompatible">{failed.reason.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          )}
          {failed.restart.kind === "fix-first" && <p className="hint" data-testid="sitl-fix">{failed.restart.instruction}</p>}
          {failed.diagnostics?.connection && (
            <details data-testid="sitl-diagnostics">
              <summary>Diagnostics of connection {failed.diagnostics.experimentId}</summary>
              <p>
                MirageSITL did not start this SITL, so it has no process logs, and it stopped nothing.
                {failed.diagnostics.ending ? ` ${failed.diagnostics.ending}.` : ""} The launcher received {failed.diagnostics.connection.servoPackets} JSON
                servo packets{failed.diagnostics.connection.rateHz === null ? "" : ` at ${failed.diagnostics.connection.rateHz} Hz`} and{" "}
                {failed.diagnostics.connection.bytesFromSitl} bytes of MAVLink from it.
              </p>
            </details>
          )}
          {failed.diagnostics && !failed.diagnostics.connection && (
            <details data-testid="sitl-diagnostics">
              <summary>Diagnostic log of experiment {failed.diagnostics.experimentId}</summary>
              <p>
                Launcher state {failed.diagnostics.launcherState ?? "unknown"}
                {failed.diagnostics.ending ? `; ${failed.diagnostics.ending}` : ""}
                {failed.diagnostics.dataflash.length > 0 ? `; DataFlash: ${failed.diagnostics.dataflash.join(", ")}` : ""}
              </p>
              <h4>Standard error</h4><pre>{failed.diagnostics.stderr || "(empty)"}</pre>
              <h4>Standard output</h4><pre>{failed.diagnostics.stdout || "(empty)"}</pre>
            </details>
          )}
        </div>
      )}
      {view && view.statusText.length > 0 && (
        <ul className="sitl-text" aria-label="Autopilot messages">{view.statusText.map((text, index) => <li key={index}>{text}</li>)}</ul>
      )}
      {error && <p className="alert" role="alert">{error}</p>}
    </section>
  );
}
