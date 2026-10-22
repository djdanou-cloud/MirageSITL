"""Write a minimal synthetic quantized-mesh terrain (TASK-073). Own work, CC0-1.0.

Flat ground at GROUND_HEIGHT_M (WGS84 ellipsoidal) everywhere, so a raycast at
the fixture origin must hit at GROUND_HEIGHT_M - ORIGIN["heightM"] in the
render frame. Only the chain of tiles containing the origin exists below level
0, down to MAX_LEVEL (one tile per level), plus both level-0 tiles.
Run in the mirage-geo environment from the repository root:

    python tests/fixtures/terrain-qm/generate.py
"""
import json
import math
import os

import numpy as np
import quantized_mesh_encoder as qme
from quantized_mesh_encoder.extensions import VertexNormalsExtension

ORIGIN = {"latDeg": 47.3769, "lonDeg": 8.5417, "heightM": 400.0}
GROUND_HEIGHT_M = 405.0
MAX_LEVEL = 12
GRID = 9
OUT = os.path.dirname(os.path.abspath(__file__))


def bounds(x, y, z):
    size = 180.0 / (1 << z)
    return (-180.0 + x * size, -90.0 + y * size, -180.0 + (x + 1) * size, -90.0 + (y + 1) * size)


def write_tile(x, y, z):
    w, s, e, n = bounds(x, y, z)
    cols, rows = np.meshgrid(np.arange(GRID), np.arange(GRID))
    lons = w + cols.flatten() / (GRID - 1) * (e - w)
    lats = n - rows.flatten() / (GRID - 1) * (n - s)
    positions = np.column_stack([lons, lats, np.full(lons.size, GROUND_HEIGHT_M)]).astype(np.float64).flatten()
    triangles = []
    for r in range(GRID - 1):
        for c in range(GRID - 1):
            a = r * GRID + c
            triangles += [a, a + GRID, a + 1, a + 1, a + GRID, a + GRID + 1]
    indices = np.array(triangles, dtype=np.uint32)
    path = os.path.join(OUT, str(z), str(x), f"{y}.terrain")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        qme.encode(f, positions, indices, bounds=(w, s, e, n), extensions=[VertexNormalsExtension(positions=positions, indices=indices)])


available = [[{"startX": 0, "startY": 0, "endX": 1, "endY": 0}]]
write_tile(0, 0, 0)
write_tile(1, 0, 0)
for z in range(1, MAX_LEVEL + 1):
    size = 180.0 / (1 << z)
    x = int(math.floor((ORIGIN["lonDeg"] + 180.0) / size)); y = int(math.floor((ORIGIN["latDeg"] + 90.0) / size))
    write_tile(x, y, z)
    available.append([{"startX": x, "startY": y, "endX": x, "endY": y}])
layer = {"tilejson": "2.1.0", "name": "MirageSITL synthetic quantized-mesh fixture (CC0-1.0)", "version": "1.0.0",
         "format": "quantized-mesh-1.0", "scheme": "tms", "projection": "EPSG:4326", "tiles": ["{z}/{x}/{y}.terrain"],
         "extensions": ["octvertexnormals"], "bounds": [-180, -90, 180, 90], "minzoom": 0, "maxzoom": MAX_LEVEL,
         "available": available, "attribution": "MirageSITL synthetic quantized-mesh fixture (CC0-1.0)",
         "extras": {"origin": ORIGIN, "groundHeightM": GROUND_HEIGHT_M, "license": "CC0-1.0"}}
with open(os.path.join(OUT, "layer.json"), "w", encoding="utf-8") as f:
    json.dump(layer, f, indent=1)
print(f"{2 + MAX_LEVEL} tiles -> {OUT}")
