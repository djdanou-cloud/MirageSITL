// TASK-137 (S01): the application shell's navigation contract. The tab list is
// read from TASK-137's description in the roadmap, so the shell cannot drift
// from the contract. Navigation persists in the project store's local
// settings and falls back to the default when the stored value or its project
// is not valid.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_NAVIGATION, NAVIGATION_SETTING, TABS, forcedTab, loadNavigation, panelId, parseNavigation, saveNavigation,
  tabForKey, tabId, type TabId,
} from '../apps/web/src/shell/navigation';
import { archiveFileName, describeProjectError } from '../apps/web/src/shell/project-files';
import { ProjectStoreError } from '../packages/project/src/schema';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store';

const UUID = '00000000-0000-4000-8000-000000000001';

function contractTabs(): string[] {
  const roadmap = readFileSync(new URL('../docs/PROJECT_ROADMAP.md', import.meta.url), 'utf8');
  const listed = /has a project context and these tabs: ([^.]+)\./.exec(roadmap)?.[1];
  if (!listed) throw new Error('TASK-137 tab list not found in the roadmap');
  // "..., Experiments and Analysis": only the final " and " joins two tabs.
  const parts = listed.split(', ');
  const last = parts.pop() ?? '';
  return [...parts, ...last.split(' and ')];
}

