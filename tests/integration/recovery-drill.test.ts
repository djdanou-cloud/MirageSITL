import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureToken } from '../../apps/launcher/src/server';
import { readCatalog, verifyEntry } from '../../apps/launcher/src/catalog';

// TASK-190: the recovery steps of docs/operations/install-macos.md, on a copy-on-write copy of the real TASK-152 installation. Nothing here
// fetches: with everything fetched, the installer repairs from the launcher folder alone, which scripts/phase1/global-workflows.mjs proves
// by running this with the network blocked. It skips without an installation, and that run counts a skip as a failure.
const HOME = join(process.cwd(), '.cache/task-152/home');
const installed = existsSync(join(HOME, 'install-manifest.json'));
const FIRMWARE = 'arducopter-fb773567';
let scratch = '', copy = '';
const install = () => spawnSync(process.execPath, ['scripts/install-macos.mjs', '--home', copy], { encoding: 'utf8', timeout: 1500_000 });
const hashOf = (id: string): string => readCatalog(copy).find(entry => entry.id === id)?.binarySha256 ?? '';

describe.skipIf(!installed)('recovery on a copy of the installation', () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'mirage-recovery-'));
    copy = join(scratch, 'home');
    const cloned = spawnSync('/bin/cp', ['-cR', HOME, copy], { encoding: 'utf8' });
    if (cloned.status !== 0) throw new Error(`The copy failed: ${cloned.stderr}`);
    // The first run binds the copy's catalog and manifest to the copy's own paths.
    const first = install();
    if (first.status !== 0) throw new Error(`The installer failed on the copy: ${first.stderr}`);
  }, 1800_000);
  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it('a rerun on a whole installation changes nothing it recorded', () => {
    const before = hashOf(FIRMWARE), started = Date.now(), again = install();
    expect(again.status, again.stderr).toBe(0);
    expect(hashOf(FIRMWARE)).toBe(before);
    expect(Date.now() - started).toBeLessThan(120_000);
  }, 300_000);
  it('an installation that stopped before its manifest finishes on a rerun', () => {
    rmSync(join(copy, 'install-manifest.json'));
    const again = install();
    expect(again.status, again.stderr).toBe(0);
    expect(existsSync(join(copy, 'install-manifest.json'))).toBe(true);
  }, 300_000);
  it('a damaged executable is rebuilt from the fetched sources, and never taken as it is', () => {
    const entry = readCatalog(copy).find(item => item.id === FIRMWARE);
    if (!entry) throw new Error('No firmware in the copy\'s catalog');
    appendFileSync(entry.binaryPath, Buffer.from([0]));
    const damaged = createHash('sha256').update(readFileSync(entry.binaryPath)).digest('hex');
    expect(verifyEntry(entry).usable).toBe(false);
    const again = install();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('The executable changed since it was built');
    expect(hashOf(FIRMWARE)).not.toBe(damaged);
    const rebuilt = readCatalog(copy).find(item => item.id === FIRMWARE);
    if (!rebuilt) throw new Error('No firmware after the rebuild');
    expect(verifyEntry(rebuilt).usable).toBe(true);
  }, 1500_000);
  it('a deleted token is replaced on the next start, readable by its owner only', () => {
    const path = join(copy, 'token'), before = readFileSync(path, 'utf8');
    rmSync(path);
    const token = ensureToken(copy);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(before.trim());
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});
