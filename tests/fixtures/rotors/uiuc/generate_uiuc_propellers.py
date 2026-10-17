#!/usr/bin/env python3
"""Deterministic generator for the UIUC propeller database inventory and fixture.

Reads a local copy of the UIUC Propeller Database archive (Vols 1-4, archive
README dated 6/27/2022), verifies every data table against the pinned
aggregate digest, audits all J-sweep tables with two dataset-only oracles,
and writes:

  data/uiuc-propdb/inventory.json          per-file SHA-256, counts, audit
  tests/fixtures/rotors/uiuc-propellers.json  DA4002/DA4022 measured subset

Only the DA4002 and DA4022 propellers are extracted: they are the only
database propellers whose blade airfoil is published (SDA1075 along the full
blade, Deters, Ananda and Selig, AIAA 2014-2151, section III and Appendix A).
Commercial propellers have measured chord/twist but no published airfoil, so a
blade-element comparison would rest on an unknown polar.

Audit oracles (independent of any model):
  * eta consistency: |eta - J*CT/CP| <= printed rounding bound + allowance;
  * Froude bound: eta <= 2/(1 + sqrt(1 + 8*CT/(pi*J^2))) for J > 0, CT > 0.

Values are copied exactly as printed; nothing is digitized, interpolated or
extrapolated. Comparison tolerances are declared here, before evaluation.

Usage (repository root, Python 3.9+ standard library only):
  python3 -I tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py [--source DIR]
  python3 -I tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py --check [--source DIR]
DIR defaults to ./UIUC-propDB (the unpacked archive root containing README.txt).
"""
import hashlib
import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
FIXTURE = HERE.parent / "uiuc-propellers.json"
INVENTORY = ROOT / "data" / "uiuc-propdb" / "inventory.json"

DATASET_ID = "UIUC-Propeller-Database-Vols-1-4"
REFERENCE_URL = "https://m-selig.ae.illinois.edu/props/propDB.html"
CITATION = (
    "J.B. Brandt, R.W. Deters, G.K. Ananda, O.D. Dantsker, and M.S. Selig "
    "(downloaded before 2026-10-17), UIUC Propeller Database, Vols 1-4, "
    "University of Illinois at Urbana-Champaign, retrieved from "
    "https://m-selig.ae.illinois.edu/props/propDB.html."
)
LICENSE = "UIUC-Propeller-Database-citation-requested-no-explicit-license"
ACQUIRED_AT = "2022-06-27T00:00:00Z"  # archive README date; no download timestamp supplied

# SHA-256 of the sorted "relative/path\tsha256\n" lines of every volume-*/data/*.txt.
PINNED_DATA_SHA256 = "0b00acaffdacef96f21973960ea3bb7a64b94d385fef5b00b6323b8330c42069"
PINNED_DATA_FILES = 1994
README_SHA256 = "7c2d9122fad0422b45705ee61fcc7c605aea54ce491d3e57c6905f0955055018"

PAPER = "papers/DetersAnandaSelig-2014-AIAA-2014-2151.pdf"
PAPER_SHA256 = "40d54828999ab9c0bda7fe5ab637160a9836994f3bde3b55835d06b8f0492b2a"
# Table 4 transcribed with pdftotext -layout; 31 upper (TE->LE) then 30 lower (LE->TE) points.
AIRFOIL_FILE = HERE / "sda1075.dat"
AIRFOIL_SHA256 = "a48e0ed6abff05a2858def4a9a0016f9b570322d3437f8b75d4c54dd6044836e"

IN_M = 0.0254
FAMILIES = ("da4002", "da4022")
# The eta column of the six-decimal tables (Vols 2-4) differs from J*CT/CP of
# the printed columns by up to 4.06e-4 over 23382 positive-thrust points
# (consistent with eta reduced per sample, then averaged); allow 1e-3.
ETA_REDUCTION_ALLOWANCE = 1e-3

