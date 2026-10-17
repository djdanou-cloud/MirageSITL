import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let count = 0;
for (const path of paths) {
  if (path.startsWith('tests/fixtures/contact/nasa/')) continue;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const normalized = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
  if (normalized.equals(bytes)) continue;
  const original = execFileSync('git', ['show', `HEAD:${path}`]);
  // Only normalize files whose LF content exactly matches the committed source.
  if (normalized.equals(original)) { writeFileSync(path, normalized); count++; }
}
console.log(`Restored exact committed LF bytes in ${count} files; byte archives preserved.`);
