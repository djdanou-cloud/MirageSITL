import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { atmosphereFromState } from '../packages/physics/src/atmosphere.ts';
import { benchMeasurements, importBenchMeasurements } from '../packages/physics/src/bench-import.ts';
import { staticThrustSweep } from '../packages/physics/src/drive.ts';
import {
  CALIBRATION_RPM_MARGIN, POLAR_SCALE_RANGE, fitMotor, fitPropulsion, scaledPolar, staticLoads, type PolarScales,
} from '../packages/physics/src/propulsion-calibration.ts';
import { rotorDefinition } from './bet-runtime-fixture.ts';

// TASK-145: the measured-mode calibration against oracles declared before the implementation:
//  - bench data the BET rotor itself gives with its polar scaled by known factors are fitted back to those factors within 1e-9
//    relative, from the unscaled polar, with thrust and torque, and the thrust-only fit leaves the drag at 1 and says why;
//  - the static solve at a speed equals the settled state of the free shaft on the TASK-092 ESC drive at that speed within 1e-6 of
//    the thrust: the same rotor, reached by a different path (a motor balancing the aerodynamic torque);
//  - the electrical data of a known DC motor (I_m = K_v·Q + I_0, V_m = ω/K_v + R·I_m, lossless ESC) give back R and I_0 within 1e-9;
//  - the residuals are recorded point by point, never judged (SA-01), and what the bench lacks is named, never filled in.
let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600_000);

const RPMS = [2000, 3000, 4000, 5000, 6000, 7000, 8000];
const CONDITIONS = { airDensityKgM3: null, airTemperatureK: 293.15, airPressurePa: 101325, supplyVoltageV: 16 };
const AIR = (() => { const a = atmosphereFromState({ temperatureK: 293.15, pressurePa: 101325 }); return { densityKgM3: a.densityKgM3, viscosityPaS: a.dynamicViscosityPaS, soundMps: a.speedOfSoundMps }; })();
/** Bench data of the fixture rotor with its polar scaled. */
function syntheticBench(scales: PolarScales, motor: { kv: number; resistanceOhm: number; noLoadCurrentA: number } | null, withTorque = true) {
  const rotor = rotorDefinition(0);
  const loads = staticLoads(module, { ...rotor, polar: scaledPolar(rotor.polar, scales) }, AIR, RPMS);
  const kv = (motor?.kv ?? 1) * Math.PI / 30;
  const currentA = motor ? RPMS.map((rpm, i) => {
    const im = kv * (loads.torqueNm[i] ?? 0) + motor.noLoadCurrentA, vm = rpm * Math.PI / 30 / kv + motor.resistanceOhm * im;
    return vm * im / 16;
  }) : null;
  return benchMeasurements(2 * rotor.geometry.radiusM, CONDITIONS, { rpm: RPMS, thrustN: loads.thrustN, torqueNm: withTorque ? loads.torqueNm : null,
    voltageV: motor ? RPMS.map(() => 16) : null, currentA });
}

