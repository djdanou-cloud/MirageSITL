"""Build quantized-mesh terrain from FABDEM for TASK-073 (run in the mirage-geo env).

    python build_terrain.py --config config/geodata.json --fabdem DIR --out DIR

1. Mosaics the FABDEM tiles (EGM2008 orthometric heights, 1 arc-second).
2. Converts heights to WGS84 ellipsoidal heights (EPSG:4979) with GDAL/PROJ and
   the EGM2008 grid (us_nga_egm08_25.tif). The conversion is verified: the
   median ellipsoidal minus orthometric difference on identical pixels
   around the area centre must equal the EGM2008 geoid undulation there and lie in GEOID_RANGE_M; otherwise the build
   stops, because PROJ silently falls back to a no-op when the grid is missing
   and buildings would then float about 19 m above the ground.
3. Cuts quantized-mesh-1.0 tiles (Cesium layer.json, EPSG:4326 TMS scheme,
   octvertexnormals) for every tile intersecting the bounding box up to
   terrain.maxZoom, and up to terrain.areaMaxZoom inside the area of operation.
   Each tile is a Delatin (Garland-Heckbert) triangulation of the DEM resampled
   to a (2^k + 1) grid; the maximum vertical error halves per level down to
   terrain.maxErrorM at the deepest level.
4. Writes layer.json and terrain-manifest.json (inputs with SHA-256, the geoid
   check, tile counts and bytes).
"""
import argparse
import glob
import hashlib
import json
import math
import multiprocessing
import os
import sys

import numpy as np
from osgeo import gdal, osr
from pydelatin import Delatin
import quantized_mesh_encoder as qme
from quantized_mesh_encoder.extensions import VertexNormalsExtension

gdal.UseExceptions()
GEOID_RANGE_M = (15.0, 25.0)  # EGM2008 undulation over Israel is about +17 to +21 m
EARTH_RADIUS_M = 6378137.0


def tile_bounds(x, y, z):
    """EPSG:4326 TMS tile bounds (west, south, east, north); level z has 2^(z+1) x 2^z tiles, y from the south."""
    size = 180.0 / (1 << z)
    return (-180.0 + x * size, -90.0 + y * size, -180.0 + (x + 1) * size, -90.0 + (y + 1) * size)


def tile_range(bbox, z):
    size = 180.0 / (1 << z)
    x0 = int(math.floor((bbox[0] + 180.0) / size)); x1 = int(math.floor((bbox[2] + 180.0 - 1e-12) / size))
    y0 = int(math.floor((bbox[1] + 90.0) / size)); y1 = int(math.floor((bbox[3] + 90.0 - 1e-12) / size))
    return x0, y0, x1, y1


def area_bbox(area):
    dlat = math.degrees(area["radiusM"] / EARTH_RADIUS_M)
    dlon = dlat / math.cos(math.radians(area["centerLatDeg"]))
    return (area["centerLonDeg"] - dlon, area["centerLatDeg"] - dlat, area["centerLonDeg"] + dlon, area["centerLatDeg"] + dlat)


def geoid_undulation(lon, lat):
    """EGM2008 undulation N (ellipsoidal minus orthometric) at a point, from PROJ."""
    source = osr.SpatialReference(); source.SetFromUserInput("EPSG:4326+3855")
    target = osr.SpatialReference(); target.SetFromUserInput("EPSG:4979")
    for srs in (source, target):
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    _, _, h = osr.CoordinateTransformation(source, target).TransformPoint(lon, lat, 0.0)
    return h


def grid_size(pixels):
    """Smallest 2^k + 1 grid that keeps the DEM resolution, between 33 and 257."""
    k = 5
    while (1 << k) + 1 < pixels and k < 8:
        k += 1
    return (1 << k) + 1


# Worker state for the per-tile pool: each process opens the DEM once.
_W = {}
WORKERS = max(1, (os.cpu_count() or 2) - 1)


def _init_worker(dem_path, out_dir, sea_level_m):
    gdal.UseExceptions()
    _W["dem"] = gdal.Open(dem_path); _W["out"] = out_dir; _W["sea"] = sea_level_m


