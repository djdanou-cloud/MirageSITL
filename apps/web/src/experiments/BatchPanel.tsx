import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { COMPARISON_BAND, experimentMetrics, flightDurationEstimate, type ExperimentMetrics } from "@mirage/analysis/metrics";
import { reopenRecording } from "@mirage/aar/recorder-v2-host";
import { FRAME_PARAMETER_NAMES } from "@mirage/aircraft/frame-parameters";
import { PWM_PARAMETER_NAMES, readExperiment } from "@mirage/aircraft/experiment";
import { SITE_PARAMETER_NAMES } from "@mirage/aircraft/site-parameters";
import { batchDependencies, readExperimentBatch, type BatchSet, type ExperimentBatch } from "@mirage/project/batch";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import { MANEUVER_TYPES, isManeuverType } from "@mirage/scenarios/maneuvers";
import type { SessionLink } from "../run/session-link";
import { failureText, type ControllerView } from "../run/session-controller";
import { batchSetOfText } from "./batch-form";
import { BatchRunner, type BatchPhase, type RunObservation } from "./batch-runner";

// A batch of parameter sets on the Experiments tab (TASK-176, S12). The user supplies the sets. One scenario, as chosen on the Run
// tab, runs once for each, in order, with every other input identical; each set's values are the run's initial parameters, so
// its experiment record holds them and ArduPilot confirms them. The results collect here. It never searches for values,
// retries a failed run, or says which set is better or fit for real flight.

const PROFILE_OWNED: ReadonlySet<string> = new Set([...FRAME_PARAMETER_NAMES, ...PWM_PARAMETER_NAMES, ...SITE_PARAMETER_NAMES]);
const FIRST_SETS = [{ name: "Set 1", text: "" }, { name: "Set 2", text: "" }];
const DURATION_RESERVE_PERCENT = 20;

export function observationOf(view: ControllerView | null | undefined): RunObservation {
  if (!view) return { state: "idle", failure: null, task: null, accident: false, recordSha256: null };
  const { state, flightTask } = view;
  return {
    state: state.name, failure: state.name === "failed" ? failureText(state.reason) : null,
    task: flightTask ? { state: flightTask.state, reason: flightTask.reason } : null, accident: state.name === "paused" && state.reason === "accident", recordSha256: view.recordSha256,
  };
}
interface Result {
  readonly metrics: ExperimentMetrics | null;
  readonly name: string;
  /** What a maneuver's request is in; null for any other task. */
  readonly responseUnit: string | null;
}
const number = (value: number | null | undefined, digits: number): string => (value === null || value === undefined ? "missing" : value.toFixed(digits));

