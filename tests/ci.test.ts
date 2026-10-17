import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import browserConfig from '../playwright.config';
import { viteFileUrl } from './support/vite-url';

const root = fileURLToPath(new URL('../', import.meta.url));
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a workflow object');
  return value as Record<string, unknown>;
}

describe('pull request CI contract', () => {
  it('serves absolute browser fixture URLs with portable separators and escaped names', () => {
    const url = viteFileUrl(new URL('./fixtures/folder%20name/hash%23name.ts', import.meta.url));
    expect(url).toMatch(/^\/@fs\//);
    expect(url).not.toContain('\\');
    expect(url).toContain('/folder%20name/hash%23name.ts');
  });
  it('runs independent unit, browser, and build jobs with frozen dependencies', () => {
    const document: unknown = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
    const workflow = record(document);
    expect(record(workflow.on)).toHaveProperty('pull_request');
    expect(record(workflow.permissions)).toEqual({ contents: 'read' });
    const jobs = record(workflow.jobs);
    for (const [name, command] of [['unit', 'npm test'], ['browser', 'npm run test:browser'], ['build', 'npm run build']]) {
      const job = record(jobs[name!]);
      expect(job['continue-on-error']).not.toBe(true);
      if (!Array.isArray(job.steps)) throw new Error('Missing job steps');
      const steps = (job.steps as unknown[]).map(record);
      for (const step of steps) expect(step['continue-on-error']).not.toBe(true);
      const commands = steps.map(step => typeof step.run === 'string' ? step.run : '').join('\n');
      expect(commands).toContain('npm ci');
      expect(commands).toContain(command);
      expect(commands).not.toMatch(/passWithNoTests|pass-with-no-tests|\|\| true/);
      expect(steps.some(step => record(step.with ?? {})['node-version'] === 24)).toBe(true);
      expect(steps.some(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@') && step.if === 'always()')).toBe(true);
    }
    const unitSteps = record(jobs.unit).steps;
    if (!Array.isArray(unitSteps)) throw new Error('Missing unit steps');
    const commands = (unitSteps as unknown[]).map(record).map(step => step.run).join('\n');
    for (const command of ['npm run lint', 'npm run typecheck', 'npm run check:docs']) expect(commands).toContain(command);
  });
  it('fails a unit run that discovers no tests', () => {
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/fixtures/tooling/missing-case.test.ts'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('No test files found');
  });
  it('fails browser discovery when no tests match', () => {
    expect(browserConfig.use?.trace).toBe('retain-on-failure');
    const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=list', '--grep', '^missing-ci-case$'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('No tests found');
  });
  it('pins one Rust toolchain across native/rust-toolchain.toml and every workflow that installs it', () => {
    const toolchain = readFileSync(join(root, 'native/rust-toolchain.toml'), 'utf8');
    const channel = /^channel = "([^"]+)"$/m.exec(toolchain)?.[1];
    expect(channel).toMatch(/^\d+\.\d+\.\d+$/);
    expect(toolchain).toContain('"wasm32-unknown-unknown"');
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/native.yml']) {
      const installs = Array.from(readFileSync(join(root, workflow), 'utf8').matchAll(/rustup toolchain install (\S+)/g), m => m[1]);
      expect(installs.length, workflow).toBeGreaterThan(0);
      for (const version of installs) expect(version, workflow).toBe(channel);
    }
    const native: unknown = parse(readFileSync(join(root, '.github/workflows/native.yml'), 'utf8'));
    const job = record(record(record(native).jobs).native);
    expect(record(record(job.defaults).run)['working-directory']).toBe('native');
    if (!Array.isArray(job.steps)) throw new Error('Missing native steps');
    const commands = (job.steps as unknown[]).map(record).map(step => typeof step.run === 'string' ? step.run : '').join('\n');
    for (const command of ['cargo check --workspace --locked', 'cargo test --workspace --locked',
      'cargo check -p mirage-bet --target wasm32-unknown-unknown --locked', 'sha256sum']) expect(commands).toContain(command);
  });
});
