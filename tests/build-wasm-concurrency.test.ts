// scripts/build-wasm.mjs runs from many test files at once, so concurrent runs must all succeed with the same artifacts, and a
// file read from the published directory during those runs must always be whole.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withExclusiveLock } from '../scripts/exclusive-lock.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const published = join(root, 'packages/wasm-bet/dist');
const lockModule = join(root, 'scripts/exclusive-lock.ts');
const ARTIFACTS = ['mirage_bet.scalar.wasm', 'mirage_bet.simd128.wasm'] as const;
const FILES = [...ARTIFACTS, 'manifest.json'] as const;

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mirage-build-wasm-'));
  directories.push(directory);
  return directory;
}
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function hashes(directory: string): Record<string, string> {
  return Object.fromEntries(FILES.map(file => [file, sha256(readFileSync(join(directory, file)))]));
}

interface RunResult { readonly out: string; readonly code: number | null; readonly output: string }
function startBuild(out: string | undefined): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/build-wasm.mjs', ...(out === undefined ? [] : ['--out', out])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => { resolve({ out: out ?? published, code, output }); });
  });
}

describe('concurrent scripts/build-wasm.mjs runs', () => {
  let baseline: Record<string, string> = {};
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { cwd: root, stdio: 'pipe' });
    const alone = temporaryDirectory();
    execFileSync(process.execPath, ['scripts/build-wasm.mjs', '--out', alone], { cwd: root, stdio: 'pipe' });
    baseline = hashes(alone);
  }, 300_000);

  it('all succeed with the artifacts of a run alone, while the published files stay whole', async () => {
    // Two or three runs at once rarely meet the race. At sixteen, about one run in ten failed before the lock (17 of 192).
    const ROUNDS = 5, RUNS_PER_ROUND = 12;
    // The manifest was open for writing for microseconds, so most reads go to it.
    const MANIFEST_READS_PER_PASS = 200;
    const manifestExpected = readFileSync(join(published, 'manifest.json'));
    let reading = true;
    const torn: string[] = [];
    let reads = 0;
    const reader = (async () => {
      while (reading) {
        reads++;
        for (let read = 0; read < MANIFEST_READS_PER_PASS; read++) {
          const manifestBytes = readFileSync(join(published, 'manifest.json'));
          if (!manifestBytes.equals(manifestExpected)) torn.push(`manifest.json: ${manifestBytes.byteLength} bytes`);
        }
        for (const file of ARTIFACTS) {
          const bytes = readFileSync(join(published, file));
          if (sha256(bytes) !== baseline[file]) torn.push(`${file}: ${bytes.byteLength} bytes`);
        }
        await new Promise(resolve => { setImmediate(resolve); });
      }
    })();
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const outputs = Array.from({ length: RUNS_PER_ROUND }, (_, run) => (run % 2 === 0 ? undefined : temporaryDirectory()));
        const results = await Promise.all(outputs.map(startBuild));
        expect(results.filter(result => result.code !== 0).map(result => result.output)).toEqual([]);
        for (const result of results) expect(hashes(result.out)).toEqual(baseline);
        for (const out of outputs) if (out !== undefined) expect(readdirSync(out).sort()).toEqual([...FILES].sort());
      }
    } finally {
      reading = false;
      await reader;
    }
    expect(torn).toEqual([]);
    expect(reads).toBeGreaterThan(0);
  }, 300_000);

  it('publishes a manifest whose every hash and size match the artifact beside it', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(published, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      crate: 'mirage-bet',
      artifacts: ARTIFACTS.map(file => {
        const bytes = readFileSync(join(published, file));
        return { file, sha256: sha256(bytes), bytes: bytes.byteLength };
      }),
    });
  });
});

describe('withExclusiveLock', () => {
  /** A process that has exited, so nothing owns its ID. */
  function finishedProcessId(): number {
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    return pid;
  }

  it('never lets two processes hold the lock, even when they all start by removing a killed holder', async () => {
    const directory = temporaryDirectory();
    const lock = join(directory, 'lock'), holder = join(directory, 'holder');
    writeFileSync(lock, `${finishedProcessId()} killed-holder\n`);
    // A second holder fails to create the marker the first still has.
    const contender = `
      import { rmSync, writeFileSync } from 'node:fs';
      import { withExclusiveLock } from ${JSON.stringify(lockModule)};
      const cell = new Int32Array(new SharedArrayBuffer(4));
      for (let turn = 0; turn < 40; turn++) withExclusiveLock(${JSON.stringify(lock)}, () => {
        writeFileSync(${JSON.stringify(holder)}, '', { flag: 'wx' });
        Atomics.wait(cell, 0, 0, 1);
        rmSync(${JSON.stringify(holder)});
      }, { pollMs: 1 });
    `;
    const exits = await Promise.all(Array.from({ length: 6 }, () => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', contender], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => { resolve({ code, stderr }); });
    })));
    expect(exits.filter(exit => exit.code !== 0)).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  }, 120_000);

  it('waits for a live owner, then fails naming the file, without running the work or taking the lock', () => {
    const lock = join(temporaryDirectory(), 'lock');
    const owner = `${process.pid} live-holder\n`;
    writeFileSync(lock, owner);
    let ran = false;
    expect(() => withExclusiveLock(lock, () => { ran = true; }, { timeoutMs: 50, pollMs: 5 })).toThrow(/Timed out after 50 ms waiting for .*lock.*live-holder/);
    expect(ran).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(owner);
  });

  it('does not guess at content it did not write', () => {
    const lock = join(temporaryDirectory(), 'lock');
    writeFileSync(lock, 'not an owner\n');
    expect(() => withExclusiveLock(lock, () => undefined, { timeoutMs: 20, pollMs: 5 })).toThrow(/Timed out/);
    expect(readFileSync(lock, 'utf8')).toBe('not an owner\n');
  });

  it('takes the lock from a finished owner and returns the result of the work', () => {
    const directory = temporaryDirectory();
    const lock = join(directory, 'lock');
    writeFileSync(lock, `${finishedProcessId()} killed-holder\n`);
    expect(withExclusiveLock(lock, () => {
      expect(readFileSync(lock, 'utf8')).toContain(`${process.pid} `);
      return 7;
    }, { timeoutMs: 1000 })).toBe(7);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('releases the lock when the work throws', () => {
    const directory = temporaryDirectory();
    const lock = join(directory, 'lock');
    expect(() => withExclusiveLock(lock, () => { throw new Error('work failed'); })).toThrow('work failed');
    expect(existsSync(lock)).toBe(false);
    expect(withExclusiveLock(lock, () => 'again', { timeoutMs: 1000 })).toBe('again');
  });

  it('leaves alone a lock that is no longer its own when the work ends', () => {
    const directory = temporaryDirectory();
    const lock = join(directory, 'lock');
    withExclusiveLock(lock, () => {
      rmSync(lock);
      writeFileSync(lock, 'another holder\n');
    });
    expect(readFileSync(lock, 'utf8')).toBe('another holder\n');
  });
});
