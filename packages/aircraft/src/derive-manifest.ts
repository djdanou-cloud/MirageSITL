import {
  validateVehicleManifest, type BatterySpec, type MassProperties, type VehicleManifest,
} from '@mirage/physics/vehicle-manifest';
import { canonicalBytes, decodeUtf8, sha256Hex } from '@mirage/project/schema';
import { deriveLayout } from './layout.ts';
import { validateAircraftProfile, type AircraftProfile, type ComponentReferences } from './profile.ts';

// Derivation of the vehicle manifest v2 (TASK-087) that physics consumes from
// an aircraft profile (TASK-138). The profile gives geometry, spins, outputs
// and mass properties; propulsion values come from component cards (TASK-139)
// and arrive here already resolved, so nothing is invented. The result is
// canonical JSON (RFC 8785): the same inputs give the same bytes on every
// engine. Configuration-time code only.

/** Bumped whenever the same inputs would give different manifest bytes. */
export const DERIVATION_VERSION = 1;
/** The one dataset of a derived manifest. */
export const DERIVED_DATASET_ID = 'aircraft-profile-derivation';
const MAX_DESCRIPTION_LENGTH = 1024;

/** The rotor geometry fields that come from a propeller (and motor) rather than from the layout. */
export interface RotorBlades {
  readonly bladeCount: number;
  readonly radiusM: number;
  readonly rootCutoutM: number;
  readonly polarId: number;
  readonly radialStationM: readonly number[];
  readonly chordM: readonly number[];
  readonly twistRad: readonly number[];
  readonly quadratureWidthM: readonly number[];
  readonly shaftInertiaKgM2: number;
  readonly bearingViscousNmPerRadS: number;
  readonly azimuthSamples: number;
}
export interface MotorValues { readonly kvRpmPerV: number; readonly resistanceOhm: number; readonly currentLimitA: number }
export interface EscValues { readonly pwmMinUs: number; readonly pwmMaxUs: number; readonly commandTauS: number }
/** Propulsion values of one profile motor, resolved from the cards that the profile references. */
export interface ResolvedMotor {
  readonly motorId: number;
  /** The cards these values came from; they must equal the profile motor's references. */
  readonly cards: ComponentReferences;
  readonly rotor: RotorBlades;
  readonly motor: MotorValues | null;
  readonly esc: EscValues | null;
}
export interface ResolvedComponents {
  /** Where the values came from, quoted in the manifest's derivation text (1..1024 characters). */
  readonly description: string;
  /** Exactly one entry per profile motor. */
  readonly motors: readonly ResolvedMotor[];
  /** Battery values and the card they came from, which must equal the profile's battery card; or null. */
  readonly battery: { readonly card: string | null; readonly values: BatterySpec } | null;
}
export interface DerivationOptions {
  /** Session model ID, 1..2^32 - 1 (Control Protocol v2 `model.load`). */
  readonly modelId: number;
}
export interface DerivedVehicleManifest {
  /** Validated by `validateVehicleManifest` and deep-frozen. */
  readonly manifest: VehicleManifest;
  /** Canonical JSON of the manifest: the payload a `VehicleRegistry` hashes. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
  /** SHA-256 of the profile's canonical JSON; renaming the stored profile does not change it. */
  readonly profileSha256: string;
  /** SHA-256 of the canonical derivation input: version, profile and components. */
  readonly inputSha256: string;
}

/** Turns -0 into +0, so values and their canonical JSON agree. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}
function sameCards(a: ComponentReferences, b: ComponentReferences): boolean {
  return a.motor === b.motor && a.propeller === b.propeller && a.esc === b.esc;
}
function checkComponents(profile: AircraftProfile, components: ResolvedComponents): void {
  if (components.description.length < 1 || components.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`The components description must have 1 to ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const seen = new Set<number>();
  for (const resolved of components.motors) {
    const motor = profile.motors.find(item => item.id === resolved.motorId);
    if (!motor) throw new Error(`Resolved components name unknown motor ${resolved.motorId}`);
    if (seen.has(resolved.motorId)) throw new Error(`Resolved components list motor ${resolved.motorId} twice`);
    seen.add(resolved.motorId);
    if (!sameCards(resolved.cards, motor.components)) {
      throw new Error(`Motor ${motor.id} was resolved from other component cards than the profile references`);
    }
  }
  for (const motor of profile.motors) if (!seen.has(motor.id)) throw new Error(`Resolved components lack motor ${motor.id}`);
  const withMotor = components.motors.filter(item => item.motor !== null).length;
  if (withMotor !== 0 && withMotor !== components.motors.length) throw new Error('Either every motor has motor values or none does');
  const withEsc = components.motors.filter(item => item.esc !== null).length;
  if (withEsc !== 0 && withEsc !== components.motors.length) throw new Error('Either every motor has ESC values or none does');
  if (components.battery && components.battery.card !== profile.battery.card) {
    throw new Error('The battery was resolved from another card than the profile references');
  }
}

/**
 * Total mass properties of the aircraft and an optional payload: the combined
 * CG, and both inertias moved to it by the parallel-axis theorem,
 * J = Σ (J_i + m_i·(|d_i|²·1 - d_i·d_iᵀ)) with d_i = c_i - c. The result is
 * exactly symmetric for symmetric inputs.
 */
