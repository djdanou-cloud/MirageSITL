import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { propellerClearance } from '@mirage/aircraft/clearance';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import { derivePropellerGeometry } from '@mirage/aircraft/propeller-geometry';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { openCircuitTableV, seriesResistanceTable } from '@mirage/physics/battery-curves';
import { buildPavo, heldAt, hoverCommand, PAVO_FILES } from './support/pavo.ts';

// The stakeholder's BetaFPV Pavo20 Pro II (SPECS_SIMULATION_ENGINES "The Pavo20 Pro II profile"), built from its cards as the U35
// is. Declared before the run, with independent oracles:
//  - every card value is known with a named source or not known (null), and the assumed ones are exactly the listed set;
//  - the propeller's chord is the stakeholder's measured 10 mm maximum (2026-11-09) on the median taper of the 14 UIUC propellers of
//    tests/fixtures/rotors/uiuc-propellers.json, each over its own maximum, recomputed here from that fixture within the card's
//    five-decimal rounding (5e-6 of R); the derivation then flags no assumed chord;
//  - the cards resolve with nothing missing, and the derived rotors stand where the 93.9 mm wheelbase puts them on a square X;
//  - the outputs are the real aircraft's own, read from its log 34 (SERVO1..4_FUNCTION 34, 35, 36, 33), and the allocation has
//    QUAD/X_REV's spins (the log's FRAME_CLASS 1, FRAME_TYPE 18) on the scripting matrix, which the TASK-128 catalog needs for it;
//  - the propellers clear each other and the body, and the derived manifest's bytes are reproducible;
//  - held level with equal commands, the model carries its 169 g within 0.1 % at zero climb, with no vortex ring fluctuation. Its
//    hover speed is reported (MIRAGE_PAVO_OUT writes it), not judged: the logs hover at a median of about 22,500 rpm. With
//    MIRAGE_PAVO_OUT, the rotor's CT = T/(rho n^2 D^4) and CP = 2 pi Q/(rho n^2 D^5) are also reported at the flights' median, held
//    the same way at the command that turns it at 22,500 rpm (bisection to 1e-4) in air of 1.177 kg/m^3, T a quarter of the vertical
//    force (as the flights measure it, after the TASK-101 download) and Q the mean aerodynamic shaft torque: the definitions of
//    scripts/pavo/propeller-from-flight.mjs; the rotors' own CT, before the download, beside it. The six-axis
//    trim of tests/support/hover-trim.ts does not apply: its rotor sweep needs a settled speed at every command to 13.05 V, and this
//    rotor holds a period-two alternation of about 3e-6 of its speed above about 5.4 V at 800 Hz.
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600_000);

const ASSUMED: Record<string, readonly string[]> = {
  motor: ['resistanceOhm', 'noLoadCurrentA', 'noLoadVoltageV', 'maxCurrentA', 'maxPowerW', 'massKg'],
  propeller: ['massKg'],
  esc: ['maxCurrentA'],
  battery: [],
};

