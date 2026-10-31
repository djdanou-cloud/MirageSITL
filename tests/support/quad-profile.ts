import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateComponentCard, type ComponentCard } from '../../packages/aircraft/src/components.ts';
import { deriveVehicleManifest, type DerivedVehicleManifest } from '../../packages/aircraft/src/derive-manifest.ts';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '../../packages/aircraft/src/profile.ts';
import { resolveComponents } from '../../packages/aircraft/src/resolve-components.ts';

// TASK-153: the S19 quad X on the example component cards with NACA6409 for
// the propeller, as tests/profile-dynamics.test.ts builds it, derived with
// model ID 153. Example cards are not measured components.

const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32);

// Paths from the repository root, so the module also works when bundled (scripts/check-sitl-link-allocation.mjs).
function json(path: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures', path), 'utf8'));
}
function card(type: string): ComponentCard {
  const base = json(`components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) {
    throw new Error(`Invalid ${type} card fixture`);
  }
  const provenance = Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example']));
  return validateComponentCard({ ...base, provenance });
}

export async function quadProfile(): Promise<{ profile: AircraftProfile; derived: DerivedVehicleManifest }> {
  const fixture = validateAircraftProfile(json('aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
  [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
  const cards = new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  return { profile, derived: await deriveVehicleManifest(profile, resolved.components, { modelId: 153 }) };
}
