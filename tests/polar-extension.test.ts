import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNeuralFoilPolar } from '@mirage/wasm-bet/rotor';
import { encodeBoundRotor, type BoundPolar } from '@mirage/wasm-bet/rotor';

// TASK-097: the full-range tables against their sources and against the closed forms of the models they
// state, with the tolerances declared in the roadmap before implementation. The oracles are independent of
// tests/fixtures/polars/generate_extended.py: the source tables, and the formulas written out again here.

interface SourceTable { alphaDeg: number[]; reynolds: number[]; cl: number[][]; cd: number[][]; analysisConfidence?: number[][]; }
interface ExtendedTable {
  schemaVersion: number; id: string; provenance: string;
  source: { file: string; sha256: string; alphaRangeDeg: [number, number] };
  model: { cdMax: number; bladeAspectRatio: number; kornKappa: number; thicknessRatio: number };
  rotationalAugmentation: { liftSlopePerRad: number; zeroLiftAlphaRad: number; referenceReynolds: number };
  alphaDeg: number[]; reynolds: number[]; mach: number[]; cl: number[][][]; cd: number[][][]; analysisConfidence: number[][][];
}
const read = (name: string) => readFileSync(`tests/fixtures/polars/${name}`);
const load = <T,>(name: string) => JSON.parse(read(name).toString('utf8')) as T;
const at = (values: number[][][], m: number, r: number, a: number): number => {
  const value = values[m]?.[r]?.[a];
  if (value === undefined) throw new Error(`No cell ${m} ${r} ${a}`);
  return value;
};
const interpolated = (axis: number[], values: number[], x: number): number => {
  const high = axis.findIndex(node => node >= x), low = Math.max(0, high - 1);
  const [a0, a1, v0, v1] = [axis[low] ?? NaN, axis[high] ?? NaN, values[low] ?? NaN, values[high] ?? NaN];
  return a1 === a0 ? v0 : v0 + (v1 - v0) * (x - a0) / (a1 - a0);
};

