import type { ContactShapePart } from './accident.ts';
import type { PhysicsHz } from '@mirage/protocol';
import { newBodyTruth } from '../../wasm-bet/src/backend.ts';
import type { BoundPolar, BoundRotorDefinition } from '../../wasm-bet/src/rotor.ts';
import { isaTroposphere } from './atmosphere.ts';
import { BetFlightDynamics, CONFIGURATION_FLAG_WAKE_UNMODELED, flightRotorDefinition, type BetFlightConfiguration } from './bet-dynamics.ts';
import { escDriveFromManifest } from './drive.ts';
import { GroundContact, type ContactShape, type ContactWheel } from './ground-contact.ts';
import { TERRAIN_READY_RADIUS_M, TerrainContactCoupler } from './terrain-contact.ts';
import type { LimitRatings } from './limit-monitor.ts';
import { boundCatalogPolar } from './polar-catalog.ts';
import { rotorWashedDragAreasM2, type RotorWakeConfiguration } from './rotor-wake.ts';
import { validateModelManifest } from './model-manifest.ts';
import { CALIBRATION_DENSITY_MARGIN, CALIBRATION_RPM_MARGIN, CALIBRATION_STATIC_ADVANCE_RATIO, scaledPolar } from './propulsion-calibration.ts';
import type { SessionModelPort } from './session-v2.ts';
import {
  deriveVehicle, PROPELLER_DISC_HALF_THICKNESS_OF_RADIUS, projectVehicleToModelV1, validateVehicleManifest, zAxis, withoutHull, withoutLandingGear,
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
/** TASK-145: a calibrated rotor's scaled polar flies under this ID plus the rotor's index, above every catalog polar's. */
export const CALIBRATED_POLAR_BASE = 1_000_000;
/** The propeller disc thickness lives with the hull shapes; it stays exported here too. */
export { PROPELLER_DISC_HALF_THICKNESS_OF_RADIUS };

/** Where a vehicle stands at the session's start tick (TASK-172): metres from the pad, and degrees from north, clockwise. */
export interface GroundPlacement { readonly northM: number; readonly eastM: number; readonly headingDeg: number }
export interface ProfileDynamicsOptions {
  /** Initial battery state of charge in (0, 1]; defaults to 1. */
  readonly initialStateOfCharge?: number;
  /** Where it stands at the start tick; on the pad, facing north, by default. */
  readonly initialGround?: GroundPlacement;
  /** Constant avionics load on the bus, W; defaults to 0. */
  readonly housePowerW?: number;
  /** Air state; defaults to the ISA troposphere at 0 m. */
  readonly densityKgM3?: number; readonly viscosityPaS?: number; readonly soundMps?: number;
  /** TASK-091 opt-in rotor kernel options (`KERNEL_OPTION_*` of @mirage/wasm-bet/rotor); 0 by default. */
  readonly kernelOptions?: number;
  /** TASK-098: dynamic inflow, on unless a caller asks for the fixed-lag model of TASK-033. */
  readonly dynamicInflow?: boolean;
  /**
   * TASK-101: which wakes the rotors feel. `all`, the default, is every ordered pair, since a wake's reach depends on the flight;
   * `declared` the manifest's `rotorWakePairs`; `off` none, with the limitation and the flag saying so for a declared pair.
   */
  readonly rotorWake?: 'all' | 'declared' | 'off';
  /** TASK-099: the vortex ring state's seed; a profile flight on dynamic inflow has it, seeded from the model ID unless given. */
  readonly vortexRingSeed?: number;
  /** TASK-146 component ratings, in rotor order; null or absent checks none. */
  readonly limitRatings?: LimitRatings | null;
  /**
   * Stand on the synthetic pad at the origin even with landing gear: for benchmarks that time the
   * BET compute alone (scripts/bench-bet.mjs, bench-profile-dynamics.mjs). Flight sessions never set it.
   */
  readonly syntheticPad?: boolean;
  /** TASK-148: the location's normal gravity, m/s² down, for the body and the ground contact; defaults to 9.80665. */
  readonly gravityMps2?: number;
  /** TASK-148: the air at the ground origin; the rotors then meet ISA air at the CG's height (`BetFlightConfiguration.originAir`). */
  readonly originAir?: { readonly temperatureK: number; readonly pressurePa: number };
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
 * at the origin. An airframe drag block (TASK-096) becomes the dynamics' body
 * drag, its center of pressure taken from the CG. Throws when the manifest
 * lacks the drive, names a polar outside the catalog, or has a section the
 * runtime cannot consume (control surfaces).
 */
export function buildProfileDynamics(input: VehicleManifest, options: ProfileDynamicsOptions = {}): ProfileDynamicsBuild {
  // TASK-145: calibrated rotors take their fitted motor values here and their scaled polars below; the rest of the build never sees the section.
  const { propulsionCalibrations: calibrations = [], ...uncalibrated } = validateVehicleManifest(input);
  const manifest = validateVehicleManifest({ ...uncalibrated, datasets: uncalibrated.datasets.filter(dataset => !calibrations.some(item => item.datasetId === dataset.id)),
    motors: uncalibrated.motors.map(motor => {
      const fitted = calibrations.find(item => item.rotorId === motor.rotorId);
      if (!fitted) return motor;
      return { ...motor, ...(fitted.resistanceOhm === null ? {} : { resistanceOhm: fitted.resistanceOhm }), ...(fitted.noLoadCurrentA === null ? {} : { noLoadCurrentA: fitted.noLoadCurrentA }) };
    }) });
  if (manifest.motors.length !== manifest.rotorCount || manifest.escs.length !== manifest.rotorCount || !manifest.battery) {
    throw new Error('Profile dynamics need a motor and an ESC for every rotor and a battery');
  }
  const drive = escDriveFromManifest(manifest, options.initialStateOfCharge ?? 1, options.housePowerW ?? 0);
  // The drive, the airframe drag, the sensor mounts and the gear are consumed here, by the sensor pipeline and by the
  // contact; the rest projects to the v1 body and rotors.
  // A dataset that only consumed sections name leaves with them.
  const provenance = { ...manifest.provenance, motors: null, escs: null, battery: null, airframeDrag: null, sensorMounts: null, rotorWakePairs: null };
  const named = new Set<string | null | undefined>(Object.values(provenance));
  const limitations: string[] = [], calibratedPolars = new Map<number, number>();
  const model = projectVehicleToModelV1(withoutHull(withoutLandingGear({
    ...manifest, motors: [], escs: [], battery: null, airframe: { drag: null }, sensorMounts: [], rotorWakePairs: [], ardupilot: null,
    provenance, datasets: manifest.datasets.filter(dataset => named.has(dataset.id)),
  })));
  const gear = options.syntheticPad === true ? null : profileGear(manifest, model);
  const polars = new Map<number, BoundPolar>();
  for (const rotor of model.rotors) if (!polars.has(rotor.polarId)) polars.set(rotor.polarId, boundCatalogPolar(rotor.polarId));
  // A calibrated rotor flies its own scaled copy of its polar, under an ID above the catalog's, and checks its envelope every step.
  const calibrationEnvelopes = calibrations.map(item => {
    const index = model.rotors.findIndex(rotor => rotor.id === item.rotorId), rotor = model.rotors[index];
    if (!rotor) throw new Error('A calibration names a rotor the build does not hold');
    const polarId = CALIBRATED_POLAR_BASE + index;
    polars.set(polarId, scaledPolar(boundCatalogPolar(rotor.polarId), { lift: item.liftScale, drag: item.dragScale }));
    calibratedPolars.set(index, polarId);
    return { rotorIndex: index, rpmLow: item.rpmMin * (1 - CALIBRATION_RPM_MARGIN), rpmHigh: item.rpmMax * (1 + CALIBRATION_RPM_MARGIN),
      densityLowKgM3: item.densityKgM3 * (1 - CALIBRATION_DENSITY_MARGIN), densityHighKgM3: item.densityKgM3 * (1 + CALIBRATION_DENSITY_MARGIN),
      advanceRatioMax: CALIBRATION_STATIC_ADVANCE_RATIO };
  });
  const flown = calibratedPolars.size === 0 ? model
    : validateModelManifest({ ...model, rotors: model.rotors.map((rotor, i) => ({ ...rotor, polarId: calibratedPolars.get(i) ?? rotor.polarId })) });
  if (calibrations.length > 0) {
    limitations.push(`${calibrations.length} rotor${calibrations.length === 1 ? ' is' : 's are'} calibrated to bench data of their exact combination; outside its RPM range, density or a near-static advance ratio a step is flagged (TASK-145).`);
  }
  let configurationFlags = 0;
  if (!gear && options.syntheticPad !== true) {
    limitations.push('The vehicle has no landing gear, so it stands on the synthetic pad, which holds it level on touchdown; decision F-07 ' +
      'places the supports at the profile\'s ground clearance, and a profile without one waits for the body hull (TASK-095).');
  }
  const drag = manifest.airframe.drag, cg = manifest.massProperties.cgOffsetBodyM;
  const airframeDrag = drag ? {
    dragAreaBodyM2: [...drag.dragAreaBodyM2], centerOfPressureCgM: drag.centerOfPressureBodyM.map((value, i) => value - cg[i]!),
    maxAirspeedMps: drag.maxAirspeedMps ?? Infinity,
  } : null;
  if (drag && drag.maxAirspeedMps === undefined) {
    limitations.push('The airframe drag data state no airspeed range, so no step flags the drag as outside its data (TASK-096).');
  }
  const rotorWake = rotorWakeOf(manifest, options.rotorWake ?? 'all');
  if (!rotorWake && manifest.rotorWakePairs.length > 0) {
    limitations.push(`${manifest.rotorWakePairs.length} declared rotor-wake pairs are switched off; each rotor sees free-stream inflow.`);
    configurationFlags |= CONFIGURATION_FLAG_WAKE_UNMODELED;
  }
  if (rotorWake) {
    limitations.push('The rotor wakes are a synthetic one-way top-hat model with no swirl, no effect of a lower rotor on its upper rotor and no transport delay (TASK-101); nothing measured confirms them.');
    if (!manifest.hull) limitations.push('This manifest has no hull, so no rotor wake puts a download on the airframe (TASK-101).');
  }
  const air = isaTroposphere(0), n = model.rotorCount, initialBody = newBodyTruth();
  // On the gear the CG starts where the fully extended feet just touch the ground plane through the origin.
  if (gear) initialBody.positionNedM[2] = -Math.max(...gear.wheels.map(wheel => wheel.anchorBodyM[2] + wheel.tireRadiusM));
  const ground = options.initialGround;
  if (ground) {
    if (![ground.northM, ground.eastM, ground.headingDeg].every(Number.isFinite)) throw new Error('The ground placement must be finite');
    initialBody.positionNedM[0] = ground.northM;
    initialBody.positionNedM[1] = ground.eastM;
    // Body to NED, w x y z: a rotation about down by the heading.
    const half = (ground.headingDeg * Math.PI) / 360;
    initialBody.quaternionBodyToNed[0] = Math.cos(half);
    initialBody.quaternionBodyToNed[3] = Math.sin(half);
  }
  const configuration: BetFlightConfiguration = {
    manifest: flown, polars,
    initialOmegaRadS: new Array<number>(n).fill(0), motorMaxTorqueNm: new Array<number>(n).fill(0),
    // Dynamic inflow derives its time constant from the flow (TASK-098): 0 asks for it.
    inflowTauS: new Array<number>(n).fill(options.dynamicInflow === false ? PROFILE_ROTOR_SETTINGS.inflowTauS : 0),
    inflowLimitMps: new Array<number>(n).fill(PROFILE_ROTOR_SETTINGS.inflowLimitMps),
    pilotMix: Array.from({ length: n }, () => [1, 0, 0, 0]).flat(), motorMapId: manifest.modelId,
    initialBody, minimumConfidence: PROFILE_ROTOR_SETTINGS.minimumConfidence,
    densityKgM3: options.densityKgM3 ?? air.densityKgM3, viscosityPaS: options.viscosityPaS ?? air.dynamicViscosityPaS,
    soundMps: options.soundMps ?? air.speedOfSoundMps, syntheticGroundDownM: gear ? undefined : 0, drive, configurationFlags,
    kernelOptions: options.kernelOptions ?? 0, dynamicInflow: options.dynamicInflow !== false,
    ...(options.dynamicInflow === false ? {} : { vortexRingSeed: options.vortexRingSeed ?? manifest.modelId }), limitRatings: options.limitRatings ?? null,
    ...(airframeDrag ? { airframeDrag } : {}),
    ...(rotorWake ? { rotorWake } : {}),
    ...(calibrationEnvelopes.length > 0 ? { calibrationEnvelopes } : {}),
    ...(options.gravityMps2 === undefined ? {} : { gravityMps2: options.gravityMps2 }),
    ...(options.originAir ? { originAir: options.originAir } : {}),
  };
  return Object.freeze({ configuration, limitations: Object.freeze(limitations), gear });
}

function rotorWakeOf(manifest: VehicleManifest, mode: 'all' | 'declared' | 'off'): RotorWakeConfiguration | null {
  if (mode === 'off') return null;
  const indexOf = (id: number): number => manifest.rotors.findIndex(rotor => rotor.id === id);
  const pairs = mode === 'all' ? 'all' as const : manifest.rotorWakePairs.map(pair => [indexOf(pair.upstreamRotorId), indexOf(pair.downstreamRotorId)] as const);
  if (!manifest.hull) return { pairs };
  const hubs = manifest.rotors.map(rotor => ({ hubBodyM: rotor.hubPositionBodyM, axisBody: zAxis(rotor.hubToBody), radiusM: rotor.radiusM }));
  return { pairs, washedDragAreaM2: rotorWashedDragAreasM2(hubs, manifest.hull) };
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
 * One rotor of a build as a bound rotor definition, exactly as the flight model binds it (`flightRotorDefinition`: dynamic inflow,
 * vortex ring seed, kernel options and rotor table included): for off-line static solves (TASK-145, TASK-090). Before 2026-11-08 it
 * left out dynamic inflow and the rest, so calibrations fitted then solved another rotor than the flight's.
 */
export function profileRotorDefinition(configuration: BetFlightConfiguration, rotorIndex: number): BoundRotorDefinition {
  return flightRotorDefinition(configuration, validateModelManifest(configuration.manifest), rotorIndex);
}
/**
 * The flight dynamics of a build at `hz`: on a new ground contact with the build's gear, or on
 * the synthetic pad without gear. Every call creates its own contact, which the dynamics owns;
 * the contact artifact must be initialized (`GroundContact.initialize`). Cold.
 */
export function profileFlightDynamics(module: WebAssembly.Module, build: ProfileDynamicsBuild, hz: PhysicsHz): BetFlightDynamics {
  const { configuration, gear } = build;
  if (!gear) return new BetFlightDynamics(module, configuration, hz);
  const contact = GroundContact.forVehicleNow(configuration.initialBody, gear.vehicle,
    { wheels: gear.wheels, hullRadiusM: gear.hullRadiusM, friction: HULL_FRICTION, gravityMps2: configuration.gravityMps2 ?? 9.80665,
      ...(gear.shapes.length > 0 ? { shapes: gear.shapes } : {}) });
  // TASK-149: the dynamics checks the shapes' contact reports against decision F-09.
  const anchors = gear.wheels.map(wheel => wheel.anchorBodyM);
  return new BetFlightDynamics(module, { ...configuration, contact, ...(gear.shapes.length > 0 ? { contactParts: gear.parts } : {}),
    contactGround: ground => new TerrainContactCoupler(contact, ground, anchors, TERRAIN_READY_RADIUS_M) }, hz);
}

/**
 * `model.load` admission (TASK-144) for vehicles with a production drive: the
 * requested hash must equal the registered payload hash, and the vehicle must
 * build (`buildProfileDynamics`) before the session changes anything. The BET
 * module comes from `module()` at load time; without one the load fails, as it
 * does for a vehicle with gear before the contact artifact is initialized.
 * `ratings` gives the TASK-146 limit ratings bound to a manifest hash, or null;
 * `initial` the run's ground start (TASK-172), bound the same way.
 */
export function profileModelPort(registry: VehicleRegistry, module: () => WebAssembly.Module | null,
  options: ProfileDynamicsOptions = {}, ratings: (manifestSha256: string) => LimitRatings | null = () => null,
  initial: (manifestSha256: string) => Pick<ProfileDynamicsOptions, 'initialGround' | 'initialStateOfCharge'> | null = () => null): SessionModelPort {
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
      const build = buildProfileDynamics(record.manifest, { ...options, ...initial(record.sha256), limitRatings });
      if (build.gear && !GroundContact.ready) throw new Error('The contact module is not loaded');
      resolve((hz: PhysicsHz) => profileFlightDynamics(bet, build, hz));
    }),
  };
}
