import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ControlWriter, SHARED_BYTES, StateWriter, createSharedMemory, newInput, newState,
  type FlightState, type PilotInput } from '@mirage/protocol';
import { verifyFixture } from '@mirage/test-support/fixtures';
import registry from './fixtures/registry.json';
import { WIDTH, assertCoverage, isWireType, regionRow, specFields, type WireType } from './support/spec-layout';

// Independent ABI v1 oracle: a hand-authored fixture is cross-checked against the
// byte tables in docs/SPECS_SHARED_MEMORY.md, then the real writers' raw shared
// bytes are compared with bytes packed here by a local DataView. StateReader and
// ControlReader are deliberately not used, so symmetric codec errors cannot hide.

interface GoldenField {
  spec: string; offset: number; type: WireType; count: number;
  property?: string; value?: number;
}
interface GoldenRegion {
  table: string; layout: string; absoluteOffset: number; bytes: number; slots: number;
  fields: GoldenField[];
}
interface GoldenLayout { abiVersion: 1; totalBytes: number; regions: GoldenRegion[] }

const FIXTURE_ID = 'abi-v1-layout';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function parseField(value: unknown): GoldenField {
  if (!record(value) || typeof value.spec !== 'string' || !count(value.offset) ||
    !isWireType(value.type) || value.type === 'u64' || !count(value.count) || value.count < 1) throw new Error('Invalid golden field');
  const field: GoldenField = { spec: value.spec, offset: value.offset, type: value.type, count: value.count };
  if (value.property !== undefined) {
    if (typeof value.property !== 'string' || value.count !== 1) throw new Error(`Invalid property: ${field.spec}`);
    field.property = value.property;
  }
  if (value.value !== undefined) {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) throw new Error(`Invalid value: ${field.spec}`);
    field.value = value.value;
  }
  if (field.property !== undefined && field.value === undefined) throw new Error(`Missing value: ${field.spec}`);
  return field;
}
function parseLayout(value: unknown): GoldenLayout {
  if (!record(value) || value.abiVersion !== 1 || !count(value.totalBytes) || !Array.isArray(value.regions)) {
    throw new Error('Invalid golden layout');
  }
  const regions = (value.regions as unknown[]).map((region): GoldenRegion => {
    if (!record(region) || typeof region.table !== 'string' || typeof region.layout !== 'string' ||
      !count(region.absoluteOffset) || !count(region.bytes) || !Array.isArray(region.fields) ||
      (region.slots !== undefined && !count(region.slots))) throw new Error('Invalid golden region');
    return { table: region.table, layout: region.layout, absoluteOffset: region.absoluteOffset,
      bytes: region.bytes, slots: count(region.slots) ? region.slots : 1,
      fields: (region.fields as unknown[]).map(parseField) };
  });
  return { abiVersion: 1, totalBytes: value.totalBytes, regions };
}

/** Throws unless the fixture describes exactly the specified regions, fields, and byte coverage. */
function assertMatchesSpecification(layout: GoldenLayout): void {
  let covered = 0;
  for (const region of layout.regions) {
    const row = regionRow('## 2. Implemented ABI v1', region.table);
    if (row.offset !== region.absoluteOffset || row.bytes !== region.bytes * region.slots) {
      throw new Error(`Region ${region.table} differs from the specification`);
    }
    covered += row.bytes;
    const actual = region.fields.map(({ spec: name, offset, type, count: n }) => ({ spec: name, offset, type, count: n }));
    expect(actual, `${region.layout} fields`).toEqual(specFields(region.layout));
    assertCoverage(region.fields, region.bytes, region.layout);
  }
  if (covered !== layout.totalBytes) throw new Error('Regions do not cover the shared buffer');
}

