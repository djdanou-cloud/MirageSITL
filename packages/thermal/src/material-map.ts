// Surface material map (TASK-069): ESA WorldCover 10 m land classes with
// OpenStreetMap road and building overlays, every sample carrying its source
// dataset. A material class is NOT a temperature: samples hold no thermal
// quantity, and thermal state (TASK-070) needs calibrated properties.
//
// Precedence: OSM building (roof, by roof:material) > OSM road (within half
// its nominal width) > WorldCover pixel > synthetic default. Missing data
// (outside every layer, or WorldCover no-data) is returned as the synthetic
// material with synthetic = true, never silently as a real class.
//
// WorldCover raster: EPSG:4326, pixel-is-area, row 0 at the north edge,
// column 0 at the west edge; a point on a pixel boundary belongs to the pixel
// to its south/east. Overlay geometry is evaluated in a local tangent plane
// at the map origin (adequate for the 10-15 km regions used here).
import { LocalTangentFrame } from "@mirage/sensors/geodesy";
import type { DataManifest, DatasetEntry } from "./data-manifest.ts";

export interface MaterialClasses {
  worldcover: ReadonlyMap<number, { material: string; label: string }>;
  nodata: number;
  building: string;
  roofMaterial: ReadonlyMap<string, string>;
  highway: ReadonlyMap<string, { material: string; widthM: number }>;
  synthetic: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every(k => actual.includes(k))) throw new Error(`Invalid ${what}: expected keys ${keys.join(", ")}`);
}
const MATERIAL_ID = /^[a-z][a-z0-9-]{0,47}$/;
function materialId(value: unknown, what: string): string {
  if (typeof value !== "string" || !MATERIAL_ID.test(value)) throw new Error(`Invalid material id for ${what}`);
  return value;
}

/** Parses tests/fixtures/thermal/material-classes.json-style legends. Unknown keys (e.g. a temperature) are rejected. */
export function parseMaterialClasses(value: unknown): MaterialClasses {
  if (!isRecord(value)) throw new Error("Invalid material classes");
  exactKeys(value, ["schema", "note", "worldcover", "osm", "synthetic"], "material classes");
  if (value.schema !== "mirage.material-classes/1") throw new Error("Unsupported material classes schema");
  const wc = value.worldcover, osm = value.osm;
  if (!isRecord(wc) || !isRecord(osm)) throw new Error("Invalid material classes");
  exactKeys(wc, ["source", "nodata", "classes"], "worldcover legend");
  exactKeys(osm, ["source", "building", "roofMaterial", "highway"], "osm legend");
  if (typeof wc.nodata !== "number" || !Number.isInteger(wc.nodata) || !isRecord(wc.classes) || !isRecord(osm.roofMaterial) || !isRecord(osm.highway)) {
    throw new Error("Invalid material classes");
  }
  const worldcover = new Map<number, { material: string; label: string }>();
  for (const [code, entry] of Object.entries(wc.classes)) {
    const n = Number(code);
    if (!Number.isInteger(n) || n < 1 || n > 255 || n === wc.nodata || !isRecord(entry)) throw new Error(`Invalid WorldCover class ${code}`);
    exactKeys(entry, ["material", "label"], `WorldCover class ${code}`);
    if (typeof entry.label !== "string" || !entry.label) throw new Error(`Invalid WorldCover label ${code}`);
    worldcover.set(n, { material: materialId(entry.material, `class ${code}`), label: entry.label });
  }
  const roofMaterial = new Map<string, string>();
  for (const [tag, material] of Object.entries(osm.roofMaterial)) roofMaterial.set(tag, materialId(material, `roof:material=${tag}`));
  const highway = new Map<string, { material: string; widthM: number }>();
  for (const [tag, entry] of Object.entries(osm.highway)) {
    if (!isRecord(entry)) throw new Error(`Invalid highway=${tag}`);
    exactKeys(entry, ["material", "widthM"], `highway=${tag}`);
    if (typeof entry.widthM !== "number" || !(entry.widthM > 0 && entry.widthM <= 100)) throw new Error(`Invalid width for highway=${tag}`);
    highway.set(tag, { material: materialId(entry.material, `highway=${tag}`), widthM: entry.widthM });
  }
  return { worldcover, nodata: wc.nodata, building: materialId(osm.building, "building"), roofMaterial, highway, synthetic: materialId(value.synthetic, "synthetic") };
}

