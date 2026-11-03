// The Run tab's current SITL session, shared with the tabs that read it
// (TASK-160): the Parameters tab reads and writes the parameters of the run
// the Run tab owns. The Run tab is the only writer; any tab may subscribe.
// The shell creates one link and passes it to both. The Experiments tab also
// plans the Run tab's next run through it: a repeat or a variant of a stored
// experiment (TASK-165), which the Run tab loads and the user starts.
import type { PlannedRun } from "../experiments/lifecycle";
import type { ControllerView, SessionController } from "./session-controller";

export interface LinkedSession {
  readonly controller: SessionController;
  /** The controller's latest view, or null before its first. */
  readonly view: ControllerView | null;
}

export class SessionLink {
  private current: LinkedSession | null = null;
  private plannedRun: PlannedRun | null = null;
  private readonly listeners = new Set<() => void>();

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
