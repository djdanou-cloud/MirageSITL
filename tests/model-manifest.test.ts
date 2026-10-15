import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ModelRegistry, validateModelManifest } from '@mirage/physics/model-manifest';
import model from './fixtures/models/demo-quad.json';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
describe('model schema and verified registry', () => {
  it('accepts the versioned SI quad and freezes a verified snapshot', async () => {
    const bytes = encode(model), registry = new ModelRegistry();
    const record = await registry.register(bytes, digest(bytes));
    expect(record.manifest.rotorCount).toBe(4);
    expect(record.sha256).toBe(digest(bytes));
    expect(Object.isFrozen(record.manifest.rotors[0]?.hubToBody)).toBe(true);
    expect(await registry.register(bytes, digest(bytes))).toBe(record);
    expect(registry.get(model.modelId)).toBe(record);
  });
  it('rejects schema/version/unit/count and physical constraint violations', () => {
    const rotor = model.rotors[0]!;
    const invalid: unknown[] = [
      { ...model, schemaVersion: 2 }, { ...model, units: 'imperial' },
      { ...model, massKg: 0 }, { ...model, massKg: NaN },
      { ...model, inertiaBodyKgM2: [1, 0, 0, 0, -1, 0, 0, 0, 1] },
      { ...model, inertiaBodyKgM2: [1, 0.5, 0, 0, 1, 0, 0, 0, 1] },
      { ...model, rotorCount: 33, rotors: Array.from({ length: 33 }, () => rotor) },
      { ...model, rotorCount: 1 },
      { ...model, rotors: [rotor, rotor, ...model.rotors.slice(2)] },
      { ...model, rotors: [{ ...rotor, hubToBody: [0, 0, 0, 0] }, ...model.rotors.slice(1)] },
      { ...model, rotors: [{ ...rotor, chordM: [0] }, ...model.rotors.slice(1)] },
      { ...model, rotors: [{ ...rotor, radialStationM: [0.1, 0.05, 0.12] }, ...model.rotors.slice(1)] },
      { ...model, unexpected: true },
    ];
    for (const input of invalid) expect(() => validateModelManifest(input)).toThrow();
  });
  it('rejects corrupt input without replacing an existing model', async () => {
    const registry = new ModelRegistry(), bytes = encode(model);
    const original = await registry.register(bytes, digest(bytes));
    const changed = encode({ ...model, massKg: 2 });
    await expect(registry.register(changed, digest(bytes))).rejects.toThrow('hash');
    await expect(registry.register(changed, digest(changed))).rejects.toThrow('collision');
    const invalid = encode({ ...model, massKg: -1 });
    await expect(registry.register(invalid, digest(invalid))).rejects.toThrow();
    expect(registry.get(model.modelId)).toBe(original);
  });
});

it('snapshots bytes before hashing and accepts a coupled positive inertia', async () => {
  const coupled = { ...model, inertiaBodyKgM2: [2, 1, 0, 1, 2, 0, 0, 0, 3] };
  const bytes = encode(coupled), registry = new ModelRegistry();
  const registering = registry.register(bytes, digest(bytes));
  bytes.fill(0);
  const record = await registering;
  expect(record.manifest.inertiaBodyKgM2).toEqual(coupled.inertiaBodyKgM2);
  coupled.inertiaBodyKgM2[0] = -1;
  expect(record.manifest.inertiaBodyKgM2[0]).toBe(2);
  expect(() => validateModelManifest({ ...model,
    inertiaBodyKgM2: [1, 1, 0, 1, 1, 0, 0, 0, 1] })).toThrow('positive definite');
  const first = model.rotors[0]!; // The checked-in quad has four rotors.
  expect(() => validateModelManifest({ ...model, rotors: [first,
    { ...model.rotors[1], motorChannel: first.motorChannel }, ...model.rotors.slice(2)] })).toThrow('Duplicate');
});
