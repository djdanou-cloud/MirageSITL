import { catalogPolar, catalogPolarForAirfoil } from '@mirage/physics/polar-catalog';
import { openCircuitTableV } from '@mirage/physics/battery-curves';
import type { BatteryDynamicsSpec } from '@mirage/physics/vehicle-manifest';
import { LIMIT_RATINGS_SCHEMA_VERSION, type LimitRatings, type MotorRatings } from '@mirage/physics/limit-monitor';
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
  | 'polar-from-card-airfoil' | 'rotor-numerics'
  // TASK-105: the ESC command path's neutral values, and the motor heat's.
  | 'esc-latency' | 'esc-ramp' | 'esc-start-duty' | 'esc-throttle-steps' | 'motor-heat-incomplete' | 'motor-heat-20c'
  // TASK-104: the dynamic pack's rules for what its card does not state.
  | 'pack-curve-chen-2006' | 'pack-no-fast-branch' | 'pack-no-slow-branch' | 'pack-resistance-no-temperature' | 'pack-no-entropic'
  | 'pack-temperature-held' | 'pack-new' | GeometryFlagId;
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
      // TASK-105: an ESC card that knows one of its command-path values shapes the command; the unknown ones are neutral.
      const shaping = [v.latencyFrames, v.rampPerS, v.startDuty, v.throttleSteps].some(x => x !== undefined && x !== null) ? {
        latencyFrames: v.latencyFrames ?? 0, rampPerS: v.rampPerS ?? 0, startDuty: v.startDuty ?? 0, throttleSteps: v.throttleSteps ?? 0,
      } : null;
      if (shaping) {
        if (v.latencyFrames === null || v.latencyFrames === undefined) assume('esc-latency', subject, 'The ESC acts on each command frame as it arrives; the card states no latency.');
        if (v.rampPerS === null || v.rampPerS === undefined) assume('esc-ramp', subject, 'The ESC output follows its command without a ramp limit; the card states none.');
        if (v.startDuty === null || v.startDuty === undefined) assume('esc-start-duty', subject, 'The ESC starts a stopped motor at any command above 0; the card states no start duty.');
        if (v.throttleSteps === null || v.throttleSteps === undefined) assume('esc-throttle-steps', subject, 'The ESC resolves its command without quantization; the card states no throttle steps.');
      }
      escValues = { pwmMinUs: ASSUMED_PWM_RANGE_US.min, pwmMaxUs: ASSUMED_PWM_RANGE_US.max, commandTauS: 1 / rate,
        updateRateHz: rate, brakeCurrentLimitA: v.maxCurrentA, ...(shaping ? { shaping } : {}) };
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
      // TASK-105: a motor heats only when its card knows all five thermal values.
      const heat = [v.windingHeatCapacityJPerK, v.housingHeatCapacityJPerK, v.windingToHousingKPerW, v.housingToAirKPerW, v.airflowCoolingPerMps];
      const known = heat.filter((x): x is number => x !== undefined && x !== null);
      const thermal = known.length === 5 ? { windingHeatCapacityJPerK: known[0]!, housingHeatCapacityJPerK: known[1]!, windingToHousingKPerW: known[2]!,
        housingToAirKPerW: known[3]!, airflowCoolingPerMps: known[4]! } : null;
      if (known.length > 0 && !thermal) {
        assume('motor-heat-incomplete', subject, `The motor does not heat: its card states ${known.length} of the five thermal values, and the network needs all five.`);
      }
      if (thermal) assume('motor-heat-20c', subject, 'The card\'s winding resistance, KV and no-load current are taken as their values at 20 °C, which the heat then scales.');
      if (v.resistanceOhm !== null && limit !== null) {
        motorValues = { kvRpmPerV: v.kvRpmPerV, resistanceOhm: v.resistanceOhm, currentLimitA: limit, noLoadCurrentA: v.noLoadCurrentA ?? 0,
          ...(thermal ? { thermal } : {}) };
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
        ...batteryDynamics(v, v.cellFullV, v.cellEmptyV, subject, assume),
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

/**
 * TASK-146 limit ratings from the cards a profile references, one entry per
 * motor in profile order, which is the derived manifest's rotor order. Only
 * stated card values become ratings, never assumed ones: a card that states
 * no value, or a card the profile has not chosen, gives null, which is never
 * checked. Component card schema 1 states no speed rating, so `rpm` is null.
 */
export function componentRatings(input: unknown, cards: ReadonlyMap<string, ComponentCard>): LimitRatings {
  const profile: AircraftProfile = validateAircraftProfile(input);
  checkProfileCards(profile, cards);
  // checkProfileCards established presence and type of every referenced card.
  const motors = profile.motors.map((motor): MotorRatings => {
    const m = motor.components.motor === null ? null : (cards.get(motor.components.motor) as MotorCard).values;
    const e = motor.components.esc === null ? null : (cards.get(motor.components.esc) as EscCard).values;
    return Object.freeze({ motorCurrentA: m?.maxCurrentA ?? null, motorPowerW: m?.maxPowerW ?? null,
      escCurrentA: e?.maxCurrentA ?? null, escVoltageV: e?.maxVoltageV ?? null, rpm: null });
  });
  const b = profile.battery.card === null ? null : (cards.get(profile.battery.card) as BatteryCard).values;
  const emptyVoltageV = b && b.cellEmptyV !== null ? b.cellsSeries * b.cellEmptyV : null;
  return Object.freeze({ schemaVersion: LIMIT_RATINGS_SCHEMA_VERSION, motors: Object.freeze(motors), battery: Object.freeze({ emptyVoltageV }) });
}

/**
 * TASK-104: the pack's dynamics when its card names an open-circuit curve, each unknown value's rule an assumption
 * (SPECS_SIMULATION_ENGINES "Battery v2": an unknown branch is absent, an unknown activation temperature or entropic
 * coefficient 0, unknown thermal values hold the temperature, unknown health a new pack).
 */
function batteryDynamics(v: BatteryCard['values'], cellFullV: number, cellEmptyV: number, subject: string,
  assume: (id: ComponentAssumptionId, subject: string, text: string) => void): { dynamics: BatteryDynamicsSpec } | Record<string, never> {
  const curve = v.openCircuitCurve ?? null;
  if (curve === null) return {};
  if (curve === 'chen-2006') {
    assume('pack-curve-chen-2006', subject, 'The open-circuit curve is the shape of Chen and Rincón-Mora\'s 850 mAh polymer Li-ion cell (2006), scaled onto the card\'s empty and full cell voltages: an approximation for another chemistry or window.');
  }
  const branches: { resistanceOhm: number; capacitanceF: number }[] = [];
  for (const [r, c, name] of [[v.rcFastResistanceOhm, v.rcFastCapacitanceF, 'fast'], [v.rcSlowResistanceOhm, v.rcSlowCapacitanceF, 'slow']] as const) {
    if (r !== undefined && r !== null && c !== undefined && c !== null) branches.push({ resistanceOhm: r, capacitanceF: c });
    else assume(`pack-no-${name}-branch`, subject, `The pack has no ${name} RC branch: the card does not state it.`);
  }
  const activation = v.resistanceActivationK ?? null, entropic = v.entropicCoefficientVPerK ?? null;
  if (activation === null) assume('pack-resistance-no-temperature', subject, 'The internal resistance does not change with temperature: the card states no activation temperature.');
  if (entropic === null) assume('pack-no-entropic', subject, 'The open-circuit voltage does not change with temperature and no reversible heat is made: the card states no entropic coefficient.');
  const heat = v.heatCapacityJPerK ?? null, still = v.stillAirConductanceWPerK ?? null, airflow = v.airflowConductanceWPerK ?? null;
  const thermal = heat !== null && still !== null && airflow !== null;
  if (!thermal) assume('pack-temperature-held', subject, 'The pack\'s temperature stays at the air\'s: the card does not state its heat capacity and both conductances.');
  const retention = v.capacityRetention ?? null, growth = v.resistanceGrowth ?? null;
  if (retention === null || growth === null) assume('pack-new', subject, 'The pack is taken as new where its card does not state its retained capacity or resistance growth.');
  return { dynamics: {
    openCircuitTableV: openCircuitTableV(curve, v.cellsSeries, cellEmptyV, cellFullV),
    branches, activationK: activation ?? 0, referenceK: 298.15,
    heatCapacityJPerK: thermal ? heat : 0, stillAirConductanceWPerK: thermal ? still : 0, airflowConductanceWPerK: thermal ? airflow : 0,
    entropicVPerK: entropic ?? 0, capacityRetention: retention ?? 1, resistanceGrowth: growth ?? 1,
  } };
}
