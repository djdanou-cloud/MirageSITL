import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BetFlightDynamics, type BetFlightConfiguration, type EscShapingValues, type MotorHeatValues } from '@mirage/physics/bet-dynamics';
import { BOUND_V2_DRIVE_DOUBLES, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS } from '@mirage/wasm-bet/rotor-v2';
import { ThermalInput, ThermalOutput } from '@mirage/wasm-bet/motor-v2';
import { validateModelManifest } from '../packages/physics/src/model-manifest.ts';
import { CARD_V2_VALUE_KEYS, validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { escDriveFromManifest } from '@mirage/physics/drive';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { PARITY_ESC_MOTOR, parityAircraft, parityEscDrive } from './support/autopilot-parity.ts';

// TASK-105, second increment: the ESC shaper and the motor's heat in BetFlightDynamics on a body too heavy to move, declared before
// the implementation (SPECS_SIMULATION_ENGINES "The ESC and the motor's heat in the flight"): without them nothing is built; an ESC
// with neutral shaping flies bit for bit as one without; with 2000 throttle steps every esc_duty is a multiple of 1/2000; with
// 3 latency frames at 400 Hz a command step first moves esc_duty 3 frames later; a command below the start duty leaves the rotor at
// rest; with heat at a held duty the winding warms monotonically (corrected after the first run: until it is within 0.01 K of the
// steady state of its losses, which then fall slowly with the discharging pack), each tick's drive record holds R₂₀·(1 + α·(T_w − 20)),
// and after 60 time constants of the network the temperatures lie within 0.01 K of its steady state at the final losses.

let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600_000);

/** The parity quad on a million-kilogram body without gravity: the rotors turn, the body stays. */
function heldAircraft(shaping?: EscShapingValues, heat?: MotorHeatValues, updatePeriodS = PARITY_ESC_MOTOR.updatePeriodS): BetFlightConfiguration {
  const c = parityAircraft(), model = validateModelManifest(c.manifest);
  c.manifest = { ...model, massKg: 1e6, inertiaBodyKgM2: model.inertiaBodyKgM2.map(v => v * 1e8) };
  c.gravityMps2 = 0;
  const drive = parityEscDrive(0.9, 3);
  c.drive = { ...drive, motors: drive.motors.map(m => ({ ...m, updatePeriodS, ...(shaping ? { shaping } : {}), ...(heat ? { heat } : {}) })) };
  return c;
}
const pilot = { flags: 3, throttle: 0, roll: 0, pitch: 0, yaw: 0, wallTimeMs: 0 };
function step(d: BetFlightDynamics, tick: number, throttle: number): void {
  d.nowMs = (tick + 0.5) * 1000 / d.hz; pilot.wallTimeMs = d.nowMs; pilot.throttle = throttle;
  d.stepNow(pilot);
  if (d.fault !== '') throw new Error(d.fault);
}
const escDuty = (d: BetFlightDynamics, rotor: number) => d.escEngine!.input[rotor * BOUND_V2_INPUT_DOUBLES + 13]!;
const omega = (d: BetFlightDynamics, rotor: number) => d.escEngine!.output[rotor * BOUND_V2_OUTPUT_SLOTS + 9]!;
const NEUTRAL: EscShapingValues = { latencyFrames: 0, rampPerS: 0, startDuty: 0, throttleSteps: 0 };

