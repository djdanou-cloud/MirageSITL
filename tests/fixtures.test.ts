import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '@mirage/test-support/prng';
import { verifyFixture } from '@mirage/test-support/fixtures';
import registry from './fixtures/registry.json';

describe('versioned fixture provenance and random streams', () => {
  it('matches the frozen uint32 reference and resets exactly', () => {
    const rng = new SeededRandom(123, 7);
    const vector = [1915834569, 2163859737, 2018986825, 2541224312, 3937151044];
    expect(vector.map(() => rng.nextUint32())).toEqual(vector);
    rng.reset(123, 7);
    expect(rng.nextUint32()).toBe(vector[0]);
    for (let i = 0; i < 1000; i++) expect(rng.nextFloat()).toBeGreaterThanOrEqual(0);
    expect(() => new SeededRandom(-1, 0)).toThrow();
    expect(() => new SeededRandom(0, 0.5)).toThrow();
  });
  it('keeps stream state separate and accepts zero seeds', () => {
    const a = new SeededRandom(0, 0), b = new SeededRandom(0, 1), control = new SeededRandom(0, 1);
    const firstA = a.nextUint32();
    for (let i = 0; i < 100; i++) a.nextUint32();
    expect(b.nextUint32()).toBe(control.nextUint32());
    expect(firstA).not.toBe(new SeededRandom(0, 1).nextUint32());
    for (let i = 0; i < 1000; i++) expect(a.nextFloat()).toBeLessThan(1);
  });
  it('verifies every registered fixture against its exact payload bytes', async () => {
    for (const entry of registry.fixtures) {
      const bytes = readFileSync(new URL(`./fixtures/${entry.path}`, import.meta.url));
      const verified = await verifyFixture(entry.manifest, bytes);
      expect(verified.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      // Only the archived NASA drop and UIUC propeller measurements may claim measured provenance.
      if (entry.path === 'contact/nasa-drop.json') {
        expect(verified.provenance).toEqual({
          kind: 'measured', datasetId: 'NASA-TM-X-3561-DropTest', license: 'Public-Domain-US-Gov',
          acquiredAt: '1977-11-01T00:00:00Z', referenceUrl: 'https://ntrs.nasa.gov/citations/19780003109',
        });
      } else if (entry.path === 'rotors/uiuc-propellers.json') {
        expect(verified.provenance).toEqual({
          kind: 'measured', datasetId: 'UIUC-Propeller-Database-Vols-1-4',
          license: 'UIUC-Propeller-Database-citation-requested-no-explicit-license',
          acquiredAt: '2022-06-27T00:00:00Z', referenceUrl: 'https://m-selig.ae.illinois.edu/props/propDB.html',
        });
      } else expect(verified.provenance.kind).toBe('synthetic');
      expect(Object.isFrozen(verified.validityEnvelope)).toBe(true);
    }
  });
  it('regenerates the NASA drop fixture byte-for-byte from the hashed archives', () => {
    const result = spawnSync('python3', ['-I', 'tests/fixtures/contact/generate_nasa_drop.py', '--check'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('matches the archived sources');
  });
  it('requires complete HTTPS measured provenance without a derivation', async () => {
    const entry = registry.fixtures.find(item => item.path === 'contact/nasa-drop.json');
    if (!entry) throw new Error('NASA drop fixture is not registered');
    const bytes = readFileSync(new URL(`./fixtures/${entry.path}`, import.meta.url));
    const { referenceUrl, ...withoutUrl } = entry.manifest.provenance;
    const invalid: unknown[] = [
      { ...entry.manifest, provenance: withoutUrl },
      { ...entry.manifest, provenance: { ...withoutUrl, reference: referenceUrl } },
      { ...entry.manifest, provenance: { ...entry.manifest.provenance, referenceUrl: 'http://ntrs.nasa.gov/citations/19780003109' } },
      { ...entry.manifest, provenance: { ...entry.manifest.provenance, derivation: 'fitted' } },
      { ...entry.manifest, provenance: { ...entry.manifest.provenance, acquiredAt: 'unknown' } },
    ];
    for (const value of invalid) await expect(verifyFixture(value, bytes)).rejects.toThrow('provenance');
  });
  it('rejects wrong units, hashes, bounds, and synthetic relabeling', async () => {
    const entry = registry.fixtures[0]!;
    const bytes = readFileSync(new URL(`./fixtures/${entry.path}`, import.meta.url));
    const invalid: unknown[] = [
      { ...entry.manifest, units: { timeS: 'seconds', downM: 'feet' } },
      { ...entry.manifest, sourceSha256: 'bad' },
      { ...entry.manifest, sourceSha256: '0'.repeat(64) },
      { ...entry.manifest, tolerance: { absolute: -1, relative: 0 } },
      { ...entry.manifest, provenance: { ...entry.manifest.provenance, kind: 'measured' } },
      { ...entry.manifest, validityEnvelope: { timeS: { min: 2, max: 1 }, downM: { min: 0, max: 20 } } },
    ];
    for (const value of invalid) await expect(verifyFixture(value, bytes)).rejects.toThrow();
    await expect(verifyFixture(entry.manifest, new Uint8Array([0]))).rejects.toThrow('hash');
  });
});
