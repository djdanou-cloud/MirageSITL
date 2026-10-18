import { expect, it } from "vitest";
import { CollisionChunks } from "../packages/terrain/src/collision-chunks.ts";
import { buildCollisionChunk, type HeightTile } from "../packages/terrain/src/collision-build.ts";
function tile(northIndex = 0, eastIndex = 0, revision = 0): HeightTile {
  // Independent plane D = 2N + 3E at integer metre nodes.
  return { version: 1, epoch: 1, revision, northIndex, eastIndex, resolution: 3, spacingM: 1,
    downM: Float64Array.from({ length: 9 }, (_, i) => 2 * (northIndex * 2 + Math.floor(i / 3)) + 3 * (eastIndex * 2 + i % 3)) };
}
it("triangulates NED with upward normals and common edge coordinates", () => {
  const a = buildCollisionChunk(tile()), b = buildCollisionChunk(tile(1));
  expect(Array.from(a.indices.slice(0, 6))).toEqual([0, 1, 3, 1, 4, 3]);
  for (let k = 0; k < 3; k++) expect(Array.from(a.verticesNedM.slice((6 + k) * 3, (7 + k) * 3))).toEqual(Array.from(b.verticesNedM.slice(k * 3, (k + 1) * 3)));
  expect(() => buildCollisionChunk({ ...tile(), downM: new Float64Array([NaN]) })).toThrow();
});
it("owns collision ground independently, validates seams and publishes only at increasing epoch ticks", () => {
  const store = new CollisionChunks(1, 3, 1, 4), input = tile();
  expect(store.stage(input)).toBe(true); input.downM.fill(900);
  expect(Number.isNaN(store.downAt(.5, .5))).toBe(true);
  expect(store.publishAtTick(2, 0)).toBe(false);
  expect(store.publishAtTick(1, 0)).toBe(true);
  expect(store.downAt(.5, .5)).toBeCloseTo(2.5, 12);
  const query = new Float64Array([.5, .5, .1]), out = new Float64Array(1);
  store.sampleInto(query, out); expect(out[0]).toBeCloseTo(2.5, 12);
  expect(store.readyFrom(query)).toBe(true);
  expect(store.downAt(.8, .7)).toBeCloseTo(3.7, 12);
  expect(store.stage(tile())).toBe(false);
  expect(store.stage({ ...tile(1), downM: new Float64Array(9) })).toBe(false);
  expect(store.stage(tile(1))).toBe(true);
  expect(store.publishAtTick(1, 0)).toBe(false);
  expect(Number.isNaN(store.downAt(2, .5))).toBe(true);
  store.publishAtTick(1, 1);
  expect(store.downAt(2, .5)).toBeCloseTo(5.5, 12);
  expect(store.readyAround(2, 1, .5)).toBe(true);
  expect(store.readyAround(2, 2, .5)).toBe(false); // East chunk is absent.
  expect(store.stage(tile(0, 1))).toBe(true); expect(store.stage(tile(1, 1))).toBe(true);
  store.publishAtTick(1, 2); expect(store.readyAround(2, 2, .5)).toBe(true);
  expect(store.stage(tile(2, 2))).toBe(false); // Capacity is fixed; ground cannot be evicted by rendering.
});
it("uses the mesh diagonal and supports negative tile coordinates", () => {
  const store = new CollisionChunks(1, 2, 1);
  store.stage({ ...tile(-1, -1), resolution: 2, downM: new Float64Array([0, 0, 0, 4]) });
  store.publishAtTick(1, 0);
  expect(store.downAt(-.75, -.75)).toBe(0);
  expect(store.downAt(-.25, -.25)).toBe(2); // Bilinear interpolation would incorrectly give 2.25.
});

it("bounds staged plus active memory and retains old ground when replacement cannot fit", () => {
  const c = buildCollisionChunk(tile()), bytes = c.downM.byteLength + c.verticesNedM.byteLength + c.indices.byteLength;
  const store = new CollisionChunks(1, 3, 1, 2, bytes);
  expect(store.stage(tile())).toBe(true); store.publishAtTick(1, 0);
  expect(store.stage(tile(1))).toBe(false);
  expect(store.stage(tile(0, 0, 1))).toBe(false); // Old+new must fit during a safe replacement.
  expect(store.downAt(.5, .5)).toBe(2.5);
  expect(() => new CollisionChunks(1, 3, 1, 2, 513 * 1024 ** 2)).toThrow();
});
it("returns the exact upward plane of the triangle under a point for terrain contact (TASK-065)", () => {
  // Global plane D = 2N + 3E (tile()): normal ∝ (2, 3, -1), and the plane passes through the origin.
  const store = new CollisionChunks(1, 3, 1, 4);
  for (const [n, e] of [[0, 0], [1, 0], [0, 1], [-1, -1]] as const) expect(store.stage(tile(n, e))).toBe(true);
  expect(store.publishAtTick(1, 0)).toBe(true);
  const p = new Float64Array(2), plane = new Float64Array(4), length = Math.sqrt(14);
  for (const [n, e] of [[0.2, 0.3], [0.8, 0.7], [3.9, 0.1], [0.1, 3.95], [-1.5, -0.25]] as const) {
    p[0] = n; p[1] = e;
    store.planeInto(p, plane);
    expect(plane[0]).toBeCloseTo(2 / length, 12); expect(plane[1]).toBeCloseTo(3 / length, 12);
    expect(plane[2]).toBeCloseTo(-1 / length, 12); expect(plane[3]).toBeCloseTo(0, 12);
    // A point 0.5 m above the surface along the normal has plane height 0.5.
    const down = store.downAt(n, e), x = [n + 0.5 * plane[0]!, e + 0.5 * plane[1]!, down + 0.5 * plane[2]!];
    expect(plane[0]! * x[0]! + plane[1]! * x[1]! + plane[2]! * x[2]! - plane[3]!).toBeCloseTo(0.5, 12);
  }
  // Ridge: the two triangles of one cell have different exact planes.
  const ridge = new CollisionChunks(2, 2, 1, 1);
  expect(ridge.stage({ version: 1, epoch: 2, revision: 0, northIndex: 0, eastIndex: 0, resolution: 2, spacingM: 1,
    downM: new Float64Array([0, 0, 0, -1]) })).toBe(true);
  expect(ridge.publishAtTick(2, 0)).toBe(true);
  p[0] = 0.2; p[1] = 0.2; ridge.planeInto(p, plane); // lower triangle is flat
  [0, 0, -1, 0].forEach((v, i) => expect(plane[i]).toBeCloseTo(v, 15));
  p[0] = 0.9; p[1] = 0.9; ridge.planeInto(p, plane); // upper: D = 1 - N - E, normal ∝ (-1, -1, -1)
  for (let i = 0; i < 3; i++) expect(plane[i]).toBeCloseTo(-1 / Math.sqrt(3), 12);
  expect(plane[3]).toBeCloseTo(-1 / Math.sqrt(3), 12); // through vertex (0, 1, 0)
  p[0] = 9; ridge.planeInto(p, plane);
  expect(plane.every(Number.isNaN)).toBe(true);
});
