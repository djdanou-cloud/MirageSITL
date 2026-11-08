// TASK-105, motor heat against wind-tunnel runs (SPECS_SIMULATION_ENGINES "Motor heat against wind-tunnel runs"). Declared with
// the method, before the first run on the data:
//  - the loss law's fit returns R₂₀ and (k·I₀)₂₀ within 1e-9 relative from rows made with them;
//  - the repository's network (BetMotorV2 over bet_motor_thermal_step), driven at held inputs, ends within 1e-6 K of its steady
//    state, found here independently by fixed-point iteration of R(T_w);
//  - the fit returns the transient of a synthetic run made by the same network within 0.01 K RMS;
//  - the file and name readers take a synthetic file in the archive's format;
//  - with MIRAGE_MOTOR_THERMAL_DIR set to the directory the Texas A&M archives unpack into, every file is checked against
//    data/motor-thermal/inventory.json, the split against the specification's table, and the comparison is run;
//    MIRAGE_MOTOR_THERMAL_OUT writes the report. The comparison is reported, whatever its outcome.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BetMotorV2 } from '@mirage/wasm-bet/motor-v2';
import {
  MOTOR_THERMAL_METHOD, compareRun, fitLossLaw, fitThermal, heatValues, lawLossW, measuredLossW, parseRawRun, parseRunName, parseSummary,
  runDrive, simulateRun, splitRuns, summaryFileName, type HeatValues, type HeatedMotorFactory, type LossLaw, type SummaryRow, type ThermalRun,
  type ThermalValues,
} from '../packages/analysis/src/motor-thermal-runs.ts';

const WASM = 'packages/wasm-bet/dist/mirage_bet.scalar.wasm';
let module: WebAssembly.Module;
const factory: HeatedMotorFactory = heat => new BetMotorV2(module, [], [heat], MOTOR_THERMAL_METHOD.hz);
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync(WASM));
}, 600_000);

const RAW_HEADER = 't [s]\tN [rpm]\tthrottle [%]\tPdc [W]\tVdc [V]\tPac [W]\tVac [Vrms]\tIac [Irms]\tVfz [V]\tVmz [V]\tTstat [degC]\tTesc [degC]\tV_pitot [V]';
const SUMMARY_HEADER = '# Index\tRPM\tThrust [g]\tTorque [mN.m]\tVac [Vrms]\tIac [Arms]\tPac [W]\tVdc [V]\tPdc [W]\tTmot [degC]\tTamb [degC]\tu [m/s]\t';
const NAME = 'wtRaw_M02_P000_u070_RPM4683_VDC130_Pr155x3_Dt2023-08-28-13-18_Ta24_Pa1002_Hmd53.txt';
const e = (v: number) => v.toExponential(3).replace('e+', 'E+').replace('e-', 'E-');

/** A synthetic run in the archive's shape: held speed and current from 5 s, 1 Hz samples, the stator column from `stator`. */
function syntheticRun(seconds: number, rpm: number, current: number, tunnelMps: number, stator: (k: number) => number): ThermalRun {
  const name = parseRunName(NAME);
  if (!name) throw new Error('name');
  const t = Float64Array.from({ length: seconds }, (_, k) => k), on = (k: number) => (k >= 5 ? 1 : 0);
  const raw = { timeS: t, rpm: t.map(k => rpm * on(k)), acPowerW: t.map(() => 0), currentA: t.map(k => current * on(k)), statorC: t.map(k => stator(k)) };
  const row: SummaryRow = { index: 60, rpm, thrustN: 0.002 * rpm, torqueNm: 0.2, currentA: current, acPowerW: 100, motorC: 40, airC: 24, tunnelMps };
  return { name, raw, summary: [row, { ...row, index: seconds - 1 }] };
}