describe.each([
  ['naca6409-extended.json', 'naca6409-neuralfoil.json', 0.09],
  ['naca0012-extended.json', 'naca0012-neuralfoil.json', 0.12],
] as const)('the full-range table %s', (name, sourceName, nominalThickness) => {
  const table = load<ExtendedTable>(name), source = load<SourceTable>(sourceName);
  const [low, high] = table.source.alphaRangeDeg;
  const alpha = table.alphaDeg, index = (deg: number) => alpha.indexOf(deg);
  const machs = table.mach.map((_, m) => m), rows = table.reynolds.map((_, r) => r);
  const hypot = (x: number) => Math.sqrt(1 - x * x);

  it('names its source by hash and keeps a uniform axis, a real Mach axis and the source Reynolds axis', () => {
    expect(table.schemaVersion).toBe(2);
    expect(table.provenance).toBe('extended-model');
    expect(table.source.sha256).toBe(createHash('sha256').update(read(sourceName)).digest('hex'));
    expect(alpha.length).toBe(361);
    alpha.forEach((deg, i) => { expect(deg).toBe(i - 180); });
    expect(table.mach).toEqual([0, 0.3, 0.5, 0.7]);
    expect(table.reynolds).toEqual(source.reynolds);
    expect(Math.min(...table.reynolds)).toBeLessThanOrEqual(1e4);
    expect(table.model.thicknessRatio).toBeCloseTo(nominalThickness, 2);
    expect(table.model.cdMax).toBeCloseTo(1.11 + 0.018 * table.model.bladeAspectRatio, 12);
  });

  it('holds the source inside its range at Mach 0, and confidence 0 outside it at every Mach', () => {
    for (const r of rows) {
      const [cl, cd, confidence] = [source.cl[r] ?? [], source.cd[r] ?? [], source.analysisConfidence?.[r] ?? []];
      alpha.forEach((deg, a) => {
        if (deg < low || deg > high) {
          for (const m of machs) expect(at(table.analysisConfidence, m, r, a)).toBe(0);
          return;
        }
        expect(Math.abs(at(table.cl, 0, r, a) - interpolated(source.alphaDeg, cl, deg))).toBeLessThanOrEqual(5e-7);
        expect(Math.abs(at(table.cd, 0, r, a) - interpolated(source.alphaDeg, cd, deg))).toBeLessThanOrEqual(5e-7);
        for (const m of machs) expect(Math.abs(at(table.analysisConfidence, m, r, a) - interpolated(source.alphaDeg, confidence, deg))).toBeLessThanOrEqual(5e-4);
      });
    }
  });

  it('is periodic at +-180 degrees, a flat plate at +-90 degrees and never has negative drag', () => {
    for (const m of machs) for (const r of rows) {
      expect(at(table.cl, m, r, 0)).toBe(at(table.cl, m, r, 360));
      expect(at(table.cd, m, r, 0)).toBe(at(table.cd, m, r, 360));
      expect(at(table.analysisConfidence, m, r, 0)).toBe(at(table.analysisConfidence, m, r, 360));
      alpha.forEach((_, a) => { expect(at(table.cd, m, r, a)).toBeGreaterThanOrEqual(0); });
    }
    for (const r of rows) for (const deg of [-90, 90]) {
      expect(Math.abs(at(table.cl, 0, r, index(deg)))).toBeLessThanOrEqual(2e-6);
      expect(Math.abs(at(table.cd, 0, r, index(deg)) - table.model.cdMax)).toBeLessThanOrEqual(2e-6);
    }
  });

  it('follows the reverse-flow mapping away from the join, at Mach 0', () => {
    for (const r of rows) for (let size = 100; size <= 180; size += 1) {
      const forward = 180 - size;
      expect(Math.abs(at(table.cl, 0, r, index(size)) + 0.7 * at(table.cl, 0, r, index(forward)))).toBeLessThanOrEqual(2e-6);
      expect(Math.abs(at(table.cd, 0, r, index(size)) - at(table.cd, 0, r, index(forward)))).toBeLessThanOrEqual(2e-6);
      expect(Math.abs(at(table.cl, 0, r, index(-size)) + 0.7 * at(table.cl, 0, r, index(-forward)))).toBeLessThanOrEqual(2e-6);
      expect(Math.abs(at(table.cd, 0, r, index(-size)) - at(table.cd, 0, r, index(-forward)))).toBeLessThanOrEqual(2e-6);
    }
  });

  it('has no force jump and no kink outside the source range', () => {
    for (const m of machs) for (const r of rows) for (const values of [table.cl, table.cd]) {
      const limit = values === table.cl ? 0.06 : 0.05;
      for (let a = 1; a < alpha.length - 1; a++) {
        const deg = alpha[a] ?? NaN, size = Math.abs(deg);
        if (size > 150 || (deg >= low && deg <= high)) continue;
        const [before, here, after] = [at(values, m, r, a - 1), at(values, m, r, a), at(values, m, r, a + 1)];
        expect(Math.abs(after - here), `${deg} deg at Mach ${table.mach[m]}, row ${r}`).toBeLessThanOrEqual(limit);
        expect(Math.abs(after - 2 * here + before), `${deg} deg at Mach ${table.mach[m]}, row ${r}`).toBeLessThanOrEqual(0.02);
      }
    }
  });

  it('applies Prandtl-Glauert to attached lift and the Korn and Lock drag rise', () => {
    const zeroLift = table.rotationalAugmentation.zeroLiftAlphaRad * 180 / Math.PI;
    let attached = 0;
    for (const m of machs) for (const r of rows) {
      // The source's largest and smallest lift bound the attached range.
      const cl = source.cl[r] ?? [], zeroAt = source.alphaDeg.indexOf(0);
      const largest = zeroAt + cl.slice(zeroAt).indexOf(Math.max(...cl.slice(zeroAt))), smallest = cl.slice(0, zeroAt + 1).indexOf(Math.min(...cl.slice(0, zeroAt + 1)));
      const [top, bottom] = [Math.min(source.alphaDeg[largest] ?? NaN, high - 5), Math.max(source.alphaDeg[smallest] ?? NaN, low + 5)];
      for (let deg = Math.ceil(Math.max(zeroLift - 5, bottom)); deg <= Math.min(zeroLift + 5, top); deg++) {
        const a = index(deg), mach = table.mach[m] ?? NaN;
        expect(Math.abs(at(table.cl, m, r, a) - at(table.cl, 0, r, a) / hypot(mach)), `${deg} deg, Mach ${mach}`).toBeLessThanOrEqual(3e-6);
        attached++;
      }
      alpha.forEach((_, a) => {
        const mach = table.mach[m] ?? NaN, cl = at(table.cl, m, r, a);
        const critical = table.model.kornKappa - table.model.thicknessRatio - Math.abs(cl) / 10 - (0.1 / 80) ** (1 / 3);
        const wave = mach > critical ? 20 * (mach - critical) ** 4 : 0;
        expect(Math.abs(at(table.cd, m, r, a) - at(table.cd, 0, r, a) - wave)).toBeLessThanOrEqual(3e-6);
      });
    }
    expect(attached).toBeGreaterThan(100);
  });

  it('parses into the flattened lookup order and asks for rotational augmentation', () => {
    const polar: BoundPolar = parseNeuralFoilPolar(table);
    expect(polar.mach).toEqual(table.mach);
    const [na, nr] = [alpha.length, table.reynolds.length];
    expect(polar.cl.length).toBe(na * nr * 4);
    const [m, r, a] = [2, 3, index(10)];
    expect(polar.cl[(m * nr + r) * na + a]).toBe(at(table.cl, m, r, a));
    expect(polar.cd[(m * nr + r) * na + a]).toBe(at(table.cd, m, r, a));
    expect(polar.confidence[(m * nr + r) * na + a]).toBe(at(table.analysisConfidence, m, r, a));
    expect(polar.alphaRad[0]).toBeCloseTo(-Math.PI, 12);
    expect(polar.rotational).toEqual({ liftSlopePerRad: 2 * Math.PI, zeroLiftAlphaRad: table.rotationalAugmentation.zeroLiftAlphaRad });
    const source = parseNeuralFoilPolar(source_(sourceName));
    expect(source.rotational).toBeUndefined();
  });

  it('rejects a table with a bad shape, axis or augmentation', () => {
    const broken = (change: (t: ExtendedTable) => void) => { const copy = structuredClone(table); change(copy); return copy; };
    expect(() => parseNeuralFoilPolar(broken(t => { t.mach = [0.1, 0.3, 0.5, 0.7]; }))).toThrow('axis');
    expect(() => parseNeuralFoilPolar(broken(t => { t.mach = [0, 0.5, 0.3, 0.7]; }))).toThrow('increase');
    expect(() => parseNeuralFoilPolar(broken(t => { t.cl = (t.cl).slice(1); }))).toThrow('Mach count');
    expect(() => parseNeuralFoilPolar(broken(t => { t.provenance = 'measured'; }))).toThrow('identity');
    expect(() => parseNeuralFoilPolar(broken(t => { t.rotationalAugmentation.liftSlopePerRad = -1; }))).toThrow('augmentation');
    expect(() => parseNeuralFoilPolar(broken(t => { const row = t.cd[0]?.[0]; if (row) row[0] = -0.1; }))).toThrow('coefficient');
  });
});

