import { catalogPolar, catalogPolarForAirfoil } from '@mirage/physics/polar-catalog';
import { checkProfileCards, type BatteryCard, type ComponentCard, type EscCard, type MotorCard, type PropellerCard } from './components.ts';
import type { EscValues, MotorValues, ResolvedComponents, RotorBlades } from './derive-manifest.ts';
import { derivePropellerGeometry, type GeometryFlagId } from './propeller-geometry.ts';
import { propellerPolarsOf, validateAircraftProfile, type AircraftProfile } from './profile.ts';

// Component cards to the resolved components of a manifest derivation
// (TASK-144). By the stakeholder decision of 2026-10-30, a physics value a
// card lacks takes a documented assumed value and is listed as a flagged
// assumption, so the profile flies as a preliminary calculation. A value with
// no citable assumption stays missing, and a profile with anything missing
// does not resolve. Configuration-time code only.

/**
 * MOT_PWM_MIN and MOT_PWM_MAX defaults of the pinned AP_MotorsMulticopter.cpp:
 * the ESC range the autopilot drives when the profile sets nothing else.
 */
export const ASSUMED_PWM_RANGE_US = Object.freeze({ min: 1000, max: 2000 });
/** AP_MOTORS_SPEED_DEFAULT of the pinned AP_Motors_Class.h (RC_SPEED): the output rate when an ESC card states none. */
export const ASSUMED_ESC_UPDATE_RATE_HZ = 490;
/** Azimuth samples per rotor revolution in the TASK-033 BET validation; a numerical setting, not a property of the propeller. */
export const ROTOR_AZIMUTH_SAMPLES = 8;
/** Propeller strips; the TASK-139 default. */
export const ROTOR_STRIPS = 16;

export type ComponentAssumptionId =
  | 'esc-pwm-range' | 'esc-update-rate' | 'esc-command-lag' | 'esc-brake-current' | 'motor-no-load-current'
  | 'motor-current-limit' | 'motor-rotor-inertia' | 'bearing-drag' | 'pack-resistance' | 'pack-current-limit'
  | 'polar-from-card-airfoil' | 'rotor-numerics' | GeometryFlagId;
export interface ComponentAssumption {
  readonly id: ComponentAssumptionId;
  /** What it applies to, such as "ESC card 1a2b3c4d5e6f" or "battery". */
  readonly subject: string;
  readonly description: string;
}
export interface ResolvedProfileComponents {
  /** Null while anything is missing. */
  readonly components: ResolvedComponents | null;
  /** Every assumption, in motor order and then the battery, without repeats. */
  readonly assumptions: readonly ComponentAssumption[];
  /** What blocks flight: unselected or unavailable cards and values with no citable assumption. */
  readonly missing: readonly string[];
}

const short = (sha256: string): string => sha256.slice(0, 12);

/**
 * The resolved components of a profile from its cards. `description` names
 * the cards for the manifest's derivation text. Cards must be the versions the
 * profile references (`checkProfileCards`).
 */
