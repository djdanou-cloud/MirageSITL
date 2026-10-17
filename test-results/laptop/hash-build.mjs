import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const files = [];
function visit(directory) {
  for (const item of readdirSync(directory)) {
    const path = `${directory}/${item}`;
    if (statSync(path).isDirectory()) visit(path);
    else { const bytes = readFileSync(path); files.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}); }
  }
}
visit('apps/web/dist');
writeFileSync(process.argv[2],JSON.stringify({recordedAt:new Date().toISOString(),files},null,2)+'\n');
