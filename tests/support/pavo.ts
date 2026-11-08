import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateComponentCard, type ComponentCard } from '../../packages/aircraft/src/components.ts';
import { deriveVehicleManifest, type DerivedVehicleManifest } from '../../packages/aircraft/src/derive-manifest.ts';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '../../packages/aircraft/src/profile.ts';
import { resolveComponents, type ResolvedProfileComponents } from '../../packages/aircraft/src/resolve-components.ts';
import { BetFlightDynamics, type BetFlightConfiguration } from '../../packages/physics/src/bet-dynamics.ts';
import { validateModelManifest } from '../../packages/physics/src/model-manifest.ts';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '../../packages/protocol/src/index.ts';
import { BOUND_V2, BOUND_V2_OUTPUT_SLOTS } from '../../packages/wasm-bet/src/rotor-v2.ts';

// The stakeholder's BetaFPV Pavo20 Pro II (data/flight-logs/inventory.json, aircraft stakeholder-pavo20pro2) built from its
// component cards and tests/fixtures/aircraft/pavo-quad.json, as the U35 of tests/browser/fidelity-u35.spec.ts is built: each
// card is addressed by the SHA-256 of its file, and the propellers fly the NACA6409 catalog polar (the card names no airfoil).
// Every assumed value is listed in SPECS_SIMULATION_ENGINES "The Pavo20 Pro II profile". Test support only.

export const PAVO_FILES = Object.freeze({
  motor: 'fixtures/components/pavo-motor-1303-8000kv.json',
  propeller: 'fixtures/components/pavo-gemfan-2219-3.json',
  esc: 'fixtures/components/pavo-esc-aio.json',
  battery: 'fixtures/components/pavo-battery-3s-850.json',
  profile: 'fixtures/aircraft/pavo-quad.json',
});
export const PAVO_POLAR = 'naca6409-neuralfoil-v1';

const text = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface PavoBuild {
  readonly profile: AircraftProfile;
  readonly cards: ReadonlyMap<string, ComponentCard>;
  readonly resolved: ResolvedProfileComponents;
  readonly derived: DerivedVehicleManifest;
  readonly references: { readonly motor: string; readonly propeller: string; readonly esc: string; readonly battery: string };
}

/** The Pavo profile with its four cards, resolved and derived. */
export async function buildPavo(modelId = 99): Promise<PavoBuild> {
  const texts = { motor: text(PAVO_FILES.motor), propeller: text(PAVO_FILES.propeller), esc: text(PAVO_FILES.esc), battery: text(PAVO_FILES.battery) };
  const references = { motor: sha256(texts.motor), propeller: sha256(texts.propeller), esc: sha256(texts.esc), battery: sha256(texts.battery) };
  const cards = new Map<string, ComponentCard>([
    [references.motor, validateComponentCard(JSON.parse(texts.motor))], [references.propeller, validateComponentCard(JSON.parse(texts.propeller))],
    [references.esc, validateComponentCard(JSON.parse(texts.esc))], [references.battery, validateComponentCard(JSON.parse(texts.battery))],
  ]);
  const fixture = validateAircraftProfile(JSON.parse(text(PAVO_FILES.profile)));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: references.battery },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: references.motor, propeller: references.propeller, esc: references.esc } })) }),
  [{ card: references.propeller, polar: PAVO_POLAR }]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`The Pavo does not resolve: ${resolved.missing.join('; ')}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId });
  return { profile, cards, resolved, derived, references };
}

export interface HeldResult {
  /** The rotors' and airframe's vertical force from the acceleration, N (positive up). */
  readonly forceUpN: number;
  /** The mean over the rotors of the squared shaft speed, averaged over the measured interval, (rad/s)^2. */
  readonly meanOmega2: number;
  /** Steps of the measured interval on which any rotor flagged the vortex ring fluctuation (output flag 256). */
  readonly fluctuationSteps: number;
  readonly measuredSteps: number;
}

/**
 * The vehicle held level by a huge mass with gravity off (as tests/rotor-ground-effect.test.ts holds it), at one command on
 * every motor, moving at a fixed climb rate and transverse speed through still air. After `settleS` the vertical force and the
 * rotors' squared speed are averaged over `measureS`. Ground effect stays off: the vehicle starts 20 m up.
 */
export function heldAt(module: WebAssembly.Module, configuration: BetFlightConfiguration, command: number,
  options: { readonly climbMps?: number; readonly transverseMps?: number; readonly settleS?: number; readonly measureS?: number; readonly hz?: 800 } = {}): HeldResult {
  const hz = options.hz ?? 800, scale = 1e5, manifest = validateModelManifest(configuration.manifest);
  const climb = options.climbMps ?? 0, transverse = options.transverseMps ?? 0;
  const heavy: BetFlightConfiguration = { ...configuration, gravityMps2: 0, syntheticGroundDownM: undefined,
    manifest: { ...structuredClone(configuration.manifest as object), massKg: manifest.massKg * scale, inertiaBodyKgM2: manifest.inertiaBodyKgM2.map(v => v * scale) },
    initialBody: { ...configuration.initialBody, positionNedM: new Float64Array([0, 0, -20]), velocityNedMps: new Float64Array([transverse, 0, -climb]) } };
  const d = new BetFlightDynamics(module, heavy, hz);
  try {
    const frame = newActuatorFrameV2(), pilot = newInput();
    frame.motorMapId = heavy.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
    frame.actuatorCount = Math.max(...manifest.rotors.map(rotor => rotor.motorChannel)) + 1;
    for (const rotor of manifest.rotors) frame.normalizedActuators[rotor.motorChannel] = command;
    const settle = Math.round((options.settleS ?? 0.5) * hz), measure = Math.round((options.measureS ?? 1) * hz);
    const out = () => { const o = d.escEngine?.output; if (!o) throw new Error('The ESC drive is required'); return o; };
    let start = 0, omega2 = 0, fluctuating = 0;
    const flags = new Uint32Array(out().buffer, out().byteOffset, out().length * 2);
    for (let tick = 0; tick < settle + measure; tick++) {
      d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / hz; d.stepNow(pilot);
      if (d.fault !== '') throw new Error(d.fault);
      if (tick === settle - 1) start = d.state.vd;
      if (tick >= settle) {
        const o = out();
        let sum = 0, any = false;
        for (let r = 0; r < manifest.rotors.length; r++) {
          sum += o[r * BOUND_V2_OUTPUT_SLOTS + BOUND_V2.output.omega / 8]! ** 2;
          if ((flags[(r * BOUND_V2_OUTPUT_SLOTS * 8 + BOUND_V2.output.flags) / 4]! & 256) !== 0) any = true;
        }
        omega2 += sum / manifest.rotors.length;
        if (any) fluctuating++;
      }
    }
    return { forceUpN: (start - d.state.vd) / (measure / hz) * manifest.massKg * scale, meanOmega2: omega2 / measure, fluctuationSteps: fluctuating, measuredSteps: measure };
  } finally { d.dispose(); }
}

/** The command on every motor that holds the weight at zero climb, by bisection to 1e-5 of the weight. */
export function hoverCommand(module: WebAssembly.Module, configuration: BetFlightConfiguration, weightN: number): number {
  let low = 0.05, high = 0.95;
  for (let i = 0; i < 40; i++) {
    const middle = 0.5 * (low + high), force = heldAt(module, configuration, middle, { settleS: 0.3, measureS: 0.3 }).forceUpN;
    if (Math.abs(force - weightN) <= 1e-5 * weightN) return middle;
    if (force < weightN) low = middle; else high = middle;
  }
  return 0.5 * (low + high);
}