# Declared before any BET evaluation (TASK-033 failure criterion).
COMPARISON = {
    "ctRelativeTolerance": 0.10,
    "ctAbsoluteTolerance": 0.005,
    "cpRelativeTolerance": 0.10,
    "cpAbsoluteTolerance": 0.003,
    # SDA1075 covers the blade except near the hub (AIAA 2014-2151); the
    # design geometry (da4002_geom.txt) starts at r/R = 0.30.
    "airfoilStartRadiusRatio": 0.30,
    # The archive lists no per-run ambient state: ISA sea level.
    "densityKgM3": 1.225,
    "viscosityPaS": 1.789e-5,
    "soundSpeedMps": 340.294,
}

NAME = re.compile(
    r"^(?P<family>[a-z0-9]+)_(?P<size>\d+(?:\.\d+)?x\d+(?:\.\d+)?)"
    r"(?:_(?P<blades>\d)b)?_(?:(?P<static>static)_(?P<srun>\d{4}[a-z]{2})|(?P<run>\d{4}[a-z]{2})_(?P<rpm>\d+)|(?P<geom>geom))\.txt$"
)
NUMBER = re.compile(r"^-?\d+(?:\.\d+)?$")
HEADERS = {
    ("J", "CT", "CP", "eta"): "advance",
    ("RPM", "CT", "CP"): "static",
    ("r/R", "c/R", "beta"): "geometry",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def half_unit(token):
    """Half of the last printed digit."""
    return 0.5 * 10.0 ** -(len(token.split(".")[1]) if "." in token else 0)


def table(data, header, path):
    """Parses a whitespace table with an exact header; returns (rows, half units)."""
    lines = [line for line in data.decode("ascii").splitlines() if line.strip()]
    if lines and re.fullmatch(r"RPM average =\s+\d+", lines[0].strip()):
        lines = lines[1:]  # two Vol 2/4 tables print the run-average RPM first
    if not lines or lines[0].split() != header:
        raise SystemExit(f"Unexpected header in {path}: {lines[:1]}")
    rows, halves = [], None
    for line in lines[1:]:
        tokens = line.split()
        if len(tokens) != len(header) or not all(NUMBER.match(t) for t in tokens):
            raise SystemExit(f"Malformed row in {path}: {line!r}")
        rows.append([float(t) for t in tokens])
        h = [half_unit(t) for t in tokens]
        halves = h if halves is None else [max(a, b) for a, b in zip(halves, h)]
    if not rows:
        raise SystemExit(f"Empty table: {path}")
    return rows, halves


def audit_point(j, ct, cp, eta, h):
    """Returns (eta consistent, below Froude bound) or None when not applicable."""
    if j <= 0 or ct <= 0 or cp <= 0:
        return None
    ratio = j * ct / cp
    bound = h[3] + ratio * (h[0] / j + h[1] / ct + h[2] / cp) + ETA_REDUCTION_ALLOWANCE
    ideal = 2.0 / (1.0 + math.sqrt(1.0 + 8.0 * ct / (math.pi * j * j)))
    return abs(ratio - eta) <= bound, eta <= ideal + h[3]


def inventory(source):
    files = sorted(
        p.relative_to(source).as_posix()
        for p in source.glob("volume-*/data/*.txt")
    )
    entries = []
    for rel in files:
        data = (source / rel).read_bytes()
        entries.append({"path": rel, "sha256": sha(data), "bytes": len(data)})
    digest = sha("".join(f"{e['path']}\t{e['sha256']}\n" for e in entries).encode())
    return entries, digest


def generate(source):
    readme = (source / "README.txt").read_bytes()
    if sha(readme) != README_SHA256:
        raise SystemExit(f"README hash mismatch: {sha(readme)}")
    entries, digest = inventory(source)
    if len(entries) != PINNED_DATA_FILES or digest != PINNED_DATA_SHA256:
        raise SystemExit(f"Data digest mismatch: {len(entries)} files, {digest}")
    paper = source / PAPER
    if sha(paper.read_bytes()) != PAPER_SHA256:
        raise SystemExit("Airfoil source paper hash mismatch")
    airfoil_bytes = AIRFOIL_FILE.read_bytes()
    if sha(airfoil_bytes) != AIRFOIL_SHA256:
        raise SystemExit("SDA1075 transcription hash mismatch")

    counts, audit = {}, {"points": 0, "applicable": 0, "etaInconsistent": 0, "aboveFroudeBound": 0}
    selected = {}
    for entry in entries:
        rel = entry["path"]
        volume = rel.split("/")[0]
        name = rel.split("/")[-1]
        match = NAME.match(name)
        data = (source / rel).read_bytes()
        # Classify by header: a few names (e.g. uppercase run codes) do not match NAME.
        header = [l for l in data.decode("ascii").splitlines() if l.strip() and not l.startswith("RPM average")]
        kind = HEADERS.get(tuple(header[0].split()) if header else (), "other")
        counts.setdefault(volume, {"advance": 0, "static": 0, "geometry": 0, "other": 0})
        counts[volume][kind] += 1
        if kind == "advance":
            rows, halves = table(data, ["J", "CT", "CP", "eta"], rel)
            for row in rows:
                audit["points"] += 1
                result = audit_point(*row, halves)
                if result is not None:
                    audit["applicable"] += 1
                    audit["etaInconsistent"] += not result[0]
                    audit["aboveFroudeBound"] += not result[1]
        elif kind != "other":
            table(data, list(next(k for k, v in HEADERS.items() if v == kind)), rel)
        if match and match["family"] in FAMILIES:
            selected[rel] = (match, data, entry["sha256"])

    propellers = {}
    for rel, (match, data, digest_hex) in sorted(selected.items()):
        size = match["size"]
        blades = int(match["blades"] or 2)
        key = f"{match['family']}-{size}-{blades}b"
        diameter_in, pitch_in = (float(v) for v in size.split("x"))
        prop = propellers.setdefault(key, {
            "id": key,
            "family": match["family"].upper(),
            "airfoil": "SDA1075",
            "bladeCount": blades,
            "diameterM": round(diameter_in * IN_M, 12),
            "nominalPitchM": round(pitch_in * IN_M, 12),
            "geometry": None,
            "static": None,
            "runs": [],
        })
        if match["run"]:
            rows, halves = table(data, ["J", "CT", "CP", "eta"], rel)
            prop["runs"].append({
                "source": rel, "sha256": digest_hex, "rpm": int(match["rpm"]),
                "halfUnit": halves,
                "points": rows,
            })
        elif match["static"]:
            rows, halves = table(data, ["RPM", "CT", "CP"], rel)
            prop["static"] = {"source": rel, "sha256": digest_hex, "halfUnit": halves, "points": rows}
    # Blade geometry is shared across blade counts; it is listed per diameter/pitch.
    for prop in propellers.values():
        family = prop["family"].lower()
        size = prop["id"].split("-")[1]
        geometry = f"volume-2/data/{family}_{size}_geom.txt"
        entry = next((e for e in entries if e["path"] == geometry), None)
        if entry is None:
            raise SystemExit(f"Missing measured geometry for {prop['id']}")
        rows, _ = table((source / geometry).read_bytes(), ["r/R", "c/R", "beta"], geometry)
        prop["geometry"] = {
            "source": geometry, "sha256": entry["sha256"],
            "radiusRatio": [r[0] for r in rows],
            "chordRatio": [r[1] for r in rows],
            "betaDeg": [r[2] for r in rows],
        }
        if not prop["runs"]:
            raise SystemExit(f"No advance-ratio runs for {prop['id']}")
        prop["runs"].sort(key=lambda run: (run["rpm"], run["source"]))

    fixture_audit = {"points": 0, "applicable": 0, "etaInconsistent": 0, "aboveFroudeBound": 0}
    for prop in propellers.values():
        for run in prop["runs"]:
            for row in run["points"]:
                fixture_audit["points"] += 1
                result = audit_point(*row, run["halfUnit"])
                if result is not None:
                    fixture_audit["applicable"] += 1
                    fixture_audit["etaInconsistent"] += not result[0]
                    fixture_audit["aboveFroudeBound"] += not result[1]

    coordinates = [
        [float(t) for t in line.split()]
        for line in airfoil_bytes.decode("ascii").splitlines()[1:]
    ]
    if len(coordinates) != 61:
        raise SystemExit("SDA1075 transcription must have 61 points")
    fixture = {
        "schemaVersion": 1,
        "id": "uiuc-propdb-da4002-da4022-v1",
        "datasetId": DATASET_ID,
        "referenceUrl": REFERENCE_URL,
        "citation": CITATION,
        "archive": {
            "readmeSha256": README_SHA256,
            "dataFiles": PINNED_DATA_FILES,
            "dataSha256": PINNED_DATA_SHA256,
            "inventory": "data/uiuc-propdb/inventory.json",
        },
        "etaReductionAllowance": ETA_REDUCTION_ALLOWANCE,
        "comparison": COMPARISON,
        "audit": fixture_audit,
        "airfoils": {
            "SDA1075": {
                "source": "Deters, Ananda and Selig, AIAA 2014-2151, Appendix A, Table 4",
                "sourcePdf": PAPER,
                "sourcePdfSha256": PAPER_SHA256,
                "transcription": "tests/fixtures/rotors/uiuc/sda1075.dat",
                "transcriptionSha256": AIRFOIL_SHA256,
                "coordinates": coordinates,
            }
        },
        "propellers": [propellers[k] for k in sorted(propellers)],
    }
    inventory_doc = {
        "schemaVersion": 1,
        "datasetId": DATASET_ID,
        "referenceUrl": REFERENCE_URL,
        "citation": CITATION,
        "license": LICENSE,
        "archiveReadmeDate": "2022-06-27",
        "readmeSha256": README_SHA256,
        "dataFiles": len(entries),
        "dataSha256": digest,
        "digestRule": "SHA-256 of sorted 'path\\tsha256\\n' lines over volume-*/data/*.txt",
        "counts": counts,
        "audit": {**audit, "etaReductionAllowance": ETA_REDUCTION_ALLOWANCE},
        "files": entries,
    }
    return fixture, inventory_doc


def layout(value, depth=0):
    """Indented JSON whose scalar-only arrays and flat objects stay on one line."""
    pad, inner = " " * depth, " " * (depth + 1)
    flat = lambda v: not isinstance(v, (list, dict))
    if isinstance(value, list) and value and not all(flat(v) for v in value):
        return "[\n" + ",\n".join(inner + layout(v, depth + 1) for v in value) + "\n" + pad + "]"
    if isinstance(value, dict) and not all(flat(v) for v in value.values()):
        items = [inner + json.dumps(k) + ": " + layout(v, depth + 1) for k, v in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    return json.dumps(value, separators=(", ", ": "))


def dump(value):
    return (layout(value) + "\n").encode()


def main(argv):
    check = "--check" in argv
    source = ROOT / "UIUC-propDB"
    if "--source" in argv:
        source = Path(argv[argv.index("--source") + 1]).resolve()
    if not (source / "README.txt").is_file():
        raise SystemExit(f"UIUC archive not found: {source}")
    fixture, inventory_doc = generate(source)
    outputs = {FIXTURE: dump(fixture), INVENTORY: dump(inventory_doc)}
    for path, data in outputs.items():
        if check:
            if not path.is_file() or path.read_bytes() != data:
                raise SystemExit(f"Stale generated file: {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        print(f"{path.relative_to(ROOT).as_posix()} sha256={sha(data)}")


if __name__ == "__main__":
    main(sys.argv[1:])
