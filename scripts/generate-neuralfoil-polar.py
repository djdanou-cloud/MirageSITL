"""Offline configurable NACA NeuralFoil polar generation and confidence-aware lookup.

Install scripts/neuralfoil-requirements.txt in an isolated environment. No
NeuralFoil execution belongs in the physics loop. --check never rewrites data.
"""
import argparse
import bisect
import hashlib
import importlib.metadata
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests/fixtures/polars/naca6409-neuralfoil.json"
FIELDS = {"cl": "CL", "cd": "CD", "cm": "CM", "analysisConfidence": "analysis_confidence",
          "topXtr": "Top_Xtr", "botXtr": "Bot_Xtr"}
REYNOLDS = [1000, 5000, 10000, 20000, 40000, 60000, 100000, 200000, 500000, 1000000]
ALPHA = [i / 2 for i in range(-60, 61)]
CONFIDENCE = 0.9


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, indent=2, allow_nan=False) + "\n").encode()


def airfoil_name(value):
    if not isinstance(value, str) or not re.fullmatch(r"NACA[0-9]{4}", value.upper()):
        raise ValueError("Expected a NACA four-digit airfoil name")
    name = value.upper()
    if int(name[-2:]) == 0 or (name[4] != "0" and name[5] == "0"):
        raise ValueError("Invalid NACA thickness or camber location")
    return name


def validate(value, expected_airfoil=None):
    name = airfoil_name(value.get("airfoil"))
    if (value.get("schemaVersion") != 1 or (expected_airfoil is not None and name != airfoil_name(expected_airfoil))
            or value.get("provenance") != "neural-surrogate" or value.get("mach") != [0]):
        raise ValueError("Expected matching incompressible NACA neural-surrogate data")
    for name in ("alphaDeg", "reynolds"):
        axis = value[name]
        if (not axis or not all(math.isfinite(v) for v in axis)
                or any(b <= a for a, b in zip(axis, axis[1:]))):
            raise ValueError("Invalid axis: " + name)
    if value["reynolds"][0] <= 0:
        raise ValueError("Reynolds number must be positive")
    for name in FIELDS:
        table = value[name]
        if len(table) != len(value["reynolds"]) or any(len(row) != len(value["alphaDeg"]) for row in table):
            raise ValueError("Invalid table shape: " + name)
        for row in table:
            for number in row:
                if not math.isfinite(number) or (name == "cd" and number < 0):
                    raise ValueError("Invalid coefficient: " + name)
                if name in ("analysisConfidence", "topXtr", "botXtr") and not 0 <= number <= 1:
                    raise ValueError("Invalid bounded coefficient: " + name)


def bracket(axis, number, logarithmic=False):
    number = min(max(number, axis[0]), axis[-1])
    i = min(max(bisect.bisect_right(axis, number) - 1, 0), len(axis) - 1)
    if number == axis[i] or i == len(axis) - 1:
        return [(i, 1.0)]
    transform = math.log if logarithmic else float
    weight = (transform(number) - transform(axis[i])) / (transform(axis[i + 1]) - transform(axis[i]))
    return [(i, 1 - weight), (i + 1, weight)]


def lookup(value, alpha_deg, reynolds, mach):
    """Cold diagnostic lookup; clamped outputs always retain validity flags."""
    validate(value)
    if not all(math.isfinite(v) for v in (alpha_deg, reynolds, mach)) or reynolds <= 0 or mach < 0:
        raise ValueError("Invalid polar query")
    flags = []
    if not (value["alphaDeg"][0] <= alpha_deg <= value["alphaDeg"][-1]
            and value["reynolds"][0] <= reynolds <= value["reynolds"][-1]):
        flags.append("outside-table")
    if mach != 0:
        flags.append("unsupported-mach")
    corners = [(r, a, rw * aw) for r, rw in bracket(value["reynolds"], reynolds, True)
               for a, aw in bracket(value["alphaDeg"], alpha_deg)]
    confidence = min(value["analysisConfidence"][r][a] for r, a, _ in corners)
    if confidence < CONFIDENCE:
        flags.append("low-confidence")
    return {**{name: sum(value[name][r][a] * w for r, a, w in corners)
               for name in ("cl", "cd", "cm", "topXtr", "botXtr")},
            "minimumCornerConfidence": confidence, "flags": flags}


