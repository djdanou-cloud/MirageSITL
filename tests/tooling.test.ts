import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import manifest from '../package.json';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('strict tooling gates', () => {
  it('exposes dedicated lint and typecheck commands', () => {
    expect(manifest.scripts).toHaveProperty('lint');
    expect(manifest.scripts).toHaveProperty('typecheck');
  });
  it('rejects explicit any and unsafe JSON-derived operations', async () => {
    const engine = new ESLint({ cwd: root });
    const source = readFileSync(join(root, 'tests/fixtures/tooling/unsafe-types.txt'), 'utf8');
    const results = await engine.lintText(source, { filePath: join(root, 'tests/tooling.test.ts') });
    const rules = results.flatMap(result => result.messages.map(message => message.ruleId));
    for (const name of ['no-explicit-any', 'no-unsafe-assignment', 'no-unsafe-call', 'no-unsafe-member-access', 'no-unsafe-argument', 'no-unsafe-return']) {
      expect(rules).toContain(`@typescript-eslint/${name}`);
    }
    expect(results.some(result => result.fatalErrorCount > 0)).toBe(false);
  });
  it('retains strict compiler settings and diagnoses incompatible assignments', () => {
    const config = ts.readConfigFile(join(root, 'tsconfig.json'), filename => ts.sys.readFile(filename));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    expect(parsed.options.strict).toBe(true);
    expect(parsed.options.noUncheckedIndexedAccess).toBe(true);
    expect(parsed.options.noEmit).toBe(true);
    const filename = join(root, 'tests/fixtures/tooling/type-error.ts');
    const host = ts.createCompilerHost(parsed.options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => path === filename
      ? ts.createSourceFile(path, 'export const speedMps: number = "invalid";', languageVersion)
      : original(path, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([filename], parsed.options, host);
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.code)).toContain(2322);
  });
});
