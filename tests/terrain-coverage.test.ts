import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CollisionChunks } from '../packages/terrain/src/collision-chunks.ts';
import { parseManifestBox, parseQuantizedLayer, parseTerrainInventory, terrainSources, type LocalTerrain } from '../packages/terrain/src/coverage.ts';
import { QUANTIZED_MAX, tileBounds } from '../packages/terrain/src/quantized-mesh.ts';
import {
  RUN_CHUNK_RESOLUTION, RUN_CHUNK_SPACING_M, RUN_CHUNK_SPAN_M, RUN_TERRAIN_EPOCH, buildRunTerrain, chunkRange, degreesPerMetre,
} from '../packages/terrain/src/run-terrain.ts';

// TASK-186: terrain source records from the TASK-131 inventory, and the collision lattice of a real-terrain run built from local
// quantized-mesh tiles. The lattice is checked against the tilted plane the independent quantized-mesh-encoder fixture was written
// from (tests/fixtures/terrain-qm-slope/generate.py), within the budget tests/quantized-mesh.test.ts declares for those tiles.
const DIR = new URL('./fixtures/terrain-qm-slope/', import.meta.url);
const json = (name: string): unknown => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));
const inventory = parseTerrainInventory(JSON.parse(readFileSync(new URL('../data/terrain/inventory.json', import.meta.url), 'utf8')));
const layer = parseQuantizedLayer(json('layer.json')), bbox = parseManifestBox(json('terrain-manifest.json'));
const plane = (json('terrain-manifest.json') as { plane: { baseM: number; lat0Deg: number; lon0Deg: number; metresPerDegLon: number; metresPerDegLat: number } }).plane;
const heightOf = (lon: number, lat: number) => plane.baseM + plane.metresPerDegLon * (lon - plane.lon0Deg) + plane.metresPerDegLat * (lat - plane.lat0Deg);
const fetchTile = (z: number, x: number, y: number): Promise<Uint8Array | null> => {
  try { return Promise.resolve(new Uint8Array(readFileSync(new URL(`${z}/${x}/${y}.terrain`, DIR)))); } catch { return Promise.resolve(null); }
};
// The quantized-mesh budget of a level-14 tile of the fixture (tests/quantized-mesh.test.ts): one height step, plus the slope times
// one quantization step and half a float32 step in each direction. The tiles' height ranges are under 40 m.
const b14 = tileBounds(19556, 11121, 14);
const BUDGET_M = 40 / QUANTIZED_MAX + Math.abs(plane.metresPerDegLon) * ((b14.east - b14.west) / QUANTIZED_MAX + 2 ** -19)
  + Math.abs(plane.metresPerDegLat) * ((b14.north - b14.south) / QUANTIZED_MAX + 2 ** -19) + 1e-9;
/** A home inside the fixture: 0.4 of the way across, and its ellipsoidal height somewhere off the terrain, as a location's may be. */
const HOME = { latitudeDeg: bbox[1] + 0.5 * (bbox[3] - bbox[1]), longitudeDeg: bbox[0] + 0.4 * (bbox[2] - bbox[0]), ellipsoidalHeightM: 100 };

