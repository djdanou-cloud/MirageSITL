import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createExperimentRecord, experimentRecordName, isSetParameter, type ExperimentFlightTask } from "@mirage/aircraft/experiment";
import { deriveLayout, type AircraftLayout } from "@mirage/aircraft/layout";
import { readAircraftProfile } from "@mirage/aircraft/profile";
import { describeAccident } from "@mirage/physics/accident";
import type { LimitEvent } from "@mirage/physics/limit-monitor";
import type { RunDriver } from "./session-link";
import type { StoredVersion } from "@mirage/project/schema";
import { CopterMode } from "@mirage/autopilot/ground-station";
import { GamepadAdapter, defaultCalibration } from "@mirage/input";
import { loadCalibration } from "@mirage/input/calibration-store";
import type { ParameterMetadataCatalog } from "@mirage/autopilot/param-metadata";
import { lineageFor, loggingOf } from "../experiments/lifecycle";
import { logPlanText, saveLogExtraction } from "../experiments/log-plan";
import { loadLoggingSettings, type LoggingSettings } from "../logging/logging-settings";
import { ParameterLogWriter } from "../params/log-writer";
import { loadParameterMetadata } from "../params/metadata";
import { RunRecorder } from "../logging/run-recorder";
import { SimulationRuntime } from "../runtime";
import type { StoreState } from "../shell/AppShell";
import { DEFAULT_LAUNCHER_PORT } from "../shell/FirstRun";
import { DEFAULT_HOME, LauncherClient, RuntimePhysics, SITL_PHYSICS_HZ, preparedRun, verifiedCommits } from "../sitl/sitl-run";
import { readFlightTask } from "../tasks/flight-task-form";
import { FlightTaskPanel } from "./FlightTaskPanel";
import { FlightTelemetry } from "./FlightTelemetry";
import { FlightView, type FlightViewProbe, type RoutePoint } from "./FlightView";
import { CompatibilityList, ManualConnect } from "./ManualConnect";
import { ManualControl } from "./ManualControl";
import { MotorCheckPanel } from "./MotorCheck";
import { PowerPanel } from "./PowerPanel";
import { AS_FAST_AS_POSSIBLE } from "./run-speed";
import { SpeedIndicator } from "./SpeedIndicator";
import { SessionController, failureText, type CatalogEntry, type ConnectionSpec, type ControllerView, type Ownership, type PauseReason,
  type PreparedRun, type RunState } from "./session-controller";
import type { SessionLink } from "./session-link";

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
// The run's measured speed (TASK-175) is shown with the pace it was asked for.
// Manual control (TASK-174) flies the run with the USB controller calibrated
// in the synthetic demo's radio panel (TASK-038). A run the Experiments tab
// planned (TASK-165) loads its parent's inputs: a repeat locks them, its
// recording setup and home included, and a variant lets them change; the
// record names its parent and the inputs that changed.
// A flight task (TASK-172) is chosen before the start: its ground values are in
// the physics from the first step and the experiment record holds it. Run task
// flies it from READY, and the panel shows requested next to actual; the flight
// view draws a route's line and points.
// The session is attached to the shell's link, so the Parameters tab (TASK-160)
// reads and writes the run's parameters, and each run's parameter changes are
// saved as its parameter log.

const MODE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(CopterMode).map(([name, value]) => [value, name.toUpperCase()]));
const STEP_TEXT = { prepare: "preparing the vehicle", firmware: "checking the ArduPilot build", physics: "loading the physics",
  launcher: "starting SITL", record: "saving the experiment record", recording: "opening the recording", connecting: "connecting to SITL",
  probing: "waiting for the SITL's JSON physics packets", version: "checking the SITL's ArduPilot version" } as const;
const FLIGHT_TEXT = { arming: "Arming", climbing: "Taking off", flying: "Flying", landing: "Landing", manual: "Manual control", task: "Flying the task" } as const;
const PAUSE_TEXT: Readonly<Record<PauseReason, string>> = { accident: "accident", user: "by you", visibility: "the tab was hidden", terrain: "no terrain",
  controller: "controller lost" };
