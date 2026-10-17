import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";
it("a WASM runtime or compiler alone cannot certify a missing HAL or license review", () => nodeCheck(`
import {probeWasm} from './scripts/probe-ardupilot-wasm.mjs';
const p=probeWasm({MIRAGE_EMCC:'/missing/emcc'});
assert.equal(p.status,'BLOCKED_EXTERNAL');assert.equal(p.checks.emscripten,false);
assert.equal(p.checks.browserHal,false);assert.equal(p.checks.nativeParity,false);
assert.equal(p.commit,'8ab6afde107a91df1b5f60ade8f333cb8a61b190');
`));
