"""Extract OSM buildings and roads around the area of operation (TASK-073 P4).

    python extract_osm.py --config config/geodata.json --pbf FILE.osm.pbf --out DIR [--margin-m 200]

Reads the operator-supplied Geofabrik extract with GDAL's OSM driver, keeps
only features intersecting the area (radius + margin), and writes
osm-buildings.geojson (multipolygons with a building tag) and
osm-roads.geojson (lines with a highway tag) with the tags the material map
uses (building, roof:material, highway), plus osm-manifest.json (extract
SHA-256, feature counts). OpenStreetMap data: ODbL 1.0,
(c) OpenStreetMap contributors.
"""
import argparse
import hashlib
import json
import math
import os

from osgeo import gdal, ogr

gdal.UseExceptions()
ogr.UseExceptions()
EARTH_RADIUS_M = 6378137.0


def area_box(area, margin_m):
    radius = area["radiusM"] + margin_m
    dlat = math.degrees(radius / EARTH_RADIUS_M)
    dlon = dlat / math.cos(math.radians(area["centerLatDeg"]))
    return (area["centerLonDeg"] - dlon, area["centerLatDeg"] - dlat, area["centerLonDeg"] + dlon, area["centerLatDeg"] + dlat)


def other_tag(feature, key):
    """Value of `key` in the OSM driver's hstore-like other_tags field ("k"=>"v",...)."""
    index = feature.GetFieldIndex("other_tags")
    raw = feature.GetField(index) if index >= 0 else None
    if not raw:
        return None
    needle = f'"{key}"=>"'
    start = raw.find(needle)
    if start < 0:
        return None
    start += len(needle)
    end = raw.find('"', start)
    return raw[start:end] if end > start else None


def field(feature, name):
    index = feature.GetFieldIndex(name)
    return feature.GetField(index) if index >= 0 else None


def write(path, features):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--pbf", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--margin-m", type=float, default=200.0)
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as f:
        config = json.load(f)
    os.makedirs(args.out, exist_ok=True)
    west, south, east, north = area_box(config["area"], args.margin_m)
    gdal.SetConfigOption("OGR_INTERLEAVED_READING", "YES")  # required by the OSM driver for multiple layers
    source = ogr.Open(args.pbf)
    buildings, roads = [], []
    for name in ("lines", "multipolygons"):
        layer = source.GetLayerByName(name)
        layer.SetSpatialFilterRect(west, south, east, north)
    # Interleaved reading: iterate all layers until every one is exhausted.
    while True:
        feature, layer = source.GetNextFeature()
        if feature is None:
            break
        name = layer.GetName()
        geometry = feature.GetGeometryRef()
        if geometry is None or not geometry.Intersects(ogr.CreateGeometryFromWkt(
                f"POLYGON(({west} {south},{east} {south},{east} {north},{west} {north},{west} {south}))")):
            continue
        if name == "multipolygons" and field(feature, "building"):
            tags = {"building": field(feature, "building")}
            roof = other_tag(feature, "roof:material")
            if roof:
                tags["roof:material"] = roof
            buildings.append({"type": "Feature", "properties": {"osm_id": field(feature, "osm_id") or field(feature, "osm_way_id"), **tags},
                              "geometry": json.loads(geometry.ExportToJson())})
        elif name == "lines" and field(feature, "highway"):
            roads.append({"type": "Feature", "properties": {"osm_id": field(feature, "osm_id"), "highway": field(feature, "highway")},
                          "geometry": json.loads(geometry.ExportToJson())})
    write(os.path.join(args.out, "osm-buildings.geojson"), buildings)
    write(os.path.join(args.out, "osm-roads.geojson"), roads)
    digest = hashlib.sha256()
    with open(args.pbf, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    manifest = {"schemaVersion": 1, "source": os.path.basename(args.pbf), "sha256": digest.hexdigest(), "license": "ODbL-1.0",
                "attribution": "(c) OpenStreetMap contributors", "box": {"west": west, "south": south, "east": east, "north": north},
                "buildings": len(buildings), "roads": len(roads), "gdal": gdal.__version__}
    with open(os.path.join(args.out, "osm-manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(json.dumps({k: manifest[k] for k in ("buildings", "roads", "sha256")}))


if __name__ == "__main__":
    main()
