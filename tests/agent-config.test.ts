import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const claude = resolve(root, 'CLAUDE.md');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/** Resolves every relative Markdown link in a file against that file's directory. */
function linkTargets(path: string): string[] {
  return Array.from(read(path).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g), match => match[1] ?? '')
    .filter(href => !/^(?:https?:|mailto:)/.test(href))
    .map(href => resolve(root, dirname(path), href));
}
/** Level-2 policy headings of CLAUDE.md; a pointer must not duplicate them. */
const policyHeadings = Array.from(read('CLAUDE.md').matchAll(/^## (.+)$/gm), match => match[1] ?? '');

describe('agent rule discovery entry points', () => {
  it('AGENTS.md resolves to the root CLAUDE.md without copying its policy', () => {
    const targets = linkTargets('AGENTS.md');
    expect(targets).toContain(claude);
    for (const target of targets) expect(existsSync(target), target).toBe(true);
    const text = read('AGENTS.md');
    expect(policyHeadings.length).toBeGreaterThan(0);
    for (const heading of policyHeadings) expect(text).not.toContain(heading);
    expect(text.split('\n').length).toBeLessThanOrEqual(20);
  });
  it('the Cursor rule always applies and resolves to the root CLAUDE.md', () => {
    const text = read('.cursor/rules/project.mdc');
    const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!frontMatter) throw new Error('Missing Cursor rule front matter');
    const metadata: unknown = parse(frontMatter[1] ?? '');
    if (typeof metadata !== 'object' || metadata === null || !('alwaysApply' in metadata) || !('description' in metadata)) {
      throw new Error('Invalid Cursor rule metadata');
    }
    expect(metadata.alwaysApply).toBe(true);
    expect(typeof metadata.description).toBe('string');
    expect(linkTargets('.cursor/rules/project.mdc')).toContain(claude);
    for (const heading of policyHeadings) expect(text).not.toContain(heading);
  });
  it('neither entry point claims automatic discovery by a specific client', () => {
    for (const path of ['AGENTS.md', '.cursor/rules/project.mdc']) {
      expect(read(path)).not.toMatch(/(?:Codex|Cursor|Claude Code)\s+(?:always\s+)?(?:automatically\s+)?(?:loads|reads)/i);
    }
  });
});