describe('the Pavo20 Pro II profile', () => {
  it('states every card value with a source or as not known, and assumes exactly the listed ones', () => {
    for (const [role, path] of Object.entries(PAVO_FILES)) {
      if (role === 'profile') continue;
      const card = read(`./${path}`) as { values: Record<string, unknown>; provenance: Record<string, string | null>; sources: { id: string; kind: string }[] };
      const ids = new Set(card.sources.map(source => source.id));
      for (const [key, value] of Object.entries(card.values)) {
        const source = card.provenance[key] ?? null;
        expect(value === null, `${role}.${key}`).toBe(source === null);
        if (source !== null) expect(ids.has(source), `${role}.${key} names ${source}`).toBe(true);
      }
      const assumed = Object.entries(card.provenance).filter(([, source]) => source === 'assumed').map(([key]) => key);
      expect(assumed, role).toEqual(ASSUMED[role]);
      for (const source of card.sources) if (source.id === 'assumed') expect(source.kind).toBe('synthetic');
    }
  });

  it('resolves, derives its rotors on the 93.9 mm wheelbase and lists the geometry assumptions', async () => {
    const { resolved, derived, references } = await buildPavo();
    expect(resolved.missing).toEqual([]);
    const ids = new Set<string>(resolved.assumptions.map(item => item.id));
    for (const id of ['root-cutout-assumed', 'twist-from-pitch', 'motor-rotor-inertia', 'esc-command-lag']) expect(ids.has(id), id).toBe(true);
    for (const id of ['chord-assumed', 'chord-extended', 'pack-resistance']) expect(ids.has(id), id).toBe(false);
    const geometry = derivePropellerGeometry(read(`./${PAVO_FILES.propeller}`));
    expect(geometry.geometry.radiusM).toBeCloseTo(0.02794, 12);
    expect(geometry.geometry.bladeCount).toBe(3);
    // The chord: the UIUC median taper, each propeller's chord over its own maximum, scaled to the measured 10 mm maximum.
    const uiuc = read('./fixtures/rotors/uiuc-propellers.json') as { propellers: { geometry: { radiusRatio: number[]; chordRatio: number[] } }[] };
    const card = read(`./${PAVO_FILES.propeller}`) as { values: { chord: { radiusRatio: number[]; chordRatio: number[] } } };
    const grid = uiuc.propellers[0]!.geometry.radiusRatio;
    const median = grid.map((_, i) => {
      const column = uiuc.propellers.map(p => p.geometry.chordRatio[i]! / Math.max(...p.geometry.chordRatio)).sort((a, b) => a - b);
      return (column[(column.length - 1) >> 1]! + column[column.length >> 1]!) / 2;
    });
    const scale = 0.010 / 0.02794 / Math.max(...median);
    expect(uiuc.propellers).toHaveLength(14);
    expect(card.values.chord.radiusRatio).toEqual(grid);
    card.values.chord.chordRatio.forEach((ratio, i) => expect(Math.abs(ratio - median[i]! * scale), `r/R ${grid[i]}`).toBeLessThan(5e-6));
    expect(Math.abs(Math.max(...card.values.chord.chordRatio) * 0.02794 - 0.010)).toBeLessThan(5e-6 * 0.02794);
    const rotors = derived.manifest.rotors;
    expect(rotors).toHaveLength(4);
    for (const rotor of rotors) {
      expect(Math.hypot(rotor.hubPositionBodyM[0]!, rotor.hubPositionBodyM[1]!)).toBeCloseTo(0.04695, 12);
      expect(rotor.radiusM).toBeCloseTo(0.02794, 12);
    }
    // Opposite rotors are one wheelbase apart.
    const [a, b] = [rotors[0]!.hubPositionBodyM, rotors[1]!.hubPositionBodyM];
    expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)).toBeCloseTo(0.0939, 12);
    expect(derived.manifest.massProperties.massKg).toBe(0.169);
    const again = await buildPavo();
    expect(again.derived.sha256).toBe(derived.sha256);
    expect(references.propeller).toMatch(/^[0-9a-f]{64}$/);
  });

  // TASK-104, the stakeholder's choice of 2026-11-14: the Pavo flies the pack fitted on log 34 (model C of
  // scripts/check-battery-logs.mjs), so its derived battery must be that model exactly: the chen-2006 curve on the card's cell
  // window, the fitted series resistance and branches from the committed report, the curve's charge multiplier, and the neutral
  // values the comparison used where the card states none (no temperature dependence, the temperature held, a new pack).
  it('flies the pack fitted on log 34, exactly the log comparison\'s model C', async () => {
    const { derived, resolved } = await buildPavo();
    const report = read('../test-results/validation/battery-logs.json') as { fitLog: string; fits: { C: { values: { r0Ohm: number; r1Ohm: number; c1F: number; r2Ohm: number; c2F: number } } } };
    const fit = report.fits.C.values, battery = derived.manifest.battery;
    expect(report.fitLog).toBe('stakeholder-pavo-log_34_UnknownDate.bin');
    if (!battery?.dynamics) throw new Error('The Pavo has no battery v2 dynamics');
    expect(battery.internalResistanceOhm).toBe(fit.r0Ohm);
    expect(battery.capacityAh).toBe(0.85);
    expect(battery.dynamics.openCircuitTableV).toEqual(openCircuitTableV('chen-2006', 3, 3.3, 4.35));
    expect(battery.dynamics.seriesResistanceTable).toEqual(seriesResistanceTable('chen-2006'));
    expect(battery.dynamics.branches).toEqual([{ resistanceOhm: fit.r1Ohm, capacitanceF: fit.c1F }, { resistanceOhm: fit.r2Ohm, capacitanceF: fit.c2F }]);
    expect(battery.dynamics).toMatchObject({ activationK: 0, heatCapacityJPerK: 0, stillAirConductanceWPerK: 0, airflowConductanceWPerK: 0,
      entropicVPerK: 0, capacityRetention: 1, resistanceGrowth: 1 });
    const ids = new Set<string>(resolved.assumptions.map(item => item.id));
    for (const id of ['pack-curve-chen-2006', 'pack-resistance-no-temperature', 'pack-no-entropic', 'pack-temperature-held', 'pack-new']) expect(ids.has(id), id).toBe(true);
    for (const id of ['pack-no-fast-branch', 'pack-no-slow-branch']) expect(ids.has(id), id).toBe(false);
  });

  it('generates the real aircraft\'s outputs, with X_REV\'s spins on the scripting matrix, and its propellers clear', async () => {
    const { profile, derived } = await buildPavo();
    const frame = frameConfiguration(profile);
    if (!frame.ok) throw new Error('The Pavo has no ArduPilot frame');
    const value = (name: string) => frame.parameters.find(item => item.name === name)?.value;
    // The real aircraft's own outputs, from stakeholder-pavo-log_34_UnknownDate.bin: SERVO1..4_FUNCTION 34, 35, 36, 33.
    expect([1, 2, 3, 4].map(n => value(`SERVO${n}_FUNCTION`))).toEqual([34, 35, 36, 33]);
    // The real aircraft flies stock QUAD/X_REV (FRAME_CLASS 1, FRAME_TYPE 18); the TASK-128 catalog holds QUAD X (type 1) only, whose
    // spins differ, so the scripting matrix carries X_REV's allocation: ArduPilot's motors 1 and 2 turn clockwise (yaw factor -0.5).
    expect([value('FRAME_CLASS'), value('FRAME_TYPE')]).toEqual([15, 1]);
    expect(frame.notes.map(note => note.code)).toContain('stock-spin-mismatch');
    expect(frame.motors.map(motor => [motor.ardupilotMotor, motor.output, Math.sign(motor.yawFactor)])).toEqual([[1, 4, -1], [2, 1, -1], [3, 2, 1], [4, 3, 1]]);
    const radius = (motorId: number) => derived.manifest.rotors[profile.motors.findIndex(motor => motor.id === motorId)]!.radiusM;
    expect(propellerClearance(profile, radius).clashes).toEqual([]);
  });

  it('holds its weight at zero climb, and reports the speed it needs', async () => {
    const { derived } = await buildPavo();
    const configuration = buildProfileDynamics(derived.manifest).configuration, weightN = 0.169 * 9.80665;
    // The command is found over the same window it is checked over: the fitted pack's branches (TASK-104, 2026-11-14) keep the
    // voltage falling for tens of seconds, so a command found over an earlier window carries about 0.25 % less over this one.
    const window = { settleS: 0.5, measureS: 1 };
    const command = hoverCommand(module, configuration, weightN, window);
    expect(command > 0.05 && command < 0.95, `command ${command}`).toBe(true);
    const held = heldAt(module, configuration, command, window);
    expect(Math.abs(held.forceUpN / weightN - 1)).toBeLessThan(1e-3);
    expect(held.fluctuationSteps).toBe(0);
    const out = process.env.MIRAGE_PAVO_OUT;
    if (!out) return;
    // The flights' median speed and air (SPECS_SIMULATION_ENGINES "Why the model hovers faster"), reported only.
    const rpm = 22500, densityKgM3 = 1.177, diameterM = 0.05588, flight = { ...configuration, densityKgM3 };
    const rpmAt = (c: number) => Math.sqrt(heldAt(module, flight, c, { settleS: 0.5, measureS: 0.5 }).meanOmega2) * 30 / Math.PI;
    let low = 0.05, high = 0.95, middle = 0.5;
    for (let i = 0; i < 40; i++) {
      middle = 0.5 * (low + high);
      const speed = rpmAt(middle);
      if (Math.abs(speed / rpm - 1) <= 1e-4) break;
      if (speed < rpm) low = middle; else high = middle;
    }
    const at = heldAt(module, flight, middle, { settleS: 0.5, measureS: 1 }), n2 = at.meanOmega2 / (2 * Math.PI) ** 2;
    writeFileSync(out, `${JSON.stringify({ manifestSha256: derived.sha256, command, forceUpN: held.forceUpN, weightN,
      hoverRpm: Math.sqrt(held.meanOmega2) * 30 / Math.PI, hoverDensityKgM3: configuration.densityKgM3,
      coefficients: { densityKgM3, command: middle, rpm: Math.sqrt(at.meanOmega2) * 30 / Math.PI, thrustN: at.forceUpN / 4, shaftTorqueNm: at.meanShaftTorqueNm,
        ct: at.forceUpN / 4 / (densityKgM3 * n2 * diameterM ** 4), rotorCt: at.meanRotorThrustN / (densityKgM3 * n2 * diameterM ** 4), cp: 2 * Math.PI * at.meanShaftTorqueNm / (densityKgM3 * n2 * diameterM ** 5), fluctuationSteps: at.fluctuationSteps } }, null, 2)}\n`);
  }, 600_000);
});
