/**
 * Rotor lookup-table mode (TASK-103): the table format, its reader and its encoding as a version 6 rotor configuration.
 * The contract is in docs/SPECS_SIMULATION_ENGINES.md, "Rotor lookup-table mode". Cold path: nothing here runs in a step.
 */

/** Values per table point: cT, cH, cQ, cR, cM, cP, validity. */
export const ROTOR_MAP_OUTPUTS = 7;
export const ROTOR_MAP_CONFIG_VERSION = 6;
export const ROTOR_MAP_MAX_AXIS = 64;
export const ROTOR_MAP_MAX_POINTS = 32768;
/** Output flag of a table rotor: a query outside an axis, or with cyclic pitch; it was clamped to the edge. */
export const ROTOR_FLAG_MAP_EDGE = 512;
/** The BET rotor's and the table rotor's outside-validity flag. */
export const ROTOR_FLAG_OUTSIDE_VALIDITY = 8;

export interface RotorMapAxes {
  readonly advanceRatio: readonly number[];
  /** −π/2 (descending into the wake) through 0 (edgewise) to π/2 (axial climb). */
  readonly airflowAngleRad: readonly number[];
  readonly tipMach: readonly number[];
  /**
   * The flight's density × speed of sound ÷ viscosity over the table's reference air: with the tip Mach number it fixes the blades'
   * Reynolds number. A blade loses lift in thin air whatever the speed, so density alone does not scale a rotor.
   */
  readonly reynoldsScale: readonly number[];
  readonly collectiveRad: readonly number[];
}
export interface RotorMapAir { readonly densityKgM3: number; readonly soundMps: number; readonly viscosityPaS: number }
export interface RotorMapTable {
  readonly schemaVersion: 1;
  readonly kind: 'mirage-rotor-map';
  /** The geometry the table describes: its radius must match the rotor it is bound to. */
  readonly rotor: { readonly radiusM: number; readonly bladeCount: number; readonly geometry: string };
  /** The air the Reynolds scale's 1 stands for; the coefficients are non-dimensional, so a flight's density rescales them exactly. */
  readonly referenceAir: RotorMapAir;
  readonly solver: { readonly name: string; readonly version: string };
  readonly provenance: 'synthetic' | 'measured';
  readonly axes: RotorMapAxes;
  /** Flat, by advance ratio, angle, tip Mach, Reynolds scale, collective, then output. */
  readonly coefficients: readonly number[];
  /** SHA-256 of `rotorMapContent`. */
  readonly sha256: string;
}
export type RotorModel = 'bet' | 'map';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Rotor map: ${what} must be a finite number`);
  return value;
}
function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 1024) throw new Error(`Rotor map: ${what} must be text`);
  return value;
}
function exact(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new Error(`Rotor map: ${what} must hold ${keys.join(', ')}`);
  }
  return value;
}
function axis(value: unknown, what: string, low: number, high: number): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ROTOR_MAP_MAX_AXIS) throw new Error(`Rotor map: ${what} needs 1 to ${ROTOR_MAP_MAX_AXIS} points`);
  const list: unknown[] = value;
  const points = list.map(point => finite(point, what));
  points.forEach((point, i) => {
    if (point < low || point > high) throw new Error(`Rotor map: ${what} ${point} is outside ${low} to ${high}`);
    if (i > 0 && !(point > points[i - 1]!)) throw new Error(`Rotor map: ${what} must increase`);
  });
  return Object.freeze(points);
}

/** The bytes the content hash covers: every field but the hash, in a fixed order. */
export function rotorMapContent(table: Omit<RotorMapTable, 'sha256'>): Uint8Array {
  const { schemaVersion, kind, rotor, referenceAir, solver, provenance, axes, coefficients } = table;
  return new TextEncoder().encode(JSON.stringify({ schemaVersion, kind, rotor: { radiusM: rotor.radiusM, bladeCount: rotor.bladeCount, geometry: rotor.geometry },
    referenceAir: { densityKgM3: referenceAir.densityKgM3, soundMps: referenceAir.soundMps, viscosityPaS: referenceAir.viscosityPaS },
    solver: { name: solver.name, version: solver.version }, provenance,
    axes: { advanceRatio: axes.advanceRatio, airflowAngleRad: axes.airflowAngleRad, tipMach: axes.tipMach, reynoldsScale: axes.reynoldsScale, collectiveRad: axes.collectiveRad }, coefficients }));
}

/** Validates a table's shape and values from `unknown`, without its hash, which `readRotorMap` checks. */
export function parseRotorMap(value: unknown): RotorMapTable {
  const v = exact(value, ['schemaVersion', 'kind', 'rotor', 'referenceAir', 'solver', 'provenance', 'axes', 'coefficients', 'sha256'], 'a table');
  if (v.schemaVersion !== 1 || v.kind !== 'mirage-rotor-map') throw new Error('Rotor map: schema 1 of kind mirage-rotor-map expected');
  const r = exact(v.rotor, ['radiusM', 'bladeCount', 'geometry'], 'rotor');
  const radiusM = finite(r.radiusM, 'radius'), bladeCount = finite(r.bladeCount, 'blade count');
  if (!(radiusM > 0) || !Number.isInteger(bladeCount) || bladeCount < 1) throw new Error('Rotor map: a positive radius and blade count are required');
  const air = exact(v.referenceAir, ['densityKgM3', 'soundMps', 'viscosityPaS'], 'reference air');
  const referenceAir = Object.freeze({ densityKgM3: finite(air.densityKgM3, 'reference density'), soundMps: finite(air.soundMps, 'reference speed of sound'), viscosityPaS: finite(air.viscosityPaS, 'reference viscosity') });
  if (!(referenceAir.densityKgM3 > 0) || !(referenceAir.soundMps > 0) || !(referenceAir.viscosityPaS > 0)) throw new Error('Rotor map: the reference air must be positive');
  const s = exact(v.solver, ['name', 'version'], 'solver');
  if (v.provenance !== 'synthetic' && v.provenance !== 'measured') throw new Error('Rotor map: provenance must be synthetic or measured');
  const a = exact(v.axes, ['advanceRatio', 'airflowAngleRad', 'tipMach', 'reynoldsScale', 'collectiveRad'], 'axes');
  const axes = Object.freeze({
    advanceRatio: axis(a.advanceRatio, 'advance ratio', 0, Number.MAX_VALUE),
    airflowAngleRad: axis(a.airflowAngleRad, 'airflow angle', -Math.PI / 2, Math.PI / 2),
    tipMach: axis(a.tipMach, 'tip Mach', 0, Number.MAX_VALUE),
    reynoldsScale: axis(a.reynoldsScale, 'Reynolds scale', Number.MIN_VALUE, Number.MAX_VALUE),
    collectiveRad: axis(a.collectiveRad, 'collective', -Math.PI, Math.PI),
  });
  const points = axes.advanceRatio.length * axes.airflowAngleRad.length * axes.tipMach.length * axes.reynoldsScale.length * axes.collectiveRad.length;
  if (points > ROTOR_MAP_MAX_POINTS) throw new Error(`Rotor map: ${points} points, above ${ROTOR_MAP_MAX_POINTS}`);
  if (!Array.isArray(v.coefficients) || v.coefficients.length !== points * ROTOR_MAP_OUTPUTS) throw new Error(`Rotor map: ${points * ROTOR_MAP_OUTPUTS} coefficients expected`);
  const raw: unknown[] = v.coefficients;
  const coefficients = raw.map(c => finite(c, 'coefficient'));
  for (let k = ROTOR_MAP_OUTPUTS - 1; k < coefficients.length; k += ROTOR_MAP_OUTPUTS) {
    if (coefficients[k]! < 0 || coefficients[k]! > 1) throw new Error('Rotor map: a validity must be within 0 to 1');
  }
  const sha256 = text(v.sha256, 'hash');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Rotor map: the hash must be 64 hexadecimal digits');
  return Object.freeze({ schemaVersion: 1, kind: 'mirage-rotor-map',
    rotor: Object.freeze({ radiusM, bladeCount, geometry: text(r.geometry, 'geometry') }), referenceAir,
    solver: Object.freeze({ name: text(s.name, 'solver name'), version: text(s.version, 'solver version') }),
    provenance: v.provenance, axes, coefficients: Object.freeze(coefficients), sha256 });
}

/** The content hash, with the platform's digest, which browsers and Node.js both have. */
export async function rotorMapHash(table: Omit<RotorMapTable, 'sha256'>): Promise<string> {
  const content = rotorMapContent(table);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(content));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Reads a table from `unknown`: its shape, its values and its content hash. */
export async function readRotorMap(value: unknown): Promise<RotorMapTable> {
  const table = parseRotorMap(value);
  if (await rotorMapHash(table) !== table.sha256) throw new Error('Rotor map: the content does not match its hash');
  return table;
}

export interface RotorMapShaft {
  readonly radiusM: number;
  readonly spinSign: number;
  readonly shaftInertiaKgM2: number;
  readonly bearingViscousNmPerRadS: number;
  readonly initialOmegaRadS: number;
}
/** A table as a version 6 rotor configuration. A table describes one rotor's geometry, so another radius is refused. */
export function encodeRotorMap(table: RotorMapTable, shaft: RotorMapShaft, dtS: number): Uint8Array<ArrayBuffer> {
  if (Math.abs(shaft.radiusM - table.rotor.radiusM) > 1e-9 * table.rotor.radiusM) {
    throw new Error(`Rotor map: the table is for a radius of ${table.rotor.radiusM} m, not ${shaft.radiusM} m`);
  }
  const { advanceRatio, airflowAngleRad, tipMach, reynoldsScale, collectiveRad } = table.axes, air = table.referenceAir;
  const lists: readonly (readonly number[])[] = [advanceRatio, airflowAngleRad, tipMach, reynoldsScale, collectiveRad, table.coefficients];
  const bytes = new Uint8Array(128 + 8 * lists.reduce((sum, list) => sum + list.length, 0)), view = new DataView(bytes.buffer);
  [ROTOR_MAP_CONFIG_VERSION, bytes.length, advanceRatio.length, airflowAngleRad.length, tipMach.length, reynoldsScale.length, collectiveRad.length]
    .forEach((word, i) => view.setUint32(i * 4, word, true));
  view.setInt32(28, shaft.spinSign, true);
  view.setFloat64(32, air.densityKgM3 * air.soundMps / air.viscosityPaS, true);
  view.setFloat64(40, shaft.radiusM, true);
  view.setFloat64(56, shaft.shaftInertiaKgM2, true);
  view.setFloat64(64, shaft.bearingViscousNmPerRadS, true);
  view.setFloat64(72, dtS, true);
  view.setFloat64(80, shaft.initialOmegaRadS, true);
  let at = 128;
  for (const list of lists) for (const value of list) { view.setFloat64(at, value, true); at += 8; }
  return bytes;
}

export interface StaticBenchPoint { readonly omegaRadS: number; readonly thrustN: number; readonly torqueNm: number }
export interface StaticBench {
  readonly radiusM: number; readonly bladeCount: number; readonly geometry: string;
  readonly densityKgM3: number; readonly soundMps: number; readonly viscosityPaS: number; readonly source: string;
  readonly points: readonly StaticBenchPoint[];
}
/**
 * A table of what a thrust stand measured: zero airflow in one air, so a flight with air moving through the rotor, or in other air,
 * is flagged as outside it, and speed as the tip Mach axis. Measured thrust and torque set cT and cQ; a stand gives no in-plane load. Cold.
 */
export async function rotorMapFromStaticBench(bench: StaticBench): Promise<RotorMapTable> {
  const { radiusM, densityKgM3, soundMps, viscosityPaS } = bench;
  if (!(radiusM > 0) || !(densityKgM3 > 0) || !(soundMps > 0) || !(viscosityPaS > 0) || bench.points.length < 1) throw new Error('Rotor map: a thrust stand table needs a radius, an air and points');
  const points = [...bench.points].sort((a, b) => a.omegaRadS - b.omegaRadS);
  const coefficients: number[] = [];
  for (const { omegaRadS, thrustN, torqueNm } of points) {
    if (!(omegaRadS > 0) || !Number.isFinite(thrustN) || !Number.isFinite(torqueNm)) throw new Error('Rotor map: a stand point needs a positive speed and finite loads');
    const scale = densityKgM3 * omegaRadS * omegaRadS * radiusM ** 4, torque = Math.abs(torqueNm) / (scale * radiusM);
    // The sign of the rotor's torque in the +1 sense: the air resists the spin.
    coefficients.push(thrustN / scale, 0, -torque, 0, 0, torque, 1);
  }
  const content: Omit<RotorMapTable, 'sha256'> = { schemaVersion: 1, kind: 'mirage-rotor-map',
    rotor: { radiusM, bladeCount: bench.bladeCount, geometry: bench.geometry }, referenceAir: { densityKgM3, soundMps, viscosityPaS },
    solver: { name: 'thrust stand', version: bench.source }, provenance: 'measured',
    axes: { advanceRatio: [0], airflowAngleRad: [0], tipMach: points.map(point => point.omegaRadS * radiusM / soundMps), reynoldsScale: [1], collectiveRad: [0] }, coefficients };
  return parseRotorMap({ ...content, sha256: await rotorMapHash(content) });
}
