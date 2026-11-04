import { Fragment, useEffect, useMemo, useState } from "react";
import type { StoredVersion } from "@mirage/project/schema";
import { FLIGHT_TASK_PARAMETERS, FLIGHT_TASK_TYPES, SETTLE_S } from "@mirage/scenarios/flight-tasks";
import type { StoreState } from "../shell/AppShell";
import {
  PARAMETER_LABELS, TASK_TYPE_LABELS, formOf, formProblems, newTaskForm, planLines, readFlightTask, saveFlightTask, taskOfForm, withType, type TaskForm,
} from "./flight-task-form";
import { RouteEditor } from "./RouteEditor";

// The Flight tasks tab (TASK-172, S10): repeatable tasks as versioned items of
// the project. A task names what to fly, from what initial conditions and how
// it ends; the Run tab flies a stored task and shows requested against actual,
// and the experiment record keeps the definition. Mass and payload belong to
// the aircraft profile. Ground values apply at the start tick. ArduPilot needs
// about 41 s of simulated time before it can fly, so an airborne start is a
// lead-in it flies, with the task's clock starting on arrival.

type TextField = "groundNorthM" | "groundEastM" | "groundHeadingDeg" | "groundChargePercent" | "airAltitudeM" | "airHeadingDeg" | "airSpeedMps";

