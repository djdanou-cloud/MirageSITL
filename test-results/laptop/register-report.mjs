import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const path='docs/documentation-index.json', index=JSON.parse(readFileSync(path));
const en='docs/validation/laptop-validation-2026-10-17.md',ru='docs/ru/laptop-validation-2026-10-17.md';
if(!index.pairs.some(p=>p.en===en))index.pairs.push({en,ru});
writeFileSync(path,JSON.stringify(index,null,2)+'\n');
writeFileSync(ru,readFileSync(ru,'utf8').replace(/source-sha256: (?:HASH|[a-f0-9]{64})/,`source-sha256: ${createHash('sha256').update(readFileSync(en)).digest('hex')}`));
