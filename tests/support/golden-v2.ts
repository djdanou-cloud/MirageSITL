import { readFileSync } from 'node:fs';
import { newFlightStateV2, newPilotInputV2, type FlightStateV2, type PilotInputV2 } from '@mirage/protocol';
import { verifyFixture } from '@mirage/test-support/fixtures';
import registry from '../fixtures/registry.json';
import { WIDTH, isWireType, type WireType } from './spec-layout';

// Loads tests/fixtures/protocol/state-v2.hex (registered, hash-verified) and
// decodes its values with a local DataView, never with the codec under test.

export interface GoldenRowV2 { offset: number; type: WireType; count: number; property: string; hex: string; spec: string }
export interface GoldenRegionV2 { rows: GoldenRowV2[]; bytes: Uint8Array }
export interface GoldenV2 { header: GoldenRegionV2; state: GoldenRegionV2; pilot: GoldenRegionV2 }

const FIXTURE_ID = 'abi-v2-golden';
const SECTIONS = ['header', 'state', 'pilot'] as const;
type Section = typeof SECTIONS[number];

export function parseGoldenV2(text: string): GoldenV2 {
  const rows: Record<Section, GoldenRowV2[]> = { header: [], state: [], pilot: [] };
  let section: Section | undefined;
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const heading = /^\[(\w+)\]$/.exec(line)?.[1];
    if (heading !== undefined) {
      section = SECTIONS.find(name => name === heading);
      if (!section) throw new Error(`Unknown golden section ${heading}`);
      continue;
    }
    const row = /^(\d+) (u32|f32|f64|u64)(?:\[(\d+)\])? (\S+) ([0-9a-f]+) \| (.+)$/.exec(line);
    if (!row || !section || !isWireType(row[2])) throw new Error(`Invalid golden row: ${line}`);
    const parsed: GoldenRowV2 = { offset: Number(row[1]), type: row[2], count: Number(row[3] ?? 1),
      property: row[4]!, hex: row[5]!, spec: row[6]! };
    if (parsed.hex.length !== parsed.count * WIDTH[parsed.type] * 2) throw new Error(`Golden width mismatch: ${line}`);
    rows[section].push(parsed);
  }
  const region = (name: Section): GoldenRegionV2 => {
    const list = rows[name];
    const size = list.reduce((end, row) => Math.max(end, row.offset + row.hex.length / 2), 0);
    const bytes = new Uint8Array(size);
    for (const row of list) bytes.set(Uint8Array.from(row.hex.match(/../g) ?? [], byte => parseInt(byte, 16)), row.offset);
    return { rows: list, bytes };
  };
  return { header: region('header'), state: region('state'), pilot: region('pilot') };
}

export async function loadGoldenV2(): Promise<GoldenV2> {
  const entry = registry.fixtures.find(candidate => candidate.manifest.id === FIXTURE_ID);
  if (!entry) throw new Error(`Unregistered fixture ${FIXTURE_ID}`);
  const bytes = readFileSync(new URL(`../fixtures/${entry.path}`, import.meta.url));
  await verifyFixture(entry.manifest, bytes);
  return parseGoldenV2(bytes.toString('utf8'));
}

/** Decodes the value of one golden row from its own bytes. */
function decode(row: GoldenRowV2): number | { lo: number; hi: number } {
  const bytes = Uint8Array.from(row.hex.match(/../g) ?? [], byte => parseInt(byte, 16));
  const view = new DataView(bytes.buffer);
  switch (row.type) {
    case 'u32': return view.getUint32(0, true);
    case 'f32': return view.getFloat32(0, true);
    case 'f64': return view.getFloat64(0, true);
    case 'u64': return { lo: view.getUint32(0, true), hi: view.getUint32(4, true) };
    default: { const never: never = row.type; throw new Error(`Unhandled type ${String(never)}`); }
  }
}
function valueRows(region: GoldenRegionV2) {
  return region.rows.filter(row => row.property !== 'seqlock' && row.property !== 'reserved');
}
/** Builds the golden FlightStateV2, requiring the fixture to name exactly the interface's properties. */
export function goldenState(golden: GoldenV2): { state: FlightStateV2; properties: string[] } {
  const rows = valueRows(golden.state);
  const state = Object.assign(newFlightStateV2(), Object.fromEntries(rows.map(row => [row.property, decode(row)])));
  return { state, properties: rows.map(row => row.property) };
}
export function goldenPilot(golden: GoldenV2): { pilot: PilotInputV2; properties: string[] } {
  const rows = valueRows(golden.pilot);
  const pilot = Object.assign(newPilotInputV2(), Object.fromEntries(rows.map(row => [row.property, decode(row)])));
  return { pilot, properties: rows.map(row => row.property) };
}