export interface WorldCoverRaster {
  datasetId: string;
  /** North edge latitude and west edge longitude of row 0 / column 0, degrees. */
  northDeg: number;
  westDeg: number;
  /** Pixel size, degrees (WorldCover: 1/12000). */
  pixelDeg: number;
  width: number;
  height: number;
  /** Row-major class codes, row 0 at the north edge. */
  data: Uint8Array;
}
export interface OsmFeature { datasetId: string; tags: Readonly<Record<string, string>>; coordinates: readonly (readonly [number, number])[] }

export type MaterialSource = "osm-building" | "osm-road" | "worldcover" | "synthetic";
/** A material sample: class identity and provenance only, no thermal quantity. */
export interface MaterialSample {
  material: string;
  source: MaterialSource;
  synthetic: boolean;
  datasetId: string | null;
  worldCoverClass: number | null;
}

interface Building { datasetId: string; material: string; ring: Float64Array; synthetic: boolean }
interface Road { datasetId: string; material: string; halfWidthM: number; line: Float64Array; synthetic: boolean }

export class MaterialMap {
  private readonly frame: LocalTangentFrame;
  private readonly buildings: Building[] = [];
  private readonly roads: Road[] = [];
  private readonly rasters: { raster: WorldCoverRaster; synthetic: boolean }[] = [];
  private readonly used = new Set<string>();
  private readonly ned = new Float64Array(3);
  private readonly deg = Math.PI / 180;

  constructor(private readonly classes: MaterialClasses, private readonly manifest: DataManifest, origin: { latDeg: number; lonDeg: number },
    layers: { worldcover?: readonly WorldCoverRaster[]; buildings?: readonly OsmFeature[]; roads?: readonly OsmFeature[] }) {
    this.frame = new LocalTangentFrame(origin.latDeg * this.deg, origin.lonDeg * this.deg, 0);
    for (const raster of layers.worldcover ?? []) {
      const entry = this.dataset(raster.datasetId, ["esa-worldcover", "synthetic"]);
      if (!(raster.pixelDeg > 0) || !Number.isInteger(raster.width) || !Number.isInteger(raster.height) || raster.width < 1 || raster.height < 1 ||
        raster.data.length !== raster.width * raster.height) throw new Error(`Invalid raster ${raster.datasetId}`);
      const south = raster.northDeg - raster.height * raster.pixelDeg, east = raster.westDeg + raster.width * raster.pixelDeg;
      const b = entry.bounds, eps = raster.pixelDeg;
      if (Math.abs(b.north - raster.northDeg) > eps || Math.abs(b.west - raster.westDeg) > eps || Math.abs(b.south - south) > eps || Math.abs(b.east - east) > eps) {
        throw new Error(`Raster ${raster.datasetId} does not match its manifest bounds`);
      }
      for (const code of raster.data) if (code !== classes.nodata && !classes.worldcover.has(code)) throw new Error(`Unknown WorldCover class ${code} in ${raster.datasetId}`);
      this.rasters.push({ raster, synthetic: entry.synthetic });
    }
    for (const feature of layers.buildings ?? []) {
      const entry = this.dataset(feature.datasetId, ["openstreetmap", "synthetic"]);
      if (!("building" in feature.tags)) throw new Error("Building features need a building tag");
      if (feature.coordinates.length < 3) throw new Error("Building ring needs at least three vertices");
      const roof = feature.tags["roof:material"];
      const material = (roof !== undefined ? classes.roofMaterial.get(roof) : undefined) ?? classes.building;
      this.buildings.push({ datasetId: feature.datasetId, material, ring: this.toLocal(feature.coordinates), synthetic: entry.synthetic });
    }
    for (const feature of layers.roads ?? []) {
      const entry = this.dataset(feature.datasetId, ["openstreetmap", "synthetic"]);
      const highway = feature.tags.highway;
      const style = highway === undefined ? undefined : classes.highway.get(highway);
      if (!style) continue; // footpaths and unknown highway values carry no surface material here
      if (feature.coordinates.length < 2) throw new Error("Road line needs at least two vertices");
      this.roads.push({ datasetId: feature.datasetId, material: style.material, halfWidthM: style.widthM / 2, line: this.toLocal(feature.coordinates), synthetic: entry.synthetic });
    }
  }

