import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFileSync(resolve(root, name), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const cyrillic = /\p{Script=Cyrillic}/u;
const index = JSON.parse(read('docs/documentation-index.json'));
assert.equal(index.schemaVersion, 1, 'Unknown documentation index version');
assert.ok(Array.isArray(index.pairs) && index.pairs.length > 0, 'Missing document pairs');
const registered = new Set();
const blocks = text => Array.from(text.matchAll(/^```[^\n]*\n[\s\S]*?^```/gm), match => match[0]);
const equations = text => Array.from(text.matchAll(/\\\[[\s\S]*?\\\]/g), match => match[0]);
const taskSections = text => text.split(/(?=^### TASK-\d{3} — )/m).slice(1);
const field = (section, label) => {
  const line = section.split('\n').find(value => value.startsWith(`- **${label}:**`));
  assert.ok(line, `Missing task field: ${label}`);
  return line;
};

for (const pair of index.pairs) {
  assert.equal(typeof pair.en, 'string');
  assert.equal(typeof pair.ru, 'string');
  assert.ok(!pair.en.startsWith('docs/ru/') && pair.ru.startsWith('docs/ru/'), 'Invalid language placement');
  assert.equal(basename(pair.en), basename(pair.ru), 'Mirror basename differs');
  for (const path of [pair.en, pair.ru]) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Invalid registered path');
    assert.ok(!registered.has(path), `Duplicate registration: ${path}`);
    registered.add(path);
  }
  const source = read(pair.en), mirror = read(pair.ru);
  assert.ok(!cyrillic.test(source), `Non-English Cyrillic text in ${pair.en}`);
  assert.ok(cyrillic.test(mirror), `Missing Russian prose in ${pair.ru}`);
  const digest = mirror.match(/^<!-- source-sha256: ([a-f0-9]{64}) -->$/m)?.[1];
  assert.equal(digest, hash(source), `Stale mirror: ${pair.ru}; translate/review before updating its source hash`);
  assert.deepEqual(blocks(mirror), blocks(source), `Fenced contracts differ: ${pair.en}`);
  assert.deepEqual(equations(mirror), equations(source), `Equations differ: ${pair.en}`);
  if (basename(pair.en) === 'SPECS_SHARED_MEMORY.md') {
    const layoutColumns = text => Array.from(text.matchAll(/^\| (\d[^|]*)\|([^|]*)\|/gm), match => [match[1].trim(), match[2].trim()]);
    assert.deepEqual(layoutColumns(mirror), layoutColumns(source), `Binary offsets/types differ: ${pair.en}`);
  }
  const sourceTasks = taskSections(source), mirrorTasks = taskSections(mirror);
  assert.equal(mirrorTasks.length, sourceTasks.length, `Task count differs: ${pair.en}`);
  for (let i = 0; i < sourceTasks.length; i++) {
    assert.equal(mirrorTasks[i].match(/^### (TASK-\d{3})/)[1], sourceTasks[i].match(/^### (TASK-\d{3})/)[1]);
    assert.equal(field(mirrorTasks[i], 'Touched Files'), field(sourceTasks[i], 'Touched Files'));
    const dependencies = section => field(section, 'Dependencies').match(/TASK-\d{3}/g) ?? [];
    assert.deepEqual(dependencies(mirrorTasks[i]), dependencies(sourceTasks[i]));
    for (const label of ['Status', 'Title & Description', 'Interfaces / Contracts', 'DoD & Acceptance Criteria']) field(mirrorTasks[i], label);
  }
  for (const [name, text] of [[pair.en, source], [pair.ru, mirror]]) {
    assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, `Unclosed fence: ${name}`);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^(?:https?:|mailto:|#)/.test(href)) continue;
      const target = resolve(root, dirname(name), href.split('#')[0]);
      assert.ok(!relative(root, target).startsWith('..'), `Link escapes repository: ${name}: ${href}`);
      assert.ok(existsSync(target), `Broken link: ${name}: ${href}`);
    }
  }
}

// Check tracked and untracked text, respecting Git ignore rules for generated files.
const paths = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
const textExtensions = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.yml', '.yaml', '.toml', '.rs', '.cpp', '.h', '.glsl', '.wgsl', '.xml', '.txt', '.lock', '.mdc']);
for (const path of paths) {
  if (!existsSync(resolve(root, path))) continue;
  if (path.endsWith('.md')) assert.ok(registered.has(path), `Unregistered documentation pair: ${path}`);
  if (path.startsWith('docs/ru/')) continue;
  if (textExtensions.has(extname(path)) || ['.gitignore', '.nvmrc'].includes(path)) {
    assert.ok(!cyrillic.test(read(path)), `Cyrillic text outside docs/ru/: ${path}`);
  }
}

const roadmap = read('docs/PROJECT_ROADMAP.md');
const graph = new Map();
for (const section of taskSections(roadmap)) {
  const id = section.match(/^### (TASK-\d{3})/)[1];
  assert.ok(!graph.has(id), `Duplicate task ${id}`);
  for (const label of ['Status', 'Title & Description', 'Touched Files', 'Interfaces / Contracts', 'DoD & Acceptance Criteria']) field(section, label);
  graph.set(id, field(section, 'Dependencies').match(/TASK-\d{3}/g) ?? []);
}
const visited = new Set(), active = new Set();
function visit(id) {
  assert.ok(graph.has(id), `Unknown dependency ${id}`);
  assert.ok(!active.has(id), `Dependency cycle at ${id}`);
  if (visited.has(id)) return;
  active.add(id);
  for (const dependency of graph.get(id)) visit(dependency);
  active.delete(id); visited.add(id);
}
for (const id of graph.keys()) visit(id);
for (const pair of index.pairs) {
  for (const ref of read(pair.en).matchAll(/TASK-\d{3}/g)) assert.ok(graph.has(ref[0]), `Unknown task reference ${ref[0]}`);
}

const memory = read('docs/SPECS_SHARED_MEMORY.md');
function verifyLayout(heading, size) {
  assert.ok(memory.includes(heading), `Missing layout ${heading}`);
  const section = memory.split(heading)[1].split('\n### ')[0].split('\n## ')[0];
  const coverage = new Set();
  for (const row of section.split('\n').filter(line => /^\| \d/.test(line))) {
    const [offset, type] = row.split('|').slice(1).map(cell => cell.trim());
    const match = type.match(/(?:u32|i32|u64|f32|f64)/);
    assert.ok(match, `Unknown binary type ${type}`);
    const width = match[0].endsWith('64') ? 8 : 4;
    let ranges;
    if (offset.includes('..')) {
      const [start, end] = offset.split('..').map(Number);
      assert.equal(end + 1 - start, Number(type.match(/\[(\d+)\]/)?.[1]) * width);
      ranges = [[start, end + 1]];
    } else {
      const starts = offset.split('/').map(Number);
      const count = type.match(/×\s*(\d+)/)?.[1];
      if (count) assert.equal(starts.length, Number(count));
      ranges = starts.map(start => [start, start + width]);
    }
    for (const [start, end] of ranges) {
      for (let byte = start; byte < end; byte++) {
        assert.ok(byte >= 0 && byte < size && !coverage.has(byte), `Overlap/out-of-range ${heading}:${byte}`);
        coverage.add(byte);
      }
    }
  }
  assert.equal(coverage.size, size, `Missing bytes in ${heading}`);
}
for (const [heading, size] of [
  ['### Header v1', 64], ['### State v1', 128], ['### Pilot mailbox v1', 64],
  ['### Header v2', 64], ['### State v2', 192], ['### Pilot mailbox v2', 64],
]) verifyLayout(heading, size);

console.log(`Documentation checks passed: ${index.pairs.length} bilingual pairs, ${graph.size} tasks, 6 complete layouts, valid links and source hashes.`);
console.log('Translation meaning and English prose quality still require human/agent review.');
