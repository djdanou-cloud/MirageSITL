#!/usr/bin/env python3
"""Read-only TASK-033 audit of local AirfoilPrep and UIUC coordinate inputs.

Requires Python 3.9+ and xlrd==2.0.2 for legacy XLS reading. No Excel macros
execute and cached workbook outputs are never treated as fresh calculations.
Usage: python scripts/audit-airfoil-inputs.py [--check] [--output PATH]
The default output is test-results/validation/airfoil-inputs.json.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK_SHA256 = "92dd2e724d2f803126b75175e54cdaed49a3c4ffd7500c0734e2ccae70888fcf"
COORDINATE_SHA256 = "bded9325786728f61ce93d740f49ff4df66f9a58c58110d8f85809ec4340a02a"
SHEETS = ["ReadMe", "ChangeLog", "Interpolate", "BlendAirfoils", "3DStall",
          "TableExtrap", "DynStall", "Editor Format"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse_selig(text):
    """Strict single-element Selig contour; unsupported files are reported.

    Geometry is dimensionless x/c,y/c. Do not silently convert Lednicer counts,
    multielement separators, nonfinite values or unordered contours into polars.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 11:
        raise ValueError("fewer than ten coordinate points")
    points = []
    for line in lines[1:]:
        fields = line.split()
        if len(fields) != 2:
            raise ValueError("expected two numeric columns")
        try:
            x, y = map(float, fields)
        except ValueError as error:
            raise ValueError("nonnumeric coordinate or separator") from error
        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("nonfinite coordinate")
        # Permit small trailing-edge normalization offsets, not count records.
        if not -0.05 <= x <= 1.05 or abs(y) > 0.5:
            raise ValueError("outside normalized single-airfoil bounds")
        points.append((x, y))
    leading = min(range(len(points)), key=lambda i: points[i][0])
    if leading == 0 or leading == len(points) - 1:
        raise ValueError("missing two surfaces around leading edge")
    if points[0][0] < 0.9 or points[-1][0] < 0.9:
        raise ValueError("contour must start and end at trailing edge")
    if any(points[i + 1][0] > points[i][0] + 0.002 for i in range(leading)):
        raise ValueError("upper surface is not trailing-to-leading")
    if any(points[i + 1][0] < points[i][0] - 0.002 for i in range(leading, len(points) - 1)):
        raise ValueError("lower surface is not leading-to-trailing")
    return lines[0], points


def workbook_audit(path):
    import xlrd
    if xlrd.__version__ != "2.0.2":
        raise ValueError("Use the pinned read-only xlrd==2.0.2 reader")
    digest = sha(path.read_bytes())
    if digest != WORKBOOK_SHA256:
        raise ValueError("AirfoilPrep workbook differs from the reviewed source")
    book = xlrd.open_workbook(path)
    if book.sheet_names() != SHEETS:
        raise ValueError("Unexpected workbook sheet contract")
    table = book.sheet_by_name("TableExtrap")
    # Independent arithmetic against the workbook's saved positive Viterna
    # branch. No recalculation or macro execution is implied by this check.
    rows = [table.row_values(i) for i in range(14, table.nrows)]
    input_rows = [r[1:5] for r in rows if isinstance(r[1], float)]
    match_alpha, match_cl, match_cd, _ = input_rows[-1]
    angle = math.radians(match_alpha)
    cd_max = table.cell_value(5, 1)
    a = (match_cl - cd_max * math.sin(angle) * math.cos(angle)) * math.sin(angle) / math.cos(angle) ** 2
    b = (match_cd - cd_max * math.sin(angle) ** 2) / math.cos(angle)
    comparisons = []
    for row in rows:
        alpha = row[7]
        if isinstance(alpha, float) and match_alpha < alpha <= 90:
            angle = math.radians(alpha)
            cl = cd_max * math.sin(2 * angle) / 2 + a * math.cos(angle) ** 2 / math.sin(angle)
            cd = cd_max * math.sin(angle) ** 2 + b * math.cos(angle)
            comparisons.append({"alphaDeg": alpha, "clError": abs(cl - row[8]), "cdError": abs(cd - row[9])})
    if len(comparisons) < 3 or any(max(x["clError"], x["cdError"]) > 1e-12 for x in comparisons):
        raise ValueError("Saved Viterna example does not match the independently evaluated branch")
    return {
        "file": path.name, "sha256": digest, "reader": "xlrd 2.0.2",
        "sourceUrl": "https://nrel.sitefinity.cloud/wind/nwtc/airfoil-prep",
        "sheets": SHEETS, "macrosExecuted": False, "recalculated": False,
        "classification": "preprocessing-method-and-unidentified-example-not-measured-SDA1075",
        "capabilities": ["linear interpolation", "airfoil blending", "Du-Selig/Eggers rotational correction", "Viterna extrapolation", "dynamic-stall parameter preparation"],
        "savedExampleCheck": {"sheet": "TableExtrap", "inputRange": "B15:E37", "cdMaxCell": "B6", "matchAlphaDeg": match_alpha, "tolerance": 1e-12, "positiveBranch": comparisons},
    }