export function BatchPanel({ store, projectId, link, active, onChanged }: { store: ProjectStore; projectId: string; link: SessionLink; active: boolean; onChanged: () => void }) {
  const driver = useSyncExternalStore(link.subscribe, link.driver);
  const [rows, setRows] = useState<readonly { readonly name: string; readonly text: string }[]>(FIRST_SETS);
  const [problem, setProblem] = useState("");
  const [batches, setBatches] = useState<readonly StoredVersion[]>([]);
  const [shown, setShown] = useState<ExperimentBatch | null>(null);
  const [phase, setPhase] = useState<BatchPhase>("finished");
  const [results, setResults] = useState<ReadonlyMap<string, Result>>(new Map());
  const [reload, setReload] = useState(0);
  const runner = useRef<BatchRunner | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    store.listItems(projectId, "experiment-batch").then(list => { if (!cancelled) setBatches(list); }, (cause: unknown) => { if (!cancelled) setProblem(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [store, projectId, active, reload]);
  // The run tells the runner directly, whatever tab is open: a batch goes on while another is shown.
  useEffect(() => link.subscribe(() => { runner.current?.observe(observationOf(link.snapshot()?.view)); }), [link]);

  // The Run tab's SITL panel owns the runs: a batch does not outlive it.
  useEffect(() => { if (!driver) runner.current?.cancel("The Run tab's ArduPilot SITL panel was closed"); }, [driver]);

  const parsed = useMemo(() => rows.map(row => batchSetOfText(row.name, row.text, PROFILE_OWNED)), [rows]);
  const sets = parsed.flatMap(item => (item.set ? [item.set] : []));
  const names = new Set(sets.map(set => set.name));
  const formProblems = [...parsed.flatMap(item => (item.problem ? [item.problem] : [])), ...(names.size !== sets.length ? ["Each set needs its own name"] : [])];
  const scenario = driver?.scenario() ?? { kind: "refused" as const, reason: "Open the Run tab to set up a run" };
  const running = phase !== "finished";
  const startable = !running && scenario.kind === "ready" && formProblems.length === 0 && sets.length > 0;

  // What a stored or running batch's experiments did, read from their recordings once they finish.
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    const wanted = shown.runs.flatMap(run => (run.experimentSha256 === null ? [] : [run.experimentSha256])).filter(sha => !results.has(sha));
    if (wanted.length === 0) return;
    void Promise.all(wanted.map(async (sha): Promise<[string, Result]> => {
      const stored = await store.get(sha), payload = readExperiment(stored);
      const metrics = payload.recording ? experimentMetrics((await reopenRecording(payload.recording.recordId)).rows, payload.flightTask?.definition ?? null) : null;
      const type = payload.flightTask?.definition.type;
      return [sha, { metrics, name: stored.record.name, responseUnit: type !== undefined && isManeuverType(type) ? (MANEUVER_TYPES[type].axis === "altitude" ? "m" : "°") : null }];
    })).then(entries => { if (!cancelled) setResults(previous => new Map([...previous, ...entries])); }, () => undefined);
    return () => { cancelled = true; };
  }, [store, shown, results]);

  // A batch flies one scenario, so its runs answer the same changes, in the same order.
  const responses = (shown?.sets ?? []).flatMap((set, setIndex) => {
    const run = shown?.runs.find(item => item.setIndex === setIndex);
    const result = run?.state === "done" ? results.get(run.experimentSha256) : undefined, response = result?.metrics?.response;
    return result && response ? [{ set, setIndex, response, unit: result.responseUnit }] : [];
  });
  const responseUnit = responses[0]?.unit ?? "";

  const start = () => {
    if (scenario.kind !== "ready" || !driver) return;
    setProblem("");
    const first: ExperimentBatch = { schemaVersion: 1, scenario: scenario.scenario, sets, runs: [], stopped: null };
    let stored: StoredVersion | null = null;
    const save = async (batch: ExperimentBatch): Promise<void> => {
      const draft = { name: `Batch of ${batch.sets.length} sets, ${scenario.label}`, payload: batch, dependencies: batchDependencies(batch) };
      stored = stored ? await store.saveVersion(stored.record.id, stored.sha256, draft) : await store.createItem(projectId, "experiment-batch", draft);
      setReload(value => value + 1);
      // A run has finished, so the tab has another experiment to list and compare.
      onChanged();
    };
    link.setBatchRunning(true);
    const next = new BatchRunner(first, {
      start: (set: BatchSet) => driver.start(set),
      runTask: () => driver.runTask(),
      stop: () => driver.stop(),
      save,
      current: () => observationOf(link.snapshot()?.view),
    }, (batch, nextPhase) => {
      setShown(batch);
      setPhase(nextPhase);
      if (nextPhase === "finished") link.setBatchRunning(false);
    });
    runner.current = next;
    setShown(first);
    setPhase("starting");
    void save(first).then(() => next.begin(), (cause: unknown) => {
      setProblem(cause instanceof Error ? cause.message : String(cause));
      setPhase("finished");
      link.setBatchRunning(false);
    });
  };
  const open = (version: StoredVersion) => {
    try { setShown(readExperimentBatch(version)); } catch (cause) { setProblem(cause instanceof Error ? cause.message : String(cause)); }
  };
  const underWay = runner.current && running ? runner.current.setIndex : null;
  return (
    <section className="project-section compare-panel" aria-labelledby="batch-heading" data-testid="batch-panel">
      <h3 id="batch-heading">Run a batch of parameter sets</h3>
      <p className="hint">
        You supply the sets. The scenario chosen on the Run tab runs once for each, in the order given, with every other input the same, and the results collect here.
        A failed run is recorded and not tried again, and the next set still runs. MirageSITL does not look for better values, and it does not say that any set is fit for real flight.
      </p>
      <p className="hint" data-testid="batch-scenario">{scenario.kind === "ready" ? `Scenario, from the Run tab: ${scenario.label}.` : scenario.reason}</p>
      {rows.map((row, index) => (
        <div key={index} className="sitl-form" data-testid="batch-set">
          <label htmlFor={`batch-set-name-${index}`}>{`Set ${index + 1} name`}</label>
          <input id={`batch-set-name-${index}`} type="text" value={row.name} disabled={running} onChange={event => setRows(rows.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))} />
          <label htmlFor={`batch-set-text-${index}`}>{`Set ${index + 1} parameters`}</label>
          <textarea id={`batch-set-text-${index}`} rows={3} value={row.text} disabled={running} placeholder="NAME,VALUE on each line, as in a parameter file" onChange={event => setRows(rows.map((item, i) => (i === index ? { ...item, text: event.target.value } : item)))} />
        </div>
      ))}
      <div className="sitl-actions">
        <button type="button" disabled={running} onClick={() => setRows([...rows, { name: `Set ${rows.length + 1}`, text: "" }])}>Add a set</button>
        <button type="button" disabled={running || rows.length <= 1} onClick={() => setRows(rows.slice(0, -1))}>Remove the last set</button>
        <button type="button" disabled={!startable} onClick={start}>Run the batch</button>
        <button type="button" disabled={!running} onClick={() => runner.current?.cancel("You stopped the batch")}>Stop the batch</button>
      </div>
      <p className="hint">A set&apos;s values are the run&apos;s initial parameters: ArduPilot boots with them and confirms them, and the experiment record holds them. An empty set runs the scenario as it stands, for comparison.</p>
      {formProblems.length > 0 && <ul className="form-errors" aria-label="Problems with the sets" data-testid="batch-problems">{formProblems.map(item => <li key={item}>{item}</li>)}</ul>}
      {problem && <p className="alert" role="alert">{problem}</p>}
      {shown && (
        <div data-testid="batch-result" data-phase={running ? phase : "finished"}>
          <h4>Results</h4>
          {shown.stopped && <p className="alert" data-testid="batch-stopped">{shown.stopped}</p>}
          <div className="table-scroll">
            <table aria-label="The batch's runs" data-testid="batch-runs">
              <thead><tr><th scope="col">Set</th><th scope="col">Run</th><th scope="col" className="compare-number">Highest above where it stood, m</th><th scope="col" className="compare-number">Mean current, A</th><th scope="col" className="compare-number">Energy, Wh</th>{responses.length === 0 && <th scope="col" className="compare-number">Altitude RMS, m</th>}<th scope="col" className="compare-number">{`Minutes to a ${DURATION_RESERVE_PERCENT} % reserve`}</th></tr></thead>
              <tbody>
                {shown.sets.map((set, index) => {
                  const run = shown.runs.find(item => item.setIndex === index);
                  const result = run?.experimentSha256 ? results.get(run.experimentSha256) : undefined, metrics = result?.metrics ?? null;
                  const window = metrics?.task ?? metrics?.wholeFlight ?? null;
                  const duration = window && metrics?.pack ? flightDurationEstimate(window, metrics.pack, DURATION_RESERVE_PERCENT) : null;
                  const stateText = run ? (run.state === "done" ? "Finished" : `Failed: ${run.reason}`) : underWay === index ? "Running" : "Waiting";
                  return (
                    <tr key={set.name} data-set={index} data-state={run?.state ?? (underWay === index ? "running" : "waiting")} data-experiment={run?.experimentSha256 ?? ""}>
                      <th scope="row">{set.name}</th>
                      <td>{stateText}{result ? `, ${result.name}` : ""}</td>
                      <td className="compare-number">{run?.state === "done" ? number(metrics?.flight?.highestAboveRestM, 2) : ""}</td>
                      <td className="compare-number">{run?.state === "done" ? number(window?.current?.mean, 2) : ""}</td>
                      <td className="compare-number">{run?.state === "done" ? number(window?.energyWh, 3) : ""}</td>
                      {responses.length === 0 && <td className="compare-number">{run?.state === "done" ? number(metrics?.position?.altitudeRmsM, 3) : ""}</td>}
                      <td className="compare-number">{run?.state === "done" ? number(duration?.minutes, 1) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {responses.length > 0 && (
            <div className="table-scroll">
              <table aria-label="The response of each run to each change it was asked for" data-testid="batch-response">
                <thead>
                  <tr>
                    <th scope="col">{`Change, ${responseUnit}`}</th><th scope="col">Set</th><th scope="col" className="compare-number">Rise time, s</th><th scope="col" className="compare-number">Overshoot, %</th>
                    <th scope="col" className="compare-number">Settling, s</th><th scope="col" className="compare-number">{`End error, ${responseUnit}`}</th>
                  </tr>
                </thead>
                <tbody>
                  {(responses[0]?.response ?? []).flatMap((_, edgeIndex) => responses.flatMap(({ set, setIndex, response }) => {
                    const edge = response[edgeIndex];
                    if (!edge) return [];
                    return [(
                      <tr key={`${edgeIndex}-${setIndex}`} data-set={setIndex} data-edge={edgeIndex}>
                        <th scope="row">{`${edge.from.toFixed(1)} to ${edge.to.toFixed(1)}`}</th>
                        <td>{set.name}</td>
                        <td className="compare-number">{number(edge.riseTimeS, 3)}</td>
                        <td className="compare-number">{number(edge.overshootPercent, 1)}</td>
                        <td className="compare-number">{number(edge.settlingTimeS, 3)}</td>
                        <td className="compare-number">{number(edge.endError, 2)}</td>
                      </tr>
                    )];
                  }))}
                </tbody>
              </table>
            </div>
          )}
          {responses.length > 0 && <p className="hint">{`Settling is to within ${COMPARISON_BAND * 100} % of the change requested. A chart of each run is under its experiment above.`}</p>}
          <p className="hint">These describe each run; you decide what they mean. Any two can be compared in full above.</p>
        </div>
      )}
      {batches.length > 0 && (
        <>
          <h4>Batches of this project</h4>
          <ul data-testid="batch-list">
            {batches.map(version => <li key={version.record.id}><button type="button" className="link-button" onClick={() => open(version)}>{version.record.name}</button> <span className="hint">{version.record.createdAt.replace("T", " ").slice(0, 19)}</span></li>)}
          </ul>
        </>
      )}
    </section>
  );
}
