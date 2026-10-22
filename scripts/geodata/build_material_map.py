"""Build the surface-material raster for the area of operation (TASK-073 P4).

    python build_material_map.py --config config/geodata.json --classes config/material-classes.json \
        --worldcover data/worldcover/2021-v200/israel --osm DIR --out DIR [--pixel-m 1]

Same legend and precedence as packages/thermal/src/material-map.ts
(OSM building by roof:material > OSM road within half its legend width >
WorldCover pixel > synthetic), evaluated on a regular grid instead of per
query: WorldCover is resampled (nearest) onto the grid, road centre lines are
buffered to half their legend width and burnt over it, building footprints
last. The grid is a local transverse Mercator projection centred on the area
(metres east/north of the render origin; scale error below 1e-7 within a few
kilometres), square, half-width = area radius, row 0 at the north edge.

A material class is not a temperature. Outputs:
  materials.bin      uint8 class index per pixel, row-major, row 0 north;
  materials.json     schema mirage.material-raster/1 (grid, class ids, counts);
  data-manifest.json schema mirage.thermal-data/1 (WorldCover + OSM provenance).
"""
import argparse
import json
import math
import os

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()
ogr.UseExceptions()


def local_srs(lat, lon):
    srs = osr.SpatialReference()
    srs.ImportFromProj4(f"+proj=tmerc +lat_0={lat} +lon_0={lon} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs")
    return srs


def wgs84():
    srs = osr.SpatialReference(); srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return srs


