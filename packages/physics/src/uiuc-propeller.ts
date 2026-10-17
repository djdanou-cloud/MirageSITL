/** UIUC propeller database comparison for the steady BET plus axial momentum
 * closure (TASK-033). The fixture (tests/fixtures/rotors/uiuc-propellers.json)
 * holds the DA4002/DA4022 wind-tunnel tables exactly as printed, their measured
 * blade geometry and the published SDA1075 coordinates. The model side is
 * declared here and in docs/SPECS_SIMULATION_ENGINES.md before evaluation:
 *
 * - polar: thin-airfoil lift CL = 2*pi*(alpha - alpha0), alpha0 from the
 *   SDA1075 mean line; laminar flat-plate friction CD = 2*1.328/sqrt(Re)
 *   (Blasius, both surfaces). Attached flow is assumed only within
 *   alpha0 +- 10 deg and 1e3 <= Re <= 5e5; elements outside are flagged by
 *   the polar lookup and their points are not compared.
 * - blade: SDA1075 from r/R = 0.30 to the tip (28 equal strips, measured
 *   chord/twist linearly interpolated); the hub region is excluded.
 *
 * This module is pure: the BET itself runs in native Rust
 * (native/bet/examples/propeller_points.rs) through an injected runner.
 */
export type ComparisonStatus = "pass" | "failed" | "unvalidated";
export interface UiucRun {
  readonly source: string;
  readonly sha256: string;
  readonly rpm: number;
  /** Half of the last printed digit per column: J, CT, CP, eta. */
  readonly halfUnit: readonly [number, number, number, number];
  /** Rows [J, CT, CP, eta]. */
  readonly points: readonly (readonly [number, number, number, number])[];
}
export interface UiucStatic {
  readonly source: string;
  readonly sha256: string;
  /** Rows [RPM, CT, CP]. */
  readonly points: readonly (readonly [number, number, number])[];
}
export interface UiucPropeller {
  readonly id: string;
  readonly family: string;
  readonly airfoil: string;
  readonly bladeCount: number;
  readonly diameterM: number;
  readonly radiusRatio: readonly number[];
  readonly chordRatio: readonly number[];
  readonly betaDeg: readonly number[];
  readonly static: UiucStatic | null;
  readonly runs: readonly UiucRun[];
}
export interface UiucComparison {
  readonly ctRelativeTolerance: number;
  readonly ctAbsoluteTolerance: number;
  readonly cpRelativeTolerance: number;
  readonly cpAbsoluteTolerance: number;
  readonly airfoilStartRadiusRatio: number;
  readonly densityKgM3: number;
  readonly viscosityPaS: number;
  readonly soundSpeedMps: number;
}
export interface UiucAudit {
  readonly points: number;
  readonly applicable: number;
  readonly etaInconsistent: number;
  readonly aboveFroudeBound: number;
}
export interface UiucFixture {
  readonly id: string;
  readonly datasetId: string;
  readonly referenceUrl: string;
  readonly etaReductionAllowance: number;
  readonly comparison: UiucComparison;
  readonly audit: UiucAudit;
  /** SDA1075 coordinates [x/c, y/c]: upper TE->LE, then lower LE->TE. */
  readonly airfoilCoordinates: readonly (readonly [number, number])[];
  readonly propellers: readonly UiucPropeller[];
}
export interface PolarTableData {
  readonly alphaRad: readonly number[];
  readonly reynolds: readonly number[];
  readonly mach: readonly number[];
  /** Index (iMach * nRe + iRe) * nAlpha + iAlpha. */
  readonly cl: readonly number[];
  readonly cd: readonly number[];
}
export interface BladeStations {
  readonly radiusM: number;
  readonly cutoutM: number;
  readonly stationM: readonly number[];
  readonly chordM: readonly number[];
  readonly twistRad: readonly number[];
  readonly widthM: readonly number[];
}
export interface BetPrediction {
  readonly ok: boolean;
  readonly ct: number;
  readonly cp: number;
  readonly polarFlags: number;
  readonly outsideMomentumValidity: boolean;
}
export type PointClass = "pass" | "failed" | "outsidePolar" | "outsideMomentum" | "error";
export interface PointResult {
  readonly propellerId: string;
  readonly source: string;
  readonly rpm: number;
  readonly advanceRatio: number;
  readonly measuredCt: number;
  readonly measuredCp: number;
  readonly predictedCt: number | null;
  readonly predictedCp: number | null;
  /** Per-coefficient tolerance checks; null when the point is not compared. */
  readonly ctWithinTolerance: boolean | null;
  readonly cpWithinTolerance: boolean | null;
  readonly result: PointClass;
}
export interface PropellerSummary {
  readonly id: string;
  readonly bladeCount: number;
  readonly diameterM: number;
  readonly points: number;
  readonly compared: number;
  readonly passed: number;
  /** Compared points meeting each coefficient tolerance separately (diagnostic). */
  readonly ctWithinTolerance: number;
  readonly cpWithinTolerance: number;
  readonly outsidePolar: number;
  readonly outsideMomentum: number;
  readonly errors: number;
  /** Over compared points; null when none were compared. */
  readonly maxAbsCtError: number | null;
  readonly maxAbsCpError: number | null;
  readonly meanCtError: number | null;
  readonly meanCpError: number | null;
  readonly status: ComparisonStatus;
}
export interface UiucEvaluation {
  readonly consistencyStatus: "pass" | "failed";
  readonly audit: UiucAudit;
  readonly status: ComparisonStatus;
  readonly polar: {
    readonly kind: "thin-airfoil-laminar-friction";
    readonly airfoil: "SDA1075";
    readonly zeroLiftAlphaRad: number;
    readonly liftSlopePerRad: number;
    readonly alphaRangeRad: readonly [number, number];
    readonly reynoldsRange: readonly [number, number];
  };
  readonly tolerance: {
    readonly ctRelative: number;
    readonly ctAbsolute: number;
    readonly cpRelative: number;
    readonly cpAbsolute: number;
  };
  readonly totals: {
    readonly points: number;
    readonly compared: number;
    readonly passed: number;
    readonly ctWithinTolerance: number;
    readonly cpWithinTolerance: number;
    readonly outsidePolar: number;
    readonly outsideMomentum: number;
    readonly errors: number;
  };
  readonly propellers: readonly PropellerSummary[];
  readonly points: readonly PointResult[];
}