def _write_tile(job):
    """Resamples one tile, triangulates it with Delatin and writes it; returns the file size."""
    x, y, z, n, max_error = job
    w, s, e, nn = tile_bounds(x, y, z)
    mem = gdal.Warp("", _W["dem"], format="MEM", outputBounds=(w, s, e, nn), width=n, height=n,
                    resampleAlg="bilinear", srcNodata=-9999, dstNodata=-9999)
    heights = mem.GetRasterBand(1).ReadAsArray().astype(np.float32)
    missing = heights <= -9000
    if missing.all():
        heights[:] = _W["sea"]  # outside data: mean sea level at the area's geoid height
    elif missing.any():
        heights[missing] = float(np.median(heights[~missing]))
    tin = Delatin(heights, max_error=max_error)
    vertices, triangles = tin.vertices, tin.triangles
    # Grid (column, row) -> lon/lat; row 0 is the north edge.
    lons = w + vertices[:, 0] / (n - 1) * (e - w)
    lats = nn - vertices[:, 1] / (n - 1) * (nn - s)
    h = heights[vertices[:, 1].astype(int), vertices[:, 0].astype(int)]
    positions = np.column_stack([lons, lats, h]).astype(np.float64).flatten()
    path = os.path.join(_W["out"], str(z), str(x), f"{y}.terrain")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Quantized-mesh front faces are counter-clockwise seen from above. Delatin
    # works in image space (y down), so flipping rows to north-up reverses its
    # winding; orient every triangle by its signed area in (lon, lat).
    tri = triangles.astype(np.int64)
    ax, ay = lons[tri[:, 0]], lats[tri[:, 0]]
    cross = (lons[tri[:, 1]] - ax) * (lats[tri[:, 2]] - ay) - (lats[tri[:, 1]] - ay) * (lons[tri[:, 2]] - ax)
    clockwise = cross < 0
    tri[clockwise, 1], tri[clockwise, 2] = tri[clockwise, 2], tri[clockwise, 1].copy()
    indices = tri.flatten().astype(np.uint32)
    with open(path, "wb") as f:  # encoder and normals default to the WGS84 ellipsoid
        qme.encode(f, positions, indices, bounds=(w, s, e, nn),
                   extensions=[VertexNormalsExtension(positions=positions, indices=indices)])
    return os.path.getsize(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--fabdem", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as f:
        config = json.load(f)
    b = config["bbox"]; bbox = (b["minLonDeg"], b["minLatDeg"], b["maxLonDeg"], b["maxLatDeg"])
    terrain = config["terrain"]; area = config["area"]
    os.makedirs(args.out, exist_ok=True)

    sources = sorted(glob.glob(os.path.join(args.fabdem, "*.tif")))
    if not sources:
        sys.exit("No FABDEM tiles found")
    work = os.path.join(args.out, "_work"); os.makedirs(work, exist_ok=True)
    vrt = gdal.BuildVRT(os.path.join(work, "fabdem.vrt"), sources)
    ellipsoidal_path = os.path.join(work, "fabdem-ellipsoidal.tif")
    if not os.path.exists(ellipsoidal_path):
        gdal.Warp(ellipsoidal_path, vrt, srcSRS="EPSG:4326+3855", dstSRS="EPSG:4979", outputBounds=bbox,
                  resampleAlg="bilinear", outputType=gdal.GDT_Float32, dstNodata=-9999,
                  creationOptions=["COMPRESS=DEFLATE", "PREDICTOR=3", "TILED=YES"])
    ellipsoidal = gdal.Open(ellipsoidal_path)

    # Verify the vertical conversion on identical pixels: re-grid the orthometric DEM
    # onto the ellipsoidal raster's grid without a vertical transform and take the
    # median difference in a window around the area centre (robust in steep terrain).
    lon, lat = area["centerLonDeg"], area["centerLatDeg"]
    undulation_m = geoid_undulation(lon, lat)
    gt = ellipsoidal.GetGeoTransform()
    col = int((lon - gt[0]) / gt[1]); row = int((lat - gt[3]) / gt[5]); half = 50
    window = (max(0, col - half), max(0, row - half), min(ellipsoidal.RasterXSize, col + half + 1) - max(0, col - half),
              min(ellipsoidal.RasterYSize, row + half + 1) - max(0, row - half))
    orthometric_grid = gdal.Warp("", vrt, format="MEM", srcSRS="EPSG:4326", dstSRS="EPSG:4326", outputBounds=bbox,
                                 width=ellipsoidal.RasterXSize, height=ellipsoidal.RasterYSize, resampleAlg="bilinear",
                                 outputType=gdal.GDT_Float32, dstNodata=-9999)
    e_win = ellipsoidal.GetRasterBand(1).ReadAsArray(*window).astype(np.float64)
    o_win = orthometric_grid.GetRasterBand(1).ReadAsArray(*window).astype(np.float64)
    valid = (e_win > -9000) & (o_win > -9000)
    applied_m = float(np.median(e_win[valid] - o_win[valid])) if valid.any() else float("nan")
    geoid_check = {"lonDeg": lon, "latDeg": lat, "windowPx": window, "validPx": int(valid.sum()),
                   "medianAppliedM": applied_m, "egm2008UndulationM": undulation_m, "rangeM": GEOID_RANGE_M}
    print("geoid check:", json.dumps(geoid_check))
    # Render-frame origin: ground (ellipsoidal) at the area centre, bilinear, so the
    # flat physics ground at NED down = 0 meets the terrain at the take-off point.
    point = gdal.Warp("", ellipsoidal, format="MEM", width=1, height=1, resampleAlg="bilinear",
                      outputBounds=(lon - 1e-6, lat - 1e-6, lon + 1e-6, lat + 1e-6))
    area_origin = {"latDeg": lat, "lonDeg": lon, "heightM": round(float(point.GetRasterBand(1).ReadAsArray()[0, 0]), 3)}
    print("area origin:", json.dumps(area_origin))
    if not (GEOID_RANGE_M[0] <= undulation_m <= GEOID_RANGE_M[1]) or abs(applied_m - undulation_m) > 0.5:
        sys.exit("Geoid-to-ellipsoid conversion was not applied (is us_nga_egm08_25.tif in the PROJ data directory?)")

    gt = ellipsoidal.GetGeoTransform(); pixel_deg = gt[1]
    deep_bbox = area_bbox(area)
    max_zoom, area_max_zoom = terrain["maxZoom"], terrain["areaMaxZoom"]
    available, tiles_written, total_bytes = [], 0, 0
    for z in range(area_max_zoom + 1):
        region = bbox if z <= max_zoom else deep_bbox
        x0, y0, x1, y1 = tile_range(region, z)
        available.append([{"startX": x0, "startY": y0, "endX": x1, "endY": y1}])
        size_deg = 180.0 / (1 << z)
        n = grid_size(size_deg / pixel_deg)
        max_error = terrain["maxErrorM"] * (2 ** max(0, area_max_zoom - z))
        jobs = [(x, y, z, n, max_error) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
        with multiprocessing.Pool(WORKERS, initializer=_init_worker, initargs=(ellipsoidal_path, args.out, undulation_m)) as pool:
            for size in pool.imap_unordered(_write_tile, jobs, chunksize=8):
                tiles_written += 1; total_bytes += size
        print(f"level {z}: {(x1 - x0 + 1) * (y1 - y0 + 1)} tiles, grid {n}, max error {max_error:.1f} m")

    layer = {"tilejson": "2.1.0", "name": "MirageSITL FABDEM terrain", "version": "1.0.0", "format": "quantized-mesh-1.0",
             "scheme": "tms", "projection": "EPSG:4326", "tiles": ["{z}/{x}/{y}.terrain"], "extensions": ["octvertexnormals"],
             "bounds": list(bbox), "minzoom": 0, "maxzoom": area_max_zoom, "available": available,
             "attribution": "FABDEM V1-2 (CC BY-NC-SA 4.0), contains modified Copernicus DEM GLO-30"}
    with open(os.path.join(args.out, "layer.json"), "w", encoding="utf-8") as f:
        json.dump(layer, f)
    with open(os.path.join(args.fabdem, "fabdem-manifest.json"), encoding="utf-8") as f:
        fabdem = json.load(f)
    manifest = {"schemaVersion": 1, "kind": "quantized-mesh-terrain", "heights": "WGS84 ellipsoidal (EPSG:4979)",
                "source": fabdem, "geoidCheck": geoid_check, "areaOrigin": area_origin, "areaRadiusM": area["radiusM"], "bbox": bbox, "areaBbox": deep_bbox,
                "maxZoom": max_zoom, "areaMaxZoom": area_max_zoom, "tiles": tiles_written, "bytes": total_bytes,
                "layerSha256": hashlib.sha256(open(os.path.join(args.out, "layer.json"), "rb").read()).hexdigest(),
                "gdal": gdal.__version__}
    with open(os.path.join(args.out, "terrain-manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"{tiles_written} tiles, {total_bytes} bytes -> {args.out}")


if __name__ == "__main__":
    main()
