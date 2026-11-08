// TASK-105, second increment: the ESC shaper and motor thermal records through WASM, declared before the implementation
// (SPECS_SIMULATION_ENGINES "The ESC and the motor's heat in the flight"). The TypeScript offsets and C header constants equal the
// specification's byte tables; the scalar and SIMD builds agree bit for bit; the shaper equals an independent transcription of its
// definition exactly, and the network an independent closed-form solution within 1e-12 relative (the two take exp from different
// libraries); an invalid record or input changes no output.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { specFields } from './support/spec-layout.ts';
import { BetMotorV2, ESC_SHAPER_V1, MOTOR_THERMAL_V1, ThermalInput, ThermalOutput, type EscShaping, type MotorHeat } from '@mirage/wasm-bet/motor-v2';

const engineSpec = readFileSync(new URL('../docs/SPECS_SIMULATION_ENGINES.md', import.meta.url), 'utf8');
const header = readFileSync(new URL('../native/bet/include/bet_bound.h', import.meta.url), 'utf8');
const modules: WebAssembly.Module[] = [];
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  for (const variant of ['scalar', 'simd128']) modules.push(new WebAssembly.Module(readFileSync(`packages/wasm-bet/dist/mirage_bet.${variant}.wasm`)));
}, 600_000);

const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/20c$/, '20c');
const SHAPING: EscShaping = { framePeriodS: 1 / 490, latencyFrames: 3, rampPerS: 40, startDuty: 0.06, throttleSteps: 2000 };
const HEAT: MotorHeat = { windingHeatCapacityJPerK: 8, housingHeatCapacityJPerK: 25, windingToHousingKPerW: 1.5, housingToAirKPerW: 6,
  airflowCoolingPerMps: 0.1, resistance20cOhm: 0.08, torqueConstant20cNmPerA: 0.0036, noLoadCurrentA: 0.6 };

/** The shaper as SPECS_SIMULATION_ENGINES and native/bet/src/esc.rs define it, transcribed independently. */
class ShaperOracle {
  frames = new Array<number>(8).fill(0); command = 0; duty = 0; countdown = 0; running = false;
  constructor(private readonly s: EscShaping) {}
  step(target: number, dt: number): number {
    const q = this.s.throttleSteps === 0 ? target : Math.round(target * this.s.throttleSteps) / this.s.throttleSteps;
    if (this.countdown <= dt * 1e-9) {
      if (this.s.latencyFrames === 0) this.command = q;
      else { this.command = this.frames[0]!; for (let i = 1; i < this.s.latencyFrames; i++) this.frames[i - 1] = this.frames[i]!; this.frames[this.s.latencyFrames - 1] = q; }
      this.countdown += this.s.framePeriodS;
    }
    this.countdown = Math.max(0, this.countdown - dt);
    if (this.command === 0) this.running = false; else if (!this.running && this.command >= this.s.startDuty) this.running = true;
    const wanted = this.running ? this.command : 0, limit = (this.s.rampPerS === 0 ? Infinity : this.s.rampPerS) * dt;
    this.duty = wanted > this.duty ? Math.min(this.duty + limit, wanted) : Math.max(this.duty - limit, wanted);
    return this.duty;
  }
}
/** The two-node network's exact step by eigen-decomposition of its 2×2 matrix, written here from the equations of the spec. */
function networkStep(t: [number, number], copper: number, iron: number, air: number, airspeed: number, dt: number, h: MotorHeat): [number, number] {
  const g1 = 1 / h.windingToHousingKPerW, g2 = (1 + h.airflowCoolingPerMps * airspeed) / h.housingToAirKPerW;
  const cw = h.windingHeatCapacityJPerK, ch = h.housingHeatCapacityJPerK;
  const hs = air + (copper + iron) / g2, ws = hs + copper / g1;
  // x' = A x with A = [[−g1/cw, g1/cw], [g1/ch, −(g1+g2)/ch]] on the deviations from the steady state.
  const a = -g1 / cw, b = g1 / cw, c = g1 / ch, d = -(g1 + g2) / ch;
  const mean = (a + d) / 2, gap = Math.sqrt(((a - d) / 2) ** 2 + b * c), l1 = mean + gap, l2 = mean - gap;
  // Eigenvectors (b, l − a) for each eigenvalue; the deviation expands in them.
  const x1 = t[0] - ws, x2 = t[1] - hs, v1 = [b, l1 - a], v2 = [b, l2 - a];
  const det = v1[0]! * v2[1]! - v2[0]! * v1[1]!, c1 = (x1 * v2[1]! - v2[0]! * x2) / det, c2 = (v1[0]! * x2 - x1 * v1[1]!) / det;
  const e1 = Math.exp(l1 * dt), e2 = Math.exp(l2 * dt);
  return [ws + c1 * e1 * v1[0]! + c2 * e2 * v2[0]!, hs + c1 * e1 * v1[1]! + c2 * e2 * v2[1]!];
}
const close = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