export function resolveComponents(input: unknown, cards: ReadonlyMap<string, ComponentCard>): ResolvedProfileComponents {
  const profile: AircraftProfile = validateAircraftProfile(input);
  checkProfileCards(profile, cards);
  const assumptions = new Map<string, ComponentAssumption>();
  const assume = (id: ComponentAssumptionId, subject: string, description: string): void => {
    const key = `${id}|${subject}`;
    if (!assumptions.has(key)) assumptions.set(key, Object.freeze({ id, subject, description }));
  };
  const missing: string[] = [];
  const chosen = new Map(propellerPolarsOf(profile).map(entry => [entry.card, entry.polar]));
  const motors: ResolvedComponents['motors'][number][] = [];
  let escRatingSumA = 0;

  for (const motor of profile.motors) {
    const refs = motor.components;
    const card = <T extends ComponentCard>(sha256: string | null, role: string): T | null => {
      if (sha256 === null) { missing.push(`motor ${motor.id}: ${role} card`); return null; }
      // checkProfileCards established presence and type.
      return cards.get(sha256) as T;
    };
    const motorCard = card<MotorCard>(refs.motor, 'motor'), propellerCard = card<PropellerCard>(refs.propeller, 'propeller');
    const escCard = card<EscCard>(refs.esc, 'ESC');
    let rotor: RotorBlades | null = null, motorValues: MotorValues | null = null, escValues: EscValues | null = null;

    if (propellerCard && refs.propeller) {
      const subject = `propeller card ${short(refs.propeller)}`;
      const result = derivePropellerGeometry(propellerCard, { strips: ROTOR_STRIPS });
      for (const flag of result.flags) if (flag.id !== 'inertia-unknown' && flag.id !== 'airfoil-unspecified') assume(flag.id, subject, flag.description);
      const g = result.geometry;
      const chosenId = chosen.get(refs.propeller);
      let polar = chosenId === undefined ? null : catalogPolar(chosenId);
      if (!polar) {
        polar = catalogPolarForAirfoil(g.airfoil);
        if (polar) assume('polar-from-card-airfoil', subject, `The card's airfoil "${String(g.airfoil)}" selects the catalog polar ${polar.id}; the profile chose none.`);
      }
      if (!polar) missing.push(`${subject}: airfoil polar (choose one from the polar catalog)`);
      if (g.bladeInertiaKgM2 === null) missing.push(`${subject}: mass (for the shaft inertia)`);
      assume('motor-rotor-inertia', subject, 'The shaft inertia is the propeller alone; the motor rotor adds an unknown amount.');
      assume('bearing-drag', subject, 'No viscous bearing drag; the motor no-load current carries the speed-independent losses.');
      assume('rotor-numerics', subject, `BET numerics: ${ROTOR_STRIPS} strips (TASK-139 default) and ${ROTOR_AZIMUTH_SAMPLES} azimuth samples (TASK-033 validation).`);
      if (polar && g.bladeInertiaKgM2 !== null) {
        rotor = {
          bladeCount: g.bladeCount, radiusM: g.radiusM, rootCutoutM: g.rootCutoutM, polarId: polar.numericId,
          radialStationM: [...g.radialStationM], chordM: [...g.chordM], twistRad: [...g.twistRad],
          quadratureWidthM: [...g.quadratureWidthM], shaftInertiaKgM2: g.bladeInertiaKgM2, bearingViscousNmPerRadS: 0,
          azimuthSamples: ROTOR_AZIMUTH_SAMPLES,
        };
      }
    }
    if (escCard && refs.esc) {
      const subject = `ESC card ${short(refs.esc)}`, v = escCard.values;
      escRatingSumA += v.maxCurrentA;
      assume('esc-pwm-range', subject, `PWM ${ASSUMED_PWM_RANGE_US.min}-${ASSUMED_PWM_RANGE_US.max} us, the MOT_PWM_MIN/MAX defaults of the pinned ArduPilot.`);
      const rate = v.updateRateHz ?? ASSUMED_ESC_UPDATE_RATE_HZ;
      if (v.updateRateHz === null) {
        assume('esc-update-rate', subject, `Update rate ${ASSUMED_ESC_UPDATE_RATE_HZ} Hz, the ArduPilot motor output default (AP_MOTORS_SPEED_DEFAULT); the card states none.`);
      }
      assume('esc-command-lag', subject, 'The ESC follows a new command with a first-order lag of one update period; its own filtering is unknown.');
      assume('esc-brake-current', subject, `Braking current limited to the ESC rating, ${v.maxCurrentA} A; the card states no brake limit.`);
      escValues = { pwmMinUs: ASSUMED_PWM_RANGE_US.min, pwmMaxUs: ASSUMED_PWM_RANGE_US.max, commandTauS: 1 / rate,
        updateRateHz: rate, brakeCurrentLimitA: v.maxCurrentA };
    }
    if (motorCard && refs.motor) {
      const subject = `motor card ${short(refs.motor)}`, v = motorCard.values;
      if (v.resistanceOhm === null) missing.push(`${subject}: winding resistance`);
      if (v.noLoadCurrentA === null) assume('motor-no-load-current', subject, 'No-load current 0: the speed-independent motor losses are neglected.');
      let limit = v.maxCurrentA;
      if (limit === null && escCard) {
        limit = escCard.values.maxCurrentA;
        assume('motor-current-limit', subject, `Current limit ${limit} A from the ESC rating; the card states no maximum current.`);
      }
      if (limit === null) missing.push(`${subject}: maximum current`);
      if (v.resistanceOhm !== null && limit !== null) {
        motorValues = { kvRpmPerV: v.kvRpmPerV, resistanceOhm: v.resistanceOhm, currentLimitA: limit, noLoadCurrentA: v.noLoadCurrentA ?? 0 };
      }
    }
    if (rotor && motorValues && escValues) motors.push({ motorId: motor.id, cards: { ...refs }, rotor, motor: motorValues, esc: escValues });
  }

  let battery: ResolvedComponents['battery'] = null;
  const batteryRef = profile.battery.card;
  if (batteryRef === null) missing.push('battery card');
  else {
    // checkProfileCards established presence and type.
    const v = (cards.get(batteryRef) as BatteryCard).values, subject = 'battery';
    if (v.cellFullV === null) missing.push('battery: full cell voltage');
    if (v.cellEmptyV === null) missing.push('battery: empty cell voltage');
    if (v.internalResistanceOhm === null) assume('pack-resistance', subject, 'Pack resistance 0: no voltage sag under load.');
    let limit = v.maxDischargeCurrentA;
    if (limit === null) {
      limit = escRatingSumA;
      assume('pack-current-limit', subject, `Pack current limit ${limit} A, the sum of the ESC ratings; the card states no maximum discharge current.`);
    }
    if (v.cellFullV !== null && v.cellEmptyV !== null && limit > 0) {
      battery = { card: batteryRef, values: {
        openCircuitFullV: v.cellsSeries * v.cellFullV, openCircuitEmptyV: v.cellsSeries * v.cellEmptyV,
        internalResistanceOhm: v.internalResistanceOhm ?? 0, capacityAh: v.capacityAh, currentLimitA: limit,
      } };
    }
  }

  const complete = missing.length === 0 && battery !== null && motors.length === profile.motors.length;
  const description = 'Component cards ' + [...new Set(profile.motors.flatMap(m => [m.components.motor, m.components.propeller, m.components.esc])
    .concat([batteryRef]).filter((sha): sha is string => sha !== null).map(short))].sort().join(', ') +
    `; ${assumptions.size} assumptions (TASK-144).`;
  return Object.freeze({
    components: complete ? { description, motors, battery } : null,
    assumptions: Object.freeze([...assumptions.values()]),
    missing: Object.freeze([...new Set(missing)]),
  });
}
