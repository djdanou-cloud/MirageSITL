// Runs a batch's sets one after another (TASK-176, S12): start a run with the set, fly the task from READY, stop, record what
// happened, and go on. A failed run is recorded and never retried, and it does not stop the sets after it. Nothing here
// looks at a result to choose what runs next: the sets run in the order given, and only those. Cold path, on each change of the run's view.
import { nextSetIndex, type BatchRun, type BatchSet, type ExperimentBatch } from "@mirage/project/batch";

/** What the runner needs to know of the current run. */
export interface RunObservation {
  readonly state: "idle" | "starting" | "loading-parameters" | "warming" | "ready" | "running" | "paused" | "stopping" | "failed";
  /** Why the run failed, in the words the Run tab shows; null unless failed. */
  readonly failure: string | null;
  readonly task: { readonly state: "waiting" | "running" | "done" | "failed"; readonly reason: string | null } | null;
  /** The run paused itself on an accident. */
  readonly accident: boolean;
  readonly recordSha256: string | null;
}
export interface BatchPorts {
  /** Starts a fresh run with this set; the reason when it cannot. */
  start(set: BatchSet): Promise<string | null>;
  /** Flies the run's task; the reason when it cannot. */
  runTask(): string | null;
  stop(): Promise<void>;
  /** Stores the batch as it stands. */
  save(batch: ExperimentBatch): Promise<void>;
  /** The run as it stands, once a start has made its session. */
  current(): RunObservation | null;
}
export type BatchPhase = "waiting" | "starting" | "flying" | "stopping" | "finished";

export class BatchRunner {
  private current: ExperimentBatch;
  private phase: BatchPhase = "waiting";
  /** The run under way has left idle: idle from here on means it is over. */
  private active = false;
  private outcome: { readonly state: "done" } | { readonly state: "failed"; readonly reason: string } | null = null;
  private saved: Promise<void> = Promise.resolve();
  private latest: RunObservation | null = null;
  /** A start is on its way: what the last run's session says now is about that run. */
  private launching = false;

  constructor(batch: ExperimentBatch, private readonly ports: BatchPorts, private readonly changed: (batch: ExperimentBatch, phase: BatchPhase) => void = () => undefined) { this.current = batch; }

  get batch(): ExperimentBatch { return this.current; }
  get state(): BatchPhase { return this.phase; }
  /** The set under way, or next. */
  get setIndex(): number | null { return nextSetIndex(this.current); }

  begin(): void { void this.startNext(); }
  /** Stops the batch: the run under way is stopped and recorded as stopped, and no later set runs. */
  cancel(reason: string): void {
    if (this.phase === "finished") return;
    this.current = { ...this.current, stopped: reason };
    if (this.phase === "flying" || this.phase === "starting") {
      this.outcome = { state: "failed", reason };
      this.stopRun();
    } else if (this.phase === "waiting") this.finish();
    this.notify();
  }
  /** Stored once everything has been written. */
  settled(): Promise<void> { return this.saved; }

  observe(run: RunObservation): void {
    if (this.launching) return;
    this.latest = run;
    if (run.state !== "idle") this.active = true;
    switch (this.phase) {
      case "starting": this.whileStarting(run); return;
      case "flying": this.whileFlying(run); return;
      case "stopping":
        if (run.state === "idle" || run.state === "failed") this.record(this.outcome ?? { state: "failed", reason: "The run ended without a result" }, run);
        return;
      case "waiting": case "finished": return;
      default: { const never: never = this.phase; throw new Error(`Unhandled batch phase ${String(never)}`); }
    }
  }

  private whileStarting(run: RunObservation): void {
    if (run.state === "failed") { this.record({ state: "failed", reason: run.failure ?? "The run failed to start" }, run); return; }
    if (run.state === "idle" && this.active) { this.stoppedFromOutside(run); return; }
    if (run.state !== "ready") return;
    const refusal = this.ports.runTask();
    if (refusal !== null) { this.outcome = { state: "failed", reason: refusal }; this.stopRun(); return; }
    this.phase = "flying";
    this.notify();
  }
  private whileFlying(run: RunObservation): void {
    if (run.state === "failed") { this.record({ state: "failed", reason: run.failure ?? "The run failed" }, run); return; }
    if (run.state === "idle") { this.stoppedFromOutside(run); return; }
    if (run.accident) { this.outcome = { state: "failed", reason: "An accident paused the run" }; this.stopRun(); return; }
    if (run.task?.state === "done") { this.outcome = { state: "done" }; this.stopRun(); return; }
    if (run.task?.state === "failed") { this.outcome = { state: "failed", reason: run.task.reason ?? "The task ended early" }; this.stopRun(); }
  }
  /** Someone stopped the run on the Run tab: that run is over, and the batch stops rather than start another under them. */
  private stoppedFromOutside(run: RunObservation): void {
    const reason = "The run was stopped on the Run tab";
    this.current = { ...this.current, stopped: reason };
    this.record({ state: "failed", reason }, run);
  }
  private stopRun(): void {
    this.phase = "stopping";
    this.notify();
    // The stop's end is the run's end, whatever the view says: a closed Run tab sends no more views.
    this.ports.stop().then(() => {
      if (this.phase === "stopping") this.record(this.outcome ?? { state: "failed", reason: "The run ended without a result" }, this.ports.current() ?? this.latest);
    }, (cause: unknown) => {
      if (this.phase === "stopping") this.record({ state: "failed", reason: `The run could not be stopped: ${cause instanceof Error ? cause.message : String(cause)}` }, this.latest);
    });
  }
  private record(outcome: { readonly state: "done" } | { readonly state: "failed"; readonly reason: string }, run: RunObservation | null): void {
    const setIndex = nextSetIndex({ ...this.current, stopped: null });
    if (setIndex === null) { this.finish(); return; }
    const experimentSha256 = run?.recordSha256 ?? null;
    let entry: BatchRun;
    if (outcome.state === "done" && experimentSha256 !== null) entry = { setIndex, state: "done", experimentSha256 };
    else entry = { setIndex, state: "failed", experimentSha256, reason: outcome.state === "failed" ? outcome.reason : "The run finished without an experiment record" };
    this.current = { ...this.current, runs: [...this.current.runs, entry] };
    this.outcome = null;
    this.active = false;
    this.store();
    void this.startNext();
  }
  private async startNext(): Promise<void> {
    const index = nextSetIndex(this.current), set = index === null ? undefined : this.current.sets[index];
    if (!set) { this.finish(); return; }
    this.phase = "starting";
    this.active = false;
    this.latest = null;
    this.notify();
    this.launching = true;
    // A run that cannot begin is that set's result, and the next set still gets its turn.
    const refusal = await this.ports.start(set).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
    this.launching = false;
    if (this.phase !== "starting") return;
    if (refusal !== null) { this.record({ state: "failed", reason: refusal }, null); return; }
    const now = this.ports.current();
    if (now) this.observe(now);
  }
  private finish(): void {
    this.phase = "finished";
    this.store();
    this.notify();
  }
  private store(): void {
    const batch = this.current;
    this.saved = this.saved.then(() => this.ports.save(batch));
  }
  private notify(): void { this.changed(this.current, this.phase); }
}