def generate(airfoil_name_value="NACA6409"):
    import aerosandbox as asb
    import neuralfoil as nf
    import numpy as np

    requirements = ROOT / "scripts/neuralfoil-requirements.txt"
    versions = {}
    for line in requirements.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        name, expected = line.split("==")
        versions[name] = importlib.metadata.version(name)
        if versions[name] != expected:
            raise ValueError(f"Dependency mismatch: {name} needs {expected}")
    section_name = airfoil_name(airfoil_name_value)
    airfoil = asb.Airfoil(section_name.lower())
    coordinates = airfoil.coordinates.tolist()
    tables = {name: [] for name in FIELDS}
    for reynolds in REYNOLDS:
        aero = nf.get_aero_from_airfoil(airfoil=airfoil, alpha=np.array(ALPHA), Re=reynolds,
                                       n_crit=9.0, xtr_upper=1.0, xtr_lower=1.0, model_size="xxxlarge")
        for name, key in FIELDS.items():
            tables[name].append(np.asarray(aero[key]).reshape(-1).tolist())
    package = Path(nf.__file__).parent
    sources = [p for p in package.rglob("*") if p.suffix in (".py", ".npz")]
    result = {
        "schemaVersion": 1, "id": section_name.lower() + "-neuralfoil-v1", "airfoil": section_name,
        "provenance": "neural-surrogate", "sourceUrl": "https://github.com/peterdsharpe/NeuralFoil",
        "dependencies": versions,
        "sourceHashes": {p.relative_to(package).as_posix(): sha(p.read_bytes()) for p in sorted(sources)},
        "geometry": {"method": "AeroSandbox analytic NACA four-digit coordinates; NeuralFoil internal Kulfan fit",
                     "coordinatesSha256": sha(encode(coordinates)), "coordinates": coordinates},
        "settings": {"modelSize": "xxxlarge", "nCrit": 9.0, "xtrUpper": 1.0, "xtrLower": 1.0,
                     "minimumConfidence": CONFIDENCE, "interpolation": "linear alpha; logarithmic Reynolds",
                     "outsideTable": "clamp and flag; no extrapolation", "compressibility": "none; Mach=0 only",
                     "postStallExtension": "none", "confidenceRule": "minimum contributing corner; not measured accuracy"},
        "limitations": ["Two-dimensional airfoil surrogate only; no measured-fidelity claim",
                        "Does not generate rotor interaction, wake, motor, battery or airframe data",
                        "Does not replace SDA1075 UIUC measured comparisons or enable production BET/READY"],
        "alphaDeg": ALPHA, "reynolds": REYNOLDS, "mach": [0], **tables,
    }
    validate(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--airfoil", default="NACA6409", type=airfoil_name)
    parser.add_argument("--query", type=float, nargs=3, metavar=("ALPHA_DEG", "REYNOLDS", "MACH"),
                        help="Look up the saved table without importing NeuralFoil")
    args = parser.parse_args()
    output = ROOT / "tests/fixtures/polars" / (args.airfoil.lower() + "-neuralfoil.json")
    if args.query is not None:
        if args.check:
            parser.error("--query and --check are mutually exclusive")
        value = json.loads(output.read_bytes())
        validate(value, args.airfoil)
        print(json.dumps(lookup(value, *args.query), allow_nan=False))
        return
    result = generate(args.airfoil)
    data = encode(result)
    if args.check:
        if output.read_bytes() != data:
            raise SystemExit("Generated polar is stale; no files changed")
    else:
        output.write_bytes(data)
    confident = sum(v >= CONFIDENCE for row in result["analysisConfidence"] for v in row)
    print(f"{output.relative_to(ROOT).as_posix()} sha256={sha(data)} "
          f"points={len(ALPHA) * len(REYNOLDS)} confidence>=0.9={confident}")


if __name__ == "__main__":
    main()