const PAUSE_HINT: Readonly<Record<PauseReason, string>> = {
  accident: "The run paused on the accident's tick, and the autopilot with it. It can continue, but what follows is not validated for a physically damaged aircraft.",
  user: "The physics and the autopilot's simulated time stand still together; position, velocity and the flight are kept. Resume continues both.",
  visibility: "This run paused because its tab was hidden: the browser slows a hidden page's timers, which run the ground station, so a run never goes on there unwatched. Resume when you are back.",
  terrain: "The run paused because no terrain is loaded under the aircraft.",
  controller: "The run paused because the controller disconnected, was swapped or stopped sending: ArduPilot never flies on a held stick. If the same controller stayed connected, Resume continues in manual control; one that was unplugged and plugged back in, or swapped, does not take over, so Resume gives the flight back to MirageSITL, which holds position, and you can take manual control again.",
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

export function RunPanel({ storeState, project, visible, link }: { storeState: StoreState; project: StoredVersion | null; visible: boolean; link: SessionLink }) {
  const runtime = useRef<SimulationRuntime | null>(null);
  const controller = useRef<SessionController | null>(null);
  const unlisten = useRef<(() => void) | null>(null);
  const [error, setError] = useState("");
  const [profiles, setProfiles] = useState<readonly StoredVersion[]>([]);
  const [profileSha, setProfileSha] = useState("");
  // TASK-165: the run the Experiments tab planned, and the stored profile version it names.
  const plan = useSyncExternalStore(link.subscribe, link.plan);
  const batchRunning = useSyncExternalStore(link.subscribe, link.batchRunning);
  const [plannedProfile, setPlannedProfile] = useState<StoredVersion | null>(null);
  const repeat = plan?.kind === "repeat";
  // TASK-182: the run the from-log wizard planned: the log's home and settings, on the aircraft the user chose.
  const fromLog = useSyncExternalStore(link.subscribe, link.logPlan);
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
  const [manualRefusal, setManualRefusal] = useState("");
  // TASK-172: the project's flight tasks, the chosen item, and the version a planned run names, which need not be the head.
  const [tasks, setTasks] = useState<readonly StoredVersion[]>([]);
  const [taskId, setTaskId] = useState("");
  const [plannedTask, setPlannedTask] = useState<StoredVersion | null>(null);
  const [taskRefusal, setTaskRefusal] = useState("");
  // TASK-174: the controller calibrated in the radio panel (TASK-038), or the default axes.
  const adapter = useMemo(() => {
    const stored = (() => { try { return loadCalibration(localStorage); } catch { return null; } })();
    const pad = new GamepadAdapter(stored?.axes ?? defaultCalibration());
    if (stored) pad.modeCalibration = stored.mode;
    return pad;
  }, []);
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
  useEffect(() => {
    if (!store || !projectId) { setTasks([]); return; }
    let cancelled = false;
    store.listItems(projectId, "flight-task").then(list => { if (!cancelled) setTasks(list); },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [store, projectId, visible]);
  // A planned run flies its parent's task, in the version the parent flew.
  useEffect(() => {
    const named = plan?.parent.flightTask ?? null;
    if (!plan || !store) { setPlannedTask(null); return; }
    if (!named) { setPlannedTask(null); setTaskId(""); return; }
    let cancelled = false;
    store.get(named.recordSha256).then(stored => {
      if (cancelled) return;
      setPlannedTask(stored);
      setTaskId(stored.record.id);
    }, (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [plan, store]);
  // A planned run selects its parent's profile version, which need not be the head, its build and its speed.
  useEffect(() => {
    if (!plan || !store) { setPlannedProfile(null); return; }
    let cancelled = false;
    store.get(plan.parent.profile.sha256).then(stored => {
      if (cancelled) return;
      setPlannedProfile(stored);
      setProfileSha(stored.sha256);
      if (plan.parent.sitl.ownership === "launcher") setBuildId(plan.parent.sitl.ardupilot.catalogId);
      if (plan.parent.session.speedup !== null) setSpeedup(plan.parent.session.speedup);
    }, (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [plan, store]);
  const choices = useMemo(() => plannedProfile && !profiles.some(entry => entry.sha256 === plannedProfile.sha256) ? [...profiles, plannedProfile] : profiles,
    [profiles, plannedProfile]);
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
    try { const made = new LauncherClient(Number(port), token.trim()); link.setLauncher(made); return made; } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; }
  };
  const listBuilds = () => {
    setError("");
    const launcher = client();
    if (!launcher) return;
    launcher.catalog().then(entries => {
      setBuilds(entries);
      const planned = plan?.parent.sitl.ownership === "launcher" ? plan.parent.sitl.ardupilot.catalogId : null;
      setBuildId(current => planned && entries.some(entry => entry.id === planned) ? planned
        : entries.some(entry => entry.id === current && entry.usable) ? current : entries.find(entry => entry.usable)?.id ?? "");
    }, (cause: unknown) => { setBuilds(null); setError(cause instanceof Error ? cause.message : String(cause)); });
  };
  /** A fresh session for every Start and Connect: the previous run's model and epoch stay with the old Worker. */
  useEffect(() => { if (fromLog) setProfileSha(fromLog.profileSha256); }, [fromLog]);
  const freshSession = (logging: LoggingSettings | null, metadata: ParameterMetadataCatalog | null, flightTask: ExperimentFlightTask | null, setParameters: readonly { readonly name: string; readonly value: number }[] = []): { next: SessionController; prepare: () => Promise<PreparedRun> } | null => {
    setError("");
    const stored = choices.find(entry => entry.sha256 === profileSha);
    // The plan belongs to this run: the record names its parent, and the next run is an original again.
    const planned = plan, plannedLog = fromLog;
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
    // TASK-160: the run's parameter changes are saved as versions of its parameter log.
    const changes = new ParameterLogWriter(store, projectId, setError);
    const next: SessionController = new SessionController(launcher, physics, {
      create: payload => {
        const { sitl } = payload;
        const name = experimentRecordName(profileName, sitl.ownership === "external" ? sitl.connectionId : sitl.experimentId, sitl.ownership);
        return createExperimentRecord(store, projectId, { name, payload: { ...payload, lineage: lineageFor(planned, payload) } }).then(async record => {
          // TASK-182: the record of where this run came from, which depends on the experiment.
          if (plannedLog) await saveLogExtraction(store, projectId, plannedLog, record.sha256, new Set(payload.parameters.filter(parameter => parameter.source === "set").map(parameter => parameter.name)));
          return record;
        });
      },
    }, { nowMs: () => performance.now(), utcNow: () => new Date().toISOString(),
      every: (ms, callback) => { const timer = setInterval(callback, ms); return () => clearInterval(timer); } },
    view => { setView(view); link.publish(next, view); changes.update(view); },
    // TASK-163: the run records with the Logging tab's settings.
    logging ? new RunRecorder(fresh, logging, SITL_PHYSICS_HZ) : null, metadata);
    controller.current = next;
    next.setInput(adapter);
    link.attach(next);
    unlisten.current = fresh.listen(data => next.worker(data));
    return {
      next,
      prepare: async () => {
        const { vehicle, run } = await preparedRun(store, stored);
        physics.use(vehicle, flightTask?.definition.initial.ground);
        profileName = vehicle.profileName;
        // TASK-182: what a log holds of the aircraft's own parameters stays the aircraft's, which the wizard says.
        const usable = plannedLog ? setParameters.filter(parameter => !run.parameters.some(generated => generated.name === parameter.name)) : setParameters;
        if (usable.length === 0) return run;
        // TASK-176: a parameter set is part of what this run boots with; the aircraft's own parameters stay the aircraft's.
        const clash = usable.filter(parameter => run.parameters.some(generated => generated.name === parameter.name)).map(parameter => parameter.name);
        if (clash.length > 0) throw new Error(`The parameter set names ${clash.join(", ")}, which the aircraft profile sets`);
        return { ...run, parameters: [...run.parameters, ...usable.map(parameter => ({ name: parameter.name, value: parameter.value, source: "set" as const }))] };
      },
    };
  };
  const logging = async (): Promise<LoggingSettings | null> => {
    if (!store) { setError("Open a project and choose an aircraft profile."); return null; }
    return loadLoggingSettings(store);
  };
  /** ArduPilot's parameter metadata; a run without it shows its parameters without restart and range facts. */
  const metadata = (): Promise<ParameterMetadataCatalog | null> => loadParameterMetadata().catch((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
    return null;
  });
  /** The chosen flight task as the run's record holds it; null with the reason set when it cannot be read. */
  const chosenFlightTask = (): { readonly entry: ExperimentFlightTask | null } | null => {
    if (!chosenTask) return { entry: null };
    try {
      return { entry: { recordSha256: chosenTask.sha256, name: chosenTask.record.name, definition: readFlightTask(chosenTask) } };
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; }
  };
  const start = () => {
    const task = chosenFlightTask();
    if (!task) return;
    setTaskRefusal("");
    // A planned run records with its parent's setup, or not at all when the parent recorded nothing, and starts at its home.
    const parent = plan?.parent ?? null;
    const settingsFor = parent ? Promise.resolve(parent.recording ? loggingOf(parent.recording) : null) : logging();
    void Promise.all([settingsFor, metadata()]).then(([settings, catalog]) => {
      if (!parent && !settings) return;
      // A planned run boots with its parent's parameter set, if it had one: the set is one of its inputs.
      // A log from another build may name parameters this one lacks, which the start would refuse.
      const knownSets = (catalog?.commits ?? []).flatMap(commit => catalog?.forCommit(commit) ?? []);
      const writable = (name: string) => knownSets.length === 0 || knownSets.some(known => { const facts = known.get(name); return facts !== undefined && !facts.readOnly && !facts.volatile; });
      const fromLogSet = (fromLog?.extraction.parameters ?? []).filter(parameter => isSetParameter(parameter.name) && writable(parameter.name))
        .map(parameter => ({ name: parameter.name, value: parameter.value }));
      const session = freshSession(settings, catalog, task.entry, fromLog ? fromLogSet : parent?.parameters.filter(parameter => parameter.source === "set") ?? []);
      if (!session) return;
      link.planRun(null);
      const logHome = fromLog?.extraction.home ?? null;
      link.planFromLog(null);
      void session.next.start({ prepare: session.prepare, firmwareId: buildId, speedup, physicsHz: parent?.session.physicsHz ?? SITL_PHYSICS_HZ,
        home: parent?.session.home ?? logHome ?? DEFAULT_HOME, flightTask: task.entry });
    });
  };
  const connect = (endpoints: ConnectionSpec) => {
    const task = chosenFlightTask();
    if (!task) return;
    const ground = task.entry?.definition.initial.ground;
    if (ground && (ground.northM !== 0 || ground.eastM !== 0)) {
      setError("A SITL you started stands at its own --home, so a flight task that starts away from the pad cannot fly on it; choose another task, or let the launcher start the run.");
      return;
    }
    setTaskRefusal("");
    void Promise.all([logging(), metadata()]).then(([settings, catalog]) => {
      const session = settings && freshSession(settings, catalog, task.entry);
      if (session) void session.next.connect({ prepare: session.prepare, endpoints, physicsHz: SITL_PHYSICS_HZ, home: DEFAULT_HOME, verifiedCommits: verifiedCommits(), flightTask: task.entry });
    });
  };
  // TASK-176: a batch runs the scenario chosen here, one fresh run per set.
  const driverState = useRef<RunDriver | null>(null);
  driverState.current = {
    scenario: () => {
      const profile = choices.find(entry => entry.sha256 === profileSha);
      if (!profile) return { kind: "refused", reason: "Choose an aircraft profile on the Run tab" };
      if (!chosenTask) return { kind: "refused", reason: "Choose a flight task on the Run tab: a batch flies one scenario" };
      if (!buildId) return { kind: "refused", reason: "List the ArduPilot builds on the Run tab and choose one" };
      if (plan) return { kind: "refused", reason: "The Run tab has a repeat or a variant planned: start it or cancel it first" };
      if (active && !batchRunning) return { kind: "refused", reason: "A run is under way on the Run tab: stop it first" };
      return { kind: "ready", label: `${profile.record.name}, ${chosenTask.record.name}, ${buildId}, ${speedup}×`,
        scenario: { profileSha256: profile.sha256, flightTaskSha256: chosenTask.sha256, firmwareId: buildId, speedup, physicsHz: SITL_PHYSICS_HZ, home: [...DEFAULT_HOME] } };
    },
    start: async set => {
      const task = chosenFlightTask();
      if (!task) return "The flight task cannot be read";
      setTaskRefusal("");
      const [settings, catalog] = await Promise.all([logging(), metadata()]);
      if (!settings) return "The recording settings cannot be read";
      const session = freshSession(settings, catalog, task.entry, set.parameters);
      if (!session) return "The run could not be set up";
      void session.next.start({ prepare: session.prepare, firmwareId: buildId, speedup, physicsHz: SITL_PHYSICS_HZ, home: DEFAULT_HOME, flightTask: task.entry });
      return null;
    },
    // runTask answers null when it flies, so a missing controller cannot be told from it by `??`.
    runTask: () => (controller.current ? controller.current.runTask() : "There is no run to fly"),
    stop: () => controller.current?.stop() ?? Promise.resolve(),
  };
  useEffect(() => {
    link.setDriver({
      scenario: () => driverState.current?.scenario() ?? { kind: "refused", reason: "Open the Run tab to set up a run" },
      start: set => driverState.current?.start(set) ?? Promise.resolve("The Run tab is not ready"),
      runTask: () => (driverState.current ? driverState.current.runTask() : "The Run tab is not ready"),
      stop: () => driverState.current?.stop() ?? Promise.resolve(),
    });
    return () => link.setDriver(null);
  }, [link]);
  const chosen = choices.find(entry => entry.sha256 === profileSha);
  const chosenTask = plannedTask?.record.id === taskId ? plannedTask : tasks.find(entry => entry.record.id === taskId) ?? null;
  // The route of the running task, or of the chosen one before the run starts.
  const routeDefinition = view?.flightTask?.task.definition ?? (() => { try { return chosenTask ? readFlightTask(chosenTask) : null; } catch { return null; } })();
  const routePoints = routeDefinition?.route ?? null;
  const route = useMemo((): readonly RoutePoint[] => (routePoints ?? []).map((point, index) => ({ northM: point.northM, eastM: point.eastM, downM: -point.altitudeM, label: `Route point ${index + 1}` })), [routePoints]);
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
        <select id="sitl-profile" value={profileSha} disabled={active || repeat} onChange={event => setProfileSha(event.target.value)}>
          {choices.length === 0 && <option value="">No aircraft profile in this project</option>}
          {choices.map(entry => <option key={entry.sha256} value={entry.sha256}>{entry.record.name} (version {entry.record.version})</option>)}
        </select>
        <label htmlFor="sitl-port">Launcher port</label>
        <input id="sitl-port" type="text" inputMode="numeric" value={port} disabled={active} onChange={event => setPort(event.target.value)} />
        <label htmlFor="sitl-token">Launcher token</label>
        <input id="sitl-token" type="password" autoComplete="off" spellCheck={false} value={token} disabled={active} onChange={event => setToken(event.target.value)} />
        <button type="button" onClick={listBuilds} disabled={active}>List ArduPilot builds</button>
        <label htmlFor="sitl-build">ArduPilot build</label>
        <select id="sitl-build" value={buildId} disabled={active || !builds || repeat} onChange={event => setBuildId(event.target.value)}>
          {!builds && <option value="">List the launcher's builds first</option>}
          {builds?.map(entry => (
            <option key={entry.id} value={entry.id} disabled={!entry.usable}>
              {entry.firmwareVersion} ({entry.id}){entry.usable ? "" : `: ${entry.reason ?? "unusable"}`}
            </option>
          ))}
        </select>
        <label htmlFor="sitl-speed">Speed</label>
        <select id="sitl-speed" value={speedup} disabled={active || repeat} onChange={event => setSpeedup(Number(event.target.value))}>
          {/* TASK-175: real time, a cap, or as fast as this computer runs; the measured pace is shown below. */}
          {[1, 2, 4, AS_FAST_AS_POSSIBLE].map(value => (
            <option key={value} value={value}>{value === 1 ? "Real time" : value === AS_FAST_AS_POSSIBLE ? "As fast as possible" : `Accelerated, at most ${value}×`}</option>
          ))}
        </select>
        <label htmlFor="sitl-task">Flight task</label>
        <select id="sitl-task" value={taskId} disabled={active || repeat} onChange={event => { setPlannedTask(null); setTaskId(event.target.value); }}>
          <option value="">None: fly from the buttons below</option>
          {plannedTask && !tasks.some(entry => entry.sha256 === plannedTask.sha256) && <option value={plannedTask.record.id}>{plannedTask.record.name} (version {plannedTask.record.version})</option>}
          {tasks.filter(entry => !(plannedTask?.record.id === entry.record.id && plannedTask.sha256 !== entry.sha256)).map(entry => (
            <option key={entry.record.id} value={entry.record.id}>{entry.record.name} (version {entry.record.version})</option>
          ))}
        </select>
      </div>
      {fromLog && (
        <p className="hint" role="status" data-testid="sitl-plan" data-kind="from-log">
          {logPlanText(fromLog.extraction)}
          <button type="button" onClick={() => link.planFromLog(null)} disabled={active}>Cancel</button>
        </p>
      )}
      {plan && (
        <p className="hint" role="status" data-testid="sitl-plan" data-kind={plan.kind}>
          {plan.kind === "repeat"
            ? `Repeat of ${plan.parentName}: the same aircraft profile version, ArduPilot build, speed, home, recording setup and flight task. List the builds, then start it.`
            : `Variant of ${plan.parentName}: its inputs are loaded; change the profile version, the build, the speed or the flight task, then start it. The record lists what changed.`}
          <button type="button" onClick={() => link.planRun(null)} disabled={active}>Cancel the {plan.kind}</button>
        </p>
      )}
      <div className="sitl-actions">
        <button type="button" onClick={start} disabled={busy || batchRunning || !profileSha || !buildId}>
          {plan ? `Start ${plan.kind}` : failed && !external ? "Start again" : "Start SITL run"}
        </button>
        <label htmlFor="sitl-altitude">Take-off altitude, m</label>
        <input id="sitl-altitude" type="text" inputMode="decimal" value={altitude} onChange={event => setAltitude(event.target.value)} />
        <button type="button" onClick={() => controller.current?.takeOff(Number(altitude))} disabled={state.name !== "ready"}>Take off</button>
        <button type="button" onClick={() => controller.current?.land()}
          disabled={state.name !== "running" || (state.flight !== "climbing" && state.flight !== "flying" && state.flight !== "task")}>Land</button>
        <button type="button" onClick={() => controller.current?.pause("user")} disabled={!PAUSABLE_STATES.has(state.name)}>Pause</button>
        <button type="button" onClick={() => { if (controller.current?.resume() === false) setManualRefusal(controller.current.resumeBlocker() ?? ""); else setManualRefusal(""); }}
          disabled={state.name !== "paused"}>
          {state.name === "paused" && state.reason === "accident" ? "Continue after the accident" : "Resume"}
        </button>
        <button type="button" onClick={() => void controller.current?.stop()} disabled={!active && !stopAgain}>
          {external ? (stopAgain ? "Disconnect again" : "Disconnect") : stopAgain ? "Stop again" : "Stop run"}
        </button>
      </div>
      {view?.flightTask && (
        <FlightTaskPanel task={view.flightTask} canRun={state.name === "ready" && view.flightTask.state === "waiting"} refusal={taskRefusal}
          onRun={() => setTaskRefusal(controller.current?.runTask() ?? "")} />
      )}
      <ManualConnect disabled={busy || !profileSha} again={Boolean(failed) && external} onConnect={connect} onError={setError} />
      <ManualControl adapter={adapter} manual={view?.manual ?? null}
        canTake={state.name === "ready" || (state.name === "running" && (state.flight === "climbing" || state.flight === "flying"))}
        onTake={mode => setManualRefusal(controller.current?.takeManual(mode) ?? "No run is active")}
        onRelease={() => setManualRefusal(controller.current?.releaseManual() ?? "")} refusal={manualRefusal} />
      {layout && chosen && (
        <div className="flight-view-area" data-testid="flight-view" data-probe={probe}>
          <FlightView runtime={runtime} layout={layout} name={chosen.record.name} route={route} active={visible} ringTurning={view?.motorCheck?.running === true}
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
        <dt>Simulated time</dt><dd data-testid="sitl-sim-time">{telemetry.simTimeS.toFixed(1)} s</dd>
        {view && <SpeedIndicator speed={view.speed} />}
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