describe('motor heat against wind-tunnel runs (TASK-105)', () => {
  it('reads the archive\'s names and files', () => {
    const name = parseRunName(NAME);
    expect(name).toEqual({ motor: 'M02', key: 'u070 RPM4683', targetTunnelMps: 7, targetRpm: 4683, supplyV: 13, propellerDiameterM: 15.5 * 0.0254,
      blades: 3, date: '2023-08-28-13-18', ambientC: 24, pressurePa: 100200, humidityPct: 53 });
    expect(summaryFileName(name!)).toBe('wtSummary_M02_u070_RPM4683.txt');
    expect(parseRunName('wtSummary_M02_u070_RPM4683.txt')).toBeNull();
    const rows = [[0, 0, 0, 0, 0, 0, 0, 0, -3.8e-3, -4e-5, 37.82, 23.39, 2.682], [5.174, 4515, 30, 217.1, 12.89, 210, 9.3, 13.99, -2.8e-3, 1.1e-3, 58.23, 23.89, 2.701]];
    const raw = parseRawRun(`${RAW_HEADER}\n${rows.map(r => r.map(e).join('\t')).join('\n')}\n`, NAME);
    expect([...raw.timeS]).toEqual([0, 5.174]);
    expect([...raw.rpm]).toEqual([0, 4515]);
    expect([...raw.currentA]).toEqual([0, 13.99]);
    expect([...raw.statorC]).toEqual([37.82, 58.23]);
    const line = (v: number[]) => `${v.map(x => x.toExponential(18)).join('\t')}\t`;
    const summary = parseSummary(`${SUMMARY_HEADER}\n${line([80, 4543.9, 1090.87, 339.71, 9.29, 14.128, 212.4, 12.89, 219.18, 47.801, 23.832, 5.7115])}\n${line([-1, 4525.8, 1076.35, 336.73, 9.3, 14.013, 210.4, 12.89, 217.25, 58.219, 23.896, 5.6674])}\n`, 'summary');
    expect(summary[0].index).toBe(80);
    expect(summary[1].index).toBe(-1);
    expect(summary[0].thrustN).toBeCloseTo(1.09087 * 9.80665, 9);
    expect(summary[1].torqueNm).toBeCloseTo(0.33673, 12);
    expect(() => parseRawRun(`${RAW_HEADER.replace('Tstat', 'Tmot')}\n`, NAME)).toThrow(/columns/);
  });

  it('fits the loss law exactly to rows made with it', () => {
    const law = { r20: 0.0712, kI0: 0.0218 }, m = MOTOR_THERMAL_METHOD;
    const rows: SummaryRow[] = [[14, 4500, 58], [7.2, 3500, 36], [2.6, 2700, 28], [11, 4200, 46], [5.7, 3260, 33]].map(([i, rpm, temp]) => {
      const omega = rpm! * 2 * Math.PI / 60, loss = law.r20 * (1 + m.copperCoefficientPerK * (temp! - 20)) * i! ** 2 + law.kI0 * (1 + m.magnetCoefficientPerK * (temp! - 20)) * omega;
      const torque = 0.024 * i!;
      return { index: 0, rpm: rpm!, thrustN: 1, torqueNm: torque, currentA: i!, acPowerW: loss + torque * omega, motorC: temp!, airC: 24, tunnelMps: 7 };
    });
    const fitted = fitLossLaw(rows);
    expect(Math.abs(fitted.resistance20cOhm / law.r20 - 1)).toBeLessThan(1e-9);
    expect(Math.abs(fitted.noLoadTorque20cNm / law.kI0 - 1)).toBeLessThan(1e-9);
    expect(fitted.torqueConstant20cNmPerA).toBeCloseTo(0.024, 12);
    for (const row of rows) expect(Math.abs(lawLossW(fitted, row) - measuredLossW(row))).toBeLessThan(1e-9);
    expect(() => fitLossLaw(rows.map(row => ({ ...row, acPowerW: row.torqueNm * row.rpm * 2 * Math.PI / 60 - 1 })))).toThrow(/not positive/);
  });

  it('drives the repository\'s network to its steady state at held inputs', () => {
    const law: LossLaw = { resistance20cOhm: 0.08, noLoadTorque20cNm: 0.02, torqueConstant20cNmPerA: 0.025, noLoadCurrentA: 0.8 };
    const thermal: ThermalValues = { windingHeatCapacityJPerK: 25, housingHeatCapacityJPerK: 90, windingToHousingKPerW: 0.6, housingToAirKPerW: 1.2, airflowCoolingPerMps: 0.15 };
    const run = syntheticRun(4000, 4000, 12, 7, () => 30), drive = runDrive(run), heat: HeatValues = heatValues(thermal, law);
    const simulation = simulateRun(factory(heat), run, drive), n = run.raw.timeS.length;
    // Independent steady state: the network's balance with R(T_w) and k(T_h) iterated to a fixed point.
    const m = MOTOR_THERMAL_METHOD, omega = 4000 * 2 * Math.PI / 60, v = drive.airspeedMps[n - 1]!;
    let tw = 20, th = 20;
    for (let i = 0; i < 500; i++) {
      const copper = heat.resistance20cOhm * (1 + m.copperCoefficientPerK * (tw - 20)) * 144;
      const iron = heat.torqueConstant20cNmPerA * (1 + m.magnetCoefficientPerK * (th - 20)) * heat.noLoadCurrentA * omega;
      th = drive.airC + (copper + iron) * heat.housingToAirKPerW / (1 + heat.airflowCoolingPerMps * v);
      tw = th + copper * heat.windingToHousingKPerW;
    }
    expect(Math.abs(simulation.housingC[n - 1]! - th)).toBeLessThan(1e-6);
    expect(Math.abs(simulation.windingC[n - 1]! - tw)).toBeLessThan(1e-6);
    // The airspeed: the tunnel's plus the hover induced velocity of the summary's thrust at full speed.
    expect(v).toBeCloseTo(7 + Math.sqrt(8 / (2 * drive.densityKgM3 * Math.PI * (15.5 * 0.0254 / 2) ** 2)), 12);
    expect(drive.airspeedMps[0]).toBe(7);
  });

  it('fits a synthetic transient made by the same network', () => {
    const law: LossLaw = { resistance20cOhm: 0.08, noLoadTorque20cNm: 0.02, torqueConstant20cNmPerA: 0.025, noLoadCurrentA: 0.8 };
    const truth: ThermalValues = { windingHeatCapacityJPerK: 20, housingHeatCapacityJPerK: 70, windingToHousingKPerW: 0.8, housingToAirKPerW: 1.5, airflowCoolingPerMps: 0.08 };
    const shapes: [number, number, number, number][] = [[400, 4500, 14, 6], [400, 3200, 6, 11], [400, 2600, 2.5, 12]];
    const runs = shapes.map(([s, rpm, i, u]) => {
      const base = syntheticRun(s, rpm, i, u, () => 30), simulated = simulateRun(factory(heatValues(truth, law)), base, runDrive(base));
      return { ...base, raw: { ...base.raw, statorC: simulated.housingC } };
    });
    const fit = fitThermal(factory, runs, law);
    expect(fit.rmsK).toBeLessThan(0.01);
  }, 900_000);

  const dir = process.env.MIRAGE_MOTOR_THERMAL_DIR ?? '', inventoryPath = new URL('../data/motor-thermal/inventory.json', import.meta.url);
  it.skipIf(dir === '' || !existsSync(join(dir, 'Thermal data 2024-04-20')))('compares the network with the Texas A&M runs', () => {
    const inventoryBytes = readFileSync(inventoryPath);
    const inventory = JSON.parse(inventoryBytes.toString('utf8')) as {
      datasetId: string; citation: string; license: string; attribution: string; archives: { file: string; sha256: string }[];
      files: { path: string; sha256: string; bytes: number }[];
    };
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const files = new Map<string, string>();
    for (const item of inventory.files) {
      const bytes = readFileSync(join(dir, item.path));
      expect({ path: item.path, sha256: sha(bytes), bytes: bytes.byteLength }).toEqual(item);
      files.set(item.path, bytes.toString('utf8'));
    }
    const declared: Record<string, { fit: string[]; holdOut: string[] }> = {
      M02: { fit: ['u070 RPM4829', 'u080 RPM4388', 'u110 RPM4071', 'u090 RPM3269', 'u100 RPM2718'], holdOut: ['u070 RPM4683', 'u100 RPM3972', 'u080 RPM3526', 'u120 RPM3218', 'u120 RPM3003'] },
      M03: { fit: ['u070 RPM3030', 'u060 RPM3170', 'u100 RPM2580', 'u080 RPM2160', 'u060 RPM1940'], holdOut: ['u080 RPM2910', 'u050 RPM2630', 'u090 RPM2300', 'u070 RPM2060', 'u090 RPM1710'] },
      M05: { fit: ['u090 RPM6044', 'u130 RPM6284', 'u130 RPM4956', 'u080 RPM4045', 'u090 RPM3618'], holdOut: ['u100 RPM5877', 'u120 RPM5391', 'u110 RPM4644', 'u140 RPM4506', 'u100 RPM3508'] },
    };
    const motors = MOTOR_THERMAL_METHOD.motors.map(motor => {
      const folder = `Thermal data 2024-04-20/Motor ${Number(motor.slice(1))}/`;
      const runs = [...files.keys()].filter(path => path.startsWith(folder) && path.slice(folder.length).startsWith('wtRaw_')).map(path => {
        const file = path.slice(folder.length), name = parseRunName(file);
        if (!name) throw new Error(`Unexpected name ${file}`);
        const summary = files.get(folder + summaryFileName(name));
        if (summary === undefined) throw new Error(`No summary for ${file}`);
        return { name, raw: parseRawRun(files.get(path)!, file), summary: parseSummary(summary, summaryFileName(name)), file };
      });
      expect(runs.length).toBe(10);
      const split = splitRuns(runs);
      expect({ fit: split.fit.map(r => r.name.key), holdOut: split.holdOut.map(r => r.name.key) }).toEqual(declared[motor]);
      const law = fitLossLaw(split.fit.flatMap(r => [...r.summary]));
      const t0 = performance.now(), fit = fitThermal(factory, split.fit, law), seconds = (performance.now() - t0) / 1000;
      const network = factory(heatValues(fit.values, law));
      const compared = [...split.fit.map(r => compareRun(network, r, 'fit', r.file)), ...split.holdOut.map(r => compareRun(network, r, 'holdOut', r.file))];
      const lossRows = [...split.fit.map(r => ['fit', r] as const), ...split.holdOut.map(r => ['holdOut', r] as const)].flatMap(([role, r]) =>
        r.summary.map((row, i) => ({ run: r.name.key, role, row: i === 0 ? 'spool-up' : 'steady state', currentA: row.currentA, rpm: row.rpm, motorC: row.motorC,
          measuredLossW: measuredLossW(row), lawLossW: lawLossW(law, row) })));
      const first = runs[0]!.name;
      return { motor, paperMotor: Number(motor.slice(1)) - 1, propeller: { diameterM: first.propellerDiameterM, blades: first.blades },
        fitRuns: split.fit.map(r => r.name.key), holdOutRuns: split.holdOut.map(r => r.name.key), lossLaw: law, lossRows,
        thermalFit: { ...fit, seconds }, runs: compared };
    });
    for (const motor of motors) for (const run of motor.runs) {
      expect(Number.isFinite(run.rmsK)).toBe(true);
      expect(run.samples).toBeGreaterThan(300);
    }
    const holdOuts = motors.flatMap(m => m.runs.filter(r => r.role === 'holdOut'));
    const status = holdOuts.every(r => r.reproduced === true) ? 'REPRODUCED' : 'NOT_REPRODUCED';
    const out = process.env.MIRAGE_MOTOR_THERMAL_OUT;
    if (out) writeFileSync(out, `${JSON.stringify({
      schemaVersion: 1, kind: 'motor-thermal-runs', task: 'TASK-105',
      dataset: { id: inventory.datasetId, citation: inventory.citation, license: inventory.license, attribution: inventory.attribution, archives: inventory.archives },
      inventorySha256: sha(inventoryBytes), method: MOTOR_THERMAL_METHOD,
      model: { network: 'BetMotorV2 (packages/wasm-bet/src/motor-v2.ts) over bet_motor_thermal_step, scalar WASM build', wasmSha256: sha(readFileSync(WASM)) },
      notCompared: [{ motor: 'M04', reason: 'summary files only, and its file names do not give the propeller' }],
      motors, heldOutReproduced: holdOuts.filter(r => r.reproduced === true).length, heldOut: holdOuts.length, status,
    }, null, 1)}\n`);
  }, 4 * 3600_000);
});
