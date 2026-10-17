/** Terrain collision lattice v1. NED metres; row increases North, column East.
 * Heavy validation/triangulation belongs in a builder Worker, never the physics step.
 */
export interface HeightTile {
  version: 1; epoch: number; revision: number; northIndex: number; eastIndex: number;
  resolution: number; spacingM: number; downM: Float64Array;
}
export interface CollisionChunk extends HeightTile {
  verticesNedM: Float32Array; indices: Uint32Array;
}
export function buildCollisionChunk(tile: HeightTile): CollisionChunk {
  const n = tile.resolution;
  if (tile.version !== 1 || !Number.isInteger(n) || n < 2 || n > 257 ||
    !Number.isFinite(tile.spacingM) || tile.spacingM <= 0 || tile.spacingM > 100 ||
    ![tile.epoch, tile.revision].every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff) ||
    ![tile.northIndex, tile.eastIndex].every(v => Number.isInteger(v) && Math.abs(v) <= 1024) ||
    tile.downM.length !== n * n || !tile.downM.every(v => Number.isFinite(v) && Math.abs(v) <= 15000) ||
    Math.max(Math.abs(tile.northIndex) + 1, Math.abs(tile.eastIndex) + 1) * (n - 1) * tile.spacingM > 15000) {
    throw new Error("Invalid collision lattice");
  }
  const vertices = new Float32Array(n * n * 3), indices = new Uint32Array((n - 1) ** 2 * 6);
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    const at = row * n + col;
    vertices[at * 3] = (tile.northIndex * (n - 1) + row) * tile.spacingM;
    vertices[at * 3 + 1] = (tile.eastIndex * (n - 1) + col) * tile.spacingM;
    vertices[at * 3 + 2] = tile.downM[at] as number; // at < n*n
    if (row < n - 1 && col < n - 1) {
      const i = (row * (n - 1) + col) * 6;
      // Cross products face -Down. Shared diagonal is NE to SW.
      indices.set([at, at + 1, at + n, at + 1, at + n + 1, at + n], i);
    }
  }
  return { ...tile, downM: new Float64Array(tile.downM), verticesNedM: vertices, indices };
}
