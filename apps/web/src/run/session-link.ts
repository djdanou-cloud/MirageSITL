// The Run tab's current SITL session, shared with the tabs that read it
// (TASK-160): the Parameters tab reads and writes the parameters of the run
// the Run tab owns. The Run tab is the only writer; any tab may subscribe.
// The shell creates one link and passes it to both. The Experiments tab also
// plans the Run tab's next run through it: a repeat or a variant of a stored
// experiment (TASK-165), which the Run tab loads and the user starts.
import type { PlannedRun } from "../experiments/lifecycle";
import type { BatchScenario, BatchSet } from "@mirage/project/batch";
import type { ControllerView, SessionController } from "./session-controller";

export interface LinkedSession {
  readonly controller: SessionController;
  /** The controller's latest view, or null before its first. */
  readonly view: ControllerView | null;
}

/** What a batch (TASK-176) asks of the Run tab, which owns the runs. */
export interface RunDriver {
  /** The Run tab's choices as a batch's scenario, or why a batch cannot start from them. */
  scenario(): { readonly kind: "ready"; readonly scenario: BatchScenario; readonly label: string } | { readonly kind: "refused"; readonly reason: string };
  /** Starts a fresh run with this set as initial parameters; the reason when it cannot. */
  start(set: BatchSet): Promise<string | null>;
  runTask(): string | null;
  stop(): Promise<void>;
}

/** What the Analysis tab reads of the launcher the Run tab talks to (TASK-180). */
export interface LauncherFiles {
  logs(id: string): Promise<{ readonly dataflash: readonly string[]; readonly attachments?: readonly string[] }>;
  dataflash(id: string, name: string): Promise<Uint8Array>;
}

export class SessionLink {
  private current: LinkedSession | null = null;
  private runDriver: RunDriver | null = null;
  private batchIsRunning = false;
  private plannedRun: PlannedRun | null = null;
  private launcherClient: LauncherFiles | null = null;
  private readonly listeners = new Set<() => void>();

  /** The launcher the Run tab last reached; its token stays in the Run tab and in this object, never in a store. */
  get launcher(): LauncherFiles | null { return this.launcherClient; }
  setLauncher(client: LauncherFiles | null): void {
    this.launcherClient = client;
    this.notify();
  }
  /** A new session replaces the previous one: every Start and Connect makes a fresh controller. */
  attach(controller: SessionController): void {
    this.current = { controller, view: null };
    this.notify();
  }
  /** The attached controller's newest view; views of a replaced controller are ignored. */
  publish(controller: SessionController, view: ControllerView): void {
    if (this.current?.controller !== controller) return;
    this.current = { controller, view };
    this.notify();
  }
  /** Plans the Run tab's next run, or clears the plan; the Run tab clears it when the run starts. */
  planRun(plan: PlannedRun | null): void {
    this.plannedRun = plan;
    this.notify();
  }
  /** The Run tab offers its runs to a batch. */
  setDriver(driver: RunDriver | null): void { this.runDriver = driver; this.notify(); }
  readonly driver = (): RunDriver | null => this.runDriver;
  /** A batch owns the Run tab's starts while it runs. */
  setBatchRunning(running: boolean): void { this.batchIsRunning = running; this.notify(); }
  readonly batchRunning = (): boolean => this.batchIsRunning;
  /** For useSyncExternalStore: the planned run. */
  readonly plan = (): PlannedRun | null => this.plannedRun;
  /** For useSyncExternalStore: the snapshot changes identity on every attach and publish. */
  readonly snapshot = (): LinkedSession | null => this.current;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
