#!/usr/bin/env python3
"""Independent EGM96 nodes for the TASK-148 geoid cross-check.

Reads OSGeo PROJ-data's us_nga_egm96_15.tif (a GeoTIFF conversion of NGA's EGM96
15-minute grid, distributed separately from NGA's WW15MGH.DAC) with the standard
library only, and writes every node of a 5-degree lattice plus the nodes at the
global minimum and maximum to egm96-proj-nodes.json. The test compares them with
data/geoid/WW15MGH.DAC.

    python3 -I tests/fixtures/geoid/generate_proj_nodes.py PATH/us_nga_egm96_15.tif [--check]

--check regenerates in memory and compares with the stored fixture byte for byte.
"""
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

SOURCE_SHA256 = "db493027562c9b004d7220fa881f5603adada4e1c5029b933fa7de4547b0e78d"
SOURCE_COMMIT = "cdab44864a36a9f3c3e90a36637c5d8a86e624c6"
OUT = Path(__file__).with_name("egm96-proj-nodes.json")


def tags(data):
    order = "<" if data[:2] == b"II" else ">"
    offset = struct.unpack(order + "I", data[4:8])[0]
    count = struct.unpack(order + "H", data[offset:offset + 2])[0]
    out = {}
    for i in range(count):
        tag, kind, n, value = struct.unpack(order + "HHI4s", data[offset + 2 + 12 * i:offset + 14 + 12 * i])
        if kind == 3 and n == 1:
            out[tag] = struct.unpack(order + "H", value[:2])[0]
        elif kind == 4 and n == 1:
            out[tag] = struct.unpack(order + "I", value)[0]
        elif kind == 4:
            at = struct.unpack(order + "I", value)[0]
            out[tag] = struct.unpack(order + "%dI" % n, data[at:at + 4 * n])
        elif kind == 12:
            at = struct.unpack(order + "I", value)[0]
            out[tag] = struct.unpack(order + "%dd" % n, data[at:at + 8 * n])
    return out


def grid(data):
    t = tags(data)
    width, height, tile_w, tile_h = t[256], t[257], t[322], t[323]
    # 32-bit IEEE floats, deflate, floating-point predictor (TIFF Technical Note 3), 0.25 degree nodes from (-180, 90).
    if (t[258], t[339], t[259], t[317]) != (32, 3, 8, 3) or t[33550][:2] != (0.25, 0.25) or t[33922][3:5] != (-180.0, 90.0):
        raise SystemExit("Unexpected GeoTIFF layout")
    values = [[0.0] * width for _ in range(height)]
    across = (width + tile_w - 1) // tile_w
    for index, (at, size) in enumerate(zip(t[324], t[325])):
        raw = bytearray(zlib.decompress(data[at:at + size]))
        row0, col0 = (index // across) * tile_h, (index % across) * tile_w
        stride = tile_w * 4
        for r in range(tile_h):
            row = raw[r * stride:(r + 1) * stride]
            for i in range(1, stride):
                row[i] = (row[i] + row[i - 1]) & 255
            if row0 + r >= height:
                continue
            for c in range(tile_w):
                if col0 + c < width:
                    values[row0 + r][col0 + c] = struct.unpack(">f", bytes(row[k * tile_w + c] for k in range(4)))[0]
    return values


def fixture(path):
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise SystemExit("us_nga_egm96_15.tif does not match the recorded SHA-256")
    values = grid(data)
    nodes = []
    for row in range(0, 721, 20):
        for col in range(0, 1440, 20):
            nodes.append([90 - 0.25 * row, -180 + 0.25 * col, round(values[row][col], 6)])
    flat = [(values[r][c], r, c) for r in range(721) for c in range(1440)]
    for _, row, col in (min(flat), max(flat)):
        nodes.append([90 - 0.25 * row, -180 + 0.25 * col, round(values[row][col], 6)])
    body = {
        "source": {
            "file": "us_nga/us_nga_egm96_15.tif",
            "repository": "https://github.com/OSGeo/PROJ-data",
            "commit": SOURCE_COMMIT,
            "sha256": SOURCE_SHA256,
            "license": "Public Domain (US NGA), as stated by PROJ-data us_nga/us_nga_README.txt",
        },
        "selection": "Every node of the 5-degree lattice (rows 90 to -90, columns -180 to 175), then the global minimum and maximum nodes",
        "units": {"latitudeDeg": "deg", "longitudeDeg": "deg", "undulationM": "m"},
        "nodes": nodes,
    }
    return (json.dumps(body, indent=1) + "\n").encode()


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--check"):
        raise SystemExit(__doc__)
    produced = fixture(sys.argv[1])
    if len(sys.argv) == 3:
        if OUT.read_bytes() != produced:
            raise SystemExit("egm96-proj-nodes.json differs from the regenerated fixture")
        print("egm96-proj-nodes.json matches the PROJ-data source")
    else:
        OUT.write_bytes(produced)
        print(f"wrote {OUT} ({len(produced)} bytes)")
