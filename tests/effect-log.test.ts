import { describe, expect, test } from 'vitest';
import { EFFECT_LOG_SCHEMA_VERSION, EFFECT_LOG_SCHEMA_VERSION_1, validateEffectLog } from '../apps/web/src/faults/effect-log';

// TASK-167: effect log schema 2 keeps each control's values, so a weather change is logged with them and its seeds; a TASK-169
// schema 1 log reads as schema 2 without them.
const SHA = 'a'.repeat(64);
const entry = { id: 'wind-gust', effect: 'wind.gust', enabled: true, intensity: 1, status: 'applied', message: '', origin: 'manual', requestedSimS: 12.5, appliedSimS: 12.5,
  writes: [], parameters: { rmsMps: 1.5, bandwidthHz: 1, seed: 1234 } };

describe('the effect log (TASK-169, TASK-167)', () => {
  test('keeps each control\'s values in schema 2', () => {
    const log = validateEffectLog({ schemaVersion: 2, experimentSha256: SHA, entries: [entry] });
    expect(log.schemaVersion).toBe(EFFECT_LOG_SCHEMA_VERSION);
    expect(log.entries[0]?.parameters).toEqual({ rmsMps: 1.5, bandwidthHz: 1, seed: 1234 });
  });
  test('reads schema 1 without values and refuses values the protocol would not accept', () => {
    const { parameters: _dropped, ...v1Entry } = entry;
    void _dropped;
    expect(validateEffectLog({ schemaVersion: EFFECT_LOG_SCHEMA_VERSION_1, experimentSha256: SHA, entries: [v1Entry] }).entries[0]?.parameters).toBeNull();
    expect(() => validateEffectLog({ schemaVersion: 1, experimentSha256: SHA, entries: [entry] })).toThrow('unexpected field parameters');
    expect(() => validateEffectLog({ schemaVersion: 2, experimentSha256: SHA, entries: [v1Entry] })).toThrow('entries[0].parameters');
    expect(() => validateEffectLog({ schemaVersion: 2, experimentSha256: SHA, entries: [{ ...entry, parameters: { rmsMps: 60, bandwidthHz: 1, seed: 1 } }] })).toThrow('rmsMps');
    expect(() => validateEffectLog({ schemaVersion: 3, experimentSha256: SHA, entries: [entry] })).toThrow('schemaVersion must be 2 or 1');
  });
});
