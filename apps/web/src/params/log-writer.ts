// Saves a run's parameter changes (TASK-160) as versions of its
// `parameter-log` item, so the history persists with the run's experiment
// record. Each version holds every change so far with its latest outcome. One
// save runs at a time; changes that arrive meanwhile are saved after it.
import type { ProjectStore } from "@mirage/project/store";
import type { ControllerView } from "../run/session-controller";
import { saveParameterLog, type ParameterChange } from "./parameter-sets";

interface Pending {
  readonly changes: readonly ParameterChange[];
  readonly experimentId: string;
  readonly experimentSha256: string;
}

export class ParameterLogWriter {
  private head: { readonly id: string; readonly head: string } | null = null;
  /** The changes last handed over, and the ones waiting to be saved. */
  private latest: readonly ParameterChange[] | null = null;
  private pending: Pending | null = null;
  private saving: Promise<void> | null = null;

  constructor(private readonly store: ProjectStore, private readonly projectId: string, private readonly onError: (message: string) => void) {}

  /** Takes a controller view; saves when its changes differ from the last ones handed over. */
  update(view: ControllerView): void {
    const changes = view.parameters?.changes, experimentSha256 = view.recordSha256, first = changes?.[0];
    if (!changes || !first || !experimentSha256 || changes === this.latest) return;
    this.latest = changes;
    this.pending = { changes, experimentId: first.experimentId, experimentSha256 };
    this.saving ??= this.drain();
  }
  /** Resolves once every change handed over is stored. */
  async flush(): Promise<void> {
    while (this.saving) await this.saving;
  }

  private async drain(): Promise<void> {
    try {
      for (let next = this.pending; next; next = this.pending) {
        this.pending = null;
        try {
          const stored = await saveParameterLog(this.store, this.projectId, { schemaVersion: 1, ...next }, this.head);
          this.head = { id: stored.record.id, head: stored.sha256 };
        } catch (cause) {
          this.onError(`The parameter change log could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    } finally {
      this.saving = null;
    }
  }
}