describe('ESC shaper and motor thermal records', () => {
  it('keeps the TypeScript offsets and C header constants equal to the specification', () => {
    for (const [heading, layout] of [['### ESC shaper record v1', ESC_SHAPER_V1], ['### Motor thermal record v1', MOTOR_THERMAL_V1]] as const) {
      const fields = specFields(heading, engineSpec);
      const offsets: Record<string, number> = layout.offset;
      for (const f of fields) if (f.spec !== 'reserved_zero') expect(offsets[camel(f.spec)], f.spec).toBe(f.offset);
      // The table ends with its reserved tail at the record's last byte.
      const tail = fields[fields.length - 1]!;
      expect([tail.spec, tail.offset + tail.count * 4]).toEqual(['reserved_zero', layout.recordBytes]);
      expect(Object.keys(offsets).length).toBe(fields.filter(f => f.spec !== 'reserved_zero').length);
    }
    const define = (name: string) => Number(new RegExp(`#define ${name} (\\d+)`).exec(header)?.[1]);
    expect(define('BET_ESC_SHAPER_VERSION')).toBe(ESC_SHAPER_V1.version);
    expect(define('BET_ESC_SHAPER_RECORD_BYTES')).toBe(ESC_SHAPER_V1.recordBytes);
    expect(define('BET_MOTOR_THERMAL_VERSION')).toBe(MOTOR_THERMAL_V1.version);
    expect(define('BET_MOTOR_THERMAL_RECORD_BYTES')).toBe(MOTOR_THERMAL_V1.recordBytes);
  });

  it('agrees between the builds bit for bit and with independent transcriptions of the models', () => {
    const neutral: EscShaping = { framePeriodS: 1 / 400, latencyFrames: 0, rampPerS: 0, startDuty: 0, throttleSteps: 0 };
    const runs = modules.map(module => new BetMotorV2(module, [SHAPING, neutral], [HEAT, { ...HEAT, airflowCoolingPerMps: 0 }], 1200));
    for (const run of runs) run.reset(25);
    const oracles = [new ShaperOracle(SHAPING), new ShaperOracle(neutral)];
    let temps: [number, number][] = [[25, 25], [25, 25]];
    const dt = 1 / 1200;
    for (let k = 0; k < 6000; k++) {
      const phase = k * 0.003, target = k % 1500 < 60 ? 0 : 0.5 + 0.45 * Math.sin(phase);
      const copper = 6 + 3 * Math.sin(phase), speed = 1700 + 200 * Math.cos(phase), airspeed = 10 + 2 * Math.sin(2 * phase);
      for (const run of runs) {
        run.targets[0] = target; run.targets[1] = target;
        for (let m = 0; m < 2; m++) {
          const b = m * ThermalInput.Stride;
          run.thermalInput[b + ThermalInput.CopperLossW] = copper; run.thermalInput[b + ThermalInput.ShaftSpeedRadS] = speed;
          run.thermalInput[b + ThermalInput.AirC] = 25; run.thermalInput[b + ThermalInput.AirspeedMps] = airspeed;
        }
        expect(run.shapeFromInput()).toBe(true);
        expect(run.heatFromInput()).toBe(true);
      }
      expect(Array.from(runs[1]!.duties)).toEqual(Array.from(runs[0]!.duties));
      expect(Array.from(runs[1]!.thermalOutput)).toEqual(Array.from(runs[0]!.thermalOutput));
      const out = runs[0]!.thermalOutput;
      oracles.forEach((o, m) => expect(runs[0]!.duties[m], `shaper ${m}, step ${k}`).toBe(o.step(target, dt)));
      temps = temps.map((t, m) => {
        const heat = m === 0 ? HEAT : { ...HEAT, airflowCoolingPerMps: 0 };
        const iron = HEAT.torqueConstant20cNmPerA * (1 - 0.0012 * (t[1] - 20)) * HEAT.noLoadCurrentA * speed;
        const next = networkStep(t, copper, iron, 25, airspeed, dt, heat), o = m * ThermalOutput.Stride;
        expect(close(out[o + ThermalOutput.IronLossW]!, iron, 1e-12)).toBe(true);
        expect(close(out[o + ThermalOutput.WindingC]!, next[0], 1e-12), `winding ${m}, step ${k}`).toBe(true);
        expect(close(out[o + ThermalOutput.HousingC]!, next[1], 1e-12)).toBe(true);
        expect(close(out[o + ThermalOutput.ResistanceOhm]!, 0.08 * (1 + 0.00393 * (next[0] - 20)), 1e-12)).toBe(true);
        // Continue from the record's own state, so the comparison does not drift by the accumulated rounding of two libraries.
        return [out[o + ThermalOutput.WindingC]!, out[o + ThermalOutput.HousingC]!];
      });
    }
    // Five seconds of load heated the winding above the housing, and more without the airflow.
    const out = runs[0]!.thermalOutput;
    expect(out[ThermalOutput.WindingC]!).toBeGreaterThan(out[ThermalOutput.HousingC]!);
    expect(out[ThermalOutput.Stride + ThermalOutput.WindingC]!).toBeGreaterThan(out[ThermalOutput.WindingC]!);
  });

  it('changes no output on an invalid input, and resets to the air temperature', () => {
    const run = new BetMotorV2(modules[0]!, [SHAPING], [HEAT], 800);
    run.targets[0] = 0.4; expect(run.shapeFromInput()).toBe(true);
    const duty = run.duties[0];
    run.targets[0] = 1.5;
    expect(run.shapeFromInput()).toBe(false);
    expect(run.lastStatus).toBe(-3);
    expect(run.duties[0]).toBe(duty);
    run.thermalInput[ThermalInput.CopperLossW] = -1;
    const before = Array.from(run.thermalOutput);
    expect(run.heatFromInput()).toBe(false);
    expect(Array.from(run.thermalOutput)).toEqual(before);
    run.reset(35);
    expect(run.thermalOutput[ThermalOutput.WindingC]).toBe(35);
    expect(run.thermalOutput[ThermalOutput.ResistanceOhm]).toBe(0.08 * (1 + 0.00393 * 15));
    expect(run.duties[0]).toBe(0);
    expect(() => new BetMotorV2(modules[0]!, [{ ...SHAPING, latencyFrames: 9 }], [], 800)).toThrow('Invalid ESC shaping');
    expect(() => new BetMotorV2(modules[0]!, [], [{ ...HEAT, housingToAirKPerW: 0 }], 800)).toThrow('Invalid motor heat');
  });
});