export function combineMassProperties(aircraft: MassProperties, payload: MassProperties | null): MassProperties {
  if (!payload) {
    return { massKg: aircraft.massKg, cgOffsetBodyM: [...aircraft.cgOffsetBodyM], inertiaCgKgM2: [...aircraft.inertiaCgKgM2] };
  }
  const massKg = aircraft.massKg + payload.massKg;
  const cg = [0, 1, 2].map(i =>
    clean((aircraft.massKg * aircraft.cgOffsetBodyM[i]! + payload.massKg * payload.cgOffsetBodyM[i]!) / massKg));
  const parts = [aircraft, payload].map(part => {
    const d = [0, 1, 2].map(i => part.cgOffsetBodyM[i]! - cg[i]!);
    return { part, d, squared: d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]! };
  });
  const inertia = [0, 1, 2].flatMap(row => [0, 1, 2].map(col => {
    let sum = 0;
    for (const { part, d, squared } of parts) {
      sum += part.inertiaCgKgM2[row * 3 + col]! + part.massKg * ((row === col ? squared : 0) - d[row]! * d[col]!);
    }
    return clean(sum);
  }));
  return { massKg, cgOffsetBodyM: cg, inertiaCgKgM2: inertia };
}

/**
 * Derives the vehicle manifest v2 of a profile with resolved components. The
 * manifest has `kind: "bet"`, no ArduPilot frame declaration (TASK-142), no
 * sensor mounts (TASK-143) and one synthetic dataset that names the exact
 * inputs; motors, ESCs and the battery appear only when resolved.
 */
export async function deriveVehicleManifest(input: unknown, components: ResolvedComponents,
  options: DerivationOptions): Promise<DerivedVehicleManifest> {
  const profile = validateAircraftProfile(input);
  checkComponents(profile, components);
  const layout = deriveLayout(profile);
  const resolved = new Map(components.motors.map(item => [item.motorId, item]));
  const profileSha256 = await sha256Hex(canonicalBytes(profile));
  const inputSha256 = await sha256Hex(canonicalBytes({ derivationVersion: DERIVATION_VERSION, profile, components }));
  const rotors = layout.rotors.map(rotor => ({
    ...resolved.get(rotor.motorId)?.rotor,
    id: rotor.motorId, motorChannel: rotor.output - 1, spinSign: rotor.spinSign,
    hubPositionBodyM: [...rotor.hubPositionBodyM], hubToBody: [...rotor.hubToBody],
  }));
  const motors = layout.rotors.flatMap(rotor => {
    const values = resolved.get(rotor.motorId)?.motor;
    return values ? [{ ...values, id: rotor.motorId, rotorId: rotor.motorId }] : [];
  });
  const escs = layout.rotors.flatMap(rotor => {
    const values = resolved.get(rotor.motorId)?.esc;
    return values ? [{ ...values, id: rotor.motorId, motorId: rotor.motorId }] : [];
  });
  const battery = components.battery ? { ...components.battery.values } : null;
  const rotorWakePairs = layout.wakePairs.map(pair =>
    ({ upstreamRotorId: pair.upstreamMotorId, downstreamRotorId: pair.downstreamMotorId }));
  const dataset = DERIVED_DATASET_ID;
  const candidate = {
    schemaVersion: 2, modelId: options.modelId, kind: 'bet',
    units: 'SI', worldFrame: 'NED', bodyFrame: 'FRD', quaternionOrder: 'wxyz',
    datasets: [{
      id: dataset, kind: 'synthetic', sourceSha256: inputSha256,
      derivation: `Derived by @mirage/aircraft derivation ${DERIVATION_VERSION} from the aircraft profile with canonical ` +
        `SHA-256 ${profileSha256}. Components: ${components.description}`,
    }],
    provenance: {
      massProperties: dataset, rotors: dataset, motors: motors.length > 0 ? dataset : null,
      escs: escs.length > 0 ? dataset : null, battery: battery ? dataset : null, airframeDrag: null,
      controlSurfaces: null, landingGear: null, sensorMounts: null,
      rotorWakePairs: rotorWakePairs.length > 0 ? dataset : null,
    },
    massProperties: combineMassProperties(profile.massProperties, profile.payload),
    rotorCount: rotors.length, rotorCapacity: 32, rotors, motors, escs, battery,
    airframe: { drag: null }, controlSurfaces: [], landingGear: [], sensorMounts: [], rotorWakePairs, ardupilot: null,
  };
  // The canonical JSON round trip turns any -0 from the inputs into 0, so the manifest equals its bytes exactly.
  const manifest = validateVehicleManifest(JSON.parse(decodeUtf8(canonicalBytes(candidate))));
  const bytes = canonicalBytes(manifest);
  return Object.freeze({ manifest, bytes, sha256: await sha256Hex(bytes), profileSha256, inputSha256 });
}