function newStore(backend = new MemoryBackend()): ProjectStore {
  let ids = 0;
  return new ProjectStore(backend, {
    now: () => new Date(Date.UTC(2026, 9, 28, 12)),
    uuid: () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, '0')}`,
    storage: null,
  });
}

describe('tabs', () => {
  test('the shell has the twelve tabs of the contract, in order', () => {
    const expected = contractTabs();
    expect(expected).toHaveLength(12);
    expect(TABS.map(tab => tab.label)).toEqual(expected);
    const ids = TABS.map(tab => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
    const elementIds = ids.flatMap(id => [tabId(id), panelId(id)]);
    expect(new Set(elementIds).size).toBe(elementIds.length);
    for (const id of elementIds) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test('arrow keys move between tabs and wrap; Home and End jump to the ends', () => {
    const first = TABS[0].id, last = TABS[TABS.length - 1]?.id;
    expect([first, last]).toEqual(['project', 'analysis']);
    expect(tabForKey('project', 'ArrowRight')).toBe('aircraft');
    expect(tabForKey('aircraft', 'ArrowLeft')).toBe('project');
    expect(tabForKey('analysis', 'ArrowRight')).toBe('project');
    expect(tabForKey('project', 'ArrowLeft')).toBe('analysis');
    expect(tabForKey('logging', 'Home')).toBe('project');
    expect(tabForKey('logging', 'End')).toBe('analysis');
    for (const key of ['Enter', ' ', 'Tab', 'ArrowUp', 'ArrowDown', 'a']) expect(tabForKey('run', key)).toBeNull();
    // Walking right visits every tab once before returning to the first.
    const visited: TabId[] = [];
    let current: TabId = first;
    for (let i = 0; i < TABS.length; i++) {
      visited.push(current);
      current = tabForKey(current, 'ArrowRight') ?? current;
    }
    expect(visited).toEqual(TABS.map(tab => tab.id));
    expect(current).toBe(first);
  });

  test('the measurement mode keeps the Run tab, where its full-screen view lives', () => {
    expect(forcedTab('?g3=1&view=chase&flight=circuit')).toBe('run');
    expect(forcedTab('')).toBeNull();
    expect(forcedTab('?g3=0')).toBeNull();
    expect(forcedTab('?flight=circuit')).toBeNull();
  });
});

describe('navigation state', () => {
  test('the stored form is validated from unknown', () => {
    expect(parseNavigation({ schemaVersion: 1, tab: 'aircraft', projectId: null })).toEqual({ tab: 'aircraft', projectId: null });
    expect(parseNavigation({ schemaVersion: 1, tab: 'run', projectId: UUID })).toEqual({ tab: 'run', projectId: UUID });
    const rejected: unknown[] = [
      undefined, null, 'run', [], {}, { schemaVersion: 2, tab: 'run', projectId: null },
      { schemaVersion: 1, tab: 'missions', projectId: null }, { schemaVersion: 1, tab: 'run' },
      { schemaVersion: 1, tab: 'run', projectId: 'not-a-uuid' }, { schemaVersion: 1, tab: 'run', projectId: '3f1c2a9e-8b7d-4c6e-9f00-112233445566'.toUpperCase() },
      { schemaVersion: 1, tab: 'run', projectId: null, extra: true }, { schemaVersion: 1, tab: 'run', projectId: null, version: 2 },
      { schemaVersion: 1, tab: 'toString', projectId: null },
    ];
    for (const value of rejected) expect(parseNavigation(value)).toBeNull();
  });

  test('with nothing stored the shell opens the Run tab without a project', async () => {
    expect(DEFAULT_NAVIGATION).toEqual({ tab: 'run', projectId: null });
    expect(await loadNavigation(newStore())).toEqual(DEFAULT_NAVIGATION);
  });

  test('navigation round-trips through the project store settings', async () => {
    const store = newStore();
    const project = await store.createProject('Hexa trials');
    await saveNavigation(store, { tab: 'aircraft', projectId: project.record.id });
    expect(await store.readSetting(NAVIGATION_SETTING)).toEqual({ schemaVersion: 1, tab: 'aircraft', projectId: project.record.id });
    expect(await loadNavigation(store)).toEqual({ tab: 'aircraft', projectId: project.record.id });
  });

  test('a stored project that is gone or is not a project is dropped; an invalid value falls back to the default', async () => {
    const store = newStore();
    const project = await store.createProject('Hexa trials');
    const card = await store.createItem(project.record.id, 'component-card', { name: 'Motor', payload: {} });
    await store.writeSetting(NAVIGATION_SETTING, { schemaVersion: 1, tab: 'logging', projectId: UUID.replace('1', '9') });
    expect(await loadNavigation(store)).toEqual({ tab: 'logging', projectId: null });
    await store.writeSetting(NAVIGATION_SETTING, { schemaVersion: 1, tab: 'logging', projectId: card.record.id });
    expect(await loadNavigation(store)).toEqual({ tab: 'logging', projectId: null });
    await store.writeSetting(NAVIGATION_SETTING, { schemaVersion: 1, tab: 'unknown', projectId: project.record.id });
    expect(await loadNavigation(store)).toEqual(DEFAULT_NAVIGATION);
  });

  test('damaged stored navigation falls back to the default and is replaced by the next save', async () => {
    const backend = new MemoryBackend(), store = newStore(backend);
    // Not canonical JSON: the store reports the setting as corrupted.
    await backend.putSetting(NAVIGATION_SETTING, new TextEncoder().encode('{"tab": "aircraft"}'));
    await expect(store.readSetting(NAVIGATION_SETTING)).rejects.toMatchObject({ code: 'storage' });
    expect(await loadNavigation(store)).toEqual(DEFAULT_NAVIGATION);
    await saveNavigation(store, { tab: 'weather', projectId: null });
    expect(await loadNavigation(store)).toEqual({ tab: 'weather', projectId: null });
  });
});

describe('project files', () => {
  test('archive file names keep the project name without reserved characters', () => {
    expect(archiveFileName('Hexa test')).toBe('Hexa test.mirageproj');
    expect(archiveFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j.mirageproj');
    expect(archiveFileName('  ..hidden  ')).toBe('hidden.mirageproj');
    expect(archiveFileName('x\u{0}y\u{202e}z\u{7f}')).toBe('x y z.mirageproj');
    for (const name of ['', '///', ' . ']) expect(archiveFileName(name)).toBe('project.mirageproj');
    // "Hexacopter trials" in Russian keeps its letters; a long name is cut on a character boundary.
    const russian = '\u{418}\u{441}\u{43f}\u{44b}\u{442}\u{430}\u{43d}\u{438}\u{44f} \u{433}\u{435}\u{43a}\u{441}\u{430}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440}\u{430}';
    expect(archiveFileName(russian)).toBe(`${russian}.mirageproj`);
    const long = archiveFileName(russian.repeat(6));
    expect(new TextEncoder().encode(long.replace('.mirageproj', '')).byteLength).toBeLessThanOrEqual(120);
    expect(/\p{Cs}/u.test(long)).toBe(false);
    expect(long.startsWith(russian)).toBe(true);
  });

  test('store errors become plain explanations', () => {
    const cases: [ProjectStoreError, RegExp][] = [
      [new ProjectStoreError('archive-hash', 'x'), /damaged or was changed/],
      [new ProjectStoreError('archive-header', 'x'), /not a MirageSITL project archive/],
      [new ProjectStoreError('archive-size', 'x'), /empty or larger than/],
      [new ProjectStoreError('archive-invalid', 'Entry 2 is bad'), /Entry 2 is bad/],
      [new ProjectStoreError('conflict', 'x'), /changed both here and in the archive|changed elsewhere/],
      [new ProjectStoreError('quota-exceeded', 'x'), /storage quota/],
      [new ProjectStoreError('invalid', 'A name must have 1 to 128 characters'), /A name must have 1 to 128 characters/],
      [new ProjectStoreError('storage', 'disk failed'), /disk failed/],
    ];
    for (const [error, expected] of cases) expect(describeProjectError(error, 'import')).toMatch(expected);
    expect(describeProjectError(new Error('boom'), 'create')).toMatch(/boom/);
  });
});
