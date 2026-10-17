import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const index = JSON.parse(readFileSync('docs/documentation-index.json'));
// Apply only after reviewing both language changes; never repair unrelated hashes.
for (const en of ['docs/PROJECT_ROADMAP.md','docs/SPECS_SIMULATION_ENGINES.md','docs/operations/runbook.md']) {
  const pair = index.pairs.find(p => p.en === en);
  if (!pair) throw new Error('Unregistered source');
  const hash = createHash('sha256').update(readFileSync(en)).digest('hex');
  writeFileSync(pair.ru, readFileSync(pair.ru,'utf8').replace(/source-sha256: [a-f0-9]{64}/, `source-sha256: ${hash}`));
}
