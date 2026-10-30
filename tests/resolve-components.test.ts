import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '@mirage/aircraft/profile';
import { ASSUMED_ESC_UPDATE_RATE_HZ, ROTOR_AZIMUTH_SAMPLES, resolveComponents } from '@mirage/aircraft/resolve-components';
import { escDriveFromManifest } from '@mirage/physics/drive';

// TASK-144: component cards to resolved components. Oracles: the example
// cards' values, the documented assumed values, and closed forms (shaft
// inertia m·R²/3, pack voltages = cells × cell voltage).

const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32);
function example(type: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`./fixtures/components/${type}-example.json`, import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('Invalid example card');
  return structuredClone(value) as Record<string, unknown>;
}
/** An example card with some values replaced; a null value also clears its provenance, as the card schema requires. */
function card(type: string, values: Record<string, unknown> = {}): ComponentCard {
  const base = example(type), merged = { ...(base.values as object), ...values };
  const provenance = Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, value === null ? null : 'example']));
  return validateComponentCard({ ...base, values: merged, provenance });
}
function cardsWith(overrides: Partial<Record<'motor' | 'propeller' | 'esc' | 'battery', Record<string, unknown>>> = {}): Map<string, ComponentCard> {
  return new Map([[MOTOR, card('motor', overrides.motor)], [PROPELLER, card('propeller', overrides.propeller)],
    [ESC, card('esc', overrides.esc)], [BATTERY, card('battery', overrides.battery)]]);
}
function quad(): AircraftProfile {
  const base: unknown = JSON.parse(readFileSync(new URL('./fixtures/aircraft/quad-x.json', import.meta.url), 'utf8'));
  const profile = validateAircraftProfile(base);
  return validateAircraftProfile({ ...profile, battery: { card: BATTERY },
    motors: profile.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) });
}
const withPolar = (profile: AircraftProfile, polar = 'naca6409-neuralfoil-v1'): AircraftProfile =>
  withPropellerPolars(profile, [{ card: PROPELLER, polar }]);
const ids = (result: ReturnType<typeof resolveComponents>): string[] => result.assumptions.map(a => a.id);

