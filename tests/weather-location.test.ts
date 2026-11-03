import { describe, expect, test } from 'vitest';
import { DEFAULT_HOME } from '../apps/web/src/sitl/sitl-run';
import { COORDINATES, formOf, locationOf } from '../apps/web/src/weather/location-form';
import {
  DEFAULT_LOCATION, LOCATION_SETTING, SITES, atSite, describeLocation, homeOf, loadLocation, parseLocation, saveLocation, type LocationChoice,
} from '../apps/web/src/weather/location';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store';

// TASK-148 (S07): the location choice of the Weather and location tab, kept per project in the store's local
// settings, its envelope, the home it gives ArduPilot, and the form it is typed into.
const PROJECT_A = '00000000-0000-4000-8000-00000000000a', PROJECT_B = '00000000-0000-4000-8000-00000000000b';
const ISRAEL: LocationChoice = { site: null, latitudeDeg: 31.5, longitudeDeg: 34.9, groundElevationMslM: 250, headingDeg: 90, measuredQnhPa: 102000, temperatureOffsetK: 5 };
const newStore = () => new ProjectStore(new MemoryBackend(), { storage: null });

describe('the location of the flight (TASK-148)', () => {
  test('the default location is the Run tab\'s former fixed home, ArduPilot\'s SITL test site', () => {
    expect(homeOf(DEFAULT_LOCATION)).toEqual(DEFAULT_HOME);
    expect(DEFAULT_LOCATION.site).toBe('cmac');
    expect(SITES.find(site => site.id === 'cmac')).toMatchObject({ latitudeDeg: -35.363261, longitudeDeg: 149.16523, groundElevationMslM: 584, headingDeg: 0 });
    expect(parseLocation(DEFAULT_LOCATION)).toEqual(DEFAULT_LOCATION);
    expect(homeOf(ISRAEL)).toEqual([31.5, 34.9, 250, 90]);
  });
  test('accepts coordinates inside the envelope and refuses everything else', () => {
    expect(parseLocation(ISRAEL)).toEqual(ISRAEL);
    for (const bad of [
      { ...ISRAEL, latitudeDeg: 90 }, { ...ISRAEL, longitudeDeg: 181 }, { ...ISRAEL, groundElevationMslM: 9001 }, { ...ISRAEL, groundElevationMslM: Number.NaN },
      { ...ISRAEL, headingDeg: 361 }, { ...ISRAEL, measuredQnhPa: 80000 }, { ...ISRAEL, measuredQnhPa: '1020' }, { ...ISRAEL, temperatureOffsetK: 51 },
      { ...ISRAEL, site: 'atlantis' }, { ...ISRAEL, site: '' }, { ...ISRAEL, extra: 1 }, { ...DEFAULT_LOCATION, groundElevationMslM: 600 }, null, 'cmac', [],
    ]) expect(parseLocation(bad), JSON.stringify(bad)).toBeNull();
    const partial: Record<string, unknown> = { ...ISRAEL };
    Reflect.deleteProperty(partial, 'headingDeg');
    expect(parseLocation(partial)).toBeNull();
  });
  test('is kept per project, survives a reload, and a damaged setting costs only the choice', async () => {
    const store = newStore();
    expect(await loadLocation(store, PROJECT_A)).toEqual(DEFAULT_LOCATION);
    await saveLocation(store, PROJECT_A, ISRAEL);
    expect(await loadLocation(store, PROJECT_A)).toEqual(ISRAEL);
    expect(await loadLocation(store, PROJECT_B)).toEqual(DEFAULT_LOCATION);
    await saveLocation(store, PROJECT_B, DEFAULT_LOCATION);
    expect(await loadLocation(store, PROJECT_A)).toEqual(ISRAEL);
    expect(await store.readSetting(LOCATION_SETTING)).toEqual({ schemaVersion: 1, projects: { [PROJECT_A]: ISRAEL, [PROJECT_B]: DEFAULT_LOCATION } });
    await store.writeSetting(LOCATION_SETTING, { schemaVersion: 1, projects: { [PROJECT_A]: { ...ISRAEL, latitudeDeg: 'north' }, [PROJECT_B]: DEFAULT_LOCATION } });
    expect(await loadLocation(store, PROJECT_A)).toEqual(DEFAULT_LOCATION);
    expect(await loadLocation(store, PROJECT_B)).toEqual(DEFAULT_LOCATION);
    await store.writeSetting(LOCATION_SETTING, 'damaged');
    expect(await loadLocation(store, PROJECT_A)).toEqual(DEFAULT_LOCATION);
    await saveLocation(store, PROJECT_A, ISRAEL);
    expect(await store.readSetting(LOCATION_SETTING)).toEqual({ schemaVersion: 1, projects: { [PROJECT_A]: ISRAEL } });
    await expect(saveLocation(store, PROJECT_A, { ...ISRAEL, headingDeg: -1 })).rejects.toThrow('outside its envelope');
  });
  test('the form round-trips a location, names each problem, and converts the QNH from hPa', () => {
    expect(formOf(ISRAEL)).toEqual({ site: COORDINATES, latitudeDeg: '31.5', longitudeDeg: '34.9', groundElevationMslM: '250', headingDeg: '90', pressure: 'measured',
      qnhHpa: '1020', temperatureOffsetK: '5' });
    expect(formOf(DEFAULT_LOCATION)).toMatchObject({ site: 'cmac', pressure: 'standard', qnhHpa: '1013.25' });
    expect(locationOf(formOf(ISRAEL))).toEqual({ location: ISRAEL, problems: [] });
    expect(locationOf(formOf(DEFAULT_LOCATION))).toEqual({ location: DEFAULT_LOCATION, problems: [] });
    expect(locationOf({ ...formOf(ISRAEL), qnhHpa: '1013.5' }).location?.measuredQnhPa).toBe(101350);
    expect(locationOf({ ...formOf(ISRAEL), pressure: 'standard' }).location?.measuredQnhPa).toBeNull();
    expect(locationOf({ ...formOf(ISRAEL), latitudeDeg: '', groundElevationMslM: '9500', qnhHpa: 'low' })).toEqual({ location: null,
      problems: ['Latitude must be a number from -89.9 to 89.9', 'Ground elevation must be a number from -500 to 9000', 'Measured QNH (hPa) must be a number from 870 to 1085'] });
    expect(locationOf({ ...formOf(DEFAULT_LOCATION), groundElevationMslM: '600' })).toEqual({ location: null,
      problems: ['The location does not match its site; choose Coordinates to change it'] });
  });
  test('moves to a site keeping the pressure choices, and describes itself in one line', () => {
    const cmac = SITES[0];
    if (!cmac) throw new Error('No site');
    expect(atSite(ISRAEL, cmac)).toEqual({ ...DEFAULT_LOCATION, measuredQnhPa: 102000, temperatureOffsetK: 5 });
    expect(describeLocation(DEFAULT_LOCATION)).toBe('ArduPilot SITL test site (CMAC, Canberra), heading 0°, standard sea-level pressure');
    expect(describeLocation(ISRAEL)).toBe('31.5°, 34.9°, 250 m above mean sea level, heading 90°, QNH 1020.00 hPa, ISA +5 K');
  });
});
