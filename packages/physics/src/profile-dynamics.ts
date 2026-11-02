import type { ContactShapePart } from './accident.ts';
import type { PhysicsHz } from '@mirage/protocol';
import { newBodyTruth } from '../../wasm-bet/src/backend.ts';
import type { BoundPolar } from '../../wasm-bet/src/rotor.ts';
import { isaTroposphere } from './atmosphere.ts';
import { BetFlightDynamics, CONFIGURATION_FLAG_WAKE_UNMODELED, type BetFlightConfiguration } from './bet-dynamics.ts';
import { escDriveFromManifest } from './drive.ts';
import { GroundContact, type ContactShape, type ContactWheel } from './ground-contact.ts';
import type { LimitRatings } from './limit-monitor.ts';
import { boundCatalogPolar } from './polar-catalog.ts';
import type { SessionModelPort } from './session-v2.ts';
import {
  deriveVehicle, PROPELLER_DISC_HALF_THICKNESS_OF_RADIUS, projectVehicleToModelV1, validateVehicleManifest, withoutHull, withoutLandingGear,
  type VehicleManifest, type VehicleRegistry,
} from './vehicle-manifest.ts';

// Flight dynamics from a vehicle manifest v2 with motors, ESCs and a battery
// (TASK-144): the manifest an aircraft profile derives (TASK-138) from its
// component cards. Configuration-time code only; the step is BetFlightDynamics.

/**
 * Inflow lag and validity settings of the TASK-033 rotor configuration; the
 * polar settings' minimum confidence of 0.9. Modeling settings, listed as
 * assumptions by the profile resolver, not properties of a propeller.
 */
export const PROFILE_ROTOR_SETTINGS = Object.freeze({ inflowTauS: 0.1, inflowLimitMps: 500, minimumConfidence: 0.9 });
/** The propeller disc thickness lives with the hull shapes; it stays exported here too. */
export { PROPELLER_DISC_HALF_THICKNESS_OF_RADIUS };

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
  /**
   * Stand on the synthetic pad at the origin even with landing gear: for benchmarks that time the
   * BET compute alone (scripts/bench-bet.mjs, bench-profile-dynamics.mjs). Flight sessions never set it.
   */
  readonly syntheticPad?: boolean;
}
/** What a contact shape of a build stands for: a hull shape of the manifest, or the disc of a rotor. */
export type ProfileShapePart = ContactShapePart;
/** The landing gear and contact shapes of a build as the ground contact takes them (TASK-095). */
export interface ProfileGear {
  /** The manifest's gear with anchors relative to the CG, as `ContactWheel` takes them. */
  readonly wheels: readonly ContactWheel[];
  /**
   * Radius of the airframe's contact sphere about the CG, m, for a manifest without a hull: half the
   * height of the CG over the ground with every strut and foot fully compressed, so only the feet
   * carry the vehicle. With shapes the contact builds no sphere; the value is then the smallest
   * shape radius, which the contact configuration still states.
   */
  readonly hullRadiusM: number;
  /**
   * The manifest's hull, then one propeller disc per rotor in rotor order, relative to the CG; empty
   * for a manifest without a hull. They never carry the vehicle at rest; TASK-149 classifies their
   * contact reports (`GroundContact.shapeStateInto`) as accidents.
   */
  readonly shapes: readonly ContactShape[];
  /** What each of `shapes` stands for, in the same order. */
  readonly parts: readonly ProfileShapePart[];
  /** The vehicle's mass and inertia about the CG, as the projected model declares them and the contact must match. */
  readonly vehicle: { readonly massKg: number; readonly inertiaBodyKgM2: readonly number[] };
}
export interface ProfileDynamicsBuild {
  /** Without a contact: each dynamics gets its own (`profileFlightDynamics`), since the dynamics owns and disposes it. */
  readonly configuration: BetFlightConfiguration;
  /** Declared model parts that the dynamics does not model, in words; each also sets a configuration validity flag. */
  readonly limitations: readonly string[];
  /** The gear the vehicle stands on, or null for a manifest without gear, which stands on the synthetic pad. */
  readonly gear: ProfileGear | null;
}

/**
 * The BET flight configuration of a manifest with a production drive. The
 * rotors run in manifest order on the ESC drive (`escDriveFromManifest`) with
 * their catalog polars. Actuator frames for the model carry its model ID as
 * the motor map ID. Without an autopilot the pilot sticks command collective
 * only (attitude control is the autopilot's). With landing gear (TASK-095)
 * the vehicle starts on its fully extended feet over the origin, motors
 * stopped, on the ground contact; without gear it starts on the synthetic pad
 * at the origin. Throws when the manifest lacks the drive, names a polar
 * outside the catalog, or has a section the runtime cannot consume (airframe
 * drag, control surfaces).
 */
