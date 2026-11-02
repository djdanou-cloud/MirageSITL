// What the Logging tab shows of the recording a run is writing now (TASK-163):
// the Run tab's recorder publishes a snapshot about once a second, and the
// tab subscribes. One recording at a time, as one run at a time.

export interface LiveRecording {
  readonly recordId: string;
  /** The launcher experiment or connection ID of the run. */
  readonly experimentId: string;
  readonly state: "recording" | "closed" | "failed";
  /** Simulated time of the latest physics tick, s, and of the first. */
  readonly simTimeS: number;
  readonly startSimTimeS: number;
  /** Wall time of this snapshot and of the recording's start, ms (performance.now). */
  readonly wallMs: number;
  readonly startWallMs: number;
  /** Bytes stored so far, chunk headers included. */
  readonly bytes: number;
  readonly rows: Readonly<Record<string, number>>;
  /** Rows the producer lost (each also a gap in the record) and chunks storage refused. */
  readonly lostRows: number;
  readonly droppedChunks: number;
  /** Why the recording failed, or "". */
  readonly error: string;
}

type Listener = (recording: LiveRecording | null) => void;

class RecordingMonitor {
  private value: LiveRecording | null = null;
  private readonly listeners = new Set<Listener>();
  get current(): LiveRecording | null { return this.value; }
  publish(recording: LiveRecording | null): void {
    this.value = recording;
    for (const listener of this.listeners) listener(recording);
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => { this.listeners.delete(listener); };
  }
}

/** The page's single monitor. */
export const recordingMonitor = new RecordingMonitor();

/** Bytes per simulated second and per wall second so far, or null before a second of either has passed. */
export function growth(recording: LiveRecording): { readonly perSimS: number | null; readonly perWallS: number | null } {
  const sim = recording.simTimeS - recording.startSimTimeS, wall = (recording.wallMs - recording.startWallMs) / 1000;
  return { perSimS: sim >= 1 ? recording.bytes / sim : null, perWallS: wall >= 1 ? recording.bytes / wall : null };
}