describe('component resolution', () => {
  it('maps complete example cards with a chosen polar and lists every assumption', () => {
    const result = resolveComponents(withPolar(quad()), cardsWith());
    expect(result.missing).toEqual([]);
    const components = result.components;
    if (!components) throw new Error('Expected resolved components');
    expect(components.motors).toHaveLength(4);
    const first = components.motors[0]!;
    // Example propeller: 0.254 m, 12.5 g; I = m·R²/3 about the shaft.
    expect(first.rotor).toMatchObject({ bladeCount: 2, radiusM: 0.127, polarId: 1, bearingViscousNmPerRadS: 0, azimuthSamples: ROTOR_AZIMUTH_SAMPLES });
    expect(first.rotor.shaftInertiaKgM2).toBeCloseTo(0.0125 * 0.127 * 0.127 / 3, 15);
    expect(first.motor).toEqual({ kvRpmPerV: 700, resistanceOhm: 0.085, currentLimitA: 30, noLoadCurrentA: 0.5 });
    // Example ESC: 30 A at 400 Hz; the lag is one update period.
    expect(first.esc).toEqual({ pwmMinUs: 1000, pwmMaxUs: 2000, commandTauS: 1 / 400, updateRateHz: 400, brakeCurrentLimitA: 30 });
    // Example battery: 4S of 4.2/3.3 V cells, 18 mΩ, 125 A.
    expect(components.battery).toEqual({ card: BATTERY, values: {
      openCircuitFullV: 4 * 4.2, openCircuitEmptyV: 4 * 3.3, internalResistanceOhm: 0.018, capacityAh: 5, currentLimitA: 125 } });
    expect(ids(result)).toEqual(['root-cutout-assumed', 'chord-assumed', 'twist-from-pitch', 'motor-rotor-inertia', 'bearing-drag',
      'rotor-numerics', 'esc-pwm-range', 'esc-command-lag', 'esc-brake-current']);
    // One entry per card, not per motor.
    expect(new Set(result.assumptions.map(a => `${a.id}|${a.subject}`)).size).toBe(result.assumptions.length);
  });

  it('assumes and flags the documented values for unknown card values', () => {
    const result = resolveComponents(withPolar(quad()), cardsWith({
      esc: { updateRateHz: null }, motor: { noLoadCurrentA: null, noLoadVoltageV: null, maxCurrentA: null },
      battery: { internalResistanceOhm: null, maxDischargeCurrentA: null },
    }));
    const m = result.components?.motors[0];
    expect(m?.esc).toMatchObject({ updateRateHz: ASSUMED_ESC_UPDATE_RATE_HZ, commandTauS: 1 / 490 });
    expect(m?.motor).toMatchObject({ noLoadCurrentA: 0, currentLimitA: 30 });
    // The pack limit is the summed ESC ratings: 4 × 30 A.
    expect(result.components?.battery?.values).toMatchObject({ internalResistanceOhm: 0, currentLimitA: 120 });
    for (const id of ['esc-update-rate', 'motor-no-load-current', 'motor-current-limit', 'pack-resistance', 'pack-current-limit']) {
      expect(ids(result), id).toContain(id);
    }
  });

  it('takes the polar from a matching card airfoil, flagged, and otherwise blocks flight', () => {
    const named = resolveComponents(quad(), cardsWith({ propeller: { airfoil: 'naca 0012' } }));
    expect(named.components?.motors[0]?.rotor.polarId).toBe(2);
    expect(ids(named)).toContain('polar-from-card-airfoil');
    // A chosen polar wins over the card's airfoil, and is not an assumption.
    const chosen = resolveComponents(withPolar(quad()), cardsWith({ propeller: { airfoil: 'NACA0012' } }));
    expect(chosen.components?.motors[0]?.rotor.polarId).toBe(1);
    expect(ids(chosen)).not.toContain('polar-from-card-airfoil');
    const none = resolveComponents(quad(), cardsWith());
    expect(none.components).toBeNull();
    expect(none.missing).toEqual([`propeller card ${PROPELLER.slice(0, 12)}: airfoil polar (choose one from the polar catalog)`]);
  });

  it('blocks flight on values with no citable assumption and on unselected cards', () => {
    const result = resolveComponents(withPolar(quad()), cardsWith({
      motor: { resistanceOhm: null }, propeller: { massKg: null }, battery: { cellFullV: null, cellEmptyV: null },
    }));
    expect(result.components).toBeNull();
    expect(result.missing).toEqual([
      `propeller card ${PROPELLER.slice(0, 12)}: mass (for the shaft inertia)`, `motor card ${MOTOR.slice(0, 12)}: winding resistance`,
      'battery: full cell voltage', 'battery: empty cell voltage',
    ]);
    const profile = quad();
    const unselected = validateAircraftProfile({ ...profile, battery: { card: null },
      motors: profile.motors.map(motor => (motor.id === 3 ? { ...motor, components: { ...motor.components, esc: null } } : motor)) });
    expect(resolveComponents(withPolar(unselected), cardsWith()).missing).toEqual(['motor 3: ESC card', 'battery card']);
    expect(() => resolveComponents(withPolar(quad()), new Map([[MOTOR, card('motor')]]))).toThrow('not available');
  });

  it('feeds a manifest that carries the drive fields to escDriveFromManifest', async () => {
    const result = resolveComponents(withPolar(quad()), cardsWith());
    if (!result.components) throw new Error('Expected resolved components');
    const derived = await deriveVehicleManifest(withPolar(quad()), result.components, { modelId: 144 });
    expect(derived.manifest.motors[0]).toMatchObject({ noLoadCurrentA: 0.5 });
    expect(derived.manifest.escs[0]).toMatchObject({ updateRateHz: 400, brakeCurrentLimitA: 30 });
    const drive = escDriveFromManifest(derived.manifest, 1);
    const kt = 60 / (2 * Math.PI * 700);
    expect(drive.motors[0]).toEqual({ resistanceOhm: 0.085, torqueConstantNmPerA: kt, currentLimitA: 30, brakeCurrentLimitA: 30,
      noLoadTorqueNm: kt * 0.5, commandTauS: 1 / 400, updatePeriodS: 1 / 400 });
  });
});
