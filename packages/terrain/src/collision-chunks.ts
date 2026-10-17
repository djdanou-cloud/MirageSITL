import { buildCollisionChunk, type CollisionChunk, type HeightTile } from "./collision-build.ts";
/** Separate collision ownership: visual cache eviction never reaches this store.
 * Stage allocates off-loop; publish/read methods use fixed slots and allocate nothing.
 */
export class CollisionChunks {
  private readonly active: (CollisionChunk | null)[];
  private readonly pending: (CollisionChunk | null)[];
  private lastTick = -1;
  private activeBytes = 0;
  private pendingBytes = 0;
  private readonly byteCap: number;
  private readonly query = new Float64Array(3);
  private readonly result = new Float64Array(1);
  readonly resolution: number;
  readonly spacingM: number;
  readonly epoch: number;
  constructor(epoch: number, resolution: number, spacingM: number, capacity = 64, byteCap = 64 * 1024 ** 2) {
    if (!Number.isInteger(resolution) || resolution < 2 || resolution > 257) throw new Error("Invalid collision resolution");
    buildCollisionChunk({ version: 1, epoch, revision: 0, resolution, spacingM, northIndex: 0, eastIndex: 0, downM: new Float64Array(resolution * resolution) });
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) throw new Error("Invalid collision capacity");
    if (!Number.isSafeInteger(byteCap) || byteCap < 1 || byteCap > 512 * 1024 ** 2) throw new Error("Invalid collision byte cap");
    this.byteCap = byteCap;
    this.active = Array<CollisionChunk | null>(capacity).fill(null);
    this.pending = Array<CollisionChunk | null>(capacity).fill(null);
    this.epoch = epoch; this.resolution = resolution; this.spacingM = spacingM;
  }
  stage(tile: HeightTile): boolean {
    const c = buildCollisionChunk(tile);
    if (c.epoch !== this.epoch || c.resolution !== this.resolution || c.spacingM !== this.spacingM) return false;
    let slot = -1;
    for (let i = 0; i < this.active.length; i++) {
      const old = this.pending[i] ?? this.active[i];
      if (!old) { if (slot < 0) slot = i; continue; }
      if (old.northIndex === c.northIndex && old.eastIndex === c.eastIndex) {
        if (c.revision <= old.revision) return false;
        slot = i;
      }
      if (!this.seamMatches(old, c)) return false;
    }
    if (slot < 0) return false;
    const oldPending = this.pending[slot];
    const oldBytes = oldPending ? oldPending.downM.byteLength + oldPending.verticesNedM.byteLength + oldPending.indices.byteLength : 0;
    const bytes = c.downM.byteLength + c.verticesNedM.byteLength + c.indices.byteLength;
    if (this.activeBytes + this.pendingBytes - oldBytes + bytes > this.byteCap) return false;
    this.pendingBytes += bytes - oldBytes;
    this.pending[slot] = c;
    return true;
  }
  private seamMatches(a: CollisionChunk, b: CollisionChunk): boolean {
    const n = this.resolution;
    for (let k = 0; k < n; k++) {
      if (a.eastIndex === b.eastIndex && a.northIndex + 1 === b.northIndex && a.downM[(n - 1) * n + k] !== b.downM[k]) return false;
      if (a.eastIndex === b.eastIndex && b.northIndex + 1 === a.northIndex && b.downM[(n - 1) * n + k] !== a.downM[k]) return false;
      if (a.northIndex === b.northIndex && a.eastIndex + 1 === b.eastIndex && a.downM[k * n + n - 1] !== b.downM[k * n]) return false;
      if (a.northIndex === b.northIndex && b.eastIndex + 1 === a.eastIndex && b.downM[k * n + n - 1] !== a.downM[k * n]) return false;
    }
    return true;
  }
  publishAtTick(epoch: number, tick: number): boolean {
    if (epoch !== this.epoch || !Number.isSafeInteger(tick) || tick <= this.lastTick) return false;
    this.lastTick = tick;
    for (let i = 0; i < this.active.length; i++) {
      const next = this.pending[i];
      if (next) {
        const old = this.active[i];
        if (old) this.activeBytes -= old.downM.byteLength + old.verticesNedM.byteLength + old.indices.byteLength;
        const bytes = next.downM.byteLength + next.verticesNedM.byteLength + next.indices.byteLength;
        this.activeBytes += bytes; this.pendingBytes -= bytes;
        this.active[i] = next; this.pending[i] = null;
      }
    }
    return true;
  }
  /** Samples the actual piecewise-triangular mesh, not a different bilinear surface. */
  downAt(northM: number, eastM: number): number {
    this.query[0] = northM; this.query[1] = eastM;
    this.sampleInto(this.query, this.result);
    return this.result[0] as number; // length 1
  }
  sampleInto(position: Float64Array, out: Float64Array): void {
    const northM = position[0] as number, eastM = position[1] as number; // caller length >= 2
    out[0] = NaN;
    if (!Number.isFinite(northM) || !Number.isFinite(eastM)) return;
    const span = (this.resolution - 1) * this.spacingM;
    const ni = Math.floor(northM / span), ei = Math.floor(eastM / span);
    for (let i = 0; i < this.active.length; i++) {
      const c = this.active[i];
      if (!c || c.northIndex !== ni || c.eastIndex !== ei) continue;
      const row = (northM - ni * span) / this.spacingM, col = (eastM - ei * span) / this.spacingM;
      const r = Math.min(Math.floor(row), this.resolution - 2), e = Math.min(Math.floor(col), this.resolution - 2);
      const u = row - r, v = col - e, at = r * this.resolution + e;
      // c owns n*n validated samples; indices are in that range.
      const a = c.downM[at] as number, b = c.downM[at + 1] as number;
      const d = c.downM[at + this.resolution] as number, f = c.downM[at + this.resolution + 1] as number;
      out[0] = u + v <= 1 ? a + u * (d - a) + v * (b - a) : f + (1 - u) * (b - f) + (1 - v) * (d - f);
      return;
    }
  }
  /** Conservative readiness over an axis-aligned safety square. Missing ground pauses admission. */
  readyAround(northM: number, eastM: number, radiusM: number): boolean {
    this.query[0] = northM; this.query[1] = eastM; this.query[2] = radiusM;
    return this.readyFrom(this.query);
  }
  readyFrom(positionRadius: Float64Array): boolean {
    const northM = positionRadius[0] as number, eastM = positionRadius[1] as number, radiusM = positionRadius[2] as number; // caller length >= 3
    const span = (this.resolution - 1) * this.spacingM;
    if (!Number.isFinite(northM) || !Number.isFinite(eastM) || !Number.isFinite(radiusM) || radiusM < 0 || radiusM > span / 2) return false;
    const n0 = Math.floor((northM - radiusM) / span), n1 = Math.floor((northM + radiusM) / span);
    const e0 = Math.floor((eastM - radiusM) / span), e1 = Math.floor((eastM + radiusM) / span);
    for (let n = n0; n <= n1; n++) for (let e = e0; e <= e1; e++) {
      let found = false;
      for (let i = 0; i < this.active.length; i++) {
        const c = this.active[i];
        if (c && c.northIndex === n && c.eastIndex === e) { found = true; break; }
      }
      if (!found) return false;
    }
    return true;
  }
}