describe('terrain source records (TASK-186)', () => {
  const served: LocalTerrain = { status: 'served', layer, bbox, baseUrl: '/geodata/terrain/' };
  const absent: LocalTerrain = { status: 'absent', reason: 'No local terrain is served: set MIRAGE_GEODATA_DIR to the output of scripts/geodata/build_terrain.py' };
  const byId = (local: LocalTerrain, place = { latitudeDeg: HOME.latitudeDeg, longitudeDeg: HOME.longitudeDeg }) =>
    new Map(terrainSources(inventory, local, place).map(record => [record.id, record]));
  test('every inventory source has a record with its kind, layer, coverage, resolution, license and readiness', () => {
    const records = terrainSources(inventory, absent, HOME);
    expect(records.map(record => record.id)).toEqual(inventory.map(source => source.id));
    for (const record of records) {
      expect(record.license.length).toBeGreaterThan(0);
      expect(record.resolution.length).toBeGreaterThan(0);
      // A ready source needs no reason; one that is not ready always says why.
      expect(record.reason === null, record.id).toBe(record.readiness === 'ready');
    }
  });
  test('the pad is ground, ready anywhere and offline; FABDEM is ground, ready only while served and covering the place', () => {
    const offline = byId(absent);
    expect(offline.get('synthetic-pad')).toMatchObject({ layer: 'ground', readiness: 'ready', coverage: { kind: 'any' }, offline: true, reason: null });
    expect(offline.get('fabdem-elevation')).toMatchObject({ layer: 'ground', readiness: 'not-ready', coverage: { kind: 'none' }, reason: absent.reason });
    expect(byId(served).get('fabdem-elevation')).toMatchObject({ layer: 'ground', readiness: 'ready', reason: null,
      coverage: { kind: 'box', west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] } });
    const elsewhere = byId(served, { latitudeDeg: 31.0, longitudeDeg: 34.8 }).get('fabdem-elevation');
    expect(elsewhere?.readiness).toBe('not-ready');
    expect(elsewhere?.reason).toContain('not the location');
  });
  test('imagery is never ground, and adapters that need keys, a deployment or data are not ready, with why', () => {
    const records = byId(served);
    for (const id of ['google-photorealistic-3d-tiles', 'r2-region-cache']) {
      expect(records.get(id)).toMatchObject({ layer: 'imagery', readiness: 'not-ready', offline: false });
      expect(records.get(id)?.reason).toMatch(/^Needs keys or a deployment: /);
    }
    expect(records.get('worldcover-israel')).toMatchObject({ layer: 'imagery', readiness: 'not-ready' });
    expect(records.get('worldcover-israel')?.reason).toMatch(/^Available but not wired into a run/);
    expect(records.get('overture-buildings')?.reason).toMatch(/^Needs data: /);
    expect(records.get('quantized-mesh-fixture')).toMatchObject({ readiness: 'not-ready', reason: 'A test fixture, not a source for a run' });
    expect(records.get('egm96-geoid')).toMatchObject({ layer: 'other', readiness: 'not-ready', reason: 'Not ground a run stands on' });
    expect([...records.values()].filter(record => record.readiness === 'ready').map(record => record.id)).toEqual(['synthetic-pad', 'fabdem-elevation']);
  });
  test('refuses an inventory, layer or manifest it cannot read, with a reason', () => {
    expect(() => parseTerrainInventory({ schemaVersion: 2, sources: [] })).toThrow('schema 1');
    expect(() => parseTerrainInventory({ schemaVersion: 1, sources: [{ ...inventory[0], readiness: 'maybe' }] })).toThrow('readiness is unknown');
    expect(() => parseQuantizedLayer({ ...(json('layer.json') as object), projection: 'EPSG:3857' })).toThrow('EPSG:4326 TMS');
    expect(() => parseQuantizedLayer({ ...(json('layer.json') as object), tiles: ['{z}/{x}.terrain'] })).toThrow('{z}, {x} and {y}');
    expect(() => parseManifestBox({ kind: 'quantized-mesh-terrain', bbox: [35, 32, 34, 33] })).toThrow('not a box on the globe');
    expect(() => parseManifestBox({ kind: '3d-tiles', bbox: [34, 32, 35, 33] })).toThrow('states no bounding box');
  });
});

