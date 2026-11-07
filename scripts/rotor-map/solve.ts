// The full BET at fixed operating points (TASK-103): what a table is generated from and compared with. A very heavy shaft holds
// the speed, the dynamic inflow settles, and the loads are read when they stop changing. Cold path.
import { BetRotorEngineV2, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_FLAGS_SLOT, BOUND_V2_OUTPUT_SLOTS } from '../../packages/wasm-bet/src/rotor-v2.ts';
import { ROTOR_FLAG_OUTSIDE_VALIDITY } from '../../packages/wasm-bet/src/rotor-map.ts';
import type { BoundRotorDefinition } from '../../packages/wasm-bet/src/rotor.ts';

/** A shaft this heavy cannot change speed in any time a point is held, so the speed is the point's. */
const HEAVY_SHAFT_KG_M2 = 1e9;
const SOLVE_HZ = 800;
/** Long enough for the slowest settling: the inflow's time constant at the lowest speed. */
const MAX_STEPS = 2400;
const CHECK_EVERY = 120;
/** Declared settled when thrust and torque change by less than this, relative, over `CHECK_EVERY` steps. */
const SETTLED = 1e-7;
const BATCH = 32;

export interface OperatingPoint { readonly omegaRadS: number; readonly airHubMps: readonly [number, number, number]; readonly collectiveRad: number }
export interface OperatingAir { readonly densityKgM3: number; readonly viscosityPaS: number; readonly soundMps: number }
export interface SteadyLoads {
  readonly force: readonly [number, number, number]; readonly moment: readonly [number, number, number];
  readonly settled: boolean; readonly outsideValidity: boolean;
}
export interface SolveOptions { readonly model?: 'bet' | 'map' }

/** The steady loads of `definition` at each point; each point is a rotor of its own, up to 32 at a time in one instance. */
export function steadyLoads(module: WebAssembly.Module, definition: BoundRotorDefinition, points: readonly OperatingPoint[], air: OperatingAir): SteadyLoads[] {
  const results: SteadyLoads[] = [];
  for (let start = 0; start < points.length; start += BATCH) {
    const batch = points.slice(start, start + BATCH);
    const definitions = batch.map(point => ({ ...definition, initialOmegaRadS: point.omegaRadS,
      geometry: { ...definition.geometry, shaftInertiaKgM2: HEAVY_SHAFT_KG_M2, bearingViscousNmPerRadS: 0 } }));
    const engine = new BetRotorEngineV2(module, definitions, SOLVE_HZ);
    batch.forEach((point, i) => {
      const row = i * BOUND_V2_INPUT_DOUBLES;
      engine.input.set([air.densityKgM3, air.viscosityPaS, air.soundMps, point.airHubMps[0], point.airHubMps[1], point.airHubMps[2], 0, 0, 0, point.collectiveRad], row);
    });
    const previous = new Float64Array(batch.length * 2), settled = new Array<boolean>(batch.length).fill(false);
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (!engine.stepInto()) throw new Error(`The rotor step returned status ${engine.lastStatus}`);
      if (step % CHECK_EVERY !== 0) continue;
      let all = true;
      batch.forEach((_, i) => {
        const out = i * BOUND_V2_OUTPUT_SLOTS, thrust = engine.output[out + 2]!, torque = engine.output[out + 5]!;
        const change = Math.max(Math.abs(thrust - previous[i * 2]!) / Math.max(Math.abs(thrust), 1e-9), Math.abs(torque - previous[i * 2 + 1]!) / Math.max(Math.abs(torque), 1e-12));
        settled[i] = change < SETTLED;
        all &&= settled[i];
        previous[i * 2] = thrust; previous[i * 2 + 1] = torque;
      });
      if (all) break;
    }
    batch.forEach((_, i) => {
      const out = i * BOUND_V2_OUTPUT_SLOTS, o = engine.output;
      results.push({ force: [o[out]!, o[out + 1]!, o[out + 2]!], moment: [o[out + 3]!, o[out + 4]!, o[out + 5]!], settled: settled[i]!,
        outsideValidity: (o[out + BOUND_V2_OUTPUT_FLAGS_SLOT]! & ROTOR_FLAG_OUTSIDE_VALIDITY) !== 0 });
    });
    engine.dispose();
  }
  return results;
}

/** The operating point of table coordinates: the air along hub +x at the airflow angle. */
export function pointOf(radiusM: number, soundMps: number, advanceRatio: number, angleRad: number, tipMach: number, collectiveRad: number): OperatingPoint {
  const omegaRadS = tipMach * soundMps / radiusM, speed = advanceRatio * omegaRadS * radiusM;
  return { omegaRadS, airHubMps: [speed * Math.cos(angleRad), 0, -speed * Math.sin(angleRad)], collectiveRad };
}
