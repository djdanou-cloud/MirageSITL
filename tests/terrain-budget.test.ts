// TASK-062: terrain LOD, byte budgets, bounded request queues.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CPU_BUDGET_BYTES, DEFAULT_GPU_BUDGET_BYTES, LodBudget, MIB, RequestQueue,
  estimateGeometryBytes, estimateTextureBytes,
} from "../packages/terrain/src/lod-budget.ts";
import { TerrainResourceCache, type ResourceSize } from "../packages/terrain/src/resource-cache.ts";

describe("byte estimators", () => {
  it("sums buffers and adds a third for a full mip chain", () => {
    expect(estimateGeometryBytes([1200, 800], 600)).toBe(2600);
    expect(estimateTextureBytes(256, 256, 4, false)).toBe(262144);
    expect(estimateTextureBytes(256, 256, 4, true)).toBe(349526); // ceil(262144 * 4 / 3)
  });
});

describe("LodBudget", () => {
  it("defaults to the DoD budgets and rejects invalid options", () => {
    const budget = new LodBudget();
    expect(budget.gpuBudgetBytes).toBe(2 * 1024 ** 3);
    expect(budget.cpuBudgetBytes).toBe(512 * MIB);
    expect(budget.errorTarget).toBe(16);
    expect(() => new LodBudget({ coarsenFactor: 1 })).toThrow();
    expect(() => new LodBudget({ minErrorTarget: 32, maxErrorTarget: 16 })).toThrow();
    expect(() => new LodBudget({ recoverFraction: 1 })).toThrow();
    expect(() => new LodBudget({ recoverFrames: 0.5 })).toThrow();
  });

  it("coarsens while over either budget and saturates at the coarsest target", () => {
    const budget = new LodBudget({ gpuBudgetBytes: 100, cpuBudgetBytes: 100, minErrorTarget: 16, maxErrorTarget: 40, coarsenFactor: 1.5 });
    expect(budget.update(101, 0)).toBe(24);
    expect(budget.update(0, 101)).toBe(36);
    expect(budget.saturated).toBe(false);
    expect(budget.update(101, 0)).toBe(40);
    expect(budget.update(101, 0)).toBe(40);
    expect(budget.saturated).toBe(true);
    expect(budget.update(100, 100)).toBe(40); // at the budget is not over
    expect(budget.saturated).toBe(false);
  });

  it("relaxes only after recoverFrames frames whose finer-level prediction fits", () => {
    const budget = new LodBudget({ gpuBudgetBytes: 1000, cpuBudgetBytes: 1000, coarsenFactor: 2, recoverFrames: 3, recoverFraction: 0.8 });
    budget.update(2000, 0);
    expect(budget.errorTarget).toBe(32);
    // 250 * 4 = 1000 > 800: predicted finer residency would not fit, never relax.
    for (let i = 0; i < 10; i++) budget.update(250, 0);
    expect(budget.errorTarget).toBe(32);
    // 200 * 4 = 800 fits; relax on the third calm frame, not earlier.
    budget.update(200, 0); budget.update(200, 0);
    expect(budget.errorTarget).toBe(32);
    budget.update(200, 0);
    expect(budget.errorTarget).toBe(16);
    budget.update(2000, 0);
    budget.update(200, 0); budget.update(200, 0); budget.update(300, 0); budget.update(200, 0); budget.update(200, 0);
    expect(budget.errorTarget).toBe(32); // the 300 frame broke the calm run
    budget.reset();
    budget.update(2000, 0); // 32
    budget.update(100, 0); budget.update(100, 0); budget.update(2000, 0); budget.update(100, 0);
    expect(budget.errorTarget).toBe(64); // an over-budget frame also restarts the calm run
    budget.reset();
    expect(budget.errorTarget).toBe(16);
  });
});

describe("RequestQueue", () => {
  it("orders by priority then age, rejects duplicates and bounds active downloads", () => {
    const q = new RequestQueue<string>(4, 2);
    expect(q.enqueue("a", 1)).toBe("queued");
    expect(q.enqueue("b", 3)).toBe("queued");
    expect(q.enqueue("c", 3)).toBe("queued");
    expect(q.enqueue("b", 9)).toBe("duplicate");
    expect(q.start()).toBe("b");
    expect(q.enqueue("b", 9)).toBe("duplicate"); // active
    expect(q.start()).toBe("c");
    expect(q.start()).toBeNull(); // two active
    q.complete("b");
    expect(q.start()).toBe("a");
  });

  it("drops or displaces the lowest-priority request when full", () => {
    const q = new RequestQueue<string>(2, 1);
    q.enqueue("low", 1);
    q.enqueue("mid", 2);
    expect(q.enqueue("lower", 0)).toBe("dropped");
    expect(q.enqueue("same", 1)).toBe("dropped"); // ties keep the older request
    expect(q.enqueue("high", 5)).toBe("displaced");
    expect(q.queuedCount).toBe(2);
    expect(q.dropped).toBe(3);
    expect(q.start()).toBe("high");
    q.clearQueued();
    expect(q.queuedCount).toBe(0);
    expect(() => new RequestQueue(0, 1)).toThrow();
  });
});

