import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {Plugin} from 'vite';
import {parseArdupilotWasmManifest} from '../../packages/autopilot/src/wasm-loader';

// Explicit local development only. Never copy firmware into public/ or dist/.
function localArdupilot():Plugin {
  return {name:'local-ardupilot-artifacts',configureServer(server){
    const directory=process.env.MIRAGE_ARDUPILOT_WASM_DIR;if(!directory)return;
    const raw=readFileSync(fileURLToPath(new URL('../../native/ardupilot/wasm-artifact.manifest.json',import.meta.url)));
    const unknownManifest:unknown=JSON.parse(raw.toString()),manifest=parseArdupilotWasmManifest(unknownManifest);
    const files=new Map<string,{bytes:Buffer;type:string}>();
    for(const [artifact,type] of [[manifest.module,'application/wasm'],[manifest.glue,'text/javascript']] as const) {
      const bytes=readFileSync(resolve(directory,artifact.file));
      if(bytes.length!==artifact.bytes||createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error('Local ArduPilot artifact differs from pinned manifest');
      files.set(artifact.file,{bytes,type});
    }
    files.set('manifest.json',{bytes:raw,type:'application/json'});
    server.middlewares.use('/__local-ardupilot/',(req,res)=>{
      const peer=req.socket.remoteAddress;
      let localHost=false;
      try {
        const host=new URL('http://'+(req.headers.host??''));
        localHost=['localhost','127.0.0.1','[::1]'].includes(host.hostname)&&
          (!req.headers.origin||new URL(req.headers.origin).host===host.host);
      }catch{localHost=false;}
      if(req.method!=='GET'||!localHost||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer??'')||req.headers['sec-fetch-site']==='cross-site') {res.statusCode=403;res.end();return;}
      const file=files.get((req.url??'').slice(1));
      if(!file){res.statusCode=404;res.end();return;}
      res.setHeader('Content-Type',file.type);res.setHeader('Cache-Control','no-store');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.end(file.bytes);
    });
  }};
}

// Serves the committed CC0 tiles fixture to loopback only. Terrain stays off
// unless the build was given VITE_MIRAGE_TILESET_URL.
function localTiles(): Plugin {
  const root = fileURLToPath(new URL('../../tests/fixtures/tiles/', import.meta.url));
  const attach = (server: { middlewares: { use: (handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '';
      if (!url.startsWith('/fixtures/tiles/')) { next(); return; }
      const peer = req.socket.remoteAddress;
      if (req.method !== 'GET' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')) { res.statusCode = 403; res.end(); return; }
      const name = decodeURIComponent(url.slice('/fixtures/tiles/'.length).split('?')[0] ?? '');
      if (name !== 'tileset.json' && name !== 'tile.glb') { res.statusCode = 404; res.end(); return; }
      const bytes = readFileSync(resolve(root, name));
      res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'model/gltf-binary');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.end(bytes);
    });
  };
  return { name: 'local-g3-tiles', configureServer: attach, configurePreviewServer: attach };
}

// Required for SharedArrayBuffer. Apply these on the production HTTPS server too.
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
export default defineConfig({
  plugins: [react(), tailwindcss(), localArdupilot(), localTiles()],
  server: { headers },
  preview: { headers },
  worker: { format: 'es' },
});
