import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repository = fileURLToPath(new URL('../', import.meta.url));
const temporaryRepositories: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mirage-docs-'));
  temporaryRepositories.push(root);
  const registry: unknown = JSON.parse(readFileSync(join(repository, 'docs/documentation-index.json'), 'utf8'));
  if (typeof registry !== 'object' || registry === null || !('pairs' in registry) || !Array.isArray(registry.pairs)) {
    throw new Error('Invalid documentation registry');
  }
  const files = ['docs/documentation-index.json', 'scripts/check-docs.mjs', 'packages/protocol/src/index.ts'];
  for (const pair of registry.pairs as unknown[]) {
    if (typeof pair !== 'object' || pair === null || !('en' in pair) || !('ru' in pair) ||
      typeof pair.en !== 'string' || typeof pair.ru !== 'string') throw new Error('Invalid document pair');
    files.push(pair.en, pair.ru);
  }
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repository, file), join(root, file));
  }
  const git = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr || 'Cannot initialize policy test fixture');
  return root;
}
function run(root: string) {
  return spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd: root, encoding: 'utf8' });
}
function rewrite(root: string, file: string, change: (text: string) => string): void {
  const path = join(root, file);
  writeFileSync(path, change(readFileSync(path, 'utf8')));
}
afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bilingual documentation policy', () => {
  it('accepts complete synchronized documents', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
    // Derive expected counts from the sources so adding a pair or task does not break this test.
    const registry: unknown = JSON.parse(readFileSync(join(repository, 'docs/documentation-index.json'), 'utf8'));
    const pairs = typeof registry === 'object' && registry !== null && 'pairs' in registry && Array.isArray(registry.pairs) ? registry.pairs.length : -1;
    const tasks = readFileSync(join(repository, 'docs/PROJECT_ROADMAP.md'), 'utf8').match(/^### TASK-\d{3} — /gm)?.length ?? -1;
    expect(pairs).toBeGreaterThan(0);
    expect(tasks).toBeGreaterThan(0);
    expect(result.stdout).toContain(`${pairs} bilingual pairs, ${tasks} tasks`);
  });
  it('rejects an English change without a translated mirror update', () => {
    const root = fixture();
    rewrite(root, 'README.md', text => text + '\nAn architecture change.\n');
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Stale mirror');
  });
  it('rejects divergent TypeScript contracts even when the source hash is current', () => {
    const root = fixture();
    rewrite(root, 'docs/ru/SPECS_SHARED_MEMORY.md', text => text.replace('version: 1; buffer:', 'version: 9; buffer:'));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Fenced contracts differ');
  });
  it('rejects static Cyrillic outside the Russian documentation directory', () => {
    const root = fixture();
    writeFileSync(join(root, 'invalid.ts'), `const message = '${String.fromCodePoint(0x0410)}';\n`);
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Cyrillic text outside docs/ru/');
  });
  it('rejects a missing Russian mirror', () => {
    const root = fixture();
    rmSync(join(root, 'docs/ru/README.md'));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
  });
  it('rejects a cyclic backlog even when both languages and the hash agree', () => {
    const root = fixture();
    const source = 'docs/PROJECT_ROADMAP.md', mirror = 'docs/ru/PROJECT_ROADMAP.md';
    const addCycle = (text: string) => text.replace(/(- \*\*Dependencies:\*\*)[^\n]+/, '$1 TASK-002.');
    rewrite(root, source, addCycle);
    rewrite(root, mirror, addCycle);
    const digest = createHash('sha256').update(readFileSync(join(root, source))).digest('hex');
    rewrite(root, mirror, text => text.replace(/source-sha256: [a-f0-9]{64}/, `source-sha256: ${digest}`));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Dependency cycle');
  });
});
