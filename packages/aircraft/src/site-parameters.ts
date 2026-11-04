// Parameters that follow from where a run starts (TASK-172). COMPASS_DEC is the
// one: a vehicle keeps it between boots, and a MirageSITL run boots with an empty
// memory, so without it ArduPilot sets its first heading before it has a position
// and is wrong by the whole local declination (12.8° at the default home). When
// GPS arrives the heading swings back, and the estimator takes part of that swing
// for a gyro error it unlearns only over minutes: the true heading then creeps
// away from the one requested, about 2° during the first flight. The value comes
// from ArduPilot's own table (data/ardupilot/declination.json), interpolated as
// AP_Declination::get_mag_field_ef does, so COMPASS_AUTODEC arrives at the same
// value once ArduPilot knows where it is.
//
// ArduPilot manages this value itself, so a run does not read it back: the
// read-back (TASK-154) holds the generated parameters ArduPilot must keep.
import tableFile from '../../../data/ardupilot/declination.json' with { type: 'json' };

export const SITE_PARAMETER_NAMES: ReadonlySet<string> = new Set(['COMPASS_DEC']);

interface DeclinationTable {
  readonly resolutionDeg: number;
  readonly minLatitudeDeg: number; readonly maxLatitudeDeg: number;
  readonly minLongitudeDeg: number; readonly maxLongitudeDeg: number;
  readonly rowsDeg: readonly (readonly number[])[];
}
const TABLE: DeclinationTable = tableFile;

/** The lower grid line of a coordinate, and how far along the cell it lies, keeping the last cell at the table's end. */
function cellOf(valueDeg: number, minDeg: number, maxDeg: number, resolutionDeg: number): { readonly index: number; readonly share: number } {
  const lastIndex = Math.round((maxDeg - minDeg) / resolutionDeg) - 1;
  const index = Math.min(Math.max(Math.floor((valueDeg - minDeg) / resolutionDeg), 0), lastIndex);
  return { index, share: (valueDeg - (minDeg + index * resolutionDeg)) / resolutionDeg };
}

/** ArduPilot's declination at a place, degrees east of true north. */
export function compassDeclinationDeg(latitudeDeg: number, longitudeDeg: number): number {
  if (!(latitudeDeg >= TABLE.minLatitudeDeg && latitudeDeg <= TABLE.maxLatitudeDeg)) throw new Error(`Latitude ${String(latitudeDeg)} is outside the declination table`);
  if (!(longitudeDeg >= TABLE.minLongitudeDeg && longitudeDeg <= TABLE.maxLongitudeDeg)) throw new Error(`Longitude ${String(longitudeDeg)} is outside the declination table`);
  const lat = cellOf(latitudeDeg, TABLE.minLatitudeDeg, TABLE.maxLatitudeDeg, TABLE.resolutionDeg);
  const lon = cellOf(longitudeDeg, TABLE.minLongitudeDeg, TABLE.maxLongitudeDeg, TABLE.resolutionDeg);
  const at = (row: number, column: number): number => {
    const value = TABLE.rowsDeg[row]?.[column];
    if (value === undefined) throw new Error('The declination table has no such cell');
    return value;
  };
  const southWest = at(lat.index, lon.index), southEast = at(lat.index, lon.index + 1), northWest = at(lat.index + 1, lon.index), northEast = at(lat.index + 1, lon.index + 1);
  const south = lon.share * (southEast - southWest) + southWest, north = lon.share * (northEast - northWest) + northWest;
  return lat.share * (north - south) + south;
}

/** What a run started at `home` (latitude and longitude first) is given before ArduPilot boots; COMPASS_DEC is in radians, as ArduPilot stores it. */
export function siteParameters(home: readonly number[]): readonly { readonly name: string; readonly value: number }[] {
  const [latitudeDeg, longitudeDeg] = home;
  if (latitudeDeg === undefined || longitudeDeg === undefined) throw new Error('A run\'s home needs a latitude and a longitude');
  return [{ name: 'COMPASS_DEC', value: Math.fround(compassDeclinationDeg(latitudeDeg, longitudeDeg) * Math.PI / 180) }];
}