describe('the lattice of a real-terrain run (TASK-186)', () => {
  test('posts are the terrain\'s height relative to the home, within the tiles\' quantization, and neighbouring chunks share their seams', async () => {
    const terrain = await buildRunTerrain({ layer, bbox, fetchTile, home: HOME, radiusM: 256 });
    const [first, last] = chunkRange(256);
    expect([first, last]).toEqual([-1, 0]);
    expect(terrain.missing).toEqual([]);
    expect(terrain.tiles.map(tile => [tile.northIndex, tile.eastIndex])).toEqual([[-1, -1], [-1, 0], [0, -1], [0, 0]]);
    expect(terrain.level).toBe(14);
    expect(Math.abs(terrain.homeHeightM - heightOf(HOME.longitudeDeg, HOME.latitudeDeg))).toBeLessThanOrEqual(BUDGET_M);
    const per = degreesPerMetre(HOME.latitudeDeg), n = RUN_CHUNK_RESOLUTION;
    let worst = 0;
    for (const tile of terrain.tiles) {
      for (let r = 0; r < n; r += 4) for (let c = 0; c < n; c += 4) {
        const northM = tile.northIndex * RUN_CHUNK_SPAN_M + r * RUN_CHUNK_SPACING_M, eastM = tile.eastIndex * RUN_CHUNK_SPAN_M + c * RUN_CHUNK_SPACING_M;
        const expected = -(heightOf(HOME.longitudeDeg + eastM * per.east, HOME.latitudeDeg + northM * per.north) - HOME.ellipsoidalHeightM);
        worst = Math.max(worst, Math.abs((tile.downM[r * n + c] ?? NaN) - expected));
      }
    }
    expect(worst).toBeLessThanOrEqual(BUDGET_M);
    // The collision store refuses a seam that does not match; every chunk stages, and the published ground holds the vehicle at the home.
    const chunks = new CollisionChunks(RUN_TERRAIN_EPOCH, RUN_CHUNK_RESOLUTION, RUN_CHUNK_SPACING_M);
    for (const tile of terrain.tiles) expect(chunks.stage(tile)).toBe(true);
    expect(chunks.readyAround(0, 0, 8)).toBe(false);
    expect(chunks.publishAtTick(RUN_TERRAIN_EPOCH, 0)).toBe(true);
    expect(chunks.readyAround(0, 0, 8)).toBe(true);
    expect(chunks.readyAround(500, -500, 8)).toBe(true);
    expect(chunks.readyAround(510, 0, 8)).toBe(false);
    expect(Math.abs(chunks.downAt(0, 0) + (terrain.homeHeightM - HOME.ellipsoidalHeightM))).toBeLessThan(1e-9);
  });
  test('ground beyond the terrain\'s coverage is missing, with its reason, never a plane', async () => {
    const terrain = await buildRunTerrain({ layer, bbox, fetchTile, home: HOME, radiusM: 1500 });
    expect(chunkRange(1500)).toEqual([-3, 2]);
    expect(terrain.tiles.length + terrain.missing.length).toBe(36);
    expect(terrain.missing.length).toBeGreaterThan(0);
    expect(new Set(terrain.missing.map(chunk => chunk.reason))).toEqual(new Set(["outside the terrain's coverage"]));
    // What is built covers only the fixture; nothing outside it stands in for missing ground.
    const per = degreesPerMetre(HOME.latitudeDeg);
    for (const tile of terrain.tiles) {
      for (const [r, c] of [[0, 0], [RUN_CHUNK_RESOLUTION - 1, RUN_CHUNK_RESOLUTION - 1]] as const) {
        const lat = HOME.latitudeDeg + (tile.northIndex * RUN_CHUNK_SPAN_M + r * RUN_CHUNK_SPACING_M) * per.north;
        const lon = HOME.longitudeDeg + (tile.eastIndex * RUN_CHUNK_SPAN_M + c * RUN_CHUNK_SPACING_M) * per.east;
        expect(lat >= bbox[1] && lat <= bbox[3] && lon >= bbox[0] && lon <= bbox[2]).toBe(true);
      }
    }
  });
  test('a tile that is not served, or a home off the terrain, is missing too', async () => {
    const none = await buildRunTerrain({ layer, bbox, fetchTile: () => Promise.resolve(null), home: HOME, radiusM: 256 });
    expect(none.tiles).toEqual([]);
    expect(new Set(none.missing.map(chunk => chunk.reason))).toEqual(new Set(['its tile is not served']));
    expect(none.homeHeightM).toBeNaN();
    const away = await buildRunTerrain({ layer, bbox, fetchTile, home: { ...HOME, latitudeDeg: 31 }, radiusM: 256 });
    expect(away.tiles).toEqual([]);
    expect(away.homeHeightM).toBeNaN();
    await expect(buildRunTerrain({ layer, bbox, fetchTile, home: HOME, radiusM: 2000 })).rejects.toThrow('256 m to 1500 m');
  });
  test('metres to degrees on the WGS84 ellipsoid, against the meridian and prime-vertical radii at 45 degrees', () => {
    // NIMA TR8350.2: at 45 degrees M = 6367381.8 m and N = 6388838.3 m.
    const per = degreesPerMetre(45);
    expect(1 / per.north * 180 / Math.PI).toBeCloseTo(6367381.8, 0);
    expect(1 / per.east * 180 / Math.PI / Math.cos(Math.PI / 4)).toBeCloseTo(6388838.3, 0);
  });
});