describe("TerrainResourceCache", () => {
  it("evicts invisible resources in LRU order and disposes each once", () => {
    const disposed: string[] = [];
    const cache = new TerrainResourceCache<string>(300, 1000);
    const size = { gpuBytes: 100, cpuBytes: 10 };
    for (const key of ["a", "b", "c"]) expect(cache.admit(key, size, () => disposed.push(key), 1)).toBe(true);
    cache.touch("a", 2);
    expect(cache.admit("d", size, () => disposed.push("d"), 3)).toBe(true);
    expect(disposed).toEqual(["b"]); // b and c last seen in frame 1; b inserted first
    expect(cache.evictions).toBe(1);
    expect(cache.gpuBytes).toBe(300);
    cache.clear();
    expect(disposed.sort()).toEqual(["a", "b", "c", "d"]);
    expect(cache.gpuBytes).toBe(0);
  });

  it("refuses and disposes a resource the visible set leaves no room for, reporting demand", () => {
    const disposed: string[] = [];
    const cache = new TerrainResourceCache<string>(1000, 150);
    expect(cache.admit("a", { gpuBytes: 10, cpuBytes: 100 }, () => disposed.push("a"), 5)).toBe(true);
    expect(cache.admit("b", { gpuBytes: 10, cpuBytes: 100 }, () => disposed.push("b"), 5)).toBe(false);
    expect(disposed).toEqual(["b"]);
    expect(cache.has("b")).toBe(false);
    const demand: ResourceSize = { gpuBytes: 0, cpuBytes: 0 };
    cache.endFrame(5, demand);
    expect(demand).toEqual({ gpuBytes: 20, cpuBytes: 200 });
    cache.endFrame(6, demand);
    expect(demand).toEqual({ gpuBytes: 10, cpuBytes: 100 }); // denied demand resets per frame
    expect(cache.refused).toBe(1);
    // Re-admitting a key replaces and disposes the previous resource.
    expect(cache.admit("a", { gpuBytes: 1, cpuBytes: 1 }, () => disposed.push("a2"), 7)).toBe(true);
    expect(disposed).toEqual(["b", "a"]);
    expect(() => cache.admit("x", { gpuBytes: Number.NaN, cpuBytes: 0 }, () => undefined, 7)).toThrow();
  });
});

// ---- Synthetic flythrough ----------------------------------------------------

/** mulberry32: deterministic 32-bit PRNG for the synthetic content. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a tile key mixed with the seed: per-tile sizes independent of request order. */
function hashKey(key: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h / 4294967296;
}

interface FrameTrace { errorTarget: number; gpuBytes: number; cpuBytes: number; queued: number; active: number; resident: number }
interface FlythroughResult {
  trace: FrameTrace[];
  created: number;
  disposeCounts: Map<number, number>;
  maxGpu: number;
  maxCpu: number;
  maxQueued: number;
  evictions: number;
  refused: number;
  droppedAtHoverStart: number;
  droppedAtEnd: number;
  hoverStart: number;
}

const VIEW_RADIUS_M = 2000;
const BASE_CELL_M = 100;
const FLY_FRAMES = 400;
const HOVER_FRAMES = 200;

/**
 * Camera flies east at 30 m/frame, then hovers. Visible tiles are grid cells
 * within VIEW_RADIUS_M; the cell size grows with the SSE target (coarser
 * targets select fewer, larger tiles of similar byte size). Each tile is
 * 12..36 MiB of estimated GPU memory and 0.15..0.45 of that decoded on the
 * CPU, so the finest level (about 1250 visible tiles) is ~30 GiB: the budgets
 * must bind. Downloads take 1..3 frames through a bounded queue.
 */