def audit(root=ROOT):
    folder = root / "coord_seligFmt"
    files = sorted(folder.rglob("*"), key=lambda p: p.relative_to(folder).as_posix())
    records, unsupported, names, usable = [], [], [], 0
    for path in files:
        if not path.is_file():
            continue
        relative = path.relative_to(folder).as_posix()
        data = path.read_bytes()
        records.append(f"{relative}\t{sha(data)}\n")
        try:
            header, _ = parse_selig(data.decode("utf-8-sig"))
            usable += 1
            if "sda1075" in (path.stem + header).lower().replace(" ", "").replace("-", ""):
                names.append(relative)
        except (ValueError, UnicodeError) as error:
            unsupported.append({"file": relative, "reason": str(error)})
    if not records:
        raise ValueError("Coordinate archive is empty or missing")
    aggregate = sha("".join(records).encode())
    if len(records) != 1665 or aggregate != COORDINATE_SHA256:
        raise ValueError("Coordinate archive differs from the reviewed source")
    baseline = root / "tests/fixtures/rotors/uiuc/sda1075.dat"
    _, baseline_points = parse_selig(baseline.read_text(encoding="utf8"))
    return {
        "schemaVersion": 1, "task": "TASK-033", "generatorSha256": sha(Path(__file__).read_bytes()),
        "workbook": workbook_audit(root / "airfoilprep_v2-02-03.xls"),
        "coordinates": {"directory": "coord_seligFmt", "sourceUrl": "https://m-selig.ae.illinois.edu/ads/coord_database.html",
                        "kind": "geometry-not-aerodynamic-coefficients", "files": len(records),
                        "aggregateRule": "SHA-256 of sorted relative/path TAB file-SHA256 LF lines",
                        "aggregateSha256": aggregate, "supportedSingleElementFiles": usable,
                        "unsupportedFiles": unsupported, "sda1075NameMatches": names},
        "currentPropellerAirfoil": {"file": "tests/fixtures/rotors/uiuc/sda1075.dat", "sha256": sha(baseline.read_bytes()), "points": len(baseline_points), "action": "retain published SDA1075 transcription; do not substitute a similarly named airfoil"},
        "acceptance": {"measuredFidelityEstablished": False, "reason": "Coordinates and extrapolation methods do not provide measured CL/CD versus alpha, Reynolds number and Mach; existing propeller tolerance failures remain."},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "test-results/validation/airfoil-inputs.json")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    data = json.dumps(audit(), indent=2, ensure_ascii=True) + "\n"
    if args.check:
        if args.output.read_text(encoding="utf8") != data:
            raise SystemExit("Airfoil input report is stale")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf8", newline="\n") as output:
            output.write(data)
    print("Airfoil input provenance and saved-example arithmetic verified; measured fidelity remains unestablished")


if __name__ == "__main__":
    main()
