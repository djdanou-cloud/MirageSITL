// The synthetic rotor table of TASK-103: the steady loads of the full BET at every point of the axes, as non-dimensional
// coefficients of the rotor spinning in the +1 sense. A point the BET marks outside its validity, that does not settle, or whose
// thrust is near zero gets validity 0: at zero thrust the inflow closure has a kink that a table cannot follow, and a percentage
// of it means nothing. Cold path.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticRotor, type BoundRotorDefinition } from '../../packages/wasm-bet/src/rotor.ts';
import { ROTOR_MAP_OUTPUTS, rotorMapHash, type RotorMapTable } from '../../packages/wasm-bet/src/rotor-map.ts';
import { pointOf, steadyLoads, type OperatingAir, type OperatingPoint, type SteadyLoads } from './solve.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MAP_ROTOR_AIR: OperatingAir = Object.freeze({ densityKgM3: 1.225, viscosityPaS: 1.789e-5, soundMps: 340 });
const degrees = (list: readonly number[]) => list.map(angle => angle * Math.PI / 180);
/** Below this share of the same speed's hover thrust a point is not trusted. */
const NEAR_ZERO_THRUST = 0.1;
/** Ten significant digits are far finer than the settling, and keep the fixture small. */
const rounded = (value: number) => Number(value.toPrecision(10));
export const MAP_AXES = Object.freeze({
  // Denser where the loads turn fastest: the wake's skew at low advance ratio, and thrust falling with climb.
  advanceRatio: [0, 0.0125, 0.025, 0.05, 0.075, 0.1, 0.125, 0.15, 0.175, 0.2, 0.225, 0.25, 0.275, 0.3, 0.325, 0.35, 0.375, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8],
  airflowAngleRad: degrees([-90, -75, -60, -45, -30, -15, -7.5, 0, 7.5, 15, 22.5, 30, 37.5, 45, 52.5, 60, 67.5, 75, 82.5, 90]),
  tipMach: [0.1, 0.125, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6],
  // From 5000 m on a standard day to sea level at −30 °C.
  reynoldsScale: [0.6, 0.7, 0.8, 1, 1.25],
  collectiveRad: [0],
});

/** The rotor the table describes: the suite's first synthetic rotor on its full-range polar, with the flight model's inflow. */
export function mapRotorDefinition(): BoundRotorDefinition {
  const read = (path: string): unknown => JSON.parse(readFileSync(`${ROOT}${path}`, 'utf8'));
  const suite = read('tests/fixtures/rotors/synthetic-bet-suite.json');
  if (typeof suite !== 'object' || suite === null || !('configurations' in suite) || !Array.isArray(suite.configurations)) throw new Error('Synthetic suite without configurations');
  const rotor = syntheticRotor(suite.configurations[0], read('tests/fixtures/polars/naca6409-extended.json'), { spinSign: 1, initialOmegaRadS: 300,
    shaftInertiaKgM2: 0.0002, bearingViscousNmPerRadS: 0, inflowTauS: 0, inflowLimitMps: 500 });
  return { ...rotor, dynamicInflow: true, minimumConfidence: 0 };
}

/** The table's coefficients of `loads` at speed `omega`: spin +1 with the air along hub +x. */
function coefficientsOf(loads: SteadyLoads, omega: number, radius: number, density: number, hoverThrustN: number): number[] {
  const scale = density * omega * omega * radius ** 4, momentScale = scale * radius;
  const cQ = loads.moment[2] / momentScale;
  const trusted = loads.settled && !loads.outsideValidity && Math.abs(loads.force[2]) >= NEAR_ZERO_THRUST * Math.abs(hoverThrustN);
  return [loads.force[2] / scale, loads.force[0] / scale, cQ, loads.moment[0] / momentScale, loads.moment[1] / momentScale, Math.abs(cQ)].map(rounded).concat(trusted ? 1 : 0);
}

export async function generateRotorMap(module: WebAssembly.Module): Promise<RotorMapTable> {
  const definition = mapRotorDefinition(), radius = definition.geometry.radiusM, air = MAP_ROTOR_AIR;
  const { advanceRatio, airflowAngleRad, tipMach, reynoldsScale, collectiveRad } = MAP_AXES;
  const points = new Map<number, { readonly key: string; readonly point: OperatingPoint }[]>(reynoldsScale.map(scale => [scale, []]));
  const index: { readonly key: string; readonly hover: string; readonly omega: number; readonly scale: number }[] = [];
  for (const j of advanceRatio) for (const angle of airflowAngleRad) for (const mach of tipMach) for (const scale of reynoldsScale) for (const collective of collectiveRad) {
    // At zero advance ratio the angle does not matter: one solve serves them all.
    const key = j === 0 ? `${mach}/${scale}/${collective}` : `${j}/${angle}/${mach}/${scale}/${collective}`;
    index.push({ key, hover: `${mach}/${scale}/${collective}`, omega: mach * air.soundMps / radius, scale });
    if (j !== 0 || angle === airflowAngleRad[0]) points.get(scale)?.push({ key, point: pointOf(radius, air.soundMps, j, angle, mach, collective) });
  }
  const byKey = new Map<string, SteadyLoads>();
  // A point of this scale in air this much denser: same Mach number, same Reynolds number as a flight of that scale in any air.
  for (const [scale, list] of points) {
    const solved = steadyLoads(module, definition, list.map(entry => entry.point), { ...air, densityKgM3: air.densityKgM3 * scale });
    list.forEach((entry, i) => {
      const loads = solved[i];
      if (!loads) throw new Error('A point without a solution');
      byKey.set(entry.key, loads);
    });
  }
  const loadsOf = (key: string) => {
    const loads = byKey.get(key);
    if (!loads) throw new Error(`No solution for ${key}`);
    return loads;
  };
  const coefficients = index.flatMap(({ key, hover, omega, scale }) => coefficientsOf(loadsOf(key), omega, radius, air.densityKgM3 * scale, loadsOf(hover).force[2]));
  if (coefficients.length !== index.length * ROTOR_MAP_OUTPUTS) throw new Error('Table size');
  const table: Omit<RotorMapTable, 'sha256'> = { schemaVersion: 1, kind: 'mirage-rotor-map',
    rotor: { radiusM: radius, bladeCount: definition.geometry.bladeCount, geometry: 'synthetic-bet-suite baseline-two-blade, NACA6409' },
    referenceAir: { densityKgM3: air.densityKgM3, soundMps: air.soundMps, viscosityPaS: air.viscosityPaS }, solver: { name: 'MirageSITL BET with dynamic inflow', version: 'naca6409-extended-v1' }, provenance: 'synthetic',
    axes: MAP_AXES, coefficients };
  return { ...table, sha256: await rotorMapHash(table) };
}
