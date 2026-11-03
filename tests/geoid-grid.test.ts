import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EGM96_15_LAYOUT, EGM96_15_SHA256, loadEgm96Geoid, mslAccuracyGate, mslHeightM } from '../packages/sensors/src/geoid.ts';

// TASK-148: the hashed EGM96 15-minute grid opens the TASK-036 absolute-MSL gate. The values are
// checked against an independent conversion of the same NGA model (OSGeo PROJ-data's GeoTIFF,
// tests/fixtures/geoid/egm96-proj-nodes.json). Tolerance, declared from the formats: the DAC rounds
// to whole centimetres (at most 5 mm), the PROJ copy rounds to millimetres (at most 0.5 mm), and
// float32 adds below 1e-5 m, so 5.6 mm at every node.
const DEG = Math.PI / 180;
const dac = new Uint8Array(readFileSync('data/geoid/WW15MGH.DAC'));
interface Nodes { source: { sha256: string; commit: string }; nodes: number[][] }
function nodes(): Nodes {
  const parsed: unknown = JSON.parse(readFileSync('tests/fixtures/geoid/egm96-proj-nodes.json', 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('nodes' in parsed) || !Array.isArray(parsed.nodes) || !('source' in parsed)) throw new Error('Bad fixture');
  const list: unknown[] = parsed.nodes, source: unknown = parsed.source;
  if (typeof source !== 'object' || source === null || !('sha256' in source) || typeof source.sha256 !== 'string' || !('commit' in source) || typeof source.commit !== 'string') throw new Error('Bad fixture source');
  const out: number[][] = [];
  for (const node of list) {
    if (!Array.isArray(node) || node.length !== 3 || !node.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) throw new Error('Bad node');
    out.push(node.map(Number));
  }
  return { source: { sha256: source.sha256, commit: source.commit }, nodes: out };
}

describe('EGM96 15-minute geoid grid (TASK-148)', () => {
  it('is the pinned NGA payload recorded in the geoid inventory', () => {
    expect(createHash('sha256').update(dac).digest('hex')).toBe(EGM96_15_SHA256);
    const inventory: unknown = JSON.parse(readFileSync('data/geoid/inventory.json', 'utf8'));
    expect(inventory).toMatchObject({ schemaVersion: 1, grids: expect.arrayContaining([expect.objectContaining({
      id: 'egm96-15', readiness: 'ready', files: [{ path: 'data/geoid/WW15MGH.DAC', sha256: EGM96_15_SHA256, bytes: EGM96_15_LAYOUT.bytes }] })]) as unknown });
  });
  it('opens the absolute-MSL gate and converts heights with the grid', async () => {
    const geoid = await loadEgm96Geoid(dac);
    expect(mslAccuracyGate(geoid, EGM96_15_SHA256)).toEqual({ status: 'AVAILABLE', model: 'EGM96-15min', sha256: EGM96_15_SHA256 });
    // The North Pole node is +13.61 m and the South Pole node -29.53 m in WW15MGH.DAC.
    expect(geoid.undulationM(90 * DEG, 0)).toBeCloseTo(13.61, 10);
    expect(geoid.undulationM(-90 * DEG, 0)).toBeCloseTo(-29.53, 10);
    expect(mslHeightM(geoid, 90 * DEG, 0, 100)).toBeCloseTo(86.39, 10);
  });
  it('agrees with the independent PROJ-data conversion of the same model at every fixture node', async () => {
    const geoid = await loadEgm96Geoid(dac), fixture = nodes();
    expect(fixture.source.sha256).toBe('db493027562c9b004d7220fa881f5603adada4e1c5029b933fa7de4547b0e78d');
    expect(fixture.nodes.length).toBe(2666);
    let worst = 0;
    for (const [lat, lon, n] of fixture.nodes) worst = Math.max(worst, Math.abs(geoid.undulationM((lat ?? Number.NaN) * DEG, (lon ?? Number.NaN) * DEG) - (n ?? Number.NaN)));
    expect(worst).toBeLessThan(0.0056);
    // The global extremes of EGM96: about -107 m south of India and +85 m over New Guinea.
    expect(geoid.undulationM(4.75 * DEG, 78.75 * DEG)).toBeCloseTo(-106.99, 2);
    expect(geoid.undulationM(-8.25 * DEG, 147.25 * DEG)).toBeCloseTo(85.39, 2);
  });
  it('refuses altered or truncated bytes', async () => {
    const altered = new Uint8Array(dac);
    altered[1000] = altered[1000]! ^ 1;
    await expect(loadEgm96Geoid(altered)).rejects.toThrow('does not match the pinned EGM96 SHA-256');
    await expect(loadEgm96Geoid(new Uint8Array(dac.slice(0, 1000)))).rejects.toThrow('must be');
  });
});
