import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { nodeCheck } from "./support/node-evidence";
it("a WASM runtime or compiler alone cannot certify a missing HAL or license review", () => nodeCheck(`
import {probeWasm} from './scripts/probe-ardupilot-wasm.mjs';
const p=probeWasm({MIRAGE_EMCC:'/missing/emcc'});
assert.equal(p.status,'BLOCKED_EXTERNAL');assert.equal(p.checks.emscripten,false);
assert.equal(p.checks.browserHal,false);assert.equal(p.checks.nativeParity,false);
assert.equal(p.commit,'8ab6afde107a91df1b5f60ade8f333cb8a61b190');
`));
it("detects a working compiler wrapper (including Windows .bat) without unblocking the port", () => nodeCheck(`
import {probeWasm} from './scripts/probe-ardupilot-wasm.mjs';
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'mirage-emcc-')),win=process.platform==='win32',path=join(dir,win?'emcc.bat':'emcc');
writeFileSync(path,win?'@echo emcc (Emscripten gcc/clang-like replacement) 4.0.15 (test)\\r\\n':'#!/bin/sh\\necho "emcc (Emscripten gcc/clang-like replacement) 4.0.15 (test)"\\n');
if(!win)chmodSync(path,0o755);
try{const p=probeWasm({MIRAGE_EMCC:path});
assert.equal(p.checks.emscripten,true);assert.equal(p.emscriptenVersion,'4.0.15');
assert.equal(p.status,'BLOCKED_EXTERNAL');assert.equal(p.checks.browserHal,false);
assert.ok(!p.reasons.includes('Emscripten compiler unavailable'));}finally{rmSync(dir,{recursive:true,force:true});}
`));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function pick(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) current = record(current) && Object.hasOwn(current, key) ? current[key] : undefined;
  return current;
}
const load = (path: string): unknown => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
it("pins the TASK-045 toolchain to the same Emscripten release and ArduPilot commit as the other locks", () => {
  const lock = load("native/ardupilot/toolchain.lock.json"), jsbsim = load("native/jsbsim/toolchain.lock.json");
  for (const key of ["repository", "commit", "version", "releaseRevision", "sdkManifestSha256"])
    expect(pick(lock, "emsdk", key)).toBe(pick(jsbsim, key));
  expect(pick(lock, "ardupilot", "commit")).toBe(pick(load("native/ardupilot/source.lock.json"), "commit"));
});
