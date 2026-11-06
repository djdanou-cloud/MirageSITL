/** TASK-091: BET flight-step compute in a real module Worker, the vehicles and load of `scripts/bench-bet.mjs`. */
import { validateAircraftProfile, withPropellerPolars } from '../../packages/aircraft/src/profile.ts';
import { validateComponentCard } from '../../packages/aircraft/src/components.ts';
import { resolveComponents } from '../../packages/aircraft/src/resolve-components.ts';
import { deriveVehicleManifest } from '../../packages/aircraft/src/derive-manifest.ts';
import { buildProfileDynamics } from '../../packages/physics/src/profile-dynamics.ts';
import { BetFlightDynamics } from '../../packages/physics/src/bet-dynamics.ts';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '../../packages/protocol/src/index.ts';
import { record } from '../../packages/wasm-bet/src/rotor.ts';
import { trimHover } from '../support/hover-trim.ts';

const WARMUP_STEPS = 20_000, TIMED_STEPS = 20_000, HZ = 1200;
const ids = { motor: '11'.repeat(32), propeller: '22'.repeat(32), esc: '33'.repeat(32), battery: '44'.repeat(32) };

async function configurationOf(profileJson: unknown, cardJson: Record<string, unknown>) {
  const cards = new Map(Object.entries(ids).map(([type, id]) => [id, validateComponentCard(cardJson[type])]));
  const base = validateAircraftProfile(profileJson);
  const profile = withPropellerPolars(validateAircraftProfile({ ...base, battery: { card: ids.battery },
    motors: base.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) }),
  [{ card: ids.propeller, polar: 'naca6409-neuralfoil-v1' }]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 91 });
  return { derived, configuration: buildProfileDynamics(derived.manifest, { kernelOptions: 0, syntheticPad: true }).configuration };
}

function timed(module: WebAssembly.Module, vehicle: Awaited<ReturnType<typeof configurationOf>>) {
  const trim = trimHover(module, vehicle.configuration);
  const dynamics = new BetFlightDynamics(module, vehicle.configuration, HZ);
  const frame = newActuatorFrameV2(), pilot = newInput();
  frame.motorMapId = vehicle.configuration.motorMapId;
  frame.actuatorFlags = ActuatorFlagV2.Armed;
  frame.actuatorCount = vehicle.derived.manifest.rotorCount;
  vehicle.derived.manifest.rotors.forEach((rotor, i) => { frame.normalizedActuators[rotor.motorChannel] = 0.8 * (trim.duty[i] ?? 0); });
  let tick = 0;
  const step = () => {
    dynamics.useActuators(frame);
    dynamics.nowMs = ++tick * 1000 / HZ;
    dynamics.stepNow(pilot);
    if (dynamics.fault !== '' || dynamics.state.down !== 0) throw new Error(`Step failed: ${dynamics.fault || 'left the pad'}`);
  };
  for (let i = 0; i < WARMUP_STEPS; i++) step();
  const samples = new Float64Array(TIMED_STEPS);
  for (let i = 0; i < TIMED_STEPS; i++) {
    const start = performance.now();
    step();
    samples[i] = performance.now() - start;
  }
  dynamics.dispose();
  // The timer of an isolated page moves in 5 us steps, coarse beside a step of some tens of us; the mean is not.
  const sorted = Array.from(samples).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  return { rotors: vehicle.derived.manifest.rotorCount, hz: HZ, warmupSteps: WARMUP_STEPS, steps: TIMED_STEPS,
    meanMs: sorted.reduce((sum, x) => sum + x, 0) / sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted[sorted.length - 1] ?? Number.NaN };
}

self.onmessage = (event: MessageEvent<unknown>) => {
  void (async () => {
    const value = event.data;
    if (!record(value) || !record(value.variants) || !record(value.profiles) || !record(value.cards)) throw new Error('Invalid compute input');
    const vehicles = await Promise.all(Object.entries(value.profiles).map(async ([fixture, json]) => [fixture, await configurationOf(json, value.cards as Record<string, unknown>)] as const));
    const rows = [];
    for (const [variant, bytes] of Object.entries(value.variants)) {
      if (!(bytes instanceof Uint8Array)) throw new Error('Invalid module bytes');
      const module = new WebAssembly.Module(new Uint8Array(bytes));
      for (const [fixture, vehicle] of vehicles) rows.push({ variant, fixture, ...timed(module, vehicle) });
    }
    self.postMessage({ rows, isolated: self.crossOriginIsolated, simd: WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])) });
  })().catch((error: unknown) => { self.postMessage({ error: String(error) }); });
};