function flythrough(seed: number): FlythroughResult {
  const budget = new LodBudget();
  const cache = new TerrainResourceCache<string>(DEFAULT_GPU_BUDGET_BYTES, DEFAULT_CPU_BUDGET_BYTES);
  const queue = new RequestQueue<string>(256, 8);
  const random = rng(seed);
  const inFlight = new Map<string, number>(); // key -> completion frame
  const disposeCounts = new Map<number, number>();
  const demand: ResourceSize = { gpuBytes: 0, cpuBytes: 0 };
  const trace: FrameTrace[] = [];
  let created = 0, maxGpu = 0, maxCpu = 0, maxQueued = 0, droppedAtHoverStart = 0;
  const step = Math.log(1.5);

  for (let frame = 1; frame <= FLY_FRAMES + HOVER_FRAMES; frame++) {
    if (frame === FLY_FRAMES + 1) droppedAtHoverStart = queue.dropped;
    const camX = 30 * Math.min(frame, FLY_FRAMES), camY = 0;
    const level = Math.round(Math.log(budget.errorTarget / 16) / step);
    const cell = BASE_CELL_M * 1.5 ** level;
    const span = Math.ceil(VIEW_RADIUS_M / cell);
    const ci = Math.floor(camX / cell), cj = Math.floor(camY / cell);
    const visible = new Set<string>();
    queue.clearQueued(); // tiles that left the view are no longer wanted
    for (let i = ci - span; i <= ci + span; i++) {
      for (let j = cj - span; j <= cj + span; j++) {
        const distance = Math.hypot((i + 0.5) * cell - camX, (j + 0.5) * cell - camY);
        if (distance > VIEW_RADIUS_M) continue;
        const key = `${level}/${i}/${j}`;
        visible.add(key);
        if (!cache.touch(key, frame) && !inFlight.has(key)) queue.enqueue(key, -distance);
      }
    }
    maxQueued = Math.max(maxQueued, queue.queuedCount);
    for (let key = queue.start(); key !== null; key = queue.start()) inFlight.set(key, frame + 1 + Math.floor(random() * 3));
    for (const [key, done] of [...inFlight]) {
      if (done > frame) continue;
      inFlight.delete(key);
      queue.complete(key);
      const id = created++;
      const dispose = () => { disposeCounts.set(id, (disposeCounts.get(id) ?? 0) + 1); };
      const gpuBytes = Math.round((12 + 24 * hashKey(key, seed)) * MIB);
      const cpuBytes = Math.round(gpuBytes * (0.15 + 0.3 * hashKey(`${key}#cpu`, seed)));
      if (visible.has(key)) cache.admit(key, { gpuBytes, cpuBytes }, dispose, frame);
      else dispose(); // finished after leaving the view: released, never cached
    }
    maxGpu = Math.max(maxGpu, cache.gpuBytes);
    maxCpu = Math.max(maxCpu, cache.cpuBytes);
    cache.endFrame(frame, demand);
    budget.update(demand.gpuBytes, demand.cpuBytes);
    trace.push({ errorTarget: budget.errorTarget, gpuBytes: cache.gpuBytes, cpuBytes: cache.cpuBytes, queued: queue.queuedCount, active: queue.activeCount, resident: cache.size });
  }
  const evictions = cache.evictions, refused = cache.refused;
  cache.clear();
  return { trace, created, disposeCounts, maxGpu, maxCpu, maxQueued, evictions, refused, droppedAtHoverStart, droppedAtEnd: queue.dropped, hoverStart: FLY_FRAMES };
}

describe("synthetic terrain flythrough", () => {
  const run = flythrough(0x5eed);

  it("never exceeds 2 GiB estimated GPU or 512 MiB decoded CPU residency, while the budgets bind", () => {
    expect(run.maxGpu).toBeLessThanOrEqual(DEFAULT_GPU_BUDGET_BYTES);
    expect(run.maxCpu).toBeLessThanOrEqual(DEFAULT_CPU_BUDGET_BYTES);
    // The budgets are actually exercised: content was refused, evicted, and LOD coarsened.
    expect(run.refused).toBeGreaterThan(0);
    expect(run.evictions).toBeGreaterThan(0);
    expect(Math.max(...run.trace.map(f => f.errorTarget))).toBeGreaterThan(16);
    expect(run.maxCpu).toBeGreaterThan(0.5 * DEFAULT_CPU_BUDGET_BYTES);
  });

  it("disposes every loaded resource exactly once", () => {
    expect(run.created).toBeGreaterThan(100);
    expect(run.disposeCounts.size).toBe(run.created);
    for (const count of run.disposeCounts.values()) expect(count).toBe(1);
  });

  it("keeps request queues bounded and lets them drain and stay empty while idle", () => {
    expect(run.maxQueued).toBeLessThanOrEqual(256);
    const hover = run.trace.slice(run.hoverStart);
    const settled = hover.findIndex(f => f.queued === 0 && f.active === 0);
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(settled).toBeLessThan(60);
    const idle = hover.slice(settled);
    expect(idle.length).toBeGreaterThan(100);
    for (const f of idle) {
      expect(f.queued).toBe(0);
      expect(f.active).toBe(0);
      expect(f.resident).toBe(idle[0]!.resident);
      expect(f.errorTarget).toBe(idle[0]!.errorTarget); // no relax/coarsen oscillation
    }
    expect(run.droppedAtEnd - run.droppedAtHoverStart).toBeLessThanOrEqual(256); // only the backlog at hover start
  });

  it("degrades deterministically for a seed", () => {
    const again = flythrough(0x5eed);
    expect(again.trace).toEqual(run.trace);
    expect(again.evictions).toBe(run.evictions);
    const other = flythrough(7);
    expect(other.trace).not.toEqual(run.trace);
    expect(other.maxGpu).toBeLessThanOrEqual(DEFAULT_GPU_BUDGET_BYTES);
    expect(other.maxCpu).toBeLessThanOrEqual(DEFAULT_CPU_BUDGET_BYTES);
  });
});
