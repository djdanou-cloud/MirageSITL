// Surface-material drape (TASK-073 P4): colours terrain tiles by the material
// class raster built by scripts/geodata/build_material_map.py. Display only:
// a class is not a temperature (thermal emissivity per class is P5).
//
// The raster is a square grid in metres east/north of the render origin
// (local transverse Mercator at the area centre), row 0 at the north edge.
// Render frame: x = east, y = up, z = -north (apps/web/src/coordinates.ts), so
// a fragment at world (x, z) reads texel u = (x - west) / (east - west),
// v = (north - (-z)) / (north - south). Outside the grid the tile keeps its
// base ground colour.
import { parseDataManifest, attributionsFor, type DataManifest } from "@mirage/thermal/data-manifest";
import {
  DataTexture, NearestFilter, RedFormat, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector4, type MeshStandardMaterial,
} from "three";

export interface MaterialRaster {
  origin: { latDeg: number; lonDeg: number };
  pixelM: number;
  width: number;
  height: number;
  extentM: { west: number; east: number; south: number; north: number };
  materials: readonly string[];
  datasets: readonly string[];
}

/** Display colours (sRGB) per material id; unknown ids use the base ground colour. */
export const MATERIAL_COLORS: Readonly<Record<string, number>> = Object.freeze({
  "synthetic-ground": 0x9c8b6a, "vegetation-tree": 0x3f6b3a, "vegetation-shrub": 0x6c7a45, "vegetation-grass": 0x8a9a55,
  "cropland": 0xa49a5c, "built-up": 0x9a948a, "bare-soil": 0xb9a47c, "snow-ice": 0xf0f0f0, "water": 0x3d6f8f,
  "wetland": 0x5e7f6a, "mangrove": 0x41604a, "moss-lichen": 0x8c9a7a, "roof-generic": 0x8d8478, "roof-metal": 0xa9adb2,
  "roof-concrete": 0xb0aba3, "roof-tile": 0xa0563c, "roof-bitumen": 0x4a4a4a, "roof-glass": 0x7aa0b0,
  "asphalt": 0x4b4d50, "gravel": 0x9b9182,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid material raster ${what}`);
  return value;
}

/** Validates materials.json (schema mirage.material-raster/1). */
export function parseMaterialRaster(value: unknown): MaterialRaster {
  if (!isRecord(value) || value.schema !== "mirage.material-raster/1") throw new Error("Unsupported material raster schema");
  const { origin, extentM, materials, datasets } = value;
  if (!isRecord(origin) || !isRecord(extentM) || !Array.isArray(materials) || !Array.isArray(datasets)) throw new Error("Invalid material raster");
  const width = finite(value.width, "width"), height = finite(value.height, "height"), pixelM = finite(value.pixelM, "pixelM");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || !(pixelM > 0)) {
    throw new Error("Invalid material raster grid");
  }
  const extent = { west: finite(extentM.west, "west"), east: finite(extentM.east, "east"), south: finite(extentM.south, "south"), north: finite(extentM.north, "north") };
  if (Math.abs((extent.east - extent.west) - width * pixelM) > pixelM || Math.abs((extent.north - extent.south) - height * pixelM) > pixelM) {
    throw new Error("Material raster extent does not match its grid");
  }
  if (materials.length < 1 || materials.length > 256 || !materials.every(m => typeof m === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(m))) {
    throw new Error("Invalid material raster class table");
  }
  if (!datasets.every(d => typeof d === "string")) throw new Error("Invalid material raster datasets");
  return { origin: { latDeg: finite(origin.latDeg, "origin"), lonDeg: finite(origin.lonDeg, "origin") }, pixelM, width, height, extentM: extent,
    materials: materials.filter((m): m is string => typeof m === "string"), datasets: datasets.filter((d): d is string => typeof d === "string") };
}

/** 256 x 1 RGBA palette: class index -> display colour (unused entries transparent). */
export function paletteBytes(materials: readonly string[]): Uint8Array {
  const bytes = new Uint8Array(256 * 4);
  materials.forEach((material, i) => {
    const color = MATERIAL_COLORS[material];
    if (color === undefined) return;
    bytes[4 * i] = (color >> 16) & 0xff; bytes[4 * i + 1] = (color >> 8) & 0xff; bytes[4 * i + 2] = color & 0xff; bytes[4 * i + 3] = 255;
  });
  return bytes;
}

export class MaterialDrape {
  readonly classTexture: DataTexture;
  readonly paletteTexture: DataTexture;
  /** west, south, east, north in render-frame metres (north positive). */
  readonly extent: Vector4;
  readonly attributions: readonly string[];

  constructor(readonly raster: MaterialRaster, classes: Uint8Array, readonly manifest: DataManifest) {
    if (classes.length !== raster.width * raster.height) throw new Error("materials.bin does not match materials.json");
    for (const id of raster.datasets) if (!manifest.datasets.some(d => d.id === id)) throw new Error(`Dataset ${id} is not in the data manifest`);
    this.classTexture = new DataTexture(classes, raster.width, raster.height, RedFormat, UnsignedByteType);
    this.classTexture.minFilter = NearestFilter; this.classTexture.magFilter = NearestFilter; this.classTexture.generateMipmaps = false;
    this.classTexture.needsUpdate = true;
    this.paletteTexture = new DataTexture(paletteBytes(raster.materials), 256, 1, RGBAFormat, UnsignedByteType);
    this.paletteTexture.colorSpace = SRGBColorSpace;
    this.paletteTexture.minFilter = NearestFilter; this.paletteTexture.magFilter = NearestFilter; this.paletteTexture.generateMipmaps = false;
    this.paletteTexture.needsUpdate = true;
    const e = raster.extentM;
    this.extent = new Vector4(e.west, e.south, e.east, e.north);
    this.attributions = attributionsFor(manifest, raster.datasets);
  }

  /** Patches one terrain material to read its colour from the drape (shared program via a fixed cache key). */
  apply(material: MeshStandardMaterial): void {
    material.customProgramCacheKey = () => "mirage-material-drape";
    material.onBeforeCompile = shader => {
      shader.uniforms.uDrapeClasses = { value: this.classTexture };
      shader.uniforms.uDrapePalette = { value: this.paletteTexture };
      shader.uniforms.uDrapeExtent = { value: this.extent };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vDrapeWorld;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvDrapeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vDrapeWorld;\nuniform sampler2D uDrapeClasses;\nuniform sampler2D uDrapePalette;\nuniform vec4 uDrapeExtent;")
        .replace("#include <color_fragment>", `#include <color_fragment>
{
  // Render frame: x = east, z = -north. Texture row 0 is the north edge.
  vec2 drapeUv = vec2((vDrapeWorld.x - uDrapeExtent.x) / (uDrapeExtent.z - uDrapeExtent.x),
                      (uDrapeExtent.w + vDrapeWorld.z) / (uDrapeExtent.w - uDrapeExtent.y));
  if (all(greaterThanEqual(drapeUv, vec2(0.0))) && all(lessThan(drapeUv, vec2(1.0)))) {
    float drapeClass = floor(texture2D(uDrapeClasses, drapeUv).r * 255.0 + 0.5);
    vec4 drapeColor = texture2D(uDrapePalette, vec2((drapeClass + 0.5) / 256.0, 0.5));
    if (drapeColor.a > 0.5) diffuseColor.rgb = drapeColor.rgb;
  }
}`);
    };
    material.needsUpdate = true;
  }

  dispose(): void {
    this.classTexture.dispose();
    this.paletteTexture.dispose();
  }
}

/** Fetches materials.json, its sibling materials.bin and data-manifest.json (cold path, before terrain loads). */
export async function loadMaterialDrape(url: string, fetchImpl: typeof fetch = fetch): Promise<MaterialDrape> {
  const base = new URL(url, globalThis.location?.href ?? "http://localhost/");
  const get = async (name: string) => {
    const response = await fetchImpl(new URL(name, base).href);
    if (!response.ok) throw new Error(`Material drape: ${name} returned HTTP ${response.status}`);
    return response;
  };
  const rasterJson: unknown = await (await get(base.pathname.split("/").pop() ?? "materials.json")).json();
  const raster = parseMaterialRaster(rasterJson);
  const classes = new Uint8Array(await (await get("materials.bin")).arrayBuffer());
  const manifestJson: unknown = await (await get("data-manifest.json")).json();
  return new MaterialDrape(raster, classes, parseDataManifest(manifestJson));
}
