import type { AircraftProfile } from '../../packages/aircraft/src/profile.ts';
import type { ResolvedComponents } from '../../packages/aircraft/src/derive-manifest.ts';

// Shared by tests/aircraft-profile.test.ts (Node) and
// tests/browser/aircraft-derivation.spec.ts (Chromium): synthetic resolved
// propulsion for the TASK-138 fixtures. These values stand in for component
// cards (TASK-139); they are not card, specification or bench data.

/** The five S19 configurations, as fixture file names under tests/fixtures/aircraft/. */
export const FIXTURE_NAMES = ['quad-x', 'hexa-x', 'octa-x', 'coaxial-x8', 'octa-coaxial-16'] as const;
export type FixtureName = typeof FIXTURE_NAMES[number];
export const FIXTURE_MODEL_ID = 138;

export const SYNTHETIC_DESCRIPTION =
  'Synthetic TASK-138 test propulsion: demo-quad blade geometry, a 920 KV motor, a 1000-2000 us ESC and a 4S battery; ' +
  'not component-card or bench data.';

/** Blade geometry of rotor 0 in tests/fixtures/models/demo-quad.json. */
export const SYNTHETIC_BLADES = {
  bladeCount: 2, radiusM: 0.14, rootCutoutM: 0.02, polarId: 0,
  radialStationM: [0.04, 0.08, 0.12], chordM: [0.02, 0.02, 0.02], twistRad: [0.2, 0.2, 0.2],
  quadratureWidthM: [0.04, 0.04, 0.04], shaftInertiaKgM2: 2e-5, bearingViscousNmPerRadS: 1e-6, azimuthSamples: 32,
};
export const SYNTHETIC_MOTOR = { kvRpmPerV: 920, resistanceOhm: 0.12, currentLimitA: 30 };
export const SYNTHETIC_ESC = { pwmMinUs: 1000, pwmMaxUs: 2000, commandTauS: 0.02 };
export const SYNTHETIC_BATTERY = {
  openCircuitFullV: 16.8, openCircuitEmptyV: 13.2, internalResistanceOhm: 0.02, capacityAh: 5, currentLimitA: 100,
};

/** Resolved components for every motor of a validated profile; `drive: false` leaves out motors, ESCs and the battery. */
export function syntheticComponents(profile: AircraftProfile, drive = true): ResolvedComponents {
  return {
    description: SYNTHETIC_DESCRIPTION,
    motors: profile.motors.map(motor => ({
      motorId: motor.id,
      cards: { ...motor.components },
      rotor: structuredClone(SYNTHETIC_BLADES),
      motor: drive ? { ...SYNTHETIC_MOTOR } : null,
      esc: drive ? { ...SYNTHETIC_ESC } : null,
    })),
    battery: drive ? { card: profile.battery.card, values: { ...SYNTHETIC_BATTERY } } : null,
  };
}

/**
 * Arm angles at which Node 24.22.2 and Chromium 153 return different last bits:
 * Math.sin or Math.cos for these azimuths, Math.tan for these tilts. They were
 * found by evaluating both engines on a grid of 400 azimuths and 400 tilts.
 */
export const ENGINE_SENSITIVE_AZIMUTHS_RAD = [
  0.34109999999999974, 1.0696, 2.0616000000000003, 2.8830999999999998, -2.8519, -2.2319, -1.1004, -0.5114000000000003,
] as const;
export const ENGINE_SENSITIVE_TILTS_RAD = [
  -0.39597000000000004, -0.38997000000000004, -0.36397, -0.34797000000000006, -0.23397, 0.12403, 0.19602999999999995,
  0.36002999999999996, 0.36202999999999996,
] as const;
/**
 * The 16-motor fixture with every arm on engine-sensitive angles. Derived with
 * the engines' own trigonometry, Node and Chromium give different manifests for
 * it; derived with packages/aircraft/src/trig.ts, they give the same bytes.
 */
export function engineSensitiveVariant(profile: AircraftProfile): unknown {
  const tilts = ENGINE_SENSITIVE_TILTS_RAD;
  return {
    ...profile,
    arms: profile.arms.map((arm, index) => ({
      ...arm,
      azimuthRad: ENGINE_SENSITIVE_AZIMUTHS_RAD[index % ENGINE_SENSITIVE_AZIMUTHS_RAD.length],
      outwardTiltRad: tilts[index % tilts.length],
      sideTiltRad: tilts[(index + 3) % tilts.length],
    })),
  };
}

/**
 * SHA-256 of each fixture's derived manifest with `syntheticComponents` and
 * FIXTURE_MODEL_ID, recorded from derivation 1 in Node 24.22.2. They lock the
 * bytes; the oracle checks in tests/aircraft-profile.test.ts establish
 * correctness. The browser test requires Chromium to produce the same bytes.
 */
export const RECORDED_MANIFEST_SHA256: { readonly [name in FixtureName]: string } = {
  'quad-x': 'a9e2cc46f6bc0b7b34740a70375e4dc5e43f6d7ce6a03a87111455e3c36a473c',
  'hexa-x': '81eb2d27eecd75378f6b000f74bc3d5d6c8317417439cc846f6607e61c857669',
  'octa-x': '12865479561e2e62a8fc3f8b355f82684f8164569110240262af9f1026fe97fe',
  'coaxial-x8': '603ec04b0a9ea12075f6e2da7aa96f7cde558407cc83305d1106d00310f5899a',
  'octa-coaxial-16': 'c07b18cdf07e6139d07efd76e8df4647ffd0eb5dcfeb15f153d02002df0b6306',
};
/** The same, for `engineSensitiveVariant` of the 16-motor fixture. */
export const RECORDED_ENGINE_SENSITIVE_SHA256 = '234f0d6e891346a377fc266fcd347f6f34355d15c5c543a70890806b8c889cae';

/**
 * TASK-139: strip counts of the propeller geometry byte check for
 * tests/fixtures/components/propeller-example.json. At 64 strips two of its
 * stations take atan arguments on which Node 24.22.2 and Chromium 153 return
 * different last bits; 16 is the default.
 */
export const GEOMETRY_STRIPS = [16, 64] as const;
/**
 * SHA-256 of the canonical JSON of the example propeller's derived geometry,
 * assumptions and flags, recorded in Node 24.22.2. They lock the bytes; the
 * oracle checks in tests/component-cards.test.ts establish correctness.
 */
export const RECORDED_PROPELLER_GEOMETRY_SHA256: { readonly [strips in typeof GEOMETRY_STRIPS[number]]: string } = {
  16: '1f6b71d017a45e9aa3e1276d9a51746e4477f484c5f468d90f4314d502891346',
  64: 'da37eca40820b137d9632470e94b64361b1cde436452c97da8b93931d5272e35',
};
