#!/usr/bin/env node
// Generates tests/fixtures/rotors/rotor-map-synthetic.json (TASK-103) from the full BET; scripts/rotor-map/generate.ts holds how.
//
//   node scripts/generate-rotor-map.mjs [--check] [--out FILE]
//
// --check regenerates and compares with the file instead of writing it; exit 1 on a difference. Needs the built scalar WASM
// (node scripts/build-wasm.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROTOR_MAP_OUTPUTS } from '../packages/wasm-bet/src/rotor-map.ts';
import { generateRotorMap } from './rotor-map/generate.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = 'tests/fixtures/rotors/rotor-map-synthetic.json';
const argv = process.argv.slice(2), check = argv.includes('--check');
const outIndex = argv.indexOf('--out'), out = outIndex >= 0 ? argv[outIndex + 1] : `${ROOT}${FIXTURE}`;
const module = new WebAssembly.Module(readFileSync(`${ROOT}packages/wasm-bet/dist/mirage_bet.scalar.wasm`));
const started = Date.now();
const table = await generateRotorMap(module);
const text = `${JSON.stringify(table)}\n`;
const flagged = table.coefficients.filter((_, k) => k % ROTOR_MAP_OUTPUTS === ROTOR_MAP_OUTPUTS - 1 && table.coefficients[k] < 1).length;
console.log(`${table.coefficients.length / ROTOR_MAP_OUTPUTS} points, ${flagged} of validity 0, ${Math.round((Date.now() - started) / 1000)} s`);
if (check) {
  if (readFileSync(out, 'utf8') !== text) { console.error(`${out} differs`); process.exit(1); }
  console.log('identical');
} else writeFileSync(out, text);
