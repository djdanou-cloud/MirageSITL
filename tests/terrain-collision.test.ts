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
