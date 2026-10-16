// Terrain LOD and GPU budgets (TASK-062). Renderer-agnostic so the budget
// logic is testable in Node; tiles-scene.ts applies it to the loader.
//
// * Byte estimates: geometry = sum of attribute/index buffer bytes; textures
//   = width * height * bytes per pixel, times 4/3 with a full mip chain.
// * LodBudget coarsens the screen-space-error target (SSE, px) by a fixed
//   factor while estimated GPU or decoded CPU bytes exceed their budgets, and
//   relaxes it only after a run of frames in which the predicted residency at
//   the finer target still fits under the recovery fraction. The prediction
//   assumes tile count scales with screen area, i.e. bytes * factor^2 (no
//   relax/coarsen oscillation while hovering). Same
//   inputs, same targets: degradation is deterministic and never depends on
//   wall time.
// * RequestQueue bounds pending tile requests and active downloads; overflow
//   drops the lowest-priority request deterministically, and an idle queue
//   stays empty.

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
/** Defaults from the TASK-062 DoD. */
export const DEFAULT_GPU_BUDGET_BYTES = 2 * GIB;
export const DEFAULT_CPU_BUDGET_BYTES = 512 * MIB;

export function estimateGeometryBytes(attributeByteLengths: readonly number[], indexByteLength = 0): number {
  let total = indexByteLength;
  for (const n of attributeByteLengths) total += n;
  return total;
}
export function estimateTextureBytes(width: number, height: number, bytesPerPixel: number, mipmapped: boolean): number {
  const base = width * height * bytesPerPixel;
  return mipmapped ? Math.ceil((base * 4) / 3) : base;
}

export interface LodBudgetOptions {
  gpuBudgetBytes?: number;
  cpuBudgetBytes?: number;
  /** Finest SSE target, px (loader default 16 is a common choice; finer = more data). */
  minErrorTarget?: number;
  maxErrorTarget?: number;
  /** Multiplicative coarsening step while over budget. */
  coarsenFactor?: number;
  /** Relax only after this many consecutive frames whose predicted finer residency is below recoverFraction of both budgets. */
  recoverFrames?: number;
  recoverFraction?: number;
}

export class LodBudget {
  readonly gpuBudgetBytes: number;
  readonly cpuBudgetBytes: number;
  readonly minErrorTarget: number;
  readonly maxErrorTarget: number;
  private readonly factor: number;
  private readonly recoverFrames: number;
  private readonly recoverFraction: number;
  private target: number;
  private calm = 0;
  /** True when the coarsest target still exceeds a budget (content must be dropped). */
  saturated = false;

  constructor(options: LodBudgetOptions = {}) {
    this.gpuBudgetBytes = options.gpuBudgetBytes ?? DEFAULT_GPU_BUDGET_BYTES;
    this.cpuBudgetBytes = options.cpuBudgetBytes ?? DEFAULT_CPU_BUDGET_BYTES;
    this.minErrorTarget = options.minErrorTarget ?? 16;
    this.maxErrorTarget = options.maxErrorTarget ?? 256;
    this.factor = options.coarsenFactor ?? 1.5;
    this.recoverFrames = options.recoverFrames ?? 30;
    this.recoverFraction = options.recoverFraction ?? 0.8;
    if (!(this.gpuBudgetBytes > 0) || !(this.cpuBudgetBytes > 0) || !(this.minErrorTarget > 0) ||
      !(this.maxErrorTarget >= this.minErrorTarget) || !(this.factor > 1) || !Number.isInteger(this.recoverFrames) ||
      this.recoverFrames < 1 || !(this.recoverFraction > 0 && this.recoverFraction < 1)) {
      throw new Error("Invalid LOD budget");
    }
    this.target = this.minErrorTarget;
  }

  get errorTarget(): number { return this.target; }

  /** Once per rendered frame with current estimates; returns the SSE target to use. */
  update(gpuBytes: number, cpuBytes: number): number {
    const over = gpuBytes > this.gpuBudgetBytes || cpuBytes > this.cpuBudgetBytes;
    if (over) {
      this.calm = 0;
      const next = Math.min(this.maxErrorTarget, this.target * this.factor);
      this.saturated = next === this.target; // already at the coarsest level
      this.target = next;
      return this.target;
    }
    this.saturated = false;
    const growth = this.factor * this.factor;
    const calm = gpuBytes * growth <= this.recoverFraction * this.gpuBudgetBytes && cpuBytes * growth <= this.recoverFraction * this.cpuBudgetBytes;
    this.calm = calm ? this.calm + 1 : 0;
    if (this.calm >= this.recoverFrames && this.target > this.minErrorTarget) {
      this.target = Math.max(this.minErrorTarget, this.target / this.factor);
      this.calm = 0;
    }
    return this.target;
  }

  reset(): void { this.target = this.minErrorTarget; this.calm = 0; this.saturated = false; }
}

export type EnqueueResult = "queued" | "duplicate" | "dropped" | "displaced";

/**
 * Bounded request queue. Higher priority first; ties by enqueue order.
 * When full, a new request displaces the lowest-priority queued one only if it
 * outranks it, otherwise it is dropped. Active downloads are capped separately.
 */
export class RequestQueue<K> {
  private readonly queued = new Map<K, { priority: number; order: number }>();
  private readonly active = new Set<K>();
  private order = 0;
  dropped = 0;
  constructor(readonly maxQueued: number, readonly maxActive: number) {
    if (!Number.isInteger(maxQueued) || maxQueued < 1 || !Number.isInteger(maxActive) || maxActive < 1) throw new Error("Invalid queue bounds");
  }

  get queuedCount(): number { return this.queued.size; }
  get activeCount(): number { return this.active.size; }

  enqueue(key: K, priority: number): EnqueueResult {
    if (this.queued.has(key) || this.active.has(key)) return "duplicate";
    let result: EnqueueResult = "queued";
    if (this.queued.size >= this.maxQueued) {
      const worst = this.lowest();
      if (worst === null || this.compare(priority, this.order, worst[1].priority, worst[1].order) <= 0) { this.dropped++; return "dropped"; }
      this.queued.delete(worst[0]);
      this.dropped++;
      result = "displaced";
    }
    this.queued.set(key, { priority, order: this.order++ });
    return result;
  }

  /** Starts the highest-priority queued request if an active slot is free. */
  start(): K | null {
    if (this.active.size >= this.maxActive || this.queued.size === 0) return null;
    let best: [K, { priority: number; order: number }] | null = null;
    for (const entry of this.queued) if (!best || this.compare(entry[1].priority, entry[1].order, best[1].priority, best[1].order) > 0) best = entry;
    if (!best) return null;
    this.queued.delete(best[0]);
    this.active.add(best[0]);
    return best[0];
  }

  complete(key: K): void { this.active.delete(key); }
  /** Cancels every queued request (e.g. tiles no longer needed); active ones finish or abort separately. */
  clearQueued(): void { this.queued.clear(); }

  private lowest(): [K, { priority: number; order: number }] | null {
    let worst: [K, { priority: number; order: number }] | null = null;
    for (const entry of this.queued) if (!worst || this.compare(entry[1].priority, entry[1].order, worst[1].priority, worst[1].order) < 0) worst = entry;
    return worst;
  }
  /** > 0 when a outranks b: higher priority, then earlier order. */
  private compare(pa: number, oa: number, pb: number, ob: number): number {
    return pa !== pb ? pa - pb : ob - oa;
  }
}
