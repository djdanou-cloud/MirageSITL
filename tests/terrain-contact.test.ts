// TASK-065: published collision chunks drive the TASK-029 Rapier contact owner.
import { beforeAll, expect, it } from "vitest";
import { GroundContact } from "../packages/physics/src/ground-contact";
import {
  TERRAIN_PAUSED_MISSING_GROUND, TERRAIN_STEPPED, TerrainContactCoupler,
} from "../packages/physics/src/terrain-contact";
import { CollisionChunks } from "../packages/terrain/src/collision-chunks";
import type { HeightTile } from "../packages/terrain/src/collision-build";
import { newBodyTruth } from "../packages/wasm-bet/src/backend";
import { prepareContact, syntheticGearOptions } from "./contact-support";
beforeAll(prepareContact, 300000);

const N = 9, SPACING = 1, SPAN = (N - 1) * SPACING;
/** Plane D = -k N (ground rises to the North) sampled at the lattice nodes. */
function slopeTile(northIndex: number, eastIndex: number, k: number): HeightTile {
  const downM = new Float64Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) downM[r * N + c] = -k * (northIndex * SPAN + r * SPACING);
  return { version: 1, epoch: 1, revision: 0, northIndex, eastIndex, resolution: N, spacingM: SPACING, downM };
}
function lattice(k: number, norths: readonly number[], easts: readonly number[]): CollisionChunks {
  const store = new CollisionChunks(1, N, SPACING, 32);
  for (const n of norths) for (const e of easts) expect(store.stage(slopeTile(n, e, k))).toBe(true);
  expect(store.publishAtTick(1, 0)).toBe(true);
  return store;
}
const anchors = (): [number, number, number][] =>
  (syntheticGearOptions().wheels ?? []).map(w => [w.anchorBodyM[0], w.anchorBodyM[1], w.anchorBodyM[2]]);

it("matches the equivalent configured slope step for step while sliding across chunk seams", async () => {
  const k = Math.tan(8 * Math.PI / 180), length = Math.hypot(k, 1);
  const start = newBodyTruth();
  start.positionNedM[0] = 2;
  start.positionNedM[2] = -0.8 - k * 2;
  const reference = await GroundContact.create(start, 10, 0.1, 0, 0,
    { ...syntheticGearOptions(), groundNormalNed: [-k / length, 0, -1 / length], groundOffsetM: 0 });
  const coupled = await GroundContact.create(start, 10, 0.1, 0, 0, syntheticGearOptions());
  const coupler = new TerrainContactCoupler(coupled, lattice(k, [-3, -2, -1, 0], [-1, 0]), anchors(), 0.6);
  const a = newBodyTruth(), b = newBodyTruth(), wrench = new Float64Array(6);
  for (const t of [a, b]) { t.positionNedM.set(start.positionNedM); t.quaternionBodyToNed.set(start.quaternionBodyToNed); }
  try {
    let maxDiff = 0, minNorth = Infinity;
    for (let i = 0; i < 3 * 400; i++) {
      expect(reference.stepInto(wrench, 1 / 400, a)).toBe(true);
      expect(coupler.stepInto(b, wrench, 1 / 400)).toBe(TERRAIN_STEPPED);
      for (let j = 0; j < 3; j++) maxDiff = Math.max(maxDiff, Math.abs(a.positionNedM[j]! - b.positionNedM[j]!), Math.abs(a.velocityNedMps[j]! - b.velocityNedMps[j]!));
      minNorth = Math.min(minNorth, b.positionNedM[0]!);
    }
    // Slid downslope (South) across the N = 0 seam into the next chunk row.
    expect(minNorth).toBeLessThan(-0.5);
    expect(maxDiff).toBeLessThan(1e-6);
    expect(coupled.allocationCalls).toBe(0);
    expect(coupled.allocationBytes).toBe(0);
  } finally {
    reference.dispose(); coupled.dispose();
  }
}, 120000);

