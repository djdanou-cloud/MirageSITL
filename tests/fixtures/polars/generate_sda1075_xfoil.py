#!/usr/bin/env python3
"""Deterministic generator for tests/fixtures/polars/sda1075-xfoil.json.

Runs MIT XFOIL 6.99 (Windows build, pinned by SHA-256) on the SDA1075
coordinates transcribed in tests/fixtures/rotors/uiuc/sda1075.dat and writes
a rectangular CL/CD table over (Re, alpha) for the TASK-033 UIUC propeller
comparison. The output is viscous-solver data, not measurement: its registry
provenance is synthetic.

Fixed settings (declared before evaluation): default PANE repaneling, free
transition with Ncrit = 9, incompressible (Mach 0), ITER 200. Each Reynolds
number runs in a fresh XFOIL process: one sweep from 0 deg up to +14 deg,
then INIT and a sweep from -0.5 deg down to -8 deg, in 0.5 deg steps.
Unconverged angles are omitted by XFOIL. The table keeps the largest
contiguous 0.5 deg alpha range around 0 deg in which every Reynolds number
converged, so nothing is interpolated or extrapolated across a gap.

Usage (repository root, Python 3.9+ standard library only):
  python3 -I tests/fixtures/polars/generate_sda1075_xfoil.py --xfoil PATH/xfoil.exe
  python3 -I tests/fixtures/polars/generate_sda1075_xfoil.py --xfoil PATH/xfoil.exe --check
"""
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUTPUT = HERE / "sda1075-xfoil.json"
AIRFOIL = ROOT / "tests" / "fixtures" / "rotors" / "uiuc" / "sda1075.dat"
AIRFOIL_SHA256 = "a48e0ed6abff05a2858def4a9a0016f9b570322d3437f8b75d4c54dd6044836e"

XFOIL_VERSION = "6.99"
XFOIL_URL = "https://web.mit.edu/drela/Public/web/xfoil/XFOIL6.99.zip"
XFOIL_ZIP_SHA256 = "e13e8fe5cc38d8ac2626e9d3b17643bdcfaa63791619f042afdaa7cd103bcb08"
XFOIL_EXE_SHA256 = "c17342f84ae260c2b11a74cd0e2fb8189a5f8954c6bb7a8467a0f27055c7faea"

REYNOLDS = [20000, 30000, 40000, 60000, 80000, 100000, 150000, 200000]
NCRIT = 9
ITERATIONS = 200
STEP_DEG = 0.5
UPPER_DEG = 14.0
LOWER_DEG = -8.0


def sha(data):
    return hashlib.sha256(data).hexdigest()


def script(reynolds):
    lines = [
        "PLOP", "G F", "",
        "LOAD sda1075.dat",
        "PANE",
        "OPER",
        f"ITER {ITERATIONS}",
        "VPAR", f"N {NCRIT}", "",
        f"VISC {reynolds}",
        "PACC", "polar.txt", "",
        f"ASEQ 0 {UPPER_DEG} {STEP_DEG}",
        "INIT",
        f"ASEQ {-STEP_DEG} {LOWER_DEG} {-STEP_DEG}",
        "PACC",
        "", "QUIT", "",
    ]
    return "\n".join(lines)


def run(xfoil, reynolds):
    """Returns {alpha_deg: (cl, cd)} for converged points of one Reynolds number."""
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        (work / "sda1075.dat").write_bytes(AIRFOIL.read_bytes())
        subprocess.run(
            [str(xfoil)], input=script(reynolds).encode(), cwd=work,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300, check=True,
        )
        text = (work / "polar.txt").read_bytes().decode("ascii")
    rows, started = {}, False
    for line in text.splitlines():
        if line.strip().startswith("------"):
            started = True
            continue
        if not started or not line.strip():
            continue
        alpha, cl, cd = (float(v) for v in line.split()[:3])
        key = round(alpha / STEP_DEG) * STEP_DEG
        if abs(key - alpha) > 1e-6:
            raise SystemExit(f"Off-grid alpha {alpha} at Re {reynolds}")
        rows[key] = (cl, cd)
    if not rows:
        raise SystemExit(f"No converged points at Re {reynolds}")
    return rows


def common_range(polars):
    """Largest contiguous alpha grid around 0 present at every Reynolds number."""
    present = lambda a: all(a in rows for rows in polars.values())
    if not present(0.0):
        raise SystemExit("alpha = 0 deg did not converge at every Reynolds number")
    low = high = 0.0
    while present(round(low - STEP_DEG, 6)):
        low = round(low - STEP_DEG, 6)
    while present(round(high + STEP_DEG, 6)):
        high = round(high + STEP_DEG, 6)
    count = int(round((high - low) / STEP_DEG)) + 1
    return [round(low + k * STEP_DEG, 6) for k in range(count)]


def generate(xfoil):
    if sha(xfoil.read_bytes()) != XFOIL_EXE_SHA256:
        raise SystemExit("xfoil.exe hash mismatch: expected the pinned XFOIL 6.99 Windows build")
    if sha(AIRFOIL.read_bytes()) != AIRFOIL_SHA256:
        raise SystemExit("SDA1075 transcription hash mismatch")
    polars = {re: run(xfoil, re) for re in REYNOLDS}
    alphas = common_range(polars)
    return {
        "schemaVersion": 1,
        "id": "sda1075-xfoil-699-v1",
        "airfoil": "SDA1075",
        "airfoilSha256": AIRFOIL_SHA256,
        "solver": {
            "name": "XFOIL", "version": XFOIL_VERSION, "url": XFOIL_URL,
            "zipSha256": XFOIL_ZIP_SHA256, "exeSha256": XFOIL_EXE_SHA256,
        },
        "settings": {
            "paneling": "PANE default", "ncrit": NCRIT, "mach": 0, "iterations": ITERATIONS,
            "alphaStepDeg": STEP_DEG, "sweepDeg": [LOWER_DEG, UPPER_DEG],
            "tableRule": "largest contiguous alpha range around 0 deg converged at every Re",
        },
        "converged": {str(re): len(rows) for re, rows in polars.items()},
        "reynolds": REYNOLDS,
        "alphaDeg": alphas,
        # Row-major [iRe][iAlpha].
        "cl": [[polars[re][a][0] for a in alphas] for re in REYNOLDS],
        "cd": [[polars[re][a][1] for a in alphas] for re in REYNOLDS],
    }


def layout(value, depth=0):
    pad, inner = " " * depth, " " * (depth + 1)
    flat = lambda v: not isinstance(v, (list, dict))
    if isinstance(value, list) and value and not all(flat(v) for v in value):
        return "[\n" + ",\n".join(inner + layout(v, depth + 1) for v in value) + "\n" + pad + "]"
    if isinstance(value, dict) and not all(flat(v) for v in value.values()):
        items = [inner + json.dumps(k) + ": " + layout(v, depth + 1) for k, v in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    return json.dumps(value, separators=(", ", ": "))


def main(argv):
    if "--xfoil" not in argv:
        raise SystemExit("--xfoil PATH is required (pinned XFOIL 6.99 Windows build)")
    xfoil = Path(argv[argv.index("--xfoil") + 1]).resolve()
    data = (layout(generate(xfoil)) + "\n").encode()
    if "--check" in argv:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != data:
            raise SystemExit(f"Stale generated file: {OUTPUT.relative_to(ROOT)}")
    else:
        OUTPUT.write_bytes(data)
    print(f"{OUTPUT.relative_to(ROOT).as_posix()} sha256={sha(data)}")


if __name__ == "__main__":
    main(sys.argv[1:])
