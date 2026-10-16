import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { FixedHistogram, StepMetrics, summarize } from '@mirage/physics';
import schema from '../docs/benchmarks/schema.json';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('step metrics recorder', () => {
  it('computes conservative quantiles within one bin, the exact maximum, and overflow', () => {
    const histogram = new FixedHistogram(1, 100);
    for (let value = 1; value <= 100; value++) histogram.record(value - 0.5); // 0.5 .. 99.5
    expect([histogram.count, histogram.mean]).toEqual([100, 50]);
    expect(histogram.quantile(0.5)).toBe(50); // true median 49.5..50.5 -> bin upper bound
    expect(histogram.quantile(0.99)).toBe(99);
    expect(histogram.quantile(1)).toBe(99.5); // exact max caps the last bin
    histogram.record(1e6); histogram.record(NaN); histogram.record(-1); histogram.record(Infinity);
    expect([histogram.count, histogram.overflow, histogram.max]).toEqual([101, 1, 1e6]);
    expect(histogram.quantile(1)).toBe(1e6);
    expect(summarize(histogram)).toMatchObject({ count: 101, p50: 51, max: 1e6, overflow: 1, binWidth: 1 });
    histogram.reset();
    expect([histogram.count, histogram.quantile(0.5)]).toEqual([0, NaN]);
    expect(() => new FixedHistogram(0, 10)).toThrow();
  });
  it('keeps compute, lateness, and executed rate separate', () => {
    const metrics = new StepMetrics();
    for (let i = 0; i <= 400; i++) metrics.recordWakeup(1.25, i % 4 === 0 ? 2 : 0.1, 1, 0, i * 2.5);
    expect(metrics.executedSteps).toBe(401);
    expect(metrics.executedHz).toBeCloseTo(401, 6); // 401 steps over 1 s
    expect(metrics.computeUs.quantile(0.5)).toBe(1.25); // bin upper bound capped by the exact maximum
    expect(metrics.latenessMs.quantile(0.99)).toBe(2);
  });
});

describe('bench-physics.mjs report', () => {
  it('measures zero allocations over 1e6 real session steps after warmup and validates against the schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-bench-')), out = join(dir, 'physics.json');
    try {
      const run = spawnSync(process.execPath, ['scripts/bench-physics.mjs', '--steps', '1000000', '--realtime-seconds', '1', '--out', out],
        { cwd: root, encoding: 'utf8' });
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const report: unknown = JSON.parse(readFileSync(out, 'utf8'));
      const validate = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
      expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
      if (typeof report !== 'object' || report === null || !('allocation' in report) || !('realtime' in report)) throw new Error('Invalid report');
      const allocation = report.allocation, realtime = report.realtime;
      expect(allocation).toMatchObject({ steps: 1_000_000, reachedSteadyState: true, gcEventsInWindows: 0, zeroAllocation: true,
        controls: { emptyLoopGcEvents: 0, allocatingLoop: { detected: true } } });
      expect(realtime).toMatchObject({ targetHz: 400 });
      if (typeof realtime !== 'object' || realtime === null || !('executedHz' in realtime) || typeof realtime.executedHz !== 'number') throw new Error('Invalid realtime');
      expect(realtime.executedHz).toBeGreaterThan(360); expect(realtime.executedHz).toBeLessThan(440);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