describe('propulsion calibration (TASK-145)', () => {
  it('recovers known lift and drag scales and a known motor from bench data the model itself gives', () => {
    const truth = { lift: 0.9, drag: 1.2 }, motor = { kv: 900, resistanceOhm: 0.08, noLoadCurrentA: 0.6 };
    const fit = fitPropulsion({ module, rotor: rotorDefinition(0), bench: syntheticBench(truth, motor), kvRpmPerV: motor.kv });
    expect(Math.abs(fit.scales.lift / truth.lift - 1)).toBeLessThan(1e-9);
    expect(Math.abs(fit.scales.drag / truth.drag - 1)).toBeLessThan(1e-9);
    expect(fit.notFitted).toEqual([]);
    expect(fit.residuals).toHaveLength(RPMS.length);
    expect(fit.rmsThrustResidualN).toBeLessThan(1e-9);
    expect(fit.motor?.kvRpmPerV).toBe(900);
    expect(Math.abs((fit.motor?.resistanceOhm ?? NaN) / motor.resistanceOhm - 1)).toBeLessThan(1e-9);
    expect(Math.abs((fit.motor?.noLoadCurrentA ?? NaN) / motor.noLoadCurrentA - 1)).toBeLessThan(1e-9);
    expect(fit.envelope).toEqual({ rpmMin: 2000, rpmMax: 8000, densityKgM3: AIR.densityKgM3, advanceRatioMax: 0 });
    for (const row of fit.motor?.residuals ?? []) expect(row.modelMotorVoltageV).toBeLessThan(row.supplyVoltageV);
  }, 120_000);
  it('fits the lift alone without torque, keeping the drag, and names what it could not fit', () => {
    const fit = fitPropulsion({ module, rotor: rotorDefinition(0), bench: syntheticBench({ lift: 1.1, drag: 1 }, null, false), kvRpmPerV: 900 });
    expect(Math.abs(fit.scales.lift / 1.1 - 1)).toBeLessThan(1e-9);
    expect(fit.scales.drag).toBe(1);
    expect(fit.rmsTorqueResidualNm).toBeNull();
    expect(fit.notFitted).toEqual([
      'drag scale: the bench measured no torque at every point, so the drag coefficient keeps its polar value',
      'motor: the bench measured no torque, voltage and current at every point',
    ]);
  }, 120_000);
  it('solves the same static loads as the free shaft settled on the ESC drive at that speed', () => {
    const rotor = rotorDefinition(0);
    const sweep = staticThrustSweep({ module, rotor, motor: { resistanceOhm: 0.08, torqueConstantNmPerA: 30 / (Math.PI * 900), currentLimitA: 200, brakeCurrentLimitA: 0,
      noLoadTorqueNm: 0, commandTauS: 0.02, updatePeriodS: 0 }, busVoltageV: 16, densityKgM3: AIR.densityKgM3, viscosityPaS: AIR.viscosityPaS, soundMps: AIR.soundMps,
      duties: [0.4, 0.7] });
    for (const point of sweep) {
      const rpm = Math.abs(point.omegaRadS) * 30 / Math.PI, loads = staticLoads(module, rotor, AIR, [rpm]);
      expect(Math.abs((loads.thrustN[0] ?? NaN) / point.thrustN - 1)).toBeLessThan(1e-6);
    }
  }, 120_000);
  it('fits the motor from electrical data alone, and refuses what cannot be fitted', () => {
    const points = RPMS.map((rpm, i) => { const q = 0.01 + 0.002 * i, kv = 1000 * Math.PI / 30, im = kv * q + 0.4, vm = rpm * Math.PI / 30 / kv + 0.12 * im;
      return { rpm, torqueNm: q, voltageV: 16, currentA: vm * im / 16 }; });
    const motor = fitMotor(1000, points);
    expect(motor.resistanceOhm).toBeCloseTo(0.12, 12);
    expect(motor.noLoadCurrentA).toBeCloseTo(0.4, 12);
    expect(() => fitMotor(0, points)).toThrow('positive KV');
    const rotor = rotorDefinition(0);
    expect(() => scaledPolar(rotor.polar, { lift: POLAR_SCALE_RANGE[1] * 1.01, drag: 1 })).toThrow('A polar scale must be 0.25 to 4');
    const two = benchMeasurements(0.3, CONDITIONS, { rpm: [2000, 3000], thrustN: [1, 2], torqueNm: null, voltageV: null, currentA: null });
    expect(() => fitPropulsion({ module, rotor, bench: two, kvRpmPerV: null })).toThrow('at least three bench points');
    expect(CALIBRATION_RPM_MARGIN).toBe(0.1);
  }, 120_000);
  it('refuses bench data of another propeller, and fits the repository\'s bench CSV v2 fixture on a rotor of its diameter, keeping every residual', () => {
    const imported = importBenchMeasurements(readFileSync('tests/fixtures/components/bench-combination.csv', 'utf8'));
    const rotor = rotorDefinition(0);
    expect(() => fitPropulsion({ module, rotor, bench: imported, kvRpmPerV: 900 })).toThrow("The bench propeller's diameter of 0.254 m is not the rotor's 0.3 m");
    // The fixture rotor scaled to the bench's 0.254 m: every length by the same factor.
    const k = imported.diameterM / (2 * rotor.geometry.radiusM), g = rotor.geometry;
    const scaled = { ...rotor, geometry: { ...g, radiusM: g.radiusM * k, rootCutoutM: g.rootCutoutM * k, radialStationM: g.radialStationM.map(v => v * k),
      chordM: g.chordM.map(v => v * k), quadratureWidthM: g.quadratureWidthM.map(v => v * k) } };
    const fit = fitPropulsion({ module, rotor: scaled, bench: imported, kvRpmPerV: 900 });
    expect(fit.residuals.map(row => row.rpm)).toEqual(imported.points.map(point => point.rpm));
    expect(fit.residuals.map(row => row.thrustN)).toEqual(imported.points.map(point => point.thrustN));
    for (const row of fit.residuals) { expect(Number.isFinite(row.modelThrustN)).toBe(true); expect(Number.isFinite(row.modelTorqueNm)).toBe(true); }
    expect(fit.scales.lift).toBeGreaterThanOrEqual(POLAR_SCALE_RANGE[0]);
    expect(fit.scales.lift).toBeLessThanOrEqual(POLAR_SCALE_RANGE[1]);
    expect(fit.motor).not.toBeNull();
  }, 120_000);
});
