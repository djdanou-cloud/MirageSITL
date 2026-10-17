#!/usr/bin/env python3
"""Deterministic generator of JSBSim propeller definitions from UIUC data (TASK-086).

Reads the hash-verified UIUC Propeller Database archive (same pinned digest
as tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py) and writes one
JSBSim propeller file per selected propeller into data/jsbsim/engine/, plus
data/jsbsim/engine/uiuc-propellers.manifest.json with per-file provenance.

JSBSim's fixed-pitch propeller uses the same coefficient convention as the
UIUC tables: J = V/(nD), C_THRUST = T/(rho n^2 D^4), C_POWER = P/(rho n^3 D^5).
Its C_THRUST/C_POWER tables depend on J only, so one RPM is chosen per
propeller by a rule fixed here, before any use:

  1. Runs whose RPM rounds to the same multiple of 250 form one group
     (UIUC splits some sweeps into low- and high-J runs at nearly equal RPM).
  2. The group with the highest RPM whose merged sweep reaches CT <= 0
     (zero thrust) is chosen; if none does, the group with the largest J.
  3. The J = 0 row is the static-table row whose RPM is nearest the group's
     mean RPM, copied as printed.
  4. Rows are sorted by J; rows with equal printed J keep the first by source
     order. Nothing is interpolated, smoothed or extrapolated. Beyond the
     last row JSBSim holds the end value, which is outside measured validity.

Diameters are the nominal names; the archive notes that Vol 4 coefficients
use the true diameter shown in its geometry plots. Rotational inertia is not
in the dataset, so no ixx element is written.

Usage (repository root, Python 3.9+ standard library only):
  python3 -I data/jsbsim/generate_uiuc_propellers.py [--source DIR]
  python3 -I data/jsbsim/generate_uiuc_propellers.py --check [--source DIR]
"""
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ENGINE = HERE / "engine"
MANIFEST = ENGINE / "uiuc-propellers.manifest.json"
PINNED_DATA_SHA256 = "0b00acaffdacef96f21973960ea3bb7a64b94d385fef5b00b6323b8330c42069"
PINNED_DATA_FILES = 1994
CITATION = (
    "J.B. Brandt, R.W. Deters, G.K. Ananda, O.D. Dantsker, and M.S. Selig "
    "(downloaded before 2026-10-17), UIUC Propeller Database, Vols 1-4, "
    "University of Illinois at Urbana-Champaign, retrieved from "
    "https://m-selig.ae.illinois.edu/props/propDB.html."
)
# (archive prefix, volume, display name, blade count)
SELECTED = [
    ("apce_10x5", "volume-1", "APC Thin Electric 10x5", 2),
    ("apce_10x7", "volume-1", "APC Thin Electric 10x7", 2),
    ("apce_11x7", "volume-1", "APC Thin Electric 11x7", 2),
    ("apce_12x6", "volume-4", "APC Thin Electric 12x6", 2),
    ("apce_14x10", "volume-4", "APC Thin Electric 14x10", 2),
    ("da4002_9x6.75", "volume-2", "UIUC DA4002 9x6.75", 2),
]
# Vol 1 run codes are letters then digits (kt0821); Vols 2-4 digits then letters (0630od).
CODE = r"(?:[a-z]{2}\d{4}|\d{4}[a-z]{2})"
RUN = re.compile(rf"^(?P<prefix>.+)_(?P<run>{CODE})_(?P<rpm>\d+)\.txt$")
STATIC = re.compile(rf"^(?P<prefix>.+)_static_(?P<run>{CODE})\.txt$")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def table(data, header, path):
    """Rows of printed tokens under an exact header (optional leading RPM-average line)."""
    lines = [l for l in data.decode("ascii").splitlines() if l.strip()]
    if lines and re.fullmatch(r"RPM average =\s+\d+", lines[0].strip()):
        lines = lines[1:]
    if not lines or lines[0].split() != header:
        raise SystemExit(f"Unexpected header in {path}")
    rows = [l.split() for l in lines[1:]]
    if not rows or any(len(r) != len(header) for r in rows):
        raise SystemExit(f"Malformed table {path}")
    for r in rows:
        for t in r:
            float(t)
    return rows


def verify(source):
    files = sorted(p.relative_to(source).as_posix() for p in source.glob("volume-*/data/*.txt"))
    lines = "".join(f"{rel}\t{sha((source / rel).read_bytes())}\n" for rel in files)
    if len(files) != PINNED_DATA_FILES or sha(lines.encode()) != PINNED_DATA_SHA256:
        raise SystemExit("UIUC archive digest mismatch")


