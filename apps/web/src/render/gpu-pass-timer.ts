// Opt-in per-pass GPU timing for the WebGL2 G3 passes (`?g3profile=1`,
// TASK-073 diagnostics). Each pass is wrapped in an
// EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query from a fixed pool;
// results are read a few frames later, when available, and averaged over a
// rolling window. Disjoint intervals (GPU clock changes) are discarded.
// Only one query may be active at a time, so passes must not nest.

const POOL = 8; // queries per pass: results lag a few frames behind
const WINDOW = 120; // frames averaged per pass

export const G3_PASSES = ["fpvScene", "fisheye", "analog", "chaseScene", "gbuffer", "thermal", "present"] as const;
export type G3Pass = (typeof G3_PASSES)[number];

interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export class GpuPassTimer {
  /** Mean GPU time per pass over the last WINDOW measured frames, ms. */
  readonly meanMs: Record<G3Pass, number> = { fpvScene: 0, fisheye: 0, analog: 0, chaseScene: 0, gbuffer: 0, thermal: 0, present: 0 };
  private readonly queries: WebGLQuery[][] = [];
  private readonly pending: boolean[][] = [];
  private readonly next: number[] = [];
  private readonly samples: Float64Array[] = [];
  private readonly sampleCount: number[] = [];
  private active = -1;

  private constructor(private readonly gl: WebGL2RenderingContext, private readonly ext: TimerExt) {
    for (let p = 0; p < G3_PASSES.length; p++) {
      const pool: WebGLQuery[] = [];
      for (let i = 0; i < POOL; i++) { const q = gl.createQuery(); if (!q) throw new Error("Cannot create a WebGL query"); pool.push(q); }
      this.queries.push(pool);
      this.pending.push(new Array<boolean>(POOL).fill(false));
      this.next.push(0);
      this.samples.push(new Float64Array(WINDOW));
      this.sampleCount.push(0);
    }
  }

  /** The timer, or null when the extension is unavailable. */
  static create(gl: WebGL2RenderingContext): GpuPassTimer | null {
    const ext: unknown = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (typeof ext !== "object" || ext === null || !("TIME_ELAPSED_EXT" in ext) || !("GPU_DISJOINT_EXT" in ext)) return null;
    const { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT } = ext;
    if (typeof TIME_ELAPSED_EXT !== "number" || typeof GPU_DISJOINT_EXT !== "number") return null;
    return new GpuPassTimer(gl, { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT });
  }

  begin(pass: G3Pass): void {
    const p = G3_PASSES.indexOf(pass), slot = this.next[p]!; // p < G3_PASSES.length
    if (this.active >= 0 || this.pending[p]![slot]) return; // a busy slot skips this frame's sample
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.queries[p]![slot]!);
    this.active = p;
  }

  end(): void {
    if (this.active < 0) return;
    const p = this.active;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending[p]![this.next[p]!] = true;
    this.next[p] = (this.next[p]! + 1) % POOL;
    this.active = -1;
  }

  /** Reads finished queries into the rolling means (call once per frame, outside any pass). */
  poll(): void {
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) === true;
    for (let p = 0; p < G3_PASSES.length; p++) {
      for (let i = 0; i < POOL; i++) {
        if (!this.pending[p]![i]) continue;
        const q = this.queries[p]![i]!;
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) !== true) continue;
        const ns: unknown = gl.getQueryParameter(q, gl.QUERY_RESULT);
        this.pending[p]![i] = false;
        if (disjoint || typeof ns !== "number") continue;
        this.samples[p]![this.sampleCount[p]! % WINDOW] = ns / 1e6;
        this.sampleCount[p]!++;
      }
      const n = Math.min(WINDOW, this.sampleCount[p]!);
      let sum = 0;
      for (let k = 0; k < n; k++) sum += this.samples[p]![k]!;
      this.meanMs[G3_PASSES[p]!] = n > 0 ? sum / n : 0;
    }
  }

  dispose(): void {
    for (const pool of this.queries) for (const q of pool) this.gl.deleteQuery(q);
  }
}