export function buildProfileDynamics(input: VehicleManifest, options: ProfileDynamicsOptions = {}): ProfileDynamicsBuild {
  const manifest = validateVehicleManifest(input);
  if (manifest.motors.length !== manifest.rotorCount || manifest.escs.length !== manifest.rotorCount || !manifest.battery) {
    throw new Error('Profile dynamics need a motor and an ESC for every rotor and a battery');
  }
  const drive = escDriveFromManifest(manifest, options.initialStateOfCharge ?? 1, options.housePowerW ?? 0);
  // The drive, the sensor mounts and the gear are consumed here, by the sensor pipeline and by the contact; the rest projects
  // to the v1 body and rotors.
  const p = manifest.provenance;
  const model = projectVehicleToModelV1(withoutHull(withoutLandingGear({
    ...manifest, motors: [], escs: [], battery: null, sensorMounts: [], rotorWakePairs: [], ardupilot: null,
    provenance: { ...p, motors: null, escs: null, battery: null, sensorMounts: null, rotorWakePairs: null },
  })));
  const gear = options.syntheticPad === true ? null : profileGear(manifest, model);
  const polars = new Map<number, BoundPolar>();
  for (const rotor of model.rotors) if (!polars.has(rotor.polarId)) polars.set(rotor.polarId, boundCatalogPolar(rotor.polarId));
  const limitations: string[] = [];
  let configurationFlags = 0;
  if (!gear && options.syntheticPad !== true) {
    limitations.push('The vehicle has no landing gear, so it stands on the synthetic pad, which holds it level on touchdown; decision F-07 ' +
      'places the supports at the profile\'s ground clearance, and a profile without one waits for the body hull (TASK-095).');
  }
  if (manifest.rotorWakePairs.length > 0) {
    limitations.push(`${manifest.rotorWakePairs.length} declared rotor-wake pairs are not modeled until TASK-101; each rotor sees free-stream inflow.`);
    configurationFlags |= CONFIGURATION_FLAG_WAKE_UNMODELED;
  }
  const air = isaTroposphere(0), n = model.rotorCount, initialBody = newBodyTruth();
  // On the gear the CG starts where the fully extended feet just touch the ground plane through the origin.
  if (gear) initialBody.positionNedM[2] = -Math.max(...gear.wheels.map(wheel => wheel.anchorBodyM[2] + wheel.tireRadiusM));
  const configuration: BetFlightConfiguration = {
    manifest: model, polars,
    initialOmegaRadS: new Array<number>(n).fill(0), motorMaxTorqueNm: new Array<number>(n).fill(0),
    inflowTauS: new Array<number>(n).fill(PROFILE_ROTOR_SETTINGS.inflowTauS),
    inflowLimitMps: new Array<number>(n).fill(PROFILE_ROTOR_SETTINGS.inflowLimitMps),
    pilotMix: Array.from({ length: n }, () => [1, 0, 0, 0]).flat(), motorMapId: manifest.modelId,
    initialBody, minimumConfidence: PROFILE_ROTOR_SETTINGS.minimumConfidence,
    densityKgM3: options.densityKgM3 ?? air.densityKgM3, viscosityPaS: options.viscosityPaS ?? air.dynamicViscosityPaS,
    soundMps: options.soundMps ?? air.speedOfSoundMps, syntheticGroundDownM: gear ? undefined : 0, drive, configurationFlags,
    kernelOptions: options.kernelOptions ?? 0, limitRatings: options.limitRatings ?? null,
  };
  return Object.freeze({ configuration, limitations: Object.freeze(limitations), gear });
}