export function FlightTasksTab({ storeState, project, active }: { storeState: StoreState; project: StoredVersion | null; active: boolean }) {
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;
  const [tasks, setTasks] = useState<readonly StoredVersion[]>([]);
  const [selected, setSelected] = useState<StoredVersion | null>(null);
  const [name, setName] = useState("");
  const [form, setForm] = useState<TaskForm>(() => newTaskForm());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!store || !projectId || !active) return;
    let cancelled = false;
    store.listItems(projectId, "flight-task").then(list => { if (!cancelled) setTasks(list); },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [store, projectId, active, reload]);

  const problems = useMemo(() => formProblems(form), [form]);
  const plan = useMemo(() => (problems.length === 0 ? planLines(taskOfForm(form)) : []), [form, problems]);
  const open = (stored: StoredVersion) => {
    setError(""); setNotice("");
    try {
      setForm(formOf(readFlightTask(stored)));
      setSelected(stored);
      setName(stored.record.name);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const startNew = () => { setSelected(null); setName(""); setForm(newTaskForm()); setNotice(""); setError(""); };
  const save = () => {
    if (!store || !projectId) return;
    setError(""); setNotice("");
    const previous = selected ? { id: selected.record.id, head: selected.sha256 } : null;
    saveFlightTask(store, projectId, name, taskOfForm(form), previous).then(stored => {
      setSelected(stored);
      setNotice(`Saved ${stored.record.name}, version ${stored.record.version}.`);
      setReload(value => value + 1);
    }, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const text = (key: TextField, label: string) => (
    <>
      <label htmlFor={`task-${key}`}>{label}</label>
      <input id={`task-${key}`} type="text" inputMode="decimal" value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} />
    </>
  );
  if (!project) return <p className="hint">Open a project on the Project tab to define flight tasks.</p>;
  const limits: Readonly<Record<string, readonly [number, number]>> = FLIGHT_TASK_PARAMETERS[form.type];
  return (
    <div className="project-panel">
      <h2>Flight tasks</h2>
      <div className="project-grid">
      <section className="project-section" aria-labelledby="tasks-heading">
        <h3 id="tasks-heading">Flight tasks of this project</h3>
        {tasks.length === 0 && <p className="hint">No flight task yet.</p>}
        <ul data-testid="task-list">
          {tasks.map(stored => (
            <li key={stored.record.id}>
              <button type="button" onClick={() => open(stored)}>{stored.record.name}</button> <span className="hint">version {stored.record.version}</span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={startNew}>New flight task</button>
      </section>
      <section className="project-section" aria-labelledby="task-edit-heading">
        <h3 id="task-edit-heading">{selected ? `Edit ${selected.record.name}` : "New flight task"}</h3>
        <div className="sitl-form">
          <label htmlFor="task-name">Task name</label>
          <input id="task-name" type="text" value={name} onChange={event => setName(event.target.value)} />
          <label htmlFor="task-type">Task type</label>
          <select id="task-type" value={form.type} onChange={event => { const type = FLIGHT_TASK_TYPES.find(item => item === event.target.value); if (type) setForm(withType(form, type)); }}>
            {FLIGHT_TASK_TYPES.map(type => <option key={type} value={type}>{TASK_TYPE_LABELS[type]}</option>)}
          </select>
          {Object.keys(limits).map(key => (
            <Fragment key={key}>
              <label htmlFor={`task-parameter-${key}`}>{PARAMETER_LABELS[key] ?? key}</label>
              <input id={`task-parameter-${key}`} type="text" inputMode="decimal" value={form.parameters[key] ?? ""}
                onChange={event => setForm({ ...form, parameters: { ...form.parameters, [key]: event.target.value } })} />
            </Fragment>
          ))}
          <label htmlFor="task-finish">After the task</label>
          <select id="task-finish" value={form.finish} disabled={form.type === "landing"} onChange={event => setForm({ ...form, finish: event.target.value === "hold" ? "hold" : "land" })}>
            <option value="land">Land and disarm</option>
            <option value="hold">Hold where it ended</option>
          </select>
        </div>
        {form.type === "route" && <RouteEditor rows={form.route} onChange={route => setForm({ ...form, route })} />}
        <h4>Initial conditions</h4>
        <p className="hint">On the ground, at the first physics step, before arming. Mass and payload belong to the aircraft profile.</p>
        <div className="sitl-form">
          {text("groundNorthM", "Start north of the pad (m)")}
          {text("groundEastM", "Start east of the pad (m)")}
          {text("groundHeadingDeg", "Start heading (°)")}
          {text("groundChargePercent", "Battery charge (%)")}
          <label htmlFor="task-airborne">Start in the air</label>
          <input id="task-airborne" type="checkbox" checked={form.airborne} disabled={form.type === "route"} onChange={event => setForm({ ...form, airborne: event.target.checked })} />
          {form.airborne && text("airAltitudeM", "Arrive at altitude (m)")}
          {form.airborne && text("airHeadingDeg", "Arrive on heading (°)")}
          {form.airborne && text("airSpeedMps", "Arrive at speed (m/s)")}
        </div>
        <p className="hint">
          ArduPilot needs about 41 s of simulated time before it can fly, so nothing can be placed in the air at the first step. An airborne start is a lead-in:
          ArduPilot takes off and flies to these values, and the task&apos;s clock starts on arrival, with requested and actual shown there. Without one, the lead-in goes to the
          state the task&apos;s own numbers start from. {form.type === "route" ? "A route starts from the ground." : ""}
        </p>
        {problems.length > 0 && <ul className="alert" aria-label="Problems to fix before saving">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
        {plan.length > 0 && (
          <>
            <h4>What ArduPilot will be asked to fly</h4>
            <ol data-testid="task-plan">
              {plan.map((line, index) => <li key={index} data-measured={line.measured}>{line.text}{line.measured ? " (the task, measured)" : ""}</li>)}
            </ol>
            <p className="hint" data-testid="task-plan-smooth">
              No aircraft changes speed at once, so every change starts and stops smoothly within ArduPilot&apos;s own limits (WP_ACC_Z, PSC_D_JERK, PSC_NE_JERK, ATC_ACC_Y_MAX).
              The requested values a run shows are that smooth path: a rate is reached after a short ramp, and each stage holds its end for {SETTLE_S} s so any overshoot is measured.
            </p>
          </>
        )}
        <button type="button" onClick={save} disabled={problems.length > 0 || name.trim() === ""}>Save flight task</button>
        {notice && <p role="status" data-testid="task-status">{notice}</p>}
        {error && <p className="alert" role="alert">{error}</p>}
      </section>
      </div>
    </div>
  );
}
