import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
for (const file of readdirSync('tests/browser').filter(f => f.endsWith('.spec.ts'))) {
  const path = 'tests/browser/' + file;
  let text = readFileSync(path, 'utf8');
  if (!text.includes('/@fs')) continue;
  text = text.replace(/(['"])\/@fs\1\s*\+\s*fileURLToPath\((new URL\([^\n]*?import\.meta\.url\))\)/g, 'viteFileUrl($2)');
  if (file === 'terrain.spec.ts') text = text.replace('url: "/@fs" + tilesetPath', 'url: viteFileUrl(new URL("../fixtures/tiles/tileset.json", import.meta.url))');
  if (file === 'terrain-collision.spec.ts') {
    text = text.replace('fileURLToPath(new URL("../../packages/terrain/src/collision-builder.worker.ts", import.meta.url))', 'viteFileUrl(new URL("../../packages/terrain/src/collision-builder.worker.ts", import.meta.url))').replace('new Worker(`/@fs/${path}`', 'new Worker(path');
  }
  if (!text.includes('viteFileUrl')) continue;
  const needsFilePath = /\bfileURLToPath\(/.test(text);
  if (!needsFilePath) text = text.replace(/import \{ fileURLToPath \} from ['"]node:url['"];\n/, '');
  text = 'import { viteFileUrl } from "../support/vite-url";\n' + text;
  writeFileSync(path, text);
}
const p='tests/browser/render-backends.spec.ts';
let text=readFileSync(p,'utf8');
text=text.replace('args: ["--use-gl=angle",', 'args: process.env.MIRAGE_BROWSER_GPU === "hardware" ? [] : ["--use-gl=angle",');
writeFileSync(p,text);
