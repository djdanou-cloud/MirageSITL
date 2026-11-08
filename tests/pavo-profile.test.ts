import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { propellerClearance } from '@mirage/aircraft/clearance';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import { derivePropellerGeometry } from '@mirage/aircraft/propeller-geometry';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { buildPavo, heldAt, hoverCommand, PAVO_FILES } from './support/pavo.ts';

// The stakeholder's BetaFPV Pavo20 Pro II (SPECS_SIMULATION_ENGINES "The Pavo20 Pro II profile"), built from its cards as the U35
// is. Declared before the run, with independent oracles:
//  - every card value is known with a named source or not known (null), and the assumed ones are exactly the listed set;
//  - the cards resolve with nothing missing, and the derived rotors stand where the 93.9 mm wheelbase puts them on a square X;
//  - the outputs are the real aircraft's own, read from its log 34 (SERVO1..4_FUNCTION 34, 35, 36, 33), and the allocation has
//    QUAD/X_REV's spins (the log's FRAME_CLASS 1, FRAME_TYPE 18) on the scripting matrix, which the TASK-128 catalog needs for it;
//  - the propellers clear each other and the body, and the derived manifest's bytes are reproducible;
//  - held level with equal commands, the model carries its 169 g within 0.1 % at zero climb, with no vortex ring fluctuation. Its
//    hover speed is reported (MIRAGE_PAVO_OUT writes it), not judged: the logs hover at a median of about 22,500 rpm. The six-axis
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
    for (const id of ['root-cutout-assumed', 'chord-assumed', 'twist-from-pitch', 'motor-rotor-inertia', 'esc-command-lag']) expect(ids.has(id), id).toBe(true);
    expect(ids.has('pack-resistance')).toBe(false);
    const geometry = derivePropellerGeometry(read(`./${PAVO_FILES.propeller}`));
    expect(geometry.geometry.radiusM).toBeCloseTo(0.02794, 12);
    expect(geometry.geometry.bladeCount).toBe(3);
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
    const command = hoverCommand(module, configuration, weightN);
    expect(command > 0.05 && command < 0.95, `command ${command}`).toBe(true);
    const held = heldAt(module, configuration, command, { settleS: 0.5, measureS: 1 });
    expect(Math.abs(held.forceUpN / weightN - 1)).toBeLessThan(1e-3);
    expect(held.fluctuationSteps).toBe(0);
    const out = process.env.MIRAGE_PAVO_OUT;
    if (out) writeFileSync(out, `${JSON.stringify({ manifestSha256: derived.sha256, command, forceUpN: held.forceUpN, weightN,
      hoverRpm: Math.sqrt(held.meanOmega2) * 30 / Math.PI }, null, 2)}\n`);
  }, 600_000);
});