/** Declared attached-flow half range about alpha0 for the thin-airfoil polar. */
export const ATTACHED_HALF_RANGE_RAD = (10 * Math.PI) / 180;
/** Laminar boundary-layer range: Blasius friction, below flat-plate transition. */
export const POLAR_REYNOLDS_RANGE: readonly [number, number] = [1e3, 5e5];
export const BLADE_STRIPS = 28;
export const AZIMUTH_SAMPLES = 8;
const MAX_PROPELLERS = 64;
const MAX_ROWS = 256;

function fail(path: string): never {
  throw new Error(`Invalid UIUC propeller fixture: ${path}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function get(value: unknown, key: string, path: string): unknown {
  if (!record(value) || !Object.hasOwn(value, key)) fail(`${path}.${key}`);
  return value[key];
}
function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path);
  return value;
}
function positive(value: unknown, path: string): number {
  const v = finite(value, path);
  if (v <= 0) fail(path);
  return v;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) fail(path);
  return value;
}
function sha256(value: unknown, path: string): string {
  const v = text(value, path);
  if (!/^[a-f0-9]{64}$/.test(v)) fail(path);
  return v;
}
function count(value: unknown, path: string): number {
  const v = finite(value, path);
  if (!Number.isInteger(v) || v < 0) fail(path);
  return v;
}
function numbers(value: unknown, path: string, length?: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS) fail(path);
  if (length !== undefined && value.length !== length) fail(path);
  return value.map((v: unknown, i) => finite(v, `${path}[${i}]`));
}
function rows<N extends number>(value: unknown, width: N, path: string): number[][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS) fail(path);
  return value.map((row: unknown, i) => numbers(row, `${path}[${i}]`, width));
}
function tuple4(v: number[], path: string): [number, number, number, number] {
  const [a, b, c, d] = v;
  if (a === undefined || b === undefined || c === undefined || d === undefined || v.length !== 4) fail(path);
  return [a, b, c, d];
}
function tuple3(v: number[], path: string): [number, number, number] {
  const [a, b, c] = v;
  if (a === undefined || b === undefined || c === undefined || v.length !== 3) fail(path);
  return [a, b, c];
}

function parseRun(value: unknown, path: string): UiucRun {
  const halfUnit = tuple4(numbers(get(value, "halfUnit", path), `${path}.halfUnit`, 4), `${path}.halfUnit`);
  if (halfUnit.some((h) => h <= 0 || h > 0.5)) fail(`${path}.halfUnit`);
  const points = rows(get(value, "points", path), 4, `${path}.points`).map((r, i) => {
    const t = tuple4(r, `${path}.points[${i}]`);
    if (t[0] < 0) fail(`${path}.points[${i}]`);
    return t;
  });
  const rpm = positive(get(value, "rpm", path), `${path}.rpm`);
  return { source: text(get(value, "source", path), `${path}.source`), sha256: sha256(get(value, "sha256", path), `${path}.sha256`), rpm, halfUnit, points };
}

/** Validates an untrusted fixture payload into the comparison domain. */
export function parseUiucPropellerFixture(value: unknown): UiucFixture {
  if (get(value, "schemaVersion", "fixture") !== 1) fail("schemaVersion");
  const referenceUrl = text(get(value, "referenceUrl", "fixture"), "referenceUrl");
  if (!referenceUrl.startsWith("https://")) fail("referenceUrl");
  const c = get(value, "comparison", "fixture");
  const comparison: UiucComparison = {
    ctRelativeTolerance: positive(get(c, "ctRelativeTolerance", "comparison"), "comparison.ctRelativeTolerance"),
    ctAbsoluteTolerance: positive(get(c, "ctAbsoluteTolerance", "comparison"), "comparison.ctAbsoluteTolerance"),
    cpRelativeTolerance: positive(get(c, "cpRelativeTolerance", "comparison"), "comparison.cpRelativeTolerance"),
    cpAbsoluteTolerance: positive(get(c, "cpAbsoluteTolerance", "comparison"), "comparison.cpAbsoluteTolerance"),
    airfoilStartRadiusRatio: positive(get(c, "airfoilStartRadiusRatio", "comparison"), "comparison.airfoilStartRadiusRatio"),
    densityKgM3: positive(get(c, "densityKgM3", "comparison"), "comparison.densityKgM3"),
    viscosityPaS: positive(get(c, "viscosityPaS", "comparison"), "comparison.viscosityPaS"),
    soundSpeedMps: positive(get(c, "soundSpeedMps", "comparison"), "comparison.soundSpeedMps"),
  };
  if (comparison.airfoilStartRadiusRatio >= 1) fail("comparison.airfoilStartRadiusRatio");
  const a = get(value, "audit", "fixture");
  const audit: UiucAudit = {
    points: count(get(a, "points", "audit"), "audit.points"),
    applicable: count(get(a, "applicable", "audit"), "audit.applicable"),
    etaInconsistent: count(get(a, "etaInconsistent", "audit"), "audit.etaInconsistent"),
    aboveFroudeBound: count(get(a, "aboveFroudeBound", "audit"), "audit.aboveFroudeBound"),
  };
  const airfoil = get(get(value, "airfoils", "fixture"), "SDA1075", "airfoils");
  const airfoilCoordinates = rows(get(airfoil, "coordinates", "airfoils.SDA1075"), 2, "airfoils.SDA1075.coordinates").map(
    ([x, y], i) => {
      if (x === undefined || y === undefined || x < -1e-3 || x > 1.001 || Math.abs(y) > 0.5) fail(`airfoils.SDA1075.coordinates[${i}]`);
      return [x, y] as const;
    },
  );
  const list = get(value, "propellers", "fixture");
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROPELLERS) fail("propellers");
  const ids = new Set<string>();
  const propellers = list.map((p: unknown, i): UiucPropeller => {
    const path = `propellers[${i}]`;
    const id = text(get(p, "id", path), `${path}.id`);
    if (!/^[a-z0-9.-]{1,64}$/.test(id) || ids.has(id)) fail(`${path}.id`);
    ids.add(id);
    if (get(p, "airfoil", path) !== "SDA1075") fail(`${path}.airfoil`);
    const bladeCount = count(get(p, "bladeCount", path), `${path}.bladeCount`);
    if (bladeCount < 1 || bladeCount > 16) fail(`${path}.bladeCount`);
    const g = get(p, "geometry", path);
    const radiusRatio = numbers(get(g, "radiusRatio", `${path}.geometry`), `${path}.geometry.radiusRatio`);
    const chordRatio = numbers(get(g, "chordRatio", `${path}.geometry`), `${path}.geometry.chordRatio`, radiusRatio.length);
    const betaDeg = numbers(get(g, "betaDeg", `${path}.geometry`), `${path}.geometry.betaDeg`, radiusRatio.length);
    sha256(get(g, "sha256", `${path}.geometry`), `${path}.geometry.sha256`);
    for (let k = 0; k < radiusRatio.length; k++) {
      const r = radiusRatio[k] ?? NaN, prev = k > 0 ? (radiusRatio[k - 1] ?? NaN) : 0;
      if (!(r > prev) || r > 1 || !((chordRatio[k] ?? NaN) > 0) || Math.abs(betaDeg[k] ?? NaN) > 90) fail(`${path}.geometry[${k}]`);
    }
    if (radiusRatio[radiusRatio.length - 1] !== 1 || (radiusRatio[0] ?? 1) > comparison.airfoilStartRadiusRatio) fail(`${path}.geometry.span`);
    const runsValue = get(p, "runs", path);
    if (!Array.isArray(runsValue) || runsValue.length === 0 || runsValue.length > 32) fail(`${path}.runs`);
    const runs = runsValue.map((r: unknown, j) => parseRun(r, `${path}.runs[${j}]`));
    const s = get(p, "static", path);
    const staticTable = s === null ? null : {
      source: text(get(s, "source", `${path}.static`), `${path}.static.source`),
      sha256: sha256(get(s, "sha256", `${path}.static`), `${path}.static.sha256`),
      points: rows(get(s, "points", `${path}.static`), 3, `${path}.static.points`).map((r, k) => {
        const t = tuple3(r, `${path}.static.points[${k}]`);
        if (!(t[0] > 0)) fail(`${path}.static.points[${k}]`);
        return t;
      }),
    };
    return {
      id,
      family: text(get(p, "family", path), `${path}.family`),
      airfoil: "SDA1075",
      bladeCount,
      diameterM: positive(get(p, "diameterM", path), `${path}.diameterM`),
      radiusRatio,
      chordRatio,
      betaDeg,
      static: staticTable,
      runs,
    };
  });
  return {
    id: text(get(value, "id", "fixture"), "id"),
    datasetId: text(get(value, "datasetId", "fixture"), "datasetId"),
    referenceUrl,
    etaReductionAllowance: positive(get(value, "etaReductionAllowance", "fixture"), "etaReductionAllowance"),
    comparison,
    audit,
    airfoilCoordinates,
    propellers,
  };
}

/** Dataset-only oracles: printed eta versus J*CT/CP within rounding plus the
 * per-sample reduction allowance, and eta below the actuator-disk (Froude)
 * ideal for J > 0, CT > 0. Independent of the BET. */
export function auditUiucFixture(fixture: UiucFixture): UiucAudit {
  let points = 0, applicable = 0, etaInconsistent = 0, aboveFroudeBound = 0;
  for (const p of fixture.propellers)
    for (const run of p.runs)
      for (const [j, ct, cp, eta] of run.points) {
        points++;
        if (j <= 0 || ct <= 0 || cp <= 0) continue;
        applicable++;
        const [hj, hct, hcp, heta] = run.halfUnit;
        const ratio = (j * ct) / cp;
        const bound = heta + ratio * (hj / j + hct / ct + hcp / cp) + fixture.etaReductionAllowance;
        if (Math.abs(ratio - eta) > bound) etaInconsistent++;
        const ideal = 2 / (1 + Math.sqrt(1 + (8 * ct) / (Math.PI * j * j)));
        if (eta > ideal + heta) aboveFroudeBound++;
      }
  return { points, applicable, etaInconsistent, aboveFroudeBound };
}

function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  for (let i = 0; i + 1 < n; i++) {
    const x0 = xs[i] ?? NaN, x1 = xs[i + 1] ?? NaN;
    if (x <= x1 || i + 2 === n) {
      const t = (x - x0) / (x1 - x0);
      return (ys[i] ?? NaN) + t * ((ys[i + 1] ?? NaN) - (ys[i] ?? NaN));
    }
  }
  return ys[0] ?? NaN;
}

/** Thin-airfoil zero-lift angle, rad:
 * alpha0 = -(1/pi) * integral_0^pi (dz/dx)(cos(theta) - 1) dtheta,
 * x = (1 - cos(theta))/2. The mean line z is the average of the upper and
 * lower surfaces, each linearly interpolated in x; dz/dx is constant per
 * theta panel, whose weight integral_a^b (cos - 1) is exact. */
export function thinAirfoilZeroLiftRad(coordinates: readonly (readonly [number, number])[], panels = 400): number {
  let le = 0;
  for (let i = 1; i < coordinates.length; i++) if ((coordinates[i]?.[0] ?? Infinity) < (coordinates[le]?.[0] ?? Infinity)) le = i;
  const upper = coordinates.slice(0, le + 1).reverse(), lower = coordinates.slice(le);
  if (upper.length < 3 || lower.length < 3) throw new Error("Airfoil needs upper and lower surfaces");
  const ux = upper.map((p) => p[0]), uy = upper.map((p) => p[1]);
  const lx = lower.map((p) => p[0]), ly = lower.map((p) => p[1]);
  for (const xs of [ux, lx]) for (let i = 1; i < xs.length; i++) if (!((xs[i] ?? NaN) > (xs[i - 1] ?? NaN))) throw new Error("Airfoil surface x must increase from the leading edge");
  const x0 = Math.max(ux[0] ?? NaN, lx[0] ?? NaN), x1 = Math.min(ux[ux.length - 1] ?? NaN, lx[lx.length - 1] ?? NaN);
  const camber = (theta: number): [number, number] => {
    const x = x0 + ((x1 - x0) * (1 - Math.cos(theta))) / 2;
    return [x, (interpolate(ux, uy, x) + interpolate(lx, ly, x)) / 2];
  };
  let integral = 0;
  for (let k = 0; k < panels; k++) {
    const a = (Math.PI * k) / panels, b = (Math.PI * (k + 1)) / panels;
    const [xa, za] = camber(a), [xb, zb] = camber(b);
    integral += ((zb - za) / (xb - xa)) * (Math.sin(b) - Math.sin(a) - (b - a));
  }
  return -integral / Math.PI;
}

/** Thin-airfoil lift and Blasius laminar friction over the declared envelope. */
export function thinAirfoilPolar(zeroLiftRad: number): PolarTableData {
  const alphaRad: number[] = [];
  for (let k = -10; k <= 10; k++) alphaRad.push(zeroLiftRad + (k * ATTACHED_HALF_RANGE_RAD) / 10);
  const reynolds: number[] = [];
  const [reLow, reHigh] = POLAR_REYNOLDS_RANGE;
  const decades = Math.log10(reHigh / reLow);
  for (let k = 0; k <= 16; k++) reynolds.push(reLow * 10 ** ((decades * k) / 16));
  const mach = [0, 0.3];
  const cl: number[] = [], cd: number[] = [];
  for (let m = 0; m < mach.length; m++)
    for (const re of reynolds)
      for (const alpha of alphaRad) {
        cl.push(2 * Math.PI * (alpha - zeroLiftRad));
        cd.push((2 * 1.328) / Math.sqrt(re));
      }
  return { alphaRad, reynolds, mach, cl, cd };
}

/** Midpoint strips over [start, 1] R with linearly interpolated measured chord/twist. */
export function bladeStations(p: UiucPropeller, startRadiusRatio: number, strips = BLADE_STRIPS): BladeStations {
  const radiusM = p.diameterM / 2, cutoutM = startRadiusRatio * radiusM;
  const width = (radiusM - cutoutM) / strips;
  const stationM: number[] = [], chordM: number[] = [], twistRad: number[] = [], widthM: number[] = [];
  for (let k = 0; k < strips; k++) {
    const ratio = startRadiusRatio + ((k + 0.5) * (1 - startRadiusRatio)) / strips;
    stationM.push(ratio * radiusM);
    chordM.push(interpolate(p.radiusRatio, p.chordRatio, ratio) * radiusM);
    twistRad.push((interpolate(p.radiusRatio, p.betaDeg, ratio) * Math.PI) / 180);
    widthM.push(width);
  }
  return { radiusM, cutoutM, stationM, chordM, twistRad, widthM };
}

interface QueuedPoint {
  readonly propeller: UiucPropeller;
  readonly source: string;
  readonly rpm: number;
  readonly j: number;
  readonly ct: number;
  readonly cp: number;
}
function queue(fixture: UiucFixture): QueuedPoint[] {
  const out: QueuedPoint[] = [];
  for (const p of fixture.propellers) {
    for (const run of p.runs)
      for (const [j, ct, cp] of run.points) out.push({ propeller: p, source: run.source, rpm: run.rpm, j, ct, cp });
    if (p.static) for (const [rpm, ct, cp] of p.static.points) out.push({ propeller: p, source: p.static.source, rpm, j: 0, ct, cp });
  }
  return out;
}
const line = (values: readonly number[]): string => values.map((v) => String(v)).join(" ");

/** Line protocol consumed by native/bet/examples/propeller_points.rs. */
export function betRequest(fixture: UiucFixture, polar: PolarTableData): string {
  const c = fixture.comparison;
  const parts = [
    `polar ${polar.alphaRad.length} ${polar.reynolds.length} ${polar.mach.length}`,
    line(polar.alphaRad), line(polar.reynolds), line(polar.mach), line(polar.cl), line(polar.cd),
  ];
  let current: UiucPropeller | null = null;
  for (const q of queue(fixture)) {
    if (q.propeller !== current) {
      current = q.propeller;
      const s = bladeStations(current, c.airfoilStartRadiusRatio);
      parts.push(`rotor ${current.bladeCount} ${s.radiusM} ${s.cutoutM} ${s.stationM.length} ${AZIMUTH_SAMPLES}`,
        line(s.stationM), line(s.chordM), line(s.twistRad), line(s.widthM));
    }
    parts.push(`point ${q.rpm} ${q.j} ${c.densityKgM3} ${c.viscosityPaS} ${c.soundSpeedMps}`);
  }
  return parts.join("\n") + "\n";
}

/** Parses the runner output: one line per queued point. */
export function parseBetResponse(output: string, expected: number): BetPrediction[] {
  const lines = output.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length !== expected) throw new Error(`BET runner returned ${lines.length} of ${expected} points`);
  return lines.map((l) => {
    if (l === "err") return { ok: false, ct: NaN, cp: NaN, polarFlags: 0, outsideMomentumValidity: false };
    const t = l.split(" ");
    if (t.length !== 8 || t[0] !== "ok") throw new Error(`Malformed BET runner line: ${l}`);
    const ct = Number(t[1]), cp = Number(t[2]), flags = Number(t[6]);
    if (!Number.isFinite(ct) || !Number.isFinite(cp) || !Number.isInteger(flags) || flags < 0 || !["0", "1"].includes(t[7] ?? ""))
      throw new Error(`Malformed BET runner line: ${l}`);
    return { ok: true, ct, cp, polarFlags: flags, outsideMomentumValidity: t[7] === "1" };
  });
}

function classify(q: QueuedPoint, p: BetPrediction, c: UiucComparison): [PointClass, boolean | null, boolean | null] {
  if (!p.ok) return ["error", null, null];
  if (p.outsideMomentumValidity) return ["outsideMomentum", null, null];
  if (p.polarFlags !== 0) return ["outsidePolar", null, null];
  const ctOk = Math.abs(p.ct - q.ct) <= Math.max(c.ctRelativeTolerance * Math.abs(q.ct), c.ctAbsoluteTolerance);
  const cpOk = Math.abs(p.cp - q.cp) <= Math.max(c.cpRelativeTolerance * Math.abs(q.cp), c.cpAbsoluteTolerance);
  return [ctOk && cpOk ? "pass" : "failed", ctOk, cpOk];
}
function status(compared: number, failed: number): ComparisonStatus {
  return failed > 0 ? "failed" : compared > 0 ? "pass" : "unvalidated";
}

/** Runs the declared comparison. `runBet` maps the request text to the runner's stdout. */
export function evaluateUiucPropellers(fixture: UiucFixture, runBet: (request: string) => string): UiucEvaluation {
  const audit = auditUiucFixture(fixture);
  const consistent = audit.etaInconsistent === 0 && audit.aboveFroudeBound === 0 &&
    audit.points === fixture.audit.points && audit.applicable === fixture.audit.applicable &&
    audit.etaInconsistent === fixture.audit.etaInconsistent && audit.aboveFroudeBound === fixture.audit.aboveFroudeBound;
  const zeroLiftAlphaRad = thinAirfoilZeroLiftRad(fixture.airfoilCoordinates);
  const polar = thinAirfoilPolar(zeroLiftAlphaRad);
  const queued = queue(fixture);
  const predictions = parseBetResponse(runBet(betRequest(fixture, polar)), queued.length);
  const points: PointResult[] = queued.map((q, i) => {
    const p = predictions[i];
    if (p === undefined) throw new Error("Missing BET prediction");
    const [result, ctWithinTolerance, cpWithinTolerance] = classify(q, p, fixture.comparison);
    return {
      propellerId: q.propeller.id, source: q.source, rpm: q.rpm, advanceRatio: q.j,
      measuredCt: q.ct, measuredCp: q.cp,
      predictedCt: p.ok ? p.ct : null, predictedCp: p.ok ? p.cp : null,
      ctWithinTolerance, cpWithinTolerance, result,
    };
  });
  const propellers = fixture.propellers.map((prop): PropellerSummary => {
    const mine = points.filter((p) => p.propellerId === prop.id);
    const compared = mine.filter((p) => p.result === "pass" || p.result === "failed");
    const ctErr = compared.map((p) => (p.predictedCt ?? NaN) - p.measuredCt);
    const cpErr = compared.map((p) => (p.predictedCp ?? NaN) - p.measuredCp);
    const n = (k: PointClass) => mine.filter((p) => p.result === k).length;
    const maxAbs = (e: number[]) => (e.length ? Math.max(...e.map(Math.abs)) : null);
    const mean = (e: number[]) => (e.length ? e.reduce((s, v) => s + v, 0) / e.length : null);
    return {
      id: prop.id, bladeCount: prop.bladeCount, diameterM: prop.diameterM,
      points: mine.length, compared: compared.length, passed: n("pass"),
      ctWithinTolerance: compared.filter((p) => p.ctWithinTolerance === true).length,
      cpWithinTolerance: compared.filter((p) => p.cpWithinTolerance === true).length,
      outsidePolar: n("outsidePolar"), outsideMomentum: n("outsideMomentum"), errors: n("error"),
      maxAbsCtError: maxAbs(ctErr), maxAbsCpError: maxAbs(cpErr), meanCtError: mean(ctErr), meanCpError: mean(cpErr),
      status: status(compared.length, n("failed") + n("error")),
    };
  });
  const total = (k: PointClass) => points.filter((p) => p.result === k).length;
  const comparedTotal = total("pass") + total("failed");
  return {
    consistencyStatus: consistent ? "pass" : "failed",
    audit,
    status: status(comparedTotal, total("failed") + total("error")),
    polar: {
      kind: "thin-airfoil-laminar-friction",
      airfoil: "SDA1075",
      zeroLiftAlphaRad,
      liftSlopePerRad: 2 * Math.PI,
      alphaRangeRad: [zeroLiftAlphaRad - ATTACHED_HALF_RANGE_RAD, zeroLiftAlphaRad + ATTACHED_HALF_RANGE_RAD],
      reynoldsRange: POLAR_REYNOLDS_RANGE,
    },
    tolerance: {
      ctRelative: fixture.comparison.ctRelativeTolerance,
      ctAbsolute: fixture.comparison.ctAbsoluteTolerance,
      cpRelative: fixture.comparison.cpRelativeTolerance,
      cpAbsolute: fixture.comparison.cpAbsoluteTolerance,
    },
    totals: {
      points: points.length, compared: comparedTotal, passed: total("pass"),
      ctWithinTolerance: points.filter((p) => p.ctWithinTolerance === true).length,
      cpWithinTolerance: points.filter((p) => p.cpWithinTolerance === true).length,
      outsidePolar: total("outsidePolar"), outsideMomentum: total("outsideMomentum"), errors: total("error"),
    },
    propellers,
    points,
  };
}
