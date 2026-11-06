// TASK-088: the --allocation report of scripts/check-bet-runtime.mjs must hold
// exactly one sample of every graph and variant, the v2 adapters included, and
// scripts/validate-models.mjs admits only that set.
import { describe, expect, it } from 'vitest';
import { ALLOCATION_GRAPHS, completeAllocationSamples } from '../scripts/bet-runtime-graphs.ts';

const complete = () => ALLOCATION_GRAPHS.map(([graph, variant]) => ({ graph, variant }));

describe('BET runtime allocation graphs', () => {
  it('include both v2 adapters in both WASM variants', () => {
    for (const graph of ['active-neuralfoil-rotor-v2', 'stationary-zero-gravity-body-v2']) {
      expect(ALLOCATION_GRAPHS.filter(([name]) => name === graph).map(([, variant]) => variant)).toEqual(['scalar', 'simd128']);
    }
  });
  it('include the TASK-093 weather graphs of the dynamics and of the session, and the TASK-096 drag graph', () => {
    for (const graph of ['weather-synthetic-pad-four-rotor', 'weather-session-synthetic-pad', 'airframe-drag-weather-pad-four-rotor']) {
      expect(ALLOCATION_GRAPHS.filter(([name]) => name === graph).map(([, variant]) => variant)).toEqual(['scalar']);
    }
  });
  it('include the TASK-097 full-range table in both WASM variants', () => {
    expect(ALLOCATION_GRAPHS.filter(([name]) => name === 'extended-polar-synthetic-pad-four-rotor').map(([, variant]) => variant)).toEqual(['scalar', 'simd128']);
  });
  it('include the TASK-098 dynamic inflow in both WASM variants', () => {
    expect(ALLOCATION_GRAPHS.filter(([name]) => name === 'dynamic-inflow-synthetic-pad-four-rotor').map(([, variant]) => variant)).toEqual(['scalar', 'simd128']);
  });
  it('include the TASK-100 ground effect', () => {
    expect(ALLOCATION_GRAPHS.filter(([name]) => name === 'ground-effect-esc-drive-pad-four-rotor').map(([, variant]) => variant)).toEqual(['scalar']);
  });
  it('admit exactly the complete set', () => {
    expect(completeAllocationSamples(complete())).toBe(true);
    expect(completeAllocationSamples(complete().reverse())).toBe(true);
    expect(completeAllocationSamples(complete().filter(s => s.graph !== 'stationary-zero-gravity-body-v2' || s.variant !== 'simd128'))).toBe(false);
    expect(completeAllocationSamples(complete().slice(0, 3))).toBe(false);
    const duplicated = complete();
    duplicated[1] = { graph: 'active-neuralfoil-rotor', variant: 'scalar' };
    expect(completeAllocationSamples(duplicated)).toBe(false);
    expect(completeAllocationSamples([...complete(), { graph: 'unknown', variant: 'scalar' }])).toBe(false);
    expect(completeAllocationSamples(complete().map(s => ({ ...s, variant: 'scalar' })))).toBe(false);
    expect(completeAllocationSamples(null)).toBe(false);
  });
});