function source_(name: string): unknown { return load<unknown>(name); }

describe('bound configuration versions (TASK-097)', () => {
  const geometry = { id: 0, polarId: 0, hubPositionBodyM: [0, 0, 0], hubToBody: [1, 0, 0, 0], bladeCount: 2, spinSign: 1 as const, radiusM: 0.127, rootCutoutM: 0.0127, azimuthSamples: 8, shaftInertiaKgM2: 1e-5, bearingViscousNmPerRadS: 0,
    radialStationM: [0.05, 0.1], chordM: [0.02, 0.02], twistRad: [0.2, 0.1], quadratureWidthM: [0.0572, 0.0571] };
  const encode = (polar: BoundPolar, kernelOptions?: number) => {
    const bytes = encodeBoundRotor({ geometry, polar, initialOmegaRadS: 100, inflowTauS: 0.1, inflowLimitMps: 50, minimumConfidence: 0.9, ...(kernelOptions === undefined ? {} : { kernelOptions }) }, 1 / 400);
    return new DataView(bytes.buffer);
  };
  it('writes version 3 with the two values only for a table that asks for the augmentation', () => {
    const extended = parseNeuralFoilPolar(load<unknown>('naca6409-extended.json')), source = parseNeuralFoilPolar(load<unknown>('naca6409-neuralfoil.json'));
    const plain = encode(source);
    expect([plain.getUint32(0, true), plain.getUint32(36, true), plain.getFloat64(112, true), plain.getFloat64(120, true)]).toEqual([1, 0, 0, 0]);
    const asked = encode(extended);
    expect([asked.getUint32(0, true), asked.getUint32(36, true)]).toEqual([3, 8]);
    expect(asked.getFloat64(112, true)).toBe(extended.rotational?.liftSlopePerRad);
    expect(asked.getFloat64(120, true)).toBe(extended.rotational?.zeroLiftAlphaRad);
    expect(encode(extended, 4).getUint32(36, true)).toBe(12);
    expect(encode(source, 4).getUint32(0, true)).toBe(2);
  });
});
