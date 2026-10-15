import { Ajv } from 'ajv';
import schema from './model.schema.json';

/** Serialized SI rotor geometry; typed WASM arenas are a separate runtime ABI. */
export interface RotorGeometry {
  readonly id: number; readonly motorChannel: number; readonly bladeCount: number;
  readonly spinSign: -1 | 1; readonly radiusM: number; readonly rootCutoutM: number;
  readonly polarId: number; readonly radialStationM: readonly number[];
  readonly chordM: readonly number[]; readonly twistRad: readonly number[];
  readonly quadratureWidthM: readonly number[]; readonly hubPositionBodyM: readonly number[];
  readonly hubToBody: readonly number[]; readonly shaftInertiaKgM2: number;
  readonly bearingViscousNmPerRadS: number; readonly azimuthSamples: number;
}
export interface ModelDescriptor {
  readonly schemaVersion: 1; readonly modelId: number;
  readonly kind: 'demo' | 'bet' | 'jsbsim'; readonly units: 'SI';
  readonly worldFrame: 'NED'; readonly bodyFrame: 'FRD'; readonly quaternionOrder: 'wxyz';
  readonly massKg: number; readonly inertiaBodyKgM2: readonly number[];
  readonly rotorCount: number; readonly rotorCapacity: 32; readonly rotors: readonly RotorGeometry[];
}
export interface VerifiedModel { readonly sha256: string; readonly manifest: ModelDescriptor }
const validateSchema = new Ajv({ strict: true, strictNumbers: true }).compile<ModelDescriptor>(schema);

function freeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function validateInertia(matrix: readonly number[]): void {
  // Schema guarantees nine entries. Cholesky rejects non-SPD matrices without
  // silently symmetrizing an invalid tensor or adding numerical regularization.
  const lower = new Float64Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col <= row; col++) {
      if (matrix[row * 3 + col] !== matrix[col * 3 + row]) throw new Error('Inertia must be symmetric');
      let pivot = matrix[row * 3 + col]!;
      for (let k = 0; k < col; k++) pivot -= lower[row * 3 + k]! * lower[col * 3 + k]!;
      if (!Number.isFinite(pivot) || (row === col && pivot <= 0)) throw new Error('Inertia must be positive definite');
      const entry = row === col ? Math.sqrt(pivot) : pivot / lower[col * 3 + col]!;
      if (!Number.isFinite(entry)) throw new Error('Inertia factorization overflow');
      lower[row * 3 + col] = entry;
    }
  }
}
/** Configuration-time validation only; never call from a physics step. */
export function validateModelManifest(input: unknown): ModelDescriptor {
  const model: unknown = structuredClone(input);
  if (!validateSchema(model)) throw new Error(`Invalid model schema: ${validateSchema.errors?.[0]?.message ?? 'unknown error'}`);
  validateInertia(model.inertiaBodyKgM2);
  if (model.rotorCount !== model.rotors.length) throw new Error('Rotor count mismatch');
  const ids = new Set<number>(), channels = new Set<number>();
  for (const rotor of model.rotors) {
    if (ids.has(rotor.id) || channels.has(rotor.motorChannel)) throw new Error('Duplicate rotor or motor channel');
    ids.add(rotor.id); channels.add(rotor.motorChannel);
    const norm = Math.hypot(...rotor.hubToBody);
    if (Math.abs(norm - 1) > 1e-6) throw new Error('Rotor quaternion must be normalized');
    if (rotor.rootCutoutM >= rotor.radiusM) throw new Error('Invalid rotor root cutout');
    const count = rotor.radialStationM.length;
    if (rotor.chordM.length !== count || rotor.twistRad.length !== count || rotor.quadratureWidthM.length !== count) throw new Error('Rotor element lengths differ');
    let previous = rotor.rootCutoutM, totalWidth = 0;
    for (let i = 0; i < count; i++) {
      // Equal array lengths and JSON schema validation establish index bounds.
      const radius = rotor.radialStationM[i]!;
      if (radius <= previous || radius >= rotor.radiusM) throw new Error('Rotor stations must increase inside the blade span');
      previous = radius;
      totalWidth += rotor.quadratureWidthM[i]!;
    }
    if (!Number.isFinite(totalWidth) || Math.abs(totalWidth - (rotor.radiusM - rotor.rootCutoutM)) > 1e-9) throw new Error('Quadrature widths must cover the blade span');
  }
  return freeze(model);
}
/** A model ID is immutable for a registry session; admission precedes selection. */
export class ModelRegistry {
  private readonly models = new Map<number, VerifiedModel>();
  get(modelId: number): VerifiedModel | undefined { return this.models.get(modelId); }
  async register(payload: Uint8Array, expectedSha256: string): Promise<VerifiedModel> {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Invalid model hash');
    if (payload.byteLength > 1024 * 1024) throw new Error('Model exceeds 1 MiB');
    const bytes = new Uint8Array(payload);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== expectedSha256) throw new Error('Model source hash mismatch');
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const manifest = validateModelManifest(input);
    const existing = this.models.get(manifest.modelId);
    if (existing) {
      if (existing.sha256 !== actual) throw new Error('Model ID collision');
      return existing;
    }
    const verified = Object.freeze({ sha256: actual, manifest });
    this.models.set(manifest.modelId, verified);
    return verified;
  }
}
