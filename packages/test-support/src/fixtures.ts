const unitNames = ['1', 's', 'us', 'm', 'm/s', 'm/s^2', 'rad', 'rad/s', 'N', 'N*m', 'kg', 'kg*m^2', 'Pa', 'K', 'V', 'A', 'rev/min', 'gauss'] as const;
export type FixtureUnit = typeof unitNames[number];
export interface FixtureManifest {
  formatVersion: 1;
  id: string;
  sourceSha256: string;
  units: Readonly<Record<string, FixtureUnit>>;
  validityEnvelope: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
  tolerance: { readonly absolute: number; readonly relative: number };
  provenance:
    | { readonly kind: 'synthetic'; readonly derivation: string }
    | { readonly kind: 'measured'; readonly datasetId: string; readonly license: string; readonly acquiredAt: string; readonly reference: string };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 2048; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function assertManifest(value: unknown): asserts value is FixtureManifest {
  if (!record(value) || !keys(value, ['formatVersion', 'id', 'sourceSha256', 'units', 'validityEnvelope', 'tolerance', 'provenance']) ||
    value.formatVersion !== 1 || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) ||
    typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
    !record(value.units) || !record(value.validityEnvelope) || !record(value.tolerance) || !record(value.provenance)) {
    throw new Error('Invalid fixture manifest');
  }
  const quantities = Object.keys(value.units);
  if (quantities.length === 0 || !keys(value.validityEnvelope, quantities)) throw new Error('Invalid fixture quantities');
  for (const quantity of quantities) {
    const unit = value.units[quantity], bounds = value.validityEnvelope[quantity];
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(quantity) || !unitNames.some(name => name === unit) ||
      !record(bounds) || !keys(bounds, ['min', 'max']) || !finite(bounds.min) || !finite(bounds.max) || bounds.min > bounds.max) {
      throw new Error('Invalid fixture units or validity envelope');
    }
  }
  const tolerance = value.tolerance;
  if (!keys(tolerance, ['absolute', 'relative']) || !finite(tolerance.absolute) || !finite(tolerance.relative) || tolerance.absolute < 0 || tolerance.relative < 0) {
    throw new Error('Invalid fixture tolerance');
  }
  const origin = value.provenance;
  if (origin.kind === 'synthetic') {
    if (!keys(origin, ['kind', 'derivation']) || !text(origin.derivation)) throw new Error('Invalid synthetic provenance');
  } else if (origin.kind === 'measured') {
    if (!keys(origin, ['kind', 'datasetId', 'license', 'acquiredAt', 'reference']) ||
      !text(origin.datasetId) || !text(origin.license) || !text(origin.acquiredAt) || !Number.isFinite(Date.parse(origin.acquiredAt)) ||
      !text(origin.reference) || !origin.reference.startsWith('https://')) throw new Error('Invalid measurement provenance');
  } else throw new Error('Unknown fixture provenance');
}
function freeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Metadata and payload are snapshotted before asynchronous verification. */
export async function verifyFixture(metadata: unknown, payload: Uint8Array): Promise<Readonly<FixtureManifest>> {
  if (payload.byteLength > 16 * 1024 * 1024) throw new Error('Fixture exceeds 16 MiB');
  const manifest: unknown = structuredClone(metadata), bytes = new Uint8Array(payload);
  assertManifest(manifest);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== manifest.sourceSha256) throw new Error('Fixture source hash mismatch');
  return freeze(manifest);
}
