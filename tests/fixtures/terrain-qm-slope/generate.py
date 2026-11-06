"""Write a synthetic sloped quantized-mesh terrain for TASK-186. Own work, CC0-1.0.

A tilted plane of WGS84 ellipsoidal heights, h = BASE_M + A_PER_DEG_LON * (lon - LON0) + B_PER_DEG_LAT * (lat - LAT0),
over a 2 x 2 block of level-14 tiles around (LAT0, LON0), each an irregular triangulation of a jittered grid, so that the
decoder's triangle search and barycentric weights are exercised on triangles that are not grid-aligned. A plane is
reproduced exactly by any triangulation of exact vertices, so the decoded heights may differ from it only by the
encoder's quantization of the vertices. The quantized-mesh-encoder package (0.5.0) writes the tiles; its writer is
independent of the MirageSITL decoder. Also writes layer.json (only level 14 is available, and only for this block,
so nothing coarser stands in for missing ground) and terrain-manifest.json with the block's bounding box. Run from the
repository root with quantized-mesh-encoder and numpy installed:

    python tests/fixtures/terrain-qm-slope/generate.py
"""
import json
import math
import os

import numpy as np
import quantized_mesh_encoder as qme

LAT0, LON0 = 32.2, 34.87
BASE_M, A_PER_DEG_LON, B_PER_DEG_LAT = 120.0, 900.0, -1500.0
LEVEL = 14
GRID = 13
OUT = os.path.dirname(os.path.abspath(__file__))


def bounds(x, y, z):
    size = 180.0 / (1 << z)
    return (-180.0 + x * size, -90.0 + y * size, -180.0 + (x + 1) * size, -90.0 + (y + 1) * size)


def height(lon, lat):
    return BASE_M + A_PER_DEG_LON * (lon - LON0) + B_PER_DEG_LAT * (lat - LAT0)


def write_tile(x, y, z, seed):
    w, s, e, n = bounds(x, y, z)
    rng = np.random.default_rng(seed)
    cols, rows = np.meshgrid(np.arange(GRID), np.arange(GRID))
    fx = cols.flatten() / (GRID - 1); fy = rows.flatten() / (GRID - 1)
    inner = (cols.flatten() > 0) & (cols.flatten() < GRID - 1) & (rows.flatten() > 0) & (rows.flatten() < GRID - 1)
    # Interior vertices move by up to a third of a cell, so the triangles are irregular; the edges stay straight.
    fx = fx + inner * rng.uniform(-1 / (3 * (GRID - 1)), 1 / (3 * (GRID - 1)), fx.size)
    fy = fy + inner * rng.uniform(-1 / (3 * (GRID - 1)), 1 / (3 * (GRID - 1)), fy.size)
    lons = w + fx * (e - w); lats = s + fy * (n - s)
    positions = np.column_stack([lons, lats, height(lons, lats)]).astype(np.float64).flatten()
    triangles = []
    for r in range(GRID - 1):
        for c in range(GRID - 1):
            a = r * GRID + c
            # Alternate the diagonal, counter-clockwise seen from above (rows run north here).
            if (r + c) % 2 == 0:
                triangles += [a, a + 1, a + GRID + 1, a, a + GRID + 1, a + GRID]
            else:
                triangles += [a, a + 1, a + GRID, a + 1, a + GRID + 1, a + GRID]
    path = os.path.join(OUT, str(z), str(x), f"{y}.terrain")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        qme.encode(f, positions, np.array(triangles, dtype=np.uint32), bounds=(w, s, e, n))


size = 180.0 / (1 << LEVEL)
x0 = int(math.floor((LON0 + 180.0) / size)) - 1
y0 = int(math.floor((LAT0 + 90.0) / size)) - 1
for dx in range(2):
    for dy in range(2):
        write_tile(x0 + dx, y0 + dy, LEVEL, 1000 * dx + dy)
west, south = bounds(x0, y0, LEVEL)[0:2]
east, north = bounds(x0 + 1, y0 + 1, LEVEL)[2:4]
available = [[] for _ in range(LEVEL)] + [[{"startX": x0, "startY": y0, "endX": x0 + 1, "endY": y0 + 1}]]
layer = {"tilejson": "2.1.0", "name": "MirageSITL synthetic sloped quantized-mesh fixture (CC0-1.0)", "version": "1.0.0",
         "format": "quantized-mesh-1.0", "scheme": "tms", "projection": "EPSG:4326", "tiles": ["{z}/{x}/{y}.terrain"],
         "bounds": [west, south, east, north], "minzoom": 0, "maxzoom": LEVEL, "available": available,
         "attribution": "MirageSITL synthetic fixture, CC0-1.0"}
with open(os.path.join(OUT, "layer.json"), "w", encoding="utf-8") as f:
    json.dump(layer, f, indent=1)
manifest = {"schemaVersion": 1, "kind": "quantized-mesh-terrain", "heights": "WGS84 ellipsoidal (EPSG:4979)",
            "bbox": [west, south, east, north], "maxZoom": LEVEL, "areaMaxZoom": LEVEL,
            "plane": {"baseM": BASE_M, "lat0Deg": LAT0, "lon0Deg": LON0, "metresPerDegLon": A_PER_DEG_LON, "metresPerDegLat": B_PER_DEG_LAT}}
with open(os.path.join(OUT, "terrain-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=1)
print(json.dumps({"tiles": [[x0 + dx, y0 + dy] for dx in range(2) for dy in range(2)], "bbox": manifest["bbox"]}))
