"""Fetch the FABDEM V1-2 1x1 degree tiles that cover a bounding box (TASK-073).

FABDEM is published as 10x10 degree zip archives of about 1.6-1.9 GB. The
server supports HTTP byte ranges, so this reads each archive's central
directory remotely and downloads only the member files whose tiles intersect
the box (about 20 MB each). Standard library only.

    python fetch_fabdem.py --config config/geodata.json --out .cache/geodata/fabdem

Writes the tiles and fabdem-manifest.json (file names, bytes, SHA-256, source
URLs, licence). FABDEM is CC BY-NC-SA 4.0 (non-commercial); it is derived from
the Copernicus DEM GLO-30 (credit line recorded in the manifest).
"""
import argparse
import hashlib
import io
import json
import math
import os
import time
import urllib.request
import zipfile

LICENSE = "CC BY-NC-SA 4.0 (FABDEM; commercial use needs a Fathom licence)"
RETRIES = 6
ATTRIBUTION = ("FABDEM V1-2, University of Bristol / Fathom (Hawker et al. 2022). Contains modified Copernicus DEM "
               "GLO-30: Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, "
               "provided under COPERNICUS by the European Union and ESA; all rights reserved.")


class RangeFile(io.RawIOBase):
    """Seekable read-only view of a remote file through HTTP Range requests."""

    def __init__(self, url, timeout=60):
        super().__init__()
        self.url, self.timeout, self.pos = url, timeout, 0
        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.headers.get("Accept-Ranges", "").lower() != "bytes":
                raise RuntimeError(f"{url} does not accept byte ranges")
            self.size = int(response.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.pos, io.SEEK_END: self.size}[whence]
        self.pos = max(0, base + offset)
        return self.pos

    def read(self, n=-1):
        if self.pos >= self.size:
            return b""
        end = self.size - 1 if n is None or n < 0 else min(self.size - 1, self.pos + n - 1)
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        # The server occasionally stalls a request; retry with back-off instead of failing the run.
        for attempt in range(RETRIES):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    data = response.read()
                break
            except (OSError, TimeoutError) as error:
                if attempt == RETRIES - 1:
                    raise
                print(f"range {self.pos}-{end}: {error}; retry {attempt + 1}", flush=True)
                time.sleep(5 * (attempt + 1))
        self.pos += len(data)
        return data

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)


def tiles_for_bbox(bbox):
    """1x1 degree tile names (south-west corner) intersecting the box."""
    names = []
    for lat in range(math.floor(bbox["minLatDeg"]), math.ceil(bbox["maxLatDeg"])):
        for lon in range(math.floor(bbox["minLonDeg"]), math.ceil(bbox["maxLonDeg"])):
            ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
            names.append((lat, lon, f"{ns}{abs(lat):02d}{ew}{abs(lon):03d}"))
    return names


def block_for(lat, lon):
    """10x10 degree archive block name, e.g. N30E030-N40E040 (northern/eastern hemisphere)."""
    if lat < 0 or lon < 0:
        raise ValueError("Only N/E archives are handled; extend block_for for other hemispheres")
    la, lo = (lat // 10) * 10, (lon // 10) * 10
    return f"N{la:02d}E{lo:03d}-N{la + 10:02d}E{lo + 10:03d}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as f:
        config = json.load(f)
    os.makedirs(args.out, exist_ok=True)
    wanted = tiles_for_bbox(config["bbox"])
    by_block = {}
    for lat, lon, name in wanted:
        by_block.setdefault(block_for(lat, lon), []).append(name)
    files = []
    for block, names in sorted(by_block.items()):
        url = config["terrain"]["archiveUrl"].replace("{block}", block)
        archive = zipfile.ZipFile(io.BufferedReader(RangeFile(url), buffer_size=1 << 20))
        members = {os.path.basename(m.filename): m for m in archive.infolist() if m.filename.lower().endswith(".tif")}
        for name in names:
            member = next((m for base, m in members.items() if base.startswith(name + "_")), None)
            if member is None:
                print(f"{name}: no tile in {block} (sea or outside coverage)")
                continue
            target = os.path.join(args.out, os.path.basename(member.filename))
            if not os.path.exists(target):
                with archive.open(member) as src, open(target + ".part", "wb") as dst:
                    while chunk := src.read(1 << 20):
                        dst.write(chunk)
                os.replace(target + ".part", target)
            with open(target, "rb") as f:
                digest = hashlib.sha256(f.read()).hexdigest()
            files.append({"file": os.path.basename(target), "bytes": os.path.getsize(target), "sha256": digest, "archive": url})
            print(f"{name}: {files[-1]['bytes']} bytes")
    manifest = {"schemaVersion": 1, "source": "FABDEM V1-2", "license": LICENSE, "attribution": ATTRIBUTION,
                "verticalDatum": "EGM2008 orthometric (as published)", "bbox": config["bbox"], "files": files}
    with open(os.path.join(args.out, "fabdem-manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"{len(files)} tiles -> {args.out}")


if __name__ == "__main__":
    main()
