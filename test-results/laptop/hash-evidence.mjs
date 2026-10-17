import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(path);
    else if (!path.endsWith('/evidence-manifest.json') && !path.endsWith('.md')) {
      const bytes = readFileSync(path);
      files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
for (const directory of ['test-results/laptop', 'test-results/bench', 'test-results/validation']) walk(directory);
writeFileSync('test-results/laptop/evidence-manifest.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceCheckpoint: 'ca78ef6594c44cb35721a0f8686e74f1f79a5e2a',
  note: 'Working-tree changes accompany these results. Earlier failures are intentionally retained.',
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
}, null, 2) + '\n');
