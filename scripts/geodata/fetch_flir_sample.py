"""Fetch one thermal video sequence from the Teledyne FLIR ADAS v2 dataset (TASK-073 P5).

The dataset is a single 11.8 GB zip. The server accepts HTTP byte ranges, so
this reads the archive's central directory remotely and downloads only the
members of one `video_thermal_test` sequence: the 14-bit radiometric TIFFs
(`analyticsData`) and the 8-bit AGC JPEGs (`data`). It also keeps the
dataset README and the `coco.json` image records (with `extra_info`) of those
frames. Standard library only; zipfile checks every member's CRC-32.

    python3 -I scripts/geodata/fetch_flir_sample.py --out ~/mirage-geodata/flir-adas-v2 [--video vbrSzr4vFTm5QwuGH]

Writes <out>/<video>/{analyticsData,data}/..., README.txt and
flir-sample-manifest.json (archive URL, size and published MD5, member names,
bytes, CRC-32 and SHA-256, camera notes, terms URL). The sample is a visual
reference only: it was recorded by a Tau 2 (13 mm, 45 deg HFOV, T-linear)
on a car, not by a Boson 640 over the area of operation, so it supports
qualitative comparison, never instrument parity.
"""
import argparse
import datetime
import hashlib
import json
import os
import sys
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_fabdem import RangeFile  # noqa: E402  (isolated mode: the script directory is not on sys.path)

BASE = "https://adas-dataset-v2.flirconservator.com/dataset"
ARCHIVE = f"{BASE}/full/FLIR_ADAS_v2.zip"
TERMS = "https://www.flir.com/oem/adas/adas-dataset-agree/"
SPLIT = "video_thermal_test"


def fetch_text(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read().decode("utf-8", "replace")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--video", default="vbrSzr4vFTm5QwuGH", help="sequence id in the frame file names (the smallest test video by default)")
    args = parser.parse_args()
    if not args.video.isalnum():
        raise SystemExit("--video must be an alphanumeric sequence id")
    out = os.path.join(os.path.expanduser(args.out), args.video)
    os.makedirs(out, exist_ok=True)

    md5_line = next((line for line in fetch_text(f"{BASE}/full/md5sums_full.txt").splitlines() if line.strip().endswith("FLIR_ADAS_v2.zip")), "")
    readme = fetch_text(f"{BASE}/README.txt")
    with open(os.path.join(out, "README.txt"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(readme)

    remote = RangeFile(ARCHIVE)
    prefix = f"-{args.video}-frame-"
    members = []
    with zipfile.ZipFile(remote) as archive:
        wanted = [info for info in archive.infolist()
                  if info.filename.startswith((f"{SPLIT}/analyticsData/", f"{SPLIT}/data/")) and prefix in info.filename]
        if not wanted:
            raise SystemExit(f"No frames of video {args.video} in {SPLIT}")
        total = sum(info.compress_size for info in wanted)
        print(f"{len(wanted)} members, {total / 1e6:.1f} MB compressed", flush=True)
        for n, info in enumerate(sorted(wanted, key=lambda i: i.filename)):
            relative = info.filename[len(SPLIT) + 1:]
            target = os.path.join(out, *relative.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            data = archive.read(info)  # raises BadZipFile on a CRC mismatch
            with open(target, "wb") as handle:
                handle.write(data)
            members.append({"member": info.filename, "bytes": len(data), "crc32": f"{info.CRC:08x}", "sha256": hashlib.sha256(data).hexdigest()})
            if n % 50 == 0:
                print(f"  {n + 1}/{len(wanted)} {relative}", flush=True)
        coco = json.loads(archive.read(f"{SPLIT}/coco.json"))
    names = {m["member"][len(SPLIT) + 1:] for m in members}
    images = [image for image in coco.get("images", []) if image.get("file_name") in names]

    manifest = {
        "schemaVersion": 1,
        "dataset": "Teledyne FLIR Free ADAS Thermal Dataset v2",
        "archive": {"url": ARCHIVE, "bytes": remote.size, "publishedMd5": md5_line.split()[0] if md5_line else None},
        "terms": TERMS,
        "camera": "Teledyne FLIR Tau 2, 13 mm f/1.0, 45 deg HFOV, 37 deg VFOV, T-linear mode, 30 FPS (dataset README)",
        "use": "Visual reference for the synthetic Boson 640 profile; not instrument parity data.",
        "split": SPLIT,
        "video": args.video,
        "retrievedUtc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "readmeSha256": hashlib.sha256(readme.encode("utf-8")).hexdigest(),
        "frames": {"analyticsData": sum(1 for m in members if "/analyticsData/" in m["member"]), "data": sum(1 for m in members if "/data/" in m["member"])},
        "cocoImages": images,
        "members": members,
    }
    with open(os.path.join(out, "flir-sample-manifest.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=1)
        handle.write("\n")
    digest = hashlib.sha256(open(os.path.join(out, "flir-sample-manifest.json"), "rb").read()).hexdigest()
    print(f"wrote {len(members)} files and flir-sample-manifest.json (sha256 {digest}) to {out}")


if __name__ == "__main__":
    main()
