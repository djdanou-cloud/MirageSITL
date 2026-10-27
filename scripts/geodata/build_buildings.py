"""Build 3D Tiles buildings from Overture Maps for TASK-073 (run in the mirage-geo env).

    python build_buildings.py --config config/geodata.json --terrain-work DIR --work DIR --out DIR

1. Downloads Overture building footprints for the bounding box with the
   official CLI: overturemaps download --bbox=W,S,E,N -f geojson --type=building.
2. Extrudes every footprint to a closed PolyhedralSurface Z in EPSG:4979: the
   base is the lowest WGS84 ellipsoidal ground height under the footprint
   vertices, read from the same geoid-corrected DEM the terrain tiles use
   (fabdem-ellipsoidal.tif), so buildings neither float nor sink; the height is
   Overture `height`, else num_floors * floorHeightM, else defaultHeightM.
   Faces: roof (with holes) and one wall quad per ring edge; floors are omitted
   (never visible from above ground).
3. Loads the solids into a private PostgreSQL/PostGIS cluster (Unix socket in
   the work directory, no TCP) and runs pg2b3dm to write a 3D Tiles 1.1 tileset.
4. Writes buildings-manifest.json (input SHA-256, counts, height sources, tool versions).
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from osgeo import gdal, ogr

gdal.UseExceptions()
ogr.UseExceptions()
PG_PORT = "55473"


def run(cmd, **kw):
    print("$", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Ground:
    """Nearest-pixel lookup in the ellipsoidal DEM (vectorised, whole raster in memory)."""

    def __init__(self, path):
        ds = gdal.Open(path)
        self.gt = ds.GetGeoTransform()
        self.z = ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
        self.rows, self.cols = self.z.shape

    def heights(self, lons, lats):
        cols = np.clip(((lons - self.gt[0]) / self.gt[1]).astype(int), 0, self.cols - 1)
        rows = np.clip(((lats - self.gt[3]) / self.gt[5]).astype(int), 0, self.rows - 1)
        return self.z[rows, cols]


def ring_points(ring):
    return [(ring.GetX(i), ring.GetY(i)) for i in range(ring.GetPointCount())]


def solid_wkt(polygons, base, top):
    """PolyhedralSurface Z: roof polygon(s) at `top` plus wall quads from `base` to `top`."""
    faces = []
    for rings in polygons:
        roof = ",".join("(" + ",".join(f"{x:.8f} {y:.8f} {top:.3f}" for x, y in ring) + ")" for ring in rings)
        faces.append(f"({roof})")
        for ring in rings:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                faces.append(f"(({x1:.8f} {y1:.8f} {base:.3f},{x2:.8f} {y2:.8f} {base:.3f},{x2:.8f} {y2:.8f} {top:.3f},"
                             f"{x1:.8f} {y1:.8f} {top:.3f},{x1:.8f} {y1:.8f} {base:.3f}))")
    return "POLYHEDRALSURFACE Z (" + ",".join(faces) + ")"


def polygons_of(geometry):
    kind = geometry.GetGeometryType()
    parts = [geometry] if kind in (ogr.wkbPolygon, ogr.wkbPolygon25D) else [geometry.GetGeometryRef(i) for i in range(geometry.GetGeometryCount())]
    return [[ring_points(p.GetGeometryRef(r)) for r in range(p.GetGeometryCount())] for p in parts]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--terrain-work", required=True, help="directory holding fabdem-ellipsoidal.tif")
    parser.add_argument("--work", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--pg2b3dm", default=os.path.expanduser("~/.mirage-geo/tools/pg2b3dm"))
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as f:
        config = json.load(f)
    b, settings = config["bbox"], config["buildings"]
    os.makedirs(args.work, exist_ok=True)

    raw = os.path.join(args.work, "buildings.geojson")
    if not os.path.exists(raw):
        run(["overturemaps", "download", f"--bbox={b['minLonDeg']},{b['minLatDeg']},{b['maxLonDeg']},{b['maxLatDeg']}",
             "-f", "geojson", "--type=building", "-o", raw + ".part"])
        os.replace(raw + ".part", raw)

    # Index once: FlatGeobuf with a spatial index makes the bounding-box filter fast (2.9 M features for Israel).
    indexed = os.path.join(args.work, "buildings.fgb")
    if not os.path.exists(indexed):
        run(["ogr2ogr", "-f", "FlatGeobuf", indexed + ".part", raw, "-nln", "buildings", "-lco", "SPATIAL_INDEX=YES"])
        os.replace(indexed + ".part", indexed)

    ground = Ground(os.path.join(args.terrain_work, "fabdem-ellipsoidal.tif"))
    tsv = os.path.join(args.work, "buildings.tsv")
    sources = {"height": 0, "num_floors": 0, "default": 0}
    count = 0
    source = ogr.Open(indexed)
    layer = source.GetLayer(0)
    layer.SetSpatialFilterRect(b["minLonDeg"], b["minLatDeg"], b["maxLonDeg"], b["maxLatDeg"])
    with open(tsv, "w", encoding="utf-8") as out:
        for feature in layer:
            geometry = feature.GetGeometryRef()
            if geometry is None:
                continue
            polygons = polygons_of(geometry)
            points = np.array([pt for rings in polygons for ring in rings for pt in ring])
            if points.size == 0:
                continue
            base = float(ground.heights(points[:, 0], points[:, 1]).min())
            height = feature.GetField("height") if feature.GetFieldIndex("height") >= 0 else None
            floors = feature.GetField("num_floors") if feature.GetFieldIndex("num_floors") >= 0 else None
            if height and height > 0:
                sources["height"] += 1
            elif floors and floors > 0:
                height = floors * settings["floorHeightM"]; sources["num_floors"] += 1
            else:
                height = settings["defaultHeightM"]; sources["default"] += 1
            fid = feature.GetField("id") if feature.GetFieldIndex("id") >= 0 else str(feature.GetFID())
            out.write(f"{fid}\t{height:.2f}\t{solid_wkt(polygons, base, base + float(height))}\n")
            count += 1
    print(f"{count} buildings extruded; height sources {sources}", flush=True)

    pgdata = os.path.join(args.work, "pg")
    socket_dir = os.path.join(args.work, "pgsock"); os.makedirs(socket_dir, exist_ok=True)
    if not os.path.exists(pgdata):
        run(["initdb", "-D", pgdata, "-U", "mirage", "--auth=trust", "-E", "UTF8"])
    run(["pg_ctl", "-D", pgdata, "-o", f"-c listen_addresses='' -c unix_socket_directories='{socket_dir}' -p {PG_PORT}",
         "-l", os.path.join(args.work, "pg.log"), "-w", "start"])
    try:
        psql = ["psql", "-h", socket_dir, "-p", PG_PORT, "-U", "mirage", "-v", "ON_ERROR_STOP=1"]
        run(psql + ["-d", "postgres", "-c", "DROP DATABASE IF EXISTS mirage", "-c", "CREATE DATABASE mirage"])
        sql = (
            "CREATE EXTENSION postgis;"
            "CREATE TABLE buildings_raw (overture_id text, height_m real, wkt text);"
            f"\\copy buildings_raw FROM '{tsv}' WITH (FORMAT text)\n"
            # pg2b3dm reads `id` as an integer feature id; the Overture UUID stays as an attribute.
            "CREATE TABLE buildings AS SELECT row_number() OVER ()::bigint AS id, overture_id, height_m,"
            " ST_GeomFromText(wkt, 4979)::geometry(PolyhedralSurfaceZ, 4979) AS geom FROM buildings_raw;"
            "DROP TABLE buildings_raw; CREATE INDEX ON buildings USING gist (st_centroid(st_envelope(geom))); ANALYZE buildings;"
        )
        run(psql + ["-d", "mirage"], input=sql.replace(";", ";\n"), text=True)
        if os.path.exists(args.out):
            shutil.rmtree(args.out)
        env = dict(os.environ, DOTNET_ROOT=os.path.expanduser("~/.mirage-geo/dotnet"), DOTNET_SYSTEM_GLOBALIZATION_INVARIANT="1")
        connection = f"Host={socket_dir};Port={PG_PORT};Username=mirage;Database=mirage;CommandTimeOut=0"
        run([args.pg2b3dm, "--connection", connection, "-t", "buildings", "-c", "geom",
             "-a", "overture_id,height_m", "--copyright", "Overture Maps Foundation, OpenStreetMap contributors", "-o", args.out], env=env)
        version = subprocess.run([args.pg2b3dm, "--version"], capture_output=True, text=True, env=env).stdout.strip()
    finally:
        run(["pg_ctl", "-D", pgdata, "-w", "stop"])
    manifest = {"schemaVersion": 1, "kind": "buildings-3dtiles", "source": "Overture Maps building", "license": "ODbL-1.0 / CDLA-Permissive-2.0 per Overture release (see source attribution)",
                "inputSha256": sha256(raw), "buildings": count, "heightSources": sources, "heights": "WGS84 ellipsoidal (EPSG:4979), base on geoid-corrected FABDEM",
                "pg2b3dm": version, "gdal": gdal.__version__, "bbox": b}
    with open(os.path.join(args.out, "buildings-manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"buildings tileset -> {args.out}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