def burn(raster, features, value_of, transform, half_width_of=None):
    """Rasterizes features (optionally buffered in metres) into `raster` with per-feature values."""
    driver = ogr.GetDriverByName("MEM")
    source = driver.CreateDataSource("burn")
    layer = source.CreateLayer("burn", raster.GetSpatialRef(), ogr.wkbUnknown)
    layer.CreateField(ogr.FieldDefn("value", ogr.OFTInteger))
    count = 0
    for feature in features:
        value = value_of(feature["properties"])
        if value is None:
            continue
        geometry = ogr.CreateGeometryFromJson(json.dumps(feature["geometry"]))
        geometry.Transform(transform)
        if half_width_of is not None:
            geometry = geometry.Buffer(half_width_of(feature["properties"]), 8)
        out = ogr.Feature(layer.GetLayerDefn()); out.SetGeometry(geometry); out.SetField("value", int(value))
        layer.CreateFeature(out); count += 1
    gdal.RasterizeLayer(raster, [1], layer, options=["ATTRIBUTE=value"])
    return count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--classes", required=True)
    parser.add_argument("--worldcover", required=True, help="directory with ESA WorldCover v200 tiles and inventory.json")
    parser.add_argument("--osm", required=True, help="directory written by extract_osm.py")
    parser.add_argument("--out", required=True)
    parser.add_argument("--pixel-m", type=float, default=1.0)
    args = parser.parse_args()
    config = json.load(open(args.config, encoding="utf-8"))
    legend = json.load(open(args.classes, encoding="utf-8"))
    area = config["area"]; lat, lon, radius = area["centerLatDeg"], area["centerLonDeg"], area["radiusM"]
    os.makedirs(args.out, exist_ok=True)

    # Class table: index 0 is the synthetic fallback, then every legend material once, in legend order.
    materials = [legend["synthetic"]]
    for code in sorted(legend["worldcover"]["classes"], key=int):
        if legend["worldcover"]["classes"][code]["material"] not in materials:
            materials.append(legend["worldcover"]["classes"][code]["material"])
    for material in [legend["osm"]["building"], *legend["osm"]["roofMaterial"].values(), *(h["material"] for h in legend["osm"]["highway"].values())]:
        if material not in materials:
            materials.append(material)
    index = {m: i for i, m in enumerate(materials)}

    size = int(round(2 * radius / args.pixel_m))
    srs = local_srs(lat, lon)
    grid = gdal.GetDriverByName("MEM").Create("", size, size, 1, gdal.GDT_Byte)
    grid.SetGeoTransform((-radius, args.pixel_m, 0, radius, 0, -args.pixel_m))
    grid.SetProjection(srs.ExportToWkt())

    # WorldCover: the 3x3 degree tile containing the centre, nearest-neighbour onto the grid.
    inventory = json.load(open(os.path.join(args.worldcover, "inventory.json"), encoding="utf-8"))
    tile_name = f"N{int(math.floor(lat / 3) * 3):02d}E{int(math.floor(lon / 3) * 3):03d}"
    tile = next(f for f in inventory["files"] if f["tile"] == tile_name)
    worldcover = gdal.Warp("", os.path.join(args.worldcover, tile["path"]), format="MEM", dstSRS=srs.ExportToWkt(),
                           outputBounds=(-radius, -radius, radius, radius), width=size, height=size, resampleAlg="near")
    codes = worldcover.GetRasterBand(1).ReadAsArray()
    lut = np.zeros(256, dtype=np.uint8)  # unknown codes and no-data stay synthetic (0)
    for code, entry in legend["worldcover"]["classes"].items():
        lut[int(code)] = index[entry["material"]]
    grid.GetRasterBand(1).WriteArray(lut[codes])

    # OSM overlays in precedence order: roads (narrow first), then buildings on top.
    to_local = osr.CoordinateTransformation(wgs84(), srs)
    roads = json.load(open(os.path.join(args.osm, "osm-roads.geojson"), encoding="utf-8"))["features"]
    buildings = json.load(open(os.path.join(args.osm, "osm-buildings.geojson"), encoding="utf-8"))["features"]
    highway = legend["osm"]["highway"]
    ordered_roads = sorted((f for f in roads if f["properties"].get("highway") in highway), key=lambda f: highway[f["properties"]["highway"]]["widthM"])
    roads_burnt = burn(grid, ordered_roads, lambda p: index[highway[p["highway"]]["material"]], to_local,
                       half_width_of=lambda p: highway[p["highway"]]["widthM"] / 2)
    roof = legend["osm"]["roofMaterial"]
    buildings_burnt = burn(grid, buildings, lambda p: index[roof.get(p.get("roof:material"), legend["osm"]["building"])], to_local)

    data = grid.GetRasterBand(1).ReadAsArray().astype(np.uint8)
    data.tofile(os.path.join(args.out, "materials.bin"))
    counts = {materials[i]: int(n) for i, n in enumerate(np.bincount(data.ravel(), minlength=len(materials))) if n}
    osm = json.load(open(os.path.join(args.osm, "osm-manifest.json"), encoding="utf-8"))
    raster = {"schema": "mirage.material-raster/1", "origin": {"latDeg": lat, "lonDeg": lon},
              "projection": "local transverse Mercator at origin (+proj=tmerc, WGS84)", "pixelM": args.pixel_m, "width": size, "height": size,
              "extentM": {"west": -radius, "east": radius, "south": -radius, "north": radius}, "rowOrder": "north-to-south",
              "materials": materials, "counts": counts, "roads": roads_burnt, "buildings": buildings_burnt,
              "datasets": [f"worldcover-{tile_name.lower()}", "osm-extract"],
              "note": "Material classes only; a class is not a temperature."}
    json.dump(raster, open(os.path.join(args.out, "materials.json"), "w", encoding="utf-8"), indent=1)

    south, west, north, east = 3 * math.floor(lat / 3), 3 * math.floor(lon / 3), 3 * math.floor(lat / 3) + 3, 3 * math.floor(lon / 3) + 3
    box = osm["box"]
    manifest = {"schema": "mirage.thermal-data/1", "datasets": [
        {"id": f"worldcover-{tile_name.lower()}", "provider": "esa-worldcover", "version": "2021-v200", "license": "CC-BY-4.0",
         "attribution": inventory["attribution"], "sha256": tile["sha256"], "crs": "EPSG:4326",
         "bounds": {"south": south, "west": west, "north": north, "east": east}, "synthetic": False},
        {"id": "osm-extract", "provider": "openstreetmap", "version": osm["source"], "license": "ODbL-1.0",
         "attribution": "© OpenStreetMap contributors", "sha256": osm["sha256"], "crs": "EPSG:4326",
         "bounds": {"south": box["south"], "west": box["west"], "north": box["north"], "east": box["east"]}, "synthetic": False},
    ]}
    json.dump(manifest, open(os.path.join(args.out, "data-manifest.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps({"size": size, "roads": roads_burnt, "buildings": buildings_burnt, "counts": counts}))


if __name__ == "__main__":
    main()