  private dataset(id: string, providers: readonly DatasetEntry["provider"][]): DatasetEntry {
    const entry = this.manifest.datasets.find(d => d.id === id);
    if (!entry) throw new Error(`Dataset ${id} is not in the data manifest`);
    if (!providers.includes(entry.provider)) throw new Error(`Dataset ${id} (${entry.provider}) cannot provide this layer`);
    return entry;
  }

  /** [lat, lon] degrees -> flat [north, east] metres in the map's tangent plane. */
  private toLocal(coordinates: readonly (readonly [number, number])[]): Float64Array {
    const out = new Float64Array(coordinates.length * 2);
    coordinates.forEach(([lat, lon], i) => {
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error("Invalid feature coordinate");
      this.frame.geodeticToNedInto(lat * this.deg, lon * this.deg, 0, this.ned);
      out[2 * i] = this.ned[0]!; out[2 * i + 1] = this.ned[1]!; // ned has length 3
    });
    return out;
  }

  /** Material at a coordinate (degrees). */
  sampleAt(latDeg: number, lonDeg: number): MaterialSample {
    if (!(Math.abs(latDeg) <= 90 && Math.abs(lonDeg) <= 180)) throw new Error("Invalid coordinate");
    this.frame.geodeticToNedInto(latDeg * this.deg, lonDeg * this.deg, 0, this.ned);
    const n = this.ned[0]!, e = this.ned[1]!; // ned has length 3
    for (const b of this.buildings) if (insideRing(b.ring, n, e)) return this.result(b.material, "osm-building", b.synthetic, b.datasetId, null);
    for (const r of this.roads) if (distanceToLine(r.line, n, e) <= r.halfWidthM) return this.result(r.material, "osm-road", r.synthetic, r.datasetId, null);
    for (const { raster, synthetic } of this.rasters) {
      const row = Math.floor((raster.northDeg - latDeg) / raster.pixelDeg + 1e-9), col = Math.floor((lonDeg - raster.westDeg) / raster.pixelDeg + 1e-9);
      if (row < 0 || row >= raster.height || col < 0 || col >= raster.width) continue;
      const code = raster.data[row * raster.width + col]!; // bounds checked above
      if (code === this.classes.nodata) continue;
      const cls = this.classes.worldcover.get(code)!; // validated at construction
      return this.result(cls.material, "worldcover", synthetic, raster.datasetId, code);
    }
    return { material: this.classes.synthetic, source: "synthetic", synthetic: true, datasetId: null, worldCoverClass: null };
  }

  private result(material: string, source: MaterialSource, synthetic: boolean, datasetId: string, code: number | null): MaterialSample {
    this.used.add(datasetId);
    return { material, source, synthetic, datasetId, worldCoverClass: code };
  }

  /** Attributions of every dataset that contributed a sample so far, for display next to the view. */
  attributions(): string[] {
    const ids = this.used;
    return this.manifest.datasets.filter(d => ids.has(d.id)).map(d => d.attribution).filter((a, i, all) => all.indexOf(a) === i);
  }
}

/** Even-odd point-in-polygon on a flat [n0, e0, n1, e1, ...] ring. */
function insideRing(ring: Float64Array, n: number, e: number): boolean {
  let inside = false;
  const count = ring.length / 2;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const ni = ring[2 * i]!, ei = ring[2 * i + 1]!, nj = ring[2 * j]!, ej = ring[2 * j + 1]!; // indices < ring.length
    if ((ni > n) !== (nj > n) && e < ((ej - ei) * (n - ni)) / (nj - ni) + ei) inside = !inside;
  }
  return inside;
}

/** Shortest distance (m) from (n, e) to a flat polyline. */
function distanceToLine(line: Float64Array, n: number, e: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const n0 = line[i]!, e0 = line[i + 1]!, n1 = line[i + 2]!, e1 = line[i + 3]!; // i + 3 < length
    const dn = n1 - n0, de = e1 - e0, len2 = dn * dn + de * de;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((n - n0) * dn + (e - e0) * de) / len2)) : 0;
    best = Math.min(best, Math.hypot(n - (n0 + t * dn), e - (e0 + t * de)));
  }
  return best;
}