it("pauses on missing ground without stepping and resumes once the chunk is published", async () => {
  const start = newBodyTruth();
  start.positionNedM[0] = 0.2; start.positionNedM[1] = 0.2; start.positionNedM[2] = -0.8;
  const contact = await GroundContact.create(start, 10, 0.1, 0, 0, syntheticGearOptions());
  // Only the chunk under the CG: the 0.6 m safety square around (0.2, 0.2) also needs West/South neighbors.
  const store = lattice(0, [0], [0]);
  const coupler = new TerrainContactCoupler(contact, store, anchors(), 0.6);
  const truth = newBodyTruth(), wrench = new Float64Array(6);
  truth.positionNedM.set(start.positionNedM);
  try {
    const before = Float64Array.from([...truth.positionNedM, ...truth.velocityNedMps]);
    for (let i = 0; i < 10; i++) expect(coupler.stepInto(truth, wrench, 1 / 400)).toBe(TERRAIN_PAUSED_MISSING_GROUND);
    expect(Float64Array.from([...truth.positionNedM, ...truth.velocityNedMps])).toEqual(before);
    for (const [n, e] of [[-1, -1], [-1, 0], [0, -1]] as const) expect(store.stage(slopeTile(n, e, 0))).toBe(true);
    expect(coupler.stepInto(truth, wrench, 1 / 400)).toBe(TERRAIN_PAUSED_MISSING_GROUND); // staged, not yet published
    expect(store.publishAtTick(1, 1)).toBe(true);
    for (let i = 0; i < 400; i++) expect(coupler.stepInto(truth, wrench, 1 / 400)).toBe(TERRAIN_STEPPED);
    expect(truth.positionNedM[2]).toBeGreaterThan(-0.8); // fell under gravity once admitted
  } finally {
    contact.dispose();
  }
}, 120000);

it("rejects anchors that do not match the wheels or a radius that does not cover them", async () => {
  const contact = await GroundContact.create(newBodyTruth(), 10, 0.1, 0, 0, syntheticGearOptions());
  const store = lattice(0, [0], [0]);
  try {
    expect(() => new TerrainContactCoupler(contact, store, anchors().slice(1), 0.6)).toThrow("Anchor count");
    expect(() => new TerrainContactCoupler(contact, store, anchors(), 0.3)).toThrow("Readiness radius");
    expect(() => new TerrainContactCoupler(contact, store, anchors(), NaN)).toThrow("Readiness radius");
  } finally {
    contact.dispose();
  }
}, 120000);

it("samples each wheel at its rotated anchor position", async () => {
  const contact = await GroundContact.create(newBodyTruth(), 10, 0.1, 0, 0, syntheticGearOptions());
  const queries: [number, number][] = [];
  const recorder = {
    planeInto(position: Float64Array, out: Float64Array) {
      queries.push([position[0]!, position[1]!]);
      out.set([0, 0, -1, 10]); // flat ground 10 m below the origin
    },
    readyFrom: () => true,
  };
  const coupler = new TerrainContactCoupler(contact, recorder, anchors(), 0.6);
  const truth = newBodyTruth(), yaw = Math.PI / 2, pitch = 0.2;
  truth.positionNedM.set([5, -3, -1]);
  // q = yaw(Z) * pitch(Y), Hamilton wxyz body-to-NED.
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  truth.quaternionBodyToNed.set([cy * cp, -sy * sp, cy * sp, sy * cp]);
  try {
    expect(coupler.stepInto(truth, new Float64Array(6), 1 / 400)).toBe(TERRAIN_STEPPED);
    expect(queries).toHaveLength(4);
    expect(queries[0]).toEqual([5, -3]);
    anchors().forEach(([x, y, z], i) => {
      // Independent rotation: pitch about body Y, then yaw about NED Down.
      const px = Math.cos(pitch) * x + Math.sin(pitch) * z, py = y;
      const north = Math.cos(yaw) * px - Math.sin(yaw) * py, east = Math.sin(yaw) * px + Math.cos(yaw) * py;
      expect(queries[i + 1]![0]).toBeCloseTo(5 + north, 12);
      expect(queries[i + 1]![1]).toBeCloseTo(-3 + east, 12);
    });
  } finally {
    contact.dispose();
  }
}, 120000);
