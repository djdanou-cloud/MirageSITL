// Provenance manifest for surface-material data (TASK-069).
//
// Every dataset that contributes material classes is listed with provider,
// version, license, required attribution, SHA-256 of the local file, CRS and
// bounds. Licenses are allowlisted and attribution text is checked against
// the provider's requirement. Synthetic data must say so. This module has no
// network code: data is placed locally by a person under its license, and
// planWorldCoverTiles refuses region plans larger than an explicit limit, so
// nothing here performs or schedules bulk downloads.

export type DatasetProvider = "esa-worldcover" | "openstreetmap" | "synthetic";

export interface DatasetEntry {
  id: string;
  provider: DatasetProvider;
  version: string;
  license: "CC-BY-4.0" | "ODbL-1.0" | "CC0-1.0";
  attribution: string;
  /** SHA-256 of the local data file (null only for synthetic data generated in code). */
  sha256: string | null;
  crs: "EPSG:4326";
  /** Geographic bounds, degrees (south, west, north, east). */
  bounds: { south: number; west: number; north: number; east: number };
  synthetic: boolean;
}

export interface DataManifest { schema: "mirage.thermal-data/1"; datasets: readonly DatasetEntry[] }

/** License and attribution each provider requires (exact substrings). */
const PROVIDER_RULES: Record<DatasetProvider, { license: DatasetEntry["license"]; attribution: string }> = {
  // ESA WorldCover 10 m 2021 v200: CC BY 4.0, "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium".
  "esa-worldcover": { license: "CC-BY-4.0", attribution: "ESA WorldCover project" },
  // OpenStreetMap: ODbL 1.0, "© OpenStreetMap contributors".
  "openstreetmap": { license: "ODbL-1.0", attribution: "OpenStreetMap contributors" },
  "synthetic": { license: "CC0-1.0", attribution: "synthetic" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(k => actual.includes(k));
}

export function parseDataManifest(value: unknown): DataManifest {
  if (!isRecord(value) || !exactKeys(value, ["schema", "datasets"]) || value.schema !== "mirage.thermal-data/1" || !Array.isArray(value.datasets)) {
    throw new Error("Invalid thermal data manifest");
  }
  const ids = new Set<string>();
  const datasets = (value.datasets as unknown[]).map(raw => {
    if (!isRecord(raw) || !exactKeys(raw, ["id", "provider", "version", "license", "attribution", "sha256", "crs", "bounds", "synthetic"])) throw new Error("Invalid dataset entry");
    const { id, provider, version, license, attribution, sha256, crs, bounds, synthetic } = raw;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || ids.has(id)) throw new Error("Invalid or duplicate dataset id");
    ids.add(id);
    if (provider !== "esa-worldcover" && provider !== "openstreetmap" && provider !== "synthetic") throw new Error(`Unknown provider for ${id}`);
    const rule = PROVIDER_RULES[provider];
    if (license !== rule.license) throw new Error(`Dataset ${id} must carry license ${rule.license}`);
    if (typeof attribution !== "string" || !attribution.includes(rule.attribution)) throw new Error(`Dataset ${id} attribution must include "${rule.attribution}"`);
    if (typeof version !== "string" || !version.trim()) throw new Error(`Dataset ${id} needs a version`);
    if (synthetic !== (provider === "synthetic")) throw new Error(`Dataset ${id}: only the synthetic provider may be (and must be) marked synthetic`);
    if (sha256 !== null && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))) throw new Error(`Dataset ${id} has an invalid sha256`);
    if (sha256 === null && provider !== "synthetic") throw new Error(`Dataset ${id} needs the SHA-256 of its local file`);
    if (crs !== "EPSG:4326") throw new Error(`Dataset ${id} must use EPSG:4326`);
    if (!isRecord(bounds) || !exactKeys(bounds, ["south", "west", "north", "east"])) throw new Error(`Dataset ${id} has invalid bounds`);
    const { south, west, north, east } = bounds;
    if (typeof south !== "number" || typeof west !== "number" || typeof north !== "number" || typeof east !== "number" ||
      !(south >= -90 && north <= 90 && south < north && west >= -180 && east <= 180 && west < east)) throw new Error(`Dataset ${id} has invalid bounds`);
    return Object.freeze({ id, provider, version, license: rule.license, attribution, sha256, crs, bounds: Object.freeze({ south, west, north, east }), synthetic });
  });
  return Object.freeze({ schema: "mirage.thermal-data/1", datasets: Object.freeze(datasets) });
}

/** ESA WorldCover tiles are 3 x 3 degrees, named by their south-west corner (e.g. N45E006). */
export function worldCoverTileName(latDeg: number, lonDeg: number): string {
  if (!(latDeg >= -90 && latDeg < 90 && lonDeg >= -180 && lonDeg < 180)) throw new Error("Coordinate out of range");
  const lat = Math.floor(latDeg / 3) * 3, lon = Math.floor(lonDeg / 3) * 3;
  const ns = lat >= 0 ? "N" : "S", ew = lon >= 0 ? "E" : "W";
  return `${ns}${String(Math.abs(lat)).padStart(2, "0")}${ew}${String(Math.abs(lon)).padStart(3, "0")}`;
}

/**
 * Tile names needed for a region. Throws when more than `maxTiles` are
 * needed (default 4: a 10-15 km region spans at most 4 tiles), so a plan
 * cannot silently grow into a bulk download. Planning only: nothing is fetched.
 */
export function planWorldCoverTiles(bounds: DatasetEntry["bounds"], maxTiles = 4): string[] {
  if (!Number.isInteger(maxTiles) || maxTiles < 1 || maxTiles > 16) throw new Error("maxTiles must be 1..16");
  if (!(bounds.south < bounds.north && bounds.west < bounds.east)) throw new Error("Invalid bounds");
  const names: string[] = [];
  const lat0 = Math.floor(bounds.south / 3) * 3, lon0 = Math.floor(bounds.west / 3) * 3;
  for (let lat = lat0; lat < bounds.north; lat += 3) {
    for (let lon = lon0; lon < bounds.east; lon += 3) {
      names.push(worldCoverTileName(lat, lon));
      if (names.length > maxTiles) throw new Error(`Region needs more than ${maxTiles} WorldCover tiles; bulk acquisition needs explicit authorization`);
    }
  }
  return names;
}

/** Distinct attributions of the given datasets, in manifest order, for display. */
export function attributionsFor(manifest: DataManifest, datasetIds: Iterable<string>): string[] {
  const wanted = new Set(datasetIds);
  return manifest.datasets.filter(d => wanted.has(d.id)).map(d => d.attribution).filter((a, i, all) => all.indexOf(a) === i);
}
