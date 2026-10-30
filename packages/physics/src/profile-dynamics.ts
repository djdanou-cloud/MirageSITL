import type { PhysicsHz } from '@mirage/protocol';
import { newBodyTruth } from '../../wasm-bet/src/backend.ts';
import type { BoundPolar } from '../../wasm-bet/src/rotor.ts';
import { isaTroposphere } from './atmosphere.ts';
import { BetFlightDynamics, CONFIGURATION_FLAG_WAKE_UNMODELED, type BetFlightConfiguration } from './bet-dynamics.ts';
import { escDriveFromManifest } from './drive.ts';
import type { LimitRatings } from './limit-monitor.ts';
import { boundCatalogPolar } from './polar-catalog.ts';
import type { SessionModelPort } from './session-v2.ts';
import { projectVehicleToModelV1, validateVehicleManifest, type VehicleManifest, type VehicleRegistry } from './vehicle-manifest.ts';

// Flight dynamics from a vehicle manifest v2 with motors, ESCs and a battery
// (TASK-144): the manifest an aircraft profile derives (TASK-138) from its
// component cards. Configuration-time code only; the step is BetFlightDynamics.

/**
 * Inflow lag and validity settings of the TASK-033 rotor configuration; the
 * polar settings' minimum confidence of 0.9. Modeling settings, listed as
 * assumptions by the profile resolver, not properties of a propeller.
 */
export const PROFILE_ROTOR_SETTINGS = Object.freeze({ inflowTauS: 0.1, inflowLimitMps: 500, minimumConfidence: 0.9 });

export interface ProfileDynamicsOptions {
  /** Initial battery state of charge in (0, 1]; defaults to 1. */
  readonly initialStateOfCharge?: number;
  /** Constant avionics load on the bus, W; defaults to 0. */
  readonly housePowerW?: number;
  /** Air state; defaults to the ISA troposphere at 0 m. */
  readonly densityKgM3?: number; readonly viscosityPaS?: number; readonly soundMps?: number;
  /** TASK-091 opt-in rotor kernel options (`KERNEL_OPTION_*` of @mirage/wasm-bet/rotor); 0 by default. */
  readonly kernelOptions?: number;
  /** TASK-146 component ratings, in rotor order; null or absent checks none. */
  readonly limitRatings?: LimitRatings | null;
}
export interface ProfileDynamicsBuild {
  readonly configuration: BetFlightConfiguration;
  /** Declared model parts that the dynamics does not model, in words; each also sets a configuration validity flag. */
  readonly limitations: readonly string[];
}

/**
 * The BET flight configuration of a manifest with a production drive. The
 * rotors run in manifest order on the ESC drive (`escDriveFromManifest`) with
 * their catalog polars. Actuator frames for the model carry its model ID as
 * the motor map ID. Without an autopilot the pilot sticks command collective
 * only (attitude control is the autopilot's), and the vehicle starts on the
 * synthetic pad at the origin, motors stopped. Throws when the manifest lacks
 * the drive, names a polar outside the catalog, or has a section the runtime
 * cannot consume (airframe drag, control surfaces, landing gear).
 */
export function buildProfileDynamics(input: VehicleManifest, options: ProfileDynamicsOptions = {}): ProfileDynamicsBuild {
  const manifest = validateVehicleManifest(input);
  if (manifest.motors.length !== manifest.rotorCount || manifest.escs.length !== manifest.rotorCount || !manifest.battery) {
    throw new Error('Profile dynamics need a motor and an ESC for every rotor and a battery');
  }
  const drive = escDriveFromManifest(manifest, options.initialStateOfCharge ?? 1, options.housePowerW ?? 0);
  // The drive and the sensor mounts are consumed here and by the sensor pipeline; the rest projects to the v1 body and rotors.
  const p = manifest.provenance;
  const model = projectVehicleToModelV1({
    ...manifest, motors: [], escs: [], battery: null, sensorMounts: [], rotorWakePairs: [], ardupilot: null,
    provenance: { ...p, motors: null, escs: null, battery: null, sensorMounts: null, rotorWakePairs: null },
  });
  const polars = new Map<number, BoundPolar>();
  for (const rotor of model.rotors) if (!polars.has(rotor.polarId)) polars.set(rotor.polarId, boundCatalogPolar(rotor.polarId));
  const limitations: string[] = [];
  let configurationFlags = 0;
  if (manifest.rotorWakePairs.length > 0) {
    limitations.push(`${manifest.rotorWakePairs.length} declared rotor-wake pairs are not modeled until TASK-101; each rotor sees free-stream inflow.`);
    configurationFlags |= CONFIGURATION_FLAG_WAKE_UNMODELED;
  }
  const air = isaTroposphere(0), n = model.rotorCount, initialBody = newBodyTruth();
  const configuration: BetFlightConfiguration = {
    manifest: model, polars,
    initialOmegaRadS: new Array<number>(n).fill(0), motorMaxTorqueNm: new Array<number>(n).fill(0),
    inflowTauS: new Array<number>(n).fill(PROFILE_ROTOR_SETTINGS.inflowTauS),
    inflowLimitMps: new Array<number>(n).fill(PROFILE_ROTOR_SETTINGS.inflowLimitMps),
    pilotMix: Array.from({ length: n }, () => [1, 0, 0, 0]).flat(), motorMapId: manifest.modelId,
    initialBody, minimumConfidence: PROFILE_ROTOR_SETTINGS.minimumConfidence,
    densityKgM3: options.densityKgM3 ?? air.densityKgM3, viscosityPaS: options.viscosityPaS ?? air.dynamicViscosityPaS,
    soundMps: options.soundMps ?? air.speedOfSoundMps, syntheticGroundDownM: 0, drive, configurationFlags,
    kernelOptions: options.kernelOptions ?? 0, limitRatings: options.limitRatings ?? null,
  };
  return Object.freeze({ configuration, limitations: Object.freeze(limitations) });
}

/**
 * `model.load` admission (TASK-144) for vehicles with a production drive: the
 * requested hash must equal the registered payload hash, and the vehicle must
 * build (`buildProfileDynamics`) before the session changes anything. The BET
 * module comes from `module()` at load time; without one the load fails.
 * `ratings` gives the TASK-146 limit ratings bound to a manifest hash, or null.
 */
export function profileModelPort(registry: VehicleRegistry, module: () => WebAssembly.Module | null,
  options: ProfileDynamicsOptions = {}, ratings: (manifestSha256: string) => LimitRatings | null = () => null): SessionModelPort {
  return {
    prepare: (modelId, manifestSha256) => new Promise(resolve => {
      const record = registry.get(modelId);
      if (!record) throw new Error(`Model ${modelId} is not registered`);
      if (record.sha256 !== manifestSha256.toLowerCase()) throw new Error(`Model ${modelId} hash does not match the registered manifest`);
      if (record.schemaVersion !== 2) throw new Error(`Model ${modelId} is a schema 1 descriptor without a production drive`);
      const bet = module();
      if (!bet) throw new Error('The BET module is not loaded');
      const limitRatings = ratings(record.sha256);
      if (limitRatings && limitRatings.motors.length !== record.manifest.rotorCount) {
        throw new Error(`Model ${modelId} has ${record.manifest.rotorCount} rotors; its limit ratings list ${limitRatings.motors.length} motors`);
      }
      const { configuration } = buildProfileDynamics(record.manifest, { ...options, limitRatings });
      resolve((hz: PhysicsHz) => new BetFlightDynamics(bet, configuration, hz));
    }),
  };
}