describe('ESC shaping and motor heat in the flight', () => {
  it('builds nothing without them, and flies neutral shaping bit for bit as none', () => {
    const plain = new BetFlightDynamics(module, heldAircraft(), 800), neutral = new BetFlightDynamics(module, heldAircraft(NEUTRAL), 800);
    expect(plain.motorV2).toBeNull();
    expect(neutral.motorV2?.shaped).toBe(4);
    for (let k = 0; k < 2400; k++) {
      const throttle = 0.2 + 0.5 * (Math.floor(k / 37) % 2) + 0.1 * Math.sin(k * 0.01);
      step(plain, k, throttle); step(neutral, k, throttle);
      // esc_duty is the raw target without a shaper, which the drive record samples itself, and the sampled one with: compare the rotors.
      for (let r = 0; r < 4; r++) expect(omega(neutral, r), `tick ${k}`).toBe(omega(plain, r));
    }
  });

  it('quantizes to the throttle steps', () => {
    const d = new BetFlightDynamics(module, heldAircraft({ ...NEUTRAL, throttleSteps: 2000 }), 800);
    for (let k = 0; k < 1200; k++) {
      step(d, k, 0.3 + 0.4 * Math.sin(k * 0.013));
      for (let r = 0; r < 4; r++) { const x = escDuty(d, r) * 2000; expect(Math.abs(x - Math.round(x))).toBeLessThan(1e-9); }
    }
  });

  it('delays a command step by its latency in frames', () => {
    const d = new BetFlightDynamics(module, heldAircraft({ ...NEUTRAL, latencyFrames: 3 }, undefined, 1 / 400), 400);
    for (let k = 0; k < 200; k++) step(d, k, 0.2);
    const before = escDuty(d, 0);
    let first = -1;
    for (let k = 200; k < 220 && first < 0; k++) { step(d, k, 0.6); if (escDuty(d, 0) !== before) first = k; }
    // The 0.6 enters the frame ring on tick 200 and acts on tick 203: 3 frames of 2.5 ms, 7.5 ms.
    expect(first).toBe(203);
  });

  it('leaves a stopped motor at rest below its start duty', () => {
    const d = new BetFlightDynamics(module, heldAircraft({ ...NEUTRAL, startDuty: 0.1 }), 800);
    for (let k = 0; k < 800; k++) step(d, k, 0.05);
    for (let r = 0; r < 4; r++) { expect(escDuty(d, r)).toBe(0); expect(omega(d, r)).toBe(0); }
    // From 0.15, above the start duty, it runs as an unshaped ESC given the same commands.
    const plain = new BetFlightDynamics(module, heldAircraft(), 800);
    for (let k = 0; k < 800; k++) step(plain, k, 0);
    for (let k = 800; k < 1600; k++) { step(d, k, 0.15); step(plain, k, 0.15); }
    for (let r = 0; r < 4; r++) { expect(omega(d, r)).toBeGreaterThan(10); expect(Math.abs(omega(d, r) / omega(plain, r) - 1)).toBeLessThan(0.01); }
  });

  it('heats the motors at a held duty to the network\'s steady state, scaling each tick\'s drive record', () => {
    // Small capacities so that 60 time constants fit a test: the slower mode's time constant is under 0.6 s.
    const heat: MotorHeatValues = { windingHeatCapacityJPerK: 0.05, housingHeatCapacityJPerK: 0.2, windingToHousingKPerW: 1, housingToAirKPerW: 2,
      airflowCoolingPerMps: 0.05 };
    const hz = 800, d = new BetFlightDynamics(module, heldAircraft(undefined, heat), hz), plain = new BetFlightDynamics(module, heldAircraft(), hz);
    const mv = d.motorV2!, out = mv.thermalOutput, input = mv.thermalInput, drive = d.escEngine!.drive;
    const air = out[ThermalOutput.WindingC]!;
    // 340 m/s is 287.6 K, 14.5 °C.
    expect(air).toBeCloseTo(340 ** 2 / (1.4 * 287.05) - 273.15, 12);
    let last = air;
    const ticks = 36 * hz;
    // The steady state of motor 0's network at this tick's losses.
    const steadyWinding = () => {
      const copper = input[ThermalInput.CopperLossW]!, iron = out[ThermalOutput.IronLossW]!, v = input[ThermalInput.AirspeedMps]!;
      return air + (copper + iron) * heat.housingToAirKPerW / (1 + heat.airflowCoolingPerMps * v) + copper * heat.windingToHousingKPerW;
    };
    for (let k = 0; k < ticks; k++) {
      step(d, k, 0.5); step(plain, k, 0.5);
      const winding = out[ThermalOutput.WindingC]!;
      // Corrected after the first run: the pack discharges, its voltage and so the losses fall, and once the winding has reached the
      // steady state of its losses it follows them down. It must not cool while it is still more than 0.01 K below that state.
      if (k > 10 && steadyWinding() - winding > 0.01) expect(winding).toBeGreaterThanOrEqual(last);
      last = winding;
      for (let r = 0; r < 4; r++) {
        const o = r * ThermalOutput.Stride, w = out[o + ThermalOutput.WindingC]!, h = out[o + ThermalOutput.HousingC]!;
        expect(Math.abs(drive[r * BOUND_V2_DRIVE_DOUBLES]! / (PARITY_ESC_MOTOR.resistanceOhm * (1 + 0.00393 * (w - 20))) - 1)).toBeLessThan(1e-15);
        expect(Math.abs(drive[r * BOUND_V2_DRIVE_DOUBLES + 1]! / (PARITY_ESC_MOTOR.torqueConstantNmPerA * (1 - 0.0012 * (h - 20))) - 1)).toBeLessThan(1e-15);
      }
    }
    for (let r = 0; r < 4; r++) {
      const i = r * ThermalInput.Stride, o = r * ThermalOutput.Stride;
      const copper = input[i + ThermalInput.CopperLossW]!, iron = out[o + ThermalOutput.IronLossW]!, v = input[i + ThermalInput.AirspeedMps]!;
      const housing = air + (copper + iron) * heat.housingToAirKPerW / (1 + heat.airflowCoolingPerMps * v), winding = housing + copper * heat.windingToHousingKPerW;
      expect(Math.abs(out[o + ThermalOutput.HousingC]! - housing)).toBeLessThan(0.01);
      expect(Math.abs(out[o + ThermalOutput.WindingC]! - winding)).toBeLessThan(0.01);
      expect(out[o + ThermalOutput.WindingC]!).toBeGreaterThan(air + 1);
    }
    // The heat reaches the rotor. Its sign is not obvious: a warmer winding's higher R slows the rotor, while the warmer magnets'
    // lower k raises the speed a duty gives (speed about d·V/k at light load); on this parity motor the second wins, by about 0.2 %.
    expect(Math.abs(omega(d, 0) / omega(plain, 0) - 1)).toBeGreaterThan(1e-3);
    d.reset();
    expect(out[ThermalOutput.WindingC]).toBe(air);
    expect(drive[0]).toBe(PARITY_ESC_MOTOR.resistanceOhm * (1 + 0.00393 * (air - 20)));
  }, 60_000); // 60 simulated time constants: 9.6 s on a GitHub runner on 2026-11-08, past Vitest's default 5 s.
});

