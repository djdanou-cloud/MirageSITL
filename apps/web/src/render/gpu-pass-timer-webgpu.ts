// Opt-in per-pass GPU timing for the WebGPU G3 passes (`?g3profile=1`,
// TASK-073 diagnostics), the WebGPU counterpart of gpu-pass-timer.ts. With
// timestamp tracking on, three's WebGPU backend gives every render pass a
// begin/end timestamp pair from its "render" query pool, allocated in
// submission order. Reading the pool's allocation index before and after a G3
// pass attributes the pairs in between to that pass (one scene render can open
// several passes: shadow map, scene, output conversion). Once per frame the
// timer resolves the pool into its own buffers and resets the pool the way
// three's own resolve does; three's resolve (renderer.resolveTimestampsAsync)
// sums every pair into one number and must not run while this timer is active.
// The pool fields are three r180 internals, checked at runtime: without them
// the timer is not created. Chrome quantizes WebGPU timestamps to 0.1 ms unless
// WebGPU developer features are enabled.
import { G3_PASSES, type G3Pass } from "./gpu-pass-timer";

const WINDOW = 120; // frames averaged per pass, as the WebGL2 timer
/** Frames kept in the per-frame log (about 4.5 min at 60 Hz, one lap of the scripted circuit). */
export const LOG_FRAMES = 16384;
/** Pass ranges waiting for a resolve; a stalled read stops recording instead of growing. */
const MAX_RANGES = 1024;
/** three r180 creates its render timestamp pool with 2048 queries. */
const POOL_QUERIES = 2048;
/** Queries left free while a read is in flight (one G3 frame opens about two dozen). */
const QUERY_HEADROOM = 256;

/** One G3 pass's query range [start, end) in the pool, in submission order. */
export interface PassRanges {
  count: number;
  readonly frame: Int32Array;
  readonly pass: Int32Array;
  readonly start: Int32Array;
  readonly end: Int32Array;
}

export function newPassRanges(capacity: number): PassRanges {
  return { count: 0, frame: new Int32Array(capacity), pass: new Int32Array(capacity), start: new Int32Array(capacity), end: new Int32Array(capacity) };
}

/**
 * Per-frame GPU time of each pass (ms, frame-major in G3_PASSES order), the frame's span from its first
 * pass begin to its last pass end (ms, includes GPU idle between passes) and the timer's frame number.
 */
export interface PassLog { frames: number; readonly passMs: Float32Array; readonly spanMs: Float32Array; readonly frame: Int32Array }

export function newPassLog(): PassLog {
  return { frames: 0, passMs: new Float32Array(LOG_FRAMES * G3_PASSES.length), spanMs: new Float32Array(LOG_FRAMES), frame: new Int32Array(LOG_FRAMES) };
}

/**
 * Sums the resolved timestamp pairs (ns) of each range into its frame's log row. Pairs that were never
 * written (zero) or run backwards are skipped. Returns the number of frames written.
 */
export function attributePasses(times: ArrayLike<bigint>, ranges: PassRanges, log: PassLog): number {
  const passes = G3_PASSES.length;
  let written = 0, current = -1, row = 0, first = 0n, last = 0n;
  const close = () => {
    if (current < 0) return;
    log.spanMs[row] = last > first ? Number(last - first) / 1e6 : 0;
    log.frames++;
    written++;
  };
  for (let r = 0; r < ranges.count; r++) {
    const frame = ranges.frame[r] ?? -1, pass = ranges.pass[r] ?? -1; // r < count <= capacity
    if (frame !== current) {
      close();
      current = frame;
      row = log.frames % LOG_FRAMES;
      log.passMs.fill(0, row * passes, row * passes + passes);
      log.frame[row] = frame;
      first = 0n; last = 0n;
    }
    const end = ranges.end[r] ?? 0;
    for (let q = ranges.start[r] ?? 0; q + 1 < end; q += 2) {
      const b = times[q], e = times[q + 1];
      if (b === undefined || e === undefined || b === 0n || e < b) continue;
      if (pass >= 0 && pass < passes) log.passMs[row * passes + pass] = (log.passMs[row * passes + pass] ?? 0) + Number(e - b) / 1e6;
      if (first === 0n || b < first) first = b;
      if (e > last) last = e;
    }
  }
  close();
  return written;
}

/** The parts of three's render timestamp pool the timer reads and resets. */
interface PoolAccess { readonly querySet: GPUQuerySet; index(): number; reset(): void }

