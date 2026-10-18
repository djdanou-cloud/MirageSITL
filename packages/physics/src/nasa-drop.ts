import { newBodyTruth } from "@mirage/wasm-bet/backend";
import { LegacyGroundContact as GroundContact } from "./legacy-ground-contact.ts";
/** NASA TM X-3561 level-surface drop comparison for the Rapier contact backend.
 * The fixture (tests/fixtures/contact/nasa-drop.json) holds measured rig values
 * converted to SI. The adapter is a rigid sphere on a plane: the lumped drop
 * mass falls onto the unloaded tire radius with the honeycomb lift force
 * applied while descending (the report: the honeycomb is "on" while crushing
 * and drops to zero at rebound). It has no tire or strut compliance, so the
 * measured stroke and deceleration envelopes are reported, not assumed.
 */
export type CheckStatus = "pass" | "failed";
export interface NasaDropCase {
  readonly id: string;
  readonly sinkRateMps: number;
  readonly maxStrutStrokeM: number;
  readonly minUpperMassAccelerationDownMps2: number;
}
export interface NasaDropAcceptance {
  readonly relativeTolerance: number;
  readonly penetrationToleranceM: number;
  readonly impulseRelativeTolerance: number;
  readonly decelerationWindowS: number;
}
export interface NasaDropFixture {
  readonly id: string;
  readonly datasetId: string;
  readonly referenceUrl: string;
  readonly massKg: number;
  readonly tireRadiusM: number;
  readonly liftForceN: number;
  readonly cases: readonly NasaDropCase[];
  readonly acceptance: NasaDropAcceptance;
}
export interface NasaDropRun {
  readonly caseId: string;
  readonly hz: 400 | 800 | 1200;
  readonly sinkRateMps: number;
  /** Most negative per-step kinematic acceleration, NED down positive. */
  readonly peakAccelerationDownMps2: number;
  /** Same, averaged over decelerationWindowS (matches the 100 Hz instrument bandwidth). */
  readonly windowedPeakAccelerationDownMps2: number;
  readonly measuredMinAccelerationDownMps2: number;
  readonly maxPenetrationM: number;
  readonly measuredMaxStrutStrokeM: number;
  readonly arrestImpulseNs: number;
  readonly sinkMomentumNs: number;
  readonly impulseBalanceErrorNs: number;
  readonly reboundSpeedMps: number;
  readonly checks: {
    readonly impulse: CheckStatus;
    readonly nonpenetration: CheckStatus;
    readonly energy: CheckStatus;
    readonly decelerationEnvelope: CheckStatus;
    readonly strokeEnvelope: CheckStatus;
  };
}
export interface NasaDropReport {
  readonly id: string;
  readonly datasetId: string;
  readonly referenceUrl: string;
  /** Impulse, nonpenetration and energy checks of the solver itself. */
  readonly consistencyStatus: CheckStatus;
  /** Comparison with the measured envelopes. */
  readonly measuredStatus: CheckStatus;
  readonly runs: readonly NasaDropRun[];
}
const G0 = 9.80665;
const RATES = [400, 800, 1200] as const;
const DURATION_S = 0.3;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!record(current) || !Object.hasOwn(current, key))
      throw new Error(`Invalid NASA drop fixture: missing ${path.join(".")}`);
    current = current[key];
  }
  return current;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Invalid NASA drop fixture: ${path}`);
  return value;
}
function si(value: unknown, unit: string, ...path: string[]): number {
  const name = path.join(".");
  if (field(value, ...path, "unit") !== unit)
    throw new Error(`Invalid NASA drop fixture unit: ${name}`);
  return finite(field(value, ...path, "value"), name);
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new Error(`Invalid NASA drop fixture: ${path}`);
  return value;
}
/** Validates the generated payload; extra explanatory fields are permitted. */
export function parseNasaDropFixture(value: unknown): NasaDropFixture {
  if (field(value, "formatVersion") !== 1)
    throw new Error("Invalid NASA drop fixture: formatVersion");
  const referenceUrl = text(field(value, "source", "referenceUrl"), "referenceUrl");
  if (!referenceUrl.startsWith("https://ntrs.nasa.gov/"))
    throw new Error("Invalid NASA drop fixture: referenceUrl");
  const rawCases = field(value, "cases");
  if (!Array.isArray(rawCases) || rawCases.length < 1 || rawCases.length > 8)
    throw new Error("Invalid NASA drop fixture: cases");
  const list: readonly unknown[] = rawCases;
  const cases: NasaDropCase[] = [];
  for (const item of list) {
    if (finite(field(item, "surfaceInclinationRad"), "surfaceInclinationRad") !== 0)
      throw new Error("Invalid NASA drop fixture: only level-surface drops are supported");
    cases.push({
      id: text(field(item, "id"), "case id"),
      sinkRateMps: si(item, "m/s", "sinkRateMps"),
      maxStrutStrokeM: si(item, "m", "measured", "maxStrutStrokeM"),
      minUpperMassAccelerationDownMps2: si(item, "m/s^2", "measured", "minUpperMassAccelerationDownMps2"),
    });
  }
  const acceptance: NasaDropAcceptance = {
    relativeTolerance: finite(field(value, "acceptance", "relativeTolerance"), "relativeTolerance"),
    penetrationToleranceM: finite(field(value, "acceptance", "penetrationToleranceM"), "penetrationToleranceM"),
    impulseRelativeTolerance: finite(field(value, "acceptance", "impulseRelativeTolerance"), "impulseRelativeTolerance"),
    decelerationWindowS: finite(field(value, "acceptance", "decelerationWindowS"), "decelerationWindowS"),
  };
  const fixture: NasaDropFixture = {
    id: text(field(value, "id"), "id"),
    datasetId: text(field(value, "datasetId"), "datasetId"),
    referenceUrl,
    massKg: si(value, "kg", "rig", "dropMassKg"),
    tireRadiusM: si(value, "m", "rig", "tireUnloadedRadiusM"),
    liftForceN: si(value, "N", "rig", "honeycombCrushForceN"),
    cases,
    acceptance,
  };
  if (
    fixture.massKg <= 0 ||
    fixture.tireRadiusM <= 0 ||
    fixture.liftForceN < 0 ||
    cases.some((c) => c.sinkRateMps <= 0 || c.maxStrutStrokeM <= 0 || c.minUpperMassAccelerationDownMps2 >= 0) ||
    Object.values(acceptance).some((x) => x < 0) ||
    acceptance.decelerationWindowS <= 0
  )
    throw new Error("Invalid NASA drop fixture bounds");
  return fixture;
}
function status(ok: boolean): CheckStatus {
  return ok ? "pass" : "failed";
}
export async function runNasaDrop(
  fixture: NasaDropFixture,
  drop: NasaDropCase,
  hz: 400 | 800 | 1200,
): Promise<NasaDropRun> {
  const dt = 1 / hz,
    m = fixture.massKg,
    r = fixture.tireRadiusM,
    v0 = drop.sinkRateMps,
    restitution = 0,
    steps = Math.round(DURATION_S * hz),
    window = Math.max(1, Math.round(fixture.acceptance.decelerationWindowS * hz)),
    history = new Float64Array(window + 1),
    truth = newBodyTruth(),
    wrench = new Float64Array(6),
    impulse = { pointBody: new Float64Array(3), impulseNed: new Float64Array(3), dt: 0 };
  truth.positionNedM[2] = -r;
  truth.velocityNedMps[2] = v0;
  const contact = await GroundContact.create(truth, m, r, restitution, 0.7);
  let peak = 0,
    windowed = 0,
    penetration = 0,
    arrest = 0,
    arrested = false,
    balance = 0,
    rebound = 0,
    previous = v0;
  history[0] = v0;
  try {
    for (let i = 1; i <= steps; i++) {
      // Body FRD equals NED at identity attitude: lift acts up (-z) while crushing.
      const lift = previous > 0 ? fixture.liftForceN : 0;
      wrench[2] = -lift;
      if (!contact.stepInto(wrench, dt, truth)) throw new Error("NASA drop step rejected");
      contact.impulseInto(impulse);
      const v = truth.velocityNedMps[2],
        contactImpulse = impulse.impulseNed[2]!,
        // Independent momentum balance from the forces this harness applied.
        expected = m * (v - previous) - (m * G0 - lift) * dt;
      balance += contactImpulse - expected;
      if (!arrested) {
        arrest -= contactImpulse;
        if (v <= 0) arrested = true;
      } else rebound = Math.max(rebound, -v);
      peak = Math.min(peak, truth.accelerationNedMps2[2]!);
      penetration = Math.max(penetration, truth.positionNedM[2] + r);
      history[i % (window + 1)] = v;
      if (i >= window)
        windowed = Math.min(windowed, (v - history[(i - window) % (window + 1)]!) / (window * dt));
      previous = v;
    }
  } finally {
    contact.dispose();
  }
  const a = fixture.acceptance,
    momentum = m * v0,
    bound = drop.minUpperMassAccelerationDownMps2 * (1 + a.relativeTolerance);
  return {
    caseId: drop.id,
    hz,
    sinkRateMps: v0,
    peakAccelerationDownMps2: peak,
    windowedPeakAccelerationDownMps2: windowed,
    measuredMinAccelerationDownMps2: drop.minUpperMassAccelerationDownMps2,
    maxPenetrationM: penetration,
    measuredMaxStrutStrokeM: drop.maxStrutStrokeM,
    arrestImpulseNs: arrest,
    sinkMomentumNs: momentum,
    impulseBalanceErrorNs: balance,
    reboundSpeedMps: rebound,
    checks: {
      // Reported contact impulse balances the momentum change and applied forces,
      // and the compression impulse arrests the sink momentum (lift roughly cancels weight).
      impulse: status(
        arrested &&
          Math.abs(balance) <= a.impulseRelativeTolerance * momentum &&
          Math.abs(arrest - momentum) <= a.relativeTolerance * momentum,
      ),
      nonpenetration: status(penetration <= a.penetrationToleranceM),
      // Restitution must not add energy: rebound speed stays within e * v0.
      energy: status(arrested && rebound <= (restitution + a.impulseRelativeTolerance) * v0),
      decelerationEnvelope: status(peak >= bound && windowed >= bound),
      strokeEnvelope: status(
        Math.abs(penetration - drop.maxStrutStrokeM) <= a.relativeTolerance * drop.maxStrutStrokeM,
      ),
    },
  };
}
export async function evaluateNasaDrop(fixture: NasaDropFixture): Promise<NasaDropReport> {
  const runs: NasaDropRun[] = [];
  for (const drop of fixture.cases)
    for (const hz of RATES) runs.push(await runNasaDrop(fixture, drop, hz));
  const consistent = runs.every(
      (run) => run.checks.impulse === "pass" && run.checks.nonpenetration === "pass" && run.checks.energy === "pass",
    ),
    measured = runs.every(
      (run) => run.checks.decelerationEnvelope === "pass" && run.checks.strokeEnvelope === "pass",
    );
  return {
    id: fixture.id,
    datasetId: fixture.datasetId,
    referenceUrl: fixture.referenceUrl,
    consistencyStatus: status(consistent),
    measuredStatus: status(consistent && measured),
    runs,
  };
}
