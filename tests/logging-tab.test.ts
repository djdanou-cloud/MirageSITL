import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGGING, parseLoggingSettings, planOf } from '../apps/web/src/logging/logging-settings.ts';
import { growth, type LiveRecording } from '../apps/web/src/logging/recording-monitor.ts';
import { estimatedBytes, estimateRecording, RUN_TAB_SOURCES } from '../apps/web/src/logging/size-estimate.ts';
import { freeBytes, storageWarnings } from '../apps/web/src/logging/storage-warning.ts';

// TASK-163: the Logging tab's settings, rate refusals and storage warnings.

const MB = 1e6;

describe('logging settings', () => {
  it('start from A-09: every signal at 50 Hz, a 60-minute run and a 500 MB reserve', () => {
    expect(DEFAULT_LOGGING).toMatchObject({ commonHz: 50, groups: {}, signals: {}, durationMin: 60, reserveMb: 500 });
    const plan = planOf(DEFAULT_LOGGING, 800);
    for (const signal of plan.signals) {
      if (signal.source === 'event') continue;
      // Autopilot telemetry arrives at the 10 Hz streams the Run tab requests, so 50 Hz is limited to it.
      expect([signal.name, signal.effectiveHz]).toEqual([signal.name, signal.source === 'telemetry' ? 10 : 50]);
    }
  });

  it('refuse rates the recorder cannot keep, naming them, and read back what they saved', () => {
    expect(() => planOf({ ...DEFAULT_LOGGING, commonHz: 2500 }, 800)).toThrow('commonHz: a rate is 0 or a whole number of hertz from 1 to 2000');
    expect(() => planOf({ ...DEFAULT_LOGGING, groups: { motors: 0.5 } }, 800)).toThrow('groups.motors');
    expect(() => planOf({ ...DEFAULT_LOGGING, signals: { 'events.pause': 10 } }, 800)).toThrow('events.pause is an event and is always recorded');
    expect(() => planOf({ ...DEFAULT_LOGGING, signals: { 'truth.speed': 10 } }, 800)).toThrow('Unknown signal truth.speed');
    // A request above a source's rate is recorded at the source's rate and marked capped.
    expect(planOf({ ...DEFAULT_LOGGING, groups: { motors: 2000 } }, 800).signals.find(s => s.name === 'motors.speed'))
      .toMatchObject({ requestedHz: 2000, effectiveHz: 800, capped: true });
    const saved = { schemaVersion: 1, commonHz: 100, groups: { truth: 400 }, signals: { 'autopilot.ekf': 0 }, durationMin: 30, reserveMb: 250 };
    expect(parseLoggingSettings(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    for (const broken of [{ ...saved, schemaVersion: 2 }, { ...saved, commonHz: 9999 }, { ...saved, groups: { wings: 10 } }, { ...saved, durationMin: 0 },
      { ...saved, reserveMb: -5 }, null, 'logging']) {
      expect(parseLoggingSettings(broken)).toBeNull();
    }
  });
});

describe('storage warnings', () => {
  const estimate = estimateRecording(planOf(DEFAULT_LOGGING, 800), RUN_TAB_SOURCES);
  const hour = estimatedBytes(estimate, 3600);

  it('warn before a run whose length needs more than is free beyond the reserve, and not when it fits', () => {
    const roomy = { quotaBytes: 10_000 * MB, usageBytes: 100 * MB };
    expect(storageWarnings(roomy, hour, 500 * MB, null)).toEqual([]);
    // Low quota: free storage covers less than the hour beyond the reserve.
    const low = { quotaBytes: 600 * MB, usageBytes: 50 * MB };
    expect(freeBytes(low)).toBe(550 * MB);
    const [warning, ...rest] = storageWarnings(low, hour, 500 * MB, null);
    expect(rest).toEqual([]);
    expect(warning).toContain(`needs about ${(hour / MB).toFixed(1)} MB, but only 50.0 MB is free beyond the 500.0 MB reserve`);
  });

  it('while a run records, warn before exhaustion at the measured growth, and once free storage falls below the reserve', () => {
    const storage = { quotaBytes: 2000 * MB, usageBytes: 1000 * MB };
    // 100 kB per simulated second for the 3000 s left needs 300 MB: room is 500 MB, no warning; 2000 s more at 300 kB/s is 600 MB.
    expect(storageWarnings(storage, hour, 500 * MB, { bytesPerSimS: 100e3, remainingSimS: 3000 })).toEqual([]);
    expect(storageWarnings(storage, hour, 500 * MB, { bytesPerSimS: 300e3, remainingSimS: 2000 })[0]).toContain('needs about 600.0 MB more for the rest of the run');
    expect(storageWarnings({ quotaBytes: 2000 * MB, usageBytes: 1700 * MB }, hour, 500 * MB, { bytesPerSimS: 1, remainingSimS: 1 })[0])
      .toContain('Only 300.0 MB of storage is free, less than the 500.0 MB reserve');
  });
});

describe('live growth', () => {
  it('reports growth per simulated hour and per real second once a second of each has passed', () => {
    const live: LiveRecording = { recordId: 'f'.repeat(32), experimentId: 'run', state: 'recording', simTimeS: 41, startSimTimeS: 1, wallMs: 30_000, startWallMs: 10_000,
      bytes: 4_000_000, rows: {}, lostRows: 0, droppedChunks: 0, error: '' };
    expect(growth(live)).toEqual({ perSimS: 100_000, perWallS: 200_000 });
    expect(growth({ ...live, simTimeS: 1.5, wallMs: 10_500 })).toEqual({ perSimS: null, perWallS: null });
  });
});