function poolAccess(backend: object): PoolAccess | null {
  const pools: unknown = Reflect.get(backend, "timestampQueryPool");
  if (typeof pools !== "object" || pools === null) return null;
  const pool: unknown = Reflect.get(pools, "render");
  if (typeof pool !== "object" || pool === null) return null;
  const querySet: unknown = Reflect.get(pool, "querySet"), offsets: unknown = Reflect.get(pool, "queryOffsets");
  if (typeof GPUQuerySet === "undefined" || !(querySet instanceof GPUQuerySet) || !(offsets instanceof Map) || typeof Reflect.get(pool, "currentQueryIndex") !== "number") return null;
  return {
    querySet,
    index: () => { const value: unknown = Reflect.get(pool, "currentQueryIndex"); return typeof value === "number" ? value : 0; },
    reset: () => { Reflect.set(pool, "currentQueryIndex", 0); offsets.clear(); },
  };
}

export class WebGpuPassTimer {
  /** Mean GPU time per pass over the last WINDOW measured frames, ms. */
  readonly meanMs: Record<G3Pass, number> = { fpvScene: 0, fisheye: 0, analog: 0, chaseScene: 0, gbuffer: 0, thermal: 0, present: 0 };
  /** The most recent LOG_FRAMES measured frames (ring; row = log.frames modulo LOG_FRAMES). */
  readonly log = newPassLog();
  private pool: PoolAccess | null = null;
  private active = -1;
  private activeStart = -1;
  private frame = 0;
  private pending = newPassRanges(MAX_RANGES);
  private flight = newPassRanges(MAX_RANGES);
  private reading = false;
  private disposed = false;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readBuffer: GPUBuffer;

  private constructor(private readonly device: GPUDevice, private readonly backend: object) {
    this.resolveBuffer = device.createBuffer({ label: "g3-pass-timer-resolve", size: POOL_QUERIES * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readBuffer = device.createBuffer({ label: "g3-pass-timer-read", size: POOL_QUERIES * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  /** Turns on three's timestamp tracking; null without the timestamp-query feature or three's tracking switch. */
  static create(device: GPUDevice, backend: object): WebGpuPassTimer | null {
    if (!device.features.has("timestamp-query") || typeof Reflect.get(backend, "trackTimestamp") !== "boolean") return null;
    Reflect.set(backend, "trackTimestamp", true);
    return new WebGpuPassTimer(device, backend);
  }

  begin(pass: G3Pass): void {
    this.pool ??= poolAccess(this.backend);
    this.active = G3_PASSES.indexOf(pass);
    this.activeStart = this.pool ? this.pool.index() : -1;
  }

  end(): void {
    const pass = this.active;
    this.active = -1;
    // three creates the pool during the first timed pass, so that pass's queries start at 0.
    this.pool ??= poolAccess(this.backend);
    const ranges = this.pending;
    if (pass < 0 || !this.pool || ranges.count >= MAX_RANGES) return;
    const start = Math.max(0, this.activeStart), end = this.pool.index();
    if (end <= start) return;
    const r = ranges.count++;
    ranges.frame[r] = this.frame; ranges.pass[r] = pass; ranges.start[r] = start; ranges.end[r] = end;
  }

  /** Call once per frame after the last pass: resolves the frame's queries unless a read is still in flight. */
  endFrame(): void {
    this.frame++;
    const pool = this.pool;
    if (this.disposed || !pool) return;
    if (this.reading) {
      // Once three's pool is full its later passes write over the first query pair; pause tracking until the read returns.
      if (pool.index() > POOL_QUERIES - QUERY_HEADROOM) Reflect.set(this.backend, "trackTimestamp", false);
      return;
    }
    if (this.pending.count === 0) return;
    const count = Math.min(pool.index(), POOL_QUERIES);
    if (count === 0) return;
    const encoder = this.device.createCommandEncoder({ label: "g3-pass-timer" });
    encoder.resolveQuerySet(pool.querySet, 0, count, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, count * 8);
    this.device.queue.submit([encoder.finish()]);
    // The copy is queued behind every pass that wrote these queries, so the pool can be reused at once.
    pool.reset();
    const flight = this.flight;
    this.flight = this.pending;
    this.pending = flight;
    this.pending.count = 0;
    this.reading = true;
    this.readBuffer.mapAsync(GPUMapMode.READ, 0, count * 8).then(() => {
      if (!this.disposed) {
        attributePasses(new BigUint64Array(this.readBuffer.getMappedRange(0, count * 8)), this.flight, this.log);
        this.updateMeans();
        this.readBuffer.unmap();
        Reflect.set(this.backend, "trackTimestamp", true);
      }
      this.reading = false;
    }, () => { this.reading = false; });
  }

  private updateMeans(): void {
    const passes = G3_PASSES.length, n = Math.min(WINDOW, this.log.frames);
    G3_PASSES.forEach((name, p) => {
      let sum = 0;
      for (let k = 1; k <= n; k++) sum += this.log.passMs[((this.log.frames - k) % LOG_FRAMES) * passes + p] ?? 0;
      this.meanMs[name] = n > 0 ? sum / n : 0;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    Reflect.set(this.backend, "trackTimestamp", false);
    this.resolveBuffer.destroy();
    this.readBuffer.destroy();
  }
}
