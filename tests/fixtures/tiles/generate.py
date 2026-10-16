#!/usr/bin/env python3
"""Writes a minimal synthetic 3D Tiles 1.1 tileset (TASK-061): tileset.json and
tile.glb. Own work, released as CC0-1.0; it depicts no real terrain.

The tile is a 21 x 21 grid (10 m spacing, 200 m square) with a 20 m marker
vertex at its centre, in glTF y-up local coordinates. The root transform is
the ENU-to-ECEF frame at ORIGIN (WGS84), so tile-local (east, north, up)
maps to ECEF. 3D Tiles rotates glTF y-up content to z-up: glTF (x, y, z) is
tile (x, -z, y), i.e. east = x, north = -z, up = y.
Run from the repository root.
"""
import json
import math
import struct
from pathlib import Path

ORIGIN = {"latDeg": 47.3769, "lonDeg": 8.5417, "heightM": 400.0}
A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)


def ecef(lat, lon, h):
    n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
    return [(n + h) * math.cos(lat) * math.cos(lon), (n + h) * math.cos(lat) * math.sin(lon), (n * (1 - E2) + h) * math.sin(lat)]


lat, lon = math.radians(ORIGIN["latDeg"]), math.radians(ORIGIN["lonDeg"])
o = ecef(lat, lon, ORIGIN["heightM"])
east = [-math.sin(lon), math.cos(lon), 0.0]
north = [-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)]
up = [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)]
transform = east + [0.0] + north + [0.0] + up + [0.0] + o + [1.0]  # column-major 4x4

# glTF grid: x east, y up, z = -north.
N = 21
positions, indices = [], []
for j in range(N):
    for i in range(N):
        x = -100 + 10 * i
        z = -100 + 10 * j
        y = 20.0 if (i == N // 2 and j == N // 2) else 0.0
        positions += [x, y, z]
for j in range(N - 1):
    for i in range(N - 1):
        a = j * N + i
        indices += [a, a + N, a + 1, a + 1, a + N, a + N + 1]
pos_bytes = struct.pack("<%df" % len(positions), *positions)
idx_bytes = struct.pack("<%dH" % len(indices), *indices)
pad = (4 - len(idx_bytes) % 4) % 4
binary = pos_bytes + idx_bytes + b"\0" * pad
xs, ys, zs = positions[0::3], positions[1::3], positions[2::3]
gltf = {
    "asset": {"version": "2.0", "generator": "MirageSITL tests/fixtures/tiles/generate.py", "copyright": "CC0-1.0 MirageSITL synthetic test tile"},
    "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
    "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]}],
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": N * N, "type": "VEC3",
         "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
        {"bufferView": 1, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
    ],
    "bufferViews": [
        {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_bytes), "target": 34962},
        {"buffer": 0, "byteOffset": len(pos_bytes), "byteLength": len(idx_bytes), "target": 34963},
    ],
    "buffers": [{"byteLength": len(binary)}],
}
json_bytes = json.dumps(gltf, separators=(",", ":")).encode()
json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_bytes) + 8 + len(binary))
glb += struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
glb += struct.pack("<II", len(binary), 0x004E4942) + binary

tileset = {
    "asset": {"version": "1.1", "generator": "MirageSITL tests/fixtures/tiles/generate.py",
              "extras": {"license": "CC0-1.0", "attribution": "MirageSITL synthetic test tiles (CC0-1.0)", "origin": ORIGIN}},
    "geometricError": 200,
    "root": {
        "transform": transform,
        "boundingVolume": {"box": [0, 0, 10, 100, 0, 0, 0, 100, 0, 0, 0, 10]},
        "geometricError": 0,
        "refine": "REPLACE",
        "content": {"uri": "tile.glb"},
    },
}
here = Path(__file__).parent
(here / "tile.glb").write_bytes(glb)
(here / "tileset.json").write_text(json.dumps(tileset, indent=2) + "\n")
print("wrote tileset.json and tile.glb (%d bytes), origin ECEF %s" % (len(glb), [round(v, 3) for v in o]))