def build(source, prefix, volume, name, blades):
    data_dir = source / volume / "data"
    runs, static = [], None
    for path in sorted(data_dir.glob(f"{prefix}_*.txt")):
        rel = path.relative_to(source).as_posix()
        if (m := RUN.match(path.name)) and m["prefix"] == prefix:
            rows = table(path.read_bytes(), ["J", "CT", "CP", "eta"], rel)
            runs.append({"source": rel, "sha256": sha(path.read_bytes()), "rpm": int(m["rpm"]), "rows": rows})
        elif (m := STATIC.match(path.name)) and m["prefix"] == prefix:
            static = {"source": rel, "sha256": sha(path.read_bytes()),
                      "rows": table(path.read_bytes(), ["RPM", "CT", "CP"], rel)}
    if not runs or static is None:
        raise SystemExit(f"Missing advance or static tables for {prefix}")
    groups = {}
    for run in runs:
        groups.setdefault(round(run["rpm"] / 250) * 250, []).append(run)
    reaches_zero = lambda g: any(float(r[1]) <= 0 for run in g for r in run["rows"])
    max_j = lambda g: max(float(r[0]) for run in g for r in run["rows"])
    zero = [k for k, g in groups.items() if reaches_zero(g)]
    key = max(zero) if zero else max(groups, key=lambda k: (max_j(groups[k]), k))
    chosen = groups[key]
    mean_rpm = sum(run["rpm"] for run in chosen) / len(chosen)
    static_row = min(static["rows"], key=lambda r: (abs(float(r[0]) - mean_rpm), float(r[0])))
    rows = [("0.0", static_row[1], static_row[2])]
    seen = {0.0}
    for run in chosen:
        for r in run["rows"]:
            if float(r[0]) not in seen:
                seen.add(float(r[0]))
                rows.append((r[0], r[1], r[2]))
    rows.sort(key=lambda r: float(r[0]))
    diameter_in = float(prefix.split("_")[1].split("x")[0])
    file_name = f"uiuc_{prefix.replace('.', 'p')}.xml"
    body = [
        '<?xml version="1.0"?>',
        "<!--",
        f"  {name}, {blades} blades, generated by data/jsbsim/generate_uiuc_propellers.py (TASK-086).",
        f"  Source: {CITATION}",
        f"  Advance-ratio runs at about {key} RPM: " + ", ".join(run["source"] for run in chosen) + ".",
        f"  J = 0 row: {static['source']} at {static_row[0]} RPM.",
        "  Rows are measured values as printed; no ixx (inertia is not in the dataset).",
        "  Beyond the last J row JSBSim holds the end value: outside measured validity.",
        "-->",
        f'<propeller name="{name} (UIUC, {key} RPM)">',
        f'  <diameter unit="IN"> {diameter_in:g} </diameter>',
        f"  <numblades> {blades} </numblades>",
    ]
    for table_name, column in (("C_THRUST", 1), ("C_POWER", 2)):
        body += [f'  <table name="{table_name}" type="internal">', "    <tableData>"]
        body += [f"      {r[0]:>10} {r[column]:>10}" for r in rows]
        body += ["    </tableData>", "  </table>"]
    body += ["</propeller>", ""]
    xml = "\n".join(body).encode()
    entry = {
        "file": f"data/jsbsim/engine/{file_name}",
        "sha256": sha(xml),
        "propeller": prefix,
        "name": name,
        "bladeCount": blades,
        "diameterIn": diameter_in,
        "rpmGroup": key,
        "meanRpm": mean_rpm,
        "rows": len(rows),
        "maxAdvanceRatio": float(rows[-1][0]),
        "reachesZeroThrust": key in zero,
        "sources": [{"source": run["source"], "sha256": run["sha256"], "rpm": run["rpm"]} for run in chosen]
        + [{"source": static["source"], "sha256": static["sha256"], "staticRpm": float(static_row[0])}],
    }
    return file_name, xml, entry


def generate(source):
    verify(source)
    outputs, entries = {}, []
    for args in SELECTED:
        file_name, xml, entry = build(source, *args)
        outputs[ENGINE / file_name] = xml
        entries.append(entry)
    manifest = {
        "schemaVersion": 1,
        "datasetId": "UIUC-Propeller-Database-Vols-1-4",
        "archiveDataSha256": PINNED_DATA_SHA256,
        "license": "UIUC-Propeller-Database-citation-requested-no-explicit-license",
        "citation": CITATION,
        "jsbsimFormat": "fixed-pitch propeller, C_THRUST/C_POWER versus J; validated against JSBSim v1.2.3 only when the native bridge runs",
        "propellers": entries,
    }
    outputs[MANIFEST] = (json.dumps(manifest, indent=1) + "\n").encode()
    return outputs


def main(argv):
    source = ROOT / "UIUC-propDB"
    if "--source" in argv:
        source = Path(argv[argv.index("--source") + 1]).resolve()
    if not (source / "README.txt").is_file():
        raise SystemExit(f"UIUC archive not found: {source}")
    for path, data in generate(source).items():
        if "--check" in argv:
            if not path.is_file() or path.read_bytes() != data:
                raise SystemExit(f"Stale generated file: {path.relative_to(ROOT).as_posix()}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        print(f"{path.relative_to(ROOT).as_posix()} sha256={sha(data)}")


if __name__ == "__main__":
    main(sys.argv[1:])