function profileGear(manifest: VehicleManifest, vehicle: ProfileGear['vehicle']): ProfileGear | null {
  if (manifest.landingGear.length === 0) return null;
  const anchors = deriveVehicle(manifest).landingGearAnchorCgM;
  const wheels = manifest.landingGear.map((gear, i): ContactWheel => ({
    anchorBodyM: [anchors[3 * i] ?? 0, anchors[3 * i + 1] ?? 0, anchors[3 * i + 2] ?? 0], unsprungMassKg: gear.unsprungMassKg,
    tireRadiusM: gear.tireRadiusM, rimRadiusM: gear.rimRadiusM, strutTravelM: gear.strutTravelM, suspension: gear.suspension,
    tireLoadCurve: gear.tireLoadCurve.map(([x, f]) => [x ?? 0, f ?? 0] as const), tireDampingNsPm: gear.tireDampingNsPm,
    rollingCoefficient: gear.rollingCoefficient, lateralCoefficient: gear.lateralCoefficient, brakingCoefficient: gear.brakingCoefficient,
    ...(gear.kineticFrictionRatio === undefined ? {} : { kineticFrictionRatio: gear.kineticFrictionRatio }),
  }));
  // Height of the CG over the ground with each strut at the end of its travel and each foot squashed to its rim.
  const clearance = Math.min(...wheels.map(wheel => wheel.anchorBodyM[2] - wheel.strutTravelM + wheel.rimRadiusM));
  // Without a hull the sphere about the CG is the airframe's bottom-out; with one the hull is, and the sphere is not built.
  if (!manifest.hull && !(clearance > 0)) throw new Error('The landing gear does not hold the CG above the ground when fully compressed');
  const derived = deriveVehicle(manifest), shapes: ContactShape[] = [], parts: ProfileShapePart[] = [];
  if (manifest.hull) {
    for (const shape of derived.hullCg) {
      shapes.push(shape.kind === 'capsule'
        ? { kind: 'capsule', startBodyM: triple(shape.startBodyM), endBodyM: triple(shape.endBodyM), radiusM: shape.radiusM }
        : { kind: 'cylinder', centerBodyM: triple(shape.centerBodyM), axisBody: triple(shape.axisBody), radiusM: shape.radiusM,
          halfHeightM: shape.halfHeightM });
      parts.push({ part: 'hull', hullId: shape.id });
    }
    manifest.rotors.forEach((rotor, i) => {
      shapes.push({
        kind: 'cylinder', centerBodyM: triple(derived.rotorHubPositionCgM.slice(3 * i, 3 * i + 3)), axisBody: thrustAxis(rotor.hubToBody),
        radiusM: rotor.radiusM, halfHeightM: PROPELLER_DISC_HALF_THICKNESS_OF_RADIUS * rotor.radiusM,
      });
      parts.push({ part: 'propeller', rotorId: rotor.id });
    });
  }
  const hullRadiusM = manifest.hull ? Math.min(...shapes.map(shape => shape.radiusM)) : clearance / 2;
  return Object.freeze({ wheels: Object.freeze(wheels), hullRadiusM, shapes: Object.freeze(shapes),
    parts: Object.freeze(parts), vehicle });
}
function triple(values: readonly number[]): [number, number, number] {
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}
/** A hub's +z (thrust) axis in body axes from its wxyz hub-to-body quaternion, normalized. */
function thrustAxis(q: readonly number[]): [number, number, number] {
  const [w = 1, x = 0, y = 0, z = 0] = q, n = Math.hypot(w, x, y, z);
  const axis: [number, number, number] = [2 * (x * z + w * y) / (n * n), 2 * (y * z - w * x) / (n * n), 1 - 2 * (x * x + y * y) / (n * n)];
  const length = Math.hypot(...axis);
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

/**
 * Friction of the airframe's sphere or shapes on the ground: decision F-08's static coefficient,
 * which Rapier's rigid contact applies for sticking and sliding alike.
 */
const HULL_FRICTION = 0.6;

/**
 * The flight dynamics of a build at `hz`: on a new ground contact with the build's gear, or on
 * the synthetic pad without gear. Every call creates its own contact, which the dynamics owns;
 * the contact artifact must be initialized (`GroundContact.initialize`). Cold.
 */
export function profileFlightDynamics(module: WebAssembly.Module, build: ProfileDynamicsBuild, hz: PhysicsHz): BetFlightDynamics {
  const { configuration, gear } = build;
  if (!gear) return new BetFlightDynamics(module, configuration, hz);
  const contact = GroundContact.forVehicleNow(configuration.initialBody, gear.vehicle,
    { wheels: gear.wheels, hullRadiusM: gear.hullRadiusM, friction: HULL_FRICTION, ...(gear.shapes.length > 0 ? { shapes: gear.shapes } : {}) });
  // TASK-149: the dynamics checks the shapes' contact reports against decision F-09.
  return new BetFlightDynamics(module, { ...configuration, contact, ...(gear.shapes.length > 0 ? { contactParts: gear.parts } : {}) }, hz);
}

/**
 * `model.load` admission (TASK-144) for vehicles with a production drive: the
 * requested hash must equal the registered payload hash, and the vehicle must
 * build (`buildProfileDynamics`) before the session changes anything. The BET
 * module comes from `module()` at load time; without one the load fails, as it
 * does for a vehicle with gear before the contact artifact is initialized.
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
      const build = buildProfileDynamics(record.manifest, { ...options, limitRatings });
      if (build.gear && !GroundContact.ready) throw new Error('The contact module is not loaded');
      resolve((hz: PhysicsHz) => profileFlightDynamics(bet, build, hz));
    }),
  };
}
