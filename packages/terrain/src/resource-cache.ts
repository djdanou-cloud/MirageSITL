// Terrain resource cache with GPU and decoded-CPU byte budgets (TASK-062).
// LRU over resources not visible in the current frame; eviction calls each
// resource's dispose exactly once. Admission is a hard cap: a new resource
// first evicts invisible LRU entries, and is refused (and disposed) when the
// visible set leaves no room. Refused bytes are reported as unmet demand so
// LodBudget coarsens. Frames are explicit integers: behaviour is deterministic.

export interface ResourceSize { gpuBytes: number; cpuBytes: number }

interface Entry { size: ResourceSize; dispose: () => void; lastFrame: number; order: number }

export class TerrainResourceCache<K> {
  private readonly entries = new Map<K, Entry>();
  private gpu = 0;
  private cpu = 0;
  private order = 0;
  evictions = 0;
  overBudget = false;

  constructor(readonly gpuBudgetBytes: number, readonly cpuBudgetBytes: number) {
    if (!(gpuBudgetBytes > 0) || !(cpuBudgetBytes > 0)) throw new Error("Invalid cache budgets");
  }

  get gpuBytes(): number { return this.gpu; }
  get cpuBytes(): number { return this.cpu; }
  get size(): number { return this.entries.size; }
  has(key: K): boolean { return this.entries.has(key); }

  /** Unmet demand (bytes refused by admit) since the last endFrame. */
  deniedGpuBytes = 0;
  deniedCpuBytes = 0;

  /**
   * Admits a loaded resource, visible in `frame`. Evicts invisible LRU entries
   * to make room; if the budgets still cannot hold it, disposes it, records
   * the unmet demand and returns false. Re-admitting a key replaces (and
   * disposes) the old resource.
   */
  admit(key: K, size: ResourceSize, dispose: () => void, frame: number): boolean {
    if (!(size.gpuBytes >= 0) || !(size.cpuBytes >= 0)) throw new Error("Invalid resource size");
    if (this.entries.has(key)) this.remove(key);
    while (this.gpu + size.gpuBytes > this.gpuBudgetBytes || this.cpu + size.cpuBytes > this.cpuBudgetBytes) {
      if (!this.evictOne(frame)) {
        this.deniedGpuBytes += size.gpuBytes;
        this.deniedCpuBytes += size.cpuBytes;
        this.refused++;
        dispose();
        return false;
      }
    }
    this.entries.set(key, { size, dispose, lastFrame: frame, order: this.order++ });
    this.gpu += size.gpuBytes;
    this.cpu += size.cpuBytes;
    return true;
  }
  /** Resources refused by admit since construction. */
  refused = 0;

  /** Marks a resource visible in `frame` (protects it from eviction this frame). */
  touch(key: K, frame: number): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    e.lastFrame = frame;
    return true;
  }

  /** Disposes and forgets one resource. */
  remove(key: K): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    this.gpu -= e.size.gpuBytes;
    this.cpu -= e.size.cpuBytes;
    e.dispose();
    return true;
  }

  /** Evicts the least-recently-visible resource not visible in `frame`; false if none. */
  private evictOne(frame: number): boolean {
    let victim: K | null = null, best: Entry | null = null;
    for (const [key, e] of this.entries) {
      if (e.lastFrame >= frame) continue;
      if (!best || e.lastFrame < best.lastFrame || (e.lastFrame === best.lastFrame && e.order < best.order)) { victim = key; best = e; }
    }
    if (victim === null) return false;
    this.remove(victim);
    this.evictions++;
    return true;
  }

  /**
   * End of `frame`: evicts least-recently-visible resources (oldest frame, then
   * oldest insertion) not visible in this frame until both budgets hold (a
   * safety net: admit already enforces them), and returns the unmet demand
   * for LodBudget in `demand`, resetting the per-frame counters.
   */
  endFrame(frame: number, demand?: ResourceSize): void {
    while ((this.gpu > this.gpuBudgetBytes || this.cpu > this.cpuBudgetBytes) && this.evictOne(frame));
    this.overBudget = this.gpu > this.gpuBudgetBytes || this.cpu > this.cpuBudgetBytes;
    if (demand) {
      demand.gpuBytes = this.gpu + this.deniedGpuBytes;
      demand.cpuBytes = this.cpu + this.deniedCpuBytes;
    }
    this.deniedGpuBytes = 0;
    this.deniedCpuBytes = 0;
  }

  /** Disposes everything (scene teardown). */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.remove(key);
  }
}