// From the cards to the flight, declared before the implementation: an ESC card knowing two of its four command-path values shapes
// every ESC with the other two neutral and listed as assumptions; a motor card knowing all five thermal values heats every motor; one
// knowing only some does not, and says so; cards without schema-2 values derive a manifest without either section.
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
function card(type: string, values: Record<string, number> = {}): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null || !('type' in base)) throw new Error('Invalid card');
  const later = type === 'motor' || type === 'esc' ? CARD_V2_VALUE_KEYS[type] : [];
  const schema2 = later.some(key => key in values);
  const merged: Record<string, unknown> = { ...base.values, ...(schema2 ? Object.fromEntries(later.map(key => [key, null])) : {}), ...values };
  return validateComponentCard({ ...base, schemaVersion: schema2 ? 2 : 1, values: merged,
    provenance: Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, value === null ? null : 'example'])) });
}
const [MOTOR, PROPELLER, ESC, BATTERY] = ['a', 'b', 'c', 'd'].map(c => c.repeat(64));
async function fromCards(motorValues: Record<string, number>, escValues: Record<string, number>) {
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }), [{ card: PROPELLER!, polar: 'naca6409-neuralfoil-v1' }]);
  const cards = new Map([[MOTOR!, card('motor', motorValues)], [PROPELLER!, card('propeller')], [ESC!, card('esc', escValues)], [BATTERY!, card('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(resolved.missing.join('; '));
  const manifest = (await deriveVehicleManifest(profile, resolved.components, { modelId: 100 })).manifest;
  return { manifest, assumptions: resolved.assumptions.map(a => a.id) };
}
const HEAT = { windingHeatCapacityJPerK: 8, housingHeatCapacityJPerK: 25, windingToHousingKPerW: 1.5, housingToAirKPerW: 6, airflowCoolingPerMps: 0.1 };

describe('ESC shaping and motor heat from the cards', () => {
  it('shapes and heats from schema-2 cards, naming each neutral value', async () => {
    const { manifest, assumptions } = await fromCards(HEAT, { latencyFrames: 2, throttleSteps: 2000 });
    for (const esc of manifest.escs) expect(esc.shaping).toEqual({ latencyFrames: 2, rampPerS: 0, startDuty: 0, throttleSteps: 2000 });
    for (const motor of manifest.motors) expect(motor.thermal).toEqual(HEAT);
    expect(assumptions).toEqual(expect.arrayContaining(['esc-ramp', 'esc-start-duty', 'motor-heat-20c']));
    expect(assumptions).not.toContain('esc-latency');
    const drive = escDriveFromManifest(manifest, 1);
    for (const motor of drive.motors) { expect(motor.shaping?.throttleSteps).toBe(2000); expect(motor.heat).toEqual(HEAT); }
    const build = buildProfileDynamics(manifest, { initialStateOfCharge: 1, syntheticPad: true });
    const d = new BetFlightDynamics(module, build.configuration, 800);
    expect([d.motorV2?.shaped, d.motorV2?.heated]).toEqual([4, 4]);
    for (let k = 0; k < 400; k++) step(d, k, 0.3);
  });
  it('does not heat with an incomplete network, and derives neither section without schema-2 values', async () => {
    const partial = await fromCards({ windingHeatCapacityJPerK: 8, housingToAirKPerW: 6 }, {});
    for (const motor of partial.manifest.motors) expect('thermal' in motor).toBe(false);
    expect(partial.assumptions).toContain('motor-heat-incomplete');
    const plain = await fromCards({}, {});
    for (const motor of plain.manifest.motors) expect('thermal' in motor).toBe(false);
    for (const esc of plain.manifest.escs) expect('shaping' in esc).toBe(false);
    expect(plain.assumptions.filter(id => /^(esc-latency|esc-ramp|esc-start-duty|esc-throttle-steps|motor-heat)/.test(id))).toEqual([]);
  });
});