/** Packs fixture values with a local little-endian DataView; unlisted bytes are zero. */
function packRegion(region: GoldenRegion, target: DataView, base: number): void {
  for (const field of region.fields) {
    const at = base + field.offset;
    if (field.value === undefined) {
      for (let i = 0; i < field.count * WIDTH[field.type]; i++) target.setUint8(at + i, 0);
    } else if (field.type === 'u32') target.setUint32(at, field.value, true);
    else if (field.type === 'f32') target.setFloat32(at, field.value, true);
    else target.setFloat64(at, field.value, true);
  }
}
function expectedBuffer(layout: GoldenLayout, publishedSlots: number): Uint8Array {
  const bytes = new Uint8Array(layout.totalBytes), view = new DataView(bytes.buffer);
  for (const region of layout.regions) {
    const slots = region.slots > 1 ? publishedSlots : 1;
    for (let slot = 0; slot < slots; slot++) packRegion(region, view, region.absoluteOffset + slot * region.bytes);
  }
  return bytes;
}
/** Copies shared memory through Atomics only, as the ABI requires. */
function snapshot(buffer: SharedArrayBuffer): Uint8Array {
  const shared = new Int32Array(buffer), copy = new Int32Array(shared.length);
  for (let i = 0; i < shared.length; i++) copy[i] = Atomics.load(shared, i);
  return new Uint8Array(copy.buffer);
}
function mismatches(actual: Uint8Array, expected: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    if (actual[i] !== expected[i]) offsets.push(i);
  }
  return offsets;
}
function populate<T extends object>(target: T, region: GoldenRegion): T {
  const values = region.fields.flatMap(({ property, value }) =>
    property !== undefined && value !== undefined ? [[property, value] as const] : []);
  // Every interface field must be encoded, and the fixture may not name unknown fields.
  expect(values.map(([property]) => property).sort(), `${region.layout} properties`).toEqual(Object.keys(target).sort());
  return Object.assign(target, Object.fromEntries(values));
}
function region(layout: GoldenLayout, table: string): GoldenRegion {
  const found = layout.regions.find(candidate => candidate.table === table);
  if (!found) throw new Error(`Missing fixture region ${table}`);
  return found;
}

async function loadLayout(): Promise<GoldenLayout> {
  const entry = registry.fixtures.find(candidate => candidate.manifest.id === FIXTURE_ID);
  if (!entry) throw new Error(`Unregistered fixture ${FIXTURE_ID}`);
  const bytes = readFileSync(new URL(`./fixtures/${entry.path}`, import.meta.url));
  await verifyFixture(entry.manifest, bytes);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  return parseLayout(parsed);
}
function publishScenario(layout: GoldenLayout): SharedArrayBuffer {
  const buffer = createSharedMemory();
  const state: FlightState = populate(newState(), region(layout, 'State ring'));
  const input: PilotInput = populate(newInput(), region(layout, 'Pilot mailbox'));
  const states = new StateWriter(buffer);
  states.publish(state); states.publish(state);
  new ControlWriter(buffer).publish(input);
  return buffer;
}

describe('ABI v1 golden byte layout', () => {
  it('runs on a little-endian host, matching the specification assumption', () => {
    expect(new Uint8Array(new Uint16Array([1]).buffer)[0]).toBe(1);
  });
  it('describes exactly the regions, fields, and bytes in the English specification', async () => {
    const layout = await loadLayout();
    expect(layout.totalBytes).toBe(SHARED_BYTES);
    assertMatchesSpecification(layout);
  });
  it('writers produce the specified bytes for header, two ring slots, and the pilot mailbox', async () => {
    const layout = await loadLayout();
    const actual = snapshot(publishScenario(layout));
    // Covers every byte of the 32,896-byte buffer, including untouched slots 2..255 and reserved words.
    expect(mismatches(actual, expectedBuffer(layout, 2))).toEqual([]);
  });
  it('detects a field moved by one word in either the fixture or the encoder', async () => {
    const layout = await loadLayout();
    const moved = structuredClone(layout);
    const north = region(moved, 'State ring').fields.find(field => field.property === 'north');
    if (!north) throw new Error('Missing north field');
    north.offset += 4;
    expect(() => assertMatchesSpecification(moved)).toThrow();
    const actual = snapshot(publishScenario(layout));
    expect(mismatches(actual, expectedBuffer(moved, 2)).length).toBeGreaterThan(0);
  });
});
