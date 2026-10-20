"""TASK-033 configuration-driven rotor surrogate validation; never measured acceptance.

Uses the registered NeuralFoil table with native BET and an independently
implemented Python uniform-inflow oracle. No NeuralFoil installation is needed
to consume the saved data. The low-Mach approximation repeats the Mach=0 data
through Mach=0.3; it supplies no compressibility corrections or measurements.
"""
import argparse
import bisect
import importlib.util
import json
import math
import os
import re
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("neuralfoil_polar", ROOT / "scripts/generate-neuralfoil-polar.py")
POLAR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLAR)
REPORT = ROOT / "test-results/validation/rotor-bet.json"
SUITE = ROOT / "tests/fixtures/rotors/synthetic-bet-suite.json"
ABS_TOL = 1e-9
REL_TOL = 1e-8


def number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError("Invalid configuration number")
    return value


def require_keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("Unexpected or missing configuration fields")


def validate_suite(suite):
    require_keys(suite, ["schemaVersion", "provenance", "configurations"])
    if (not isinstance(suite, dict) or suite.get("schemaVersion") != 1 or suite.get("provenance") != "synthetic"
            or not isinstance(suite.get("configurations"), list) or not 1 <= len(suite["configurations"]) <= 32):
        raise ValueError("Invalid synthetic rotor suite")
    identifiers = set()
    for config in suite["configurations"]:
        require_keys(config, ["id", "airfoil", "polarFixture", "rotor", "environment", "operatingPoints"])
        if not isinstance(config, dict) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", str(config.get("id", ""))):
            raise ValueError("Invalid configuration identity")
        if config["id"] in identifiers:
            raise ValueError("Duplicate configuration identity")
        identifiers.add(config["id"])
        name = POLAR.airfoil_name(config.get("airfoil"))
        if config["airfoil"] != name or config.get("polarFixture") != "polars/" + name.lower() + "-neuralfoil.json":
            raise ValueError("Airfoil and polar fixture identity mismatch")
        try:
            rotor, env = config["rotor"], config["environment"]
            require_keys(rotor, ["bladeCount", "radiusM", "rootRadiusRatio", "span", "strips", "azimuthSamples"])
            require_keys(env, ["densityKgM3", "viscosityPaS", "soundMps"])
            number(rotor["radiusM"], 0.001, 10)
            number(rotor["rootRadiusRatio"], 0, 0.99)
            for key, low, high in [("bladeCount", 1, 16), ("strips", 1, 64), ("azimuthSamples", 1, 64)]:
                n = number(rotor[key], low, high)
                if not isinstance(n, int):
                    raise ValueError("Expected an integer geometry count")
            span = rotor["span"]
            if not isinstance(span, list) or not 2 <= len(span) <= 64:
                raise ValueError("Invalid span definition")
            previous = -1
            for row in span:
                if not isinstance(row, list) or len(row) != 3:
                    raise ValueError("Expected radius ratio, chord/radius, twist degrees")
                ratio = number(row[0], rotor["rootRadiusRatio"], 1)
                number(row[1], 0.0001, 2)
                number(row[2], -60, 60)
                if ratio <= previous:
                    raise ValueError("Span stations must increase")
                previous = ratio
            if span[0][0] != rotor["rootRadiusRatio"] or span[-1][0] != 1:
                raise ValueError("Span must cover the active blade")
            number(env["densityKgM3"], 0.05, 2)
            number(env["viscosityPaS"], 1e-8, 0.001)
            number(env["soundMps"], 1, 10000)
            points = config["operatingPoints"]
            if not isinstance(points, list) or not 1 <= len(points) <= 128:
                raise ValueError("Invalid operating point count")
            for point in points:
                if not isinstance(point, list) or len(point) != 2:
                    raise ValueError("Expected RPM and advance ratio")
                number(point[0], 0.001, 100000)
                number(point[1], 0, 5)
            if len(set(tuple(point) for point in points)) != len(points):
                raise ValueError("Duplicate operating point")
        except (KeyError, TypeError) as error:
            raise ValueError("Incomplete rotor configuration") from error
    return suite


def read_suite(path=SUITE):
    raw = Path(path).read_bytes()
    if len(raw) > 1024 * 1024:
        raise ValueError("Rotor suite exceeds 1 MiB")
    return validate_suite(json.loads(raw)), POLAR.sha(raw)


DEFAULT = read_suite()[0]["configurations"][0]


def read_polar(config=DEFAULT):
    relative = config["polarFixture"]
    raw = (ROOT / "tests/fixtures" / relative).read_bytes()
    registry = json.loads((ROOT / "tests/fixtures/registry.json").read_bytes())
    entry = next(e for e in registry["fixtures"] if e["path"] == relative)
    if (entry["manifest"]["sourceSha256"] != POLAR.sha(raw)
            or entry["manifest"]["provenance"]["kind"] != "synthetic"):
        raise ValueError("Polar fixture provenance or hash mismatch")
    data = json.loads(raw)
    POLAR.validate(data, config["airfoil"])
    if data["settings"]["minimumConfidence"] != 0.9:
        raise ValueError("Unexpected confidence admission rule")
    return data, POLAR.sha(raw)


def bracket(axis, query):
    """Independent interpolation bracket; exact nodes use only that node."""
    query = max(axis[0], min(axis[-1], query))
    high = bisect.bisect_left(axis, query)
    if axis[high] == query:
        return high, high, 0.0
    low = high - 1
    return low, high, (query - axis[low]) / (axis[high] - axis[low])


def sample(data, alpha, reynolds):
    a0, a1, ta = bracket(data["alphaDeg"], math.degrees(alpha))
    r0, r1, tr = bracket([math.log(v) for v in data["reynolds"]], math.log(reynolds))
    result = []
    for key in ("cl", "cd"):
        table = data[key]
        low = table[r0][a0] * (1 - ta) + table[r0][a1] * ta
        high = table[r1][a0] * (1 - ta) + table[r1][a1] * ta
        result.append(low * (1 - tr) + high * tr)
    return result


def geometry(config=DEFAULT):
    rotor = config["rotor"]
    radius = rotor["radiusM"]
    root = radius * rotor["rootRadiusRatio"]
    width = (radius - root) / rotor["strips"]
    ratios = [row[0] for row in rotor["span"]]
    stations = []
    for i in range(rotor["strips"]):
        r = root + (i + 0.5) * width
        lo, hi, t = bracket(ratios, r / radius)
        left, right = rotor["span"][lo], rotor["span"][hi]
        chord = radius * (left[1] * (1 - t) + right[1] * t)
        twist = math.radians(left[2] * (1 - t) + right[2] * t)
        stations.append((r, chord, twist, width))
    return stations


def loads(data, rpm, advance, induced, config=DEFAULT):
    rotor, env = config["rotor"], config["environment"]
    omega = 2 * math.pi * rpm / 60
    axial = advance * rpm / 60 * 2 * rotor["radiusM"] + induced
    thrust, power = 0.0, 0.0
    sections = []
    for radius, chord, twist, width in geometry(config):
        tangent = omega * radius
        velocity = math.hypot(tangent, axial)
        phi = math.atan2(axial, tangent)
        alpha = twist - phi
        reynolds = env["densityKgM3"] * velocity * chord / env["viscosityPaS"]
        cl, cd = sample(data, alpha, reynolds)
        force_scale = 0.5 * env["densityKgM3"] * velocity**2 * chord * width * rotor["bladeCount"]
        thrust += force_scale * (cl * math.cos(phi) - cd * math.sin(phi))
        power += force_scale * radius * omega * (cl * math.sin(phi) + cd * math.cos(phi))
        sections.append((alpha, reynolds))
    return thrust, power, sections


def uniform_oracle(data, rpm, advance, config=DEFAULT):
    radius = config["rotor"]["radiusM"]
    rho = config["environment"]["densityKgM3"]
    n = rpm / 60
    speed = advance * n * 2 * radius
    area = math.pi * radius**2
    initial = loads(data, rpm, advance, 0, config)[0]
    low, high = 0.0, 2 * math.pi * n * radius
    if initial > 0:
        for _ in range(90):
            induced = (low + high) / 2
            thrust = loads(data, rpm, advance, induced, config)[0]
            if thrust > 2 * rho * area * induced * (speed + induced):
                low = induced
            else:
                high = induced
        induced = (low + high) / 2
    else:
        induced = 0.0
    thrust, power, sections = loads(data, rpm, advance, induced, config)
    return {"ct": thrust / (rho * n*n * (2 * radius)**4),
            "cp": power / (rho * n**3 * (2 * radius)**5), "inducedMps": induced,
            "sections": sections,
            "momentumResidualN": abs(thrust - 2 * rho * area * induced * (speed + induced))}


def coverage(data, bounds):
    amin, amax, rmin, rmax = bounds
    if not all(math.isfinite(v) for v in bounds) or amin > amax or rmin <= 0 or rmin > rmax:
        raise ValueError("Invalid native coverage bounds")
    a0 = bracket(data["alphaDeg"], math.degrees(amin))[0]
    a1 = bracket(data["alphaDeg"], math.degrees(amax))[1]
    r0 = bracket(data["reynolds"], rmin)[0]
    r1 = bracket(data["reynolds"], rmax)[1]
    confidence = min(data["analysisConfidence"][r][a]
                     for r in range(r0, r1 + 1) for a in range(a0, a1 + 1))
    flags = []
    if confidence < 0.9:
        flags.append("low-confidence")
    if (math.degrees(amin) < data["alphaDeg"][0] or math.degrees(amax) > data["alphaDeg"][-1]
            or rmin < data["reynolds"][0] or rmax > data["reynolds"][-1]):
        flags.append("outside-table")
    # Conservative for annular solutions: includes unused cells inside the final
    # section bounding box. It may reject extra cases, never average uncertainty away.
    return {"minimumBoundingBoxConfidence": confidence, "flags": flags}


def request(data, config=DEFAULT):
    rotor, env = config["rotor"], config["environment"]
    line = lambda values: " ".join(str(v) for v in values)
    cl = [v for row in data["cl"] for v in row]
    cd = [v for row in data["cd"] for v in row]
    parts = [f"polar {len(data['alphaDeg'])} {len(data['reynolds'])} 2",
             line(math.radians(v) for v in data["alphaDeg"]), line(data["reynolds"]), "0 0.3",
             line(cl + cl), line(cd + cd), f"rotor {rotor['bladeCount']} {rotor['radiusM']} {rotor['radiusM'] * rotor['rootRadiusRatio']} {rotor['strips']} {rotor['azimuthSamples']}"]
    stations = geometry(config)
    parts.extend(line(row[i] for row in stations) for i in range(4))
    parts.extend(f"point {rpm} {j} {env['densityKgM3']} {env['viscosityPaS']} {env['soundMps']}" for rpm, j in config["operatingPoints"])
    return "\n".join(parts) + "\n"


def parse_output(stdout, stderr, annular, count=None):
    if count is None:
        count = len(DEFAULT["operatingPoints"])
    rows = stdout.splitlines()
    diagnostics = [line[4:] for line in stderr.splitlines() if line.startswith("bem ")]
    if len(rows) != count or (annular and len(diagnostics) != len(rows)):
        raise ValueError("Missing native BET output")
    results = []
    for i, row in enumerate(rows):
        tokens = row.split()
        if len(tokens) != 8 or tokens[0] != "ok":
            raise ValueError("Native BET failed to converge")
        values = [float(v) for v in tokens[1:]]
        if (not all(math.isfinite(v) for v in values) or values[4] < 0 or values[5] not in (0, 2)
                or values[6] not in (0, 1)):
            raise ValueError("Malformed native BET output")
        entry = dict(zip(("ct", "cp", "eta", "inducedMps", "residual", "polarFlags", "outsideMomentum"), values))
        if annular:
            diag = [float(v) for v in diagnostics[i].split()]
            if (len(diag) != 12 or not all(math.isfinite(v) for v in diag)
                    or diag[0] != 1 or diag[1] != entry["outsideMomentum"]
                    or diag[2] != entry["polarFlags"] or not 0 <= diag[3] < 1e-9 or diag[3] != entry["residual"]
                    or diag[10] != entry["ct"] or diag[11] != entry["cp"]):
                raise ValueError("Malformed or nonconverged annular diagnostics")
            entry["bounds"] = diag[4:8]
        results.append(entry)
    return results


def run(suite_path=SUITE, report_path=REPORT):
    suite, suite_digest = read_suite(suite_path)
    subprocess.run(["cargo", "build", "--locked", "-p", "mirage-bet", "--example", "propeller_points"],
                   cwd=ROOT / "native", check=True, capture_output=True, timeout=180)
    executable = ROOT / "native/target/debug/examples" / ("propeller_points.exe" if os.name == "nt" else "propeller_points")
    cases, configurations = [], []
    for config in suite["configurations"]:
        data, digest = read_polar(config)
        local = []
        for annular in (False, True):
            native = subprocess.run([str(executable)] + (["--annular"] if annular else []),
                                    input=request(data, config), text=True, capture_output=True, check=True, timeout=120)
            results = parse_output(native.stdout, native.stderr, annular, len(config["operatingPoints"]))
            for (rpm, j), result in zip(config["operatingPoints"], results):
                passed, errors = True, None
                if not annular:
                    oracle = uniform_oracle(data, rpm, j, config)
                    errors = {key: abs(result[key] - oracle[key]) for key in ("ct", "cp")}
                    passed = all(errors[k] <= ABS_TOL + REL_TOL * abs(oracle[k]) for k in errors)
                    scale = config["environment"]["densityKgM3"] * (rpm / 60)**2 * (2 * config["rotor"]["radiusM"])**4
                    passed &= result["outsideMomentum"] == 1 or result["residual"] <= 1e-9 * max(1, scale)
                    alphas, reynolds = zip(*oracle["sections"])
                    bounds = [min(alphas), max(alphas), min(reynolds), max(reynolds)]
                else:
                    bounds = result.pop("bounds")
                screening = coverage(data, bounds)
                if result["polarFlags"]:
                    screening["flags"].append("native-outside-polar")
                if result["outsideMomentum"]:
                    screening["flags"].append("outside-momentum")
                local.append({"configurationId": config["id"], "airfoil": config["airfoil"],
                              "solver": "annular-tip-hub-swirl" if annular else "uniform",
                              "rpm": rpm, "advanceRatio": j, "numericalStatus": "pass" if passed else "failed",
                              "oracleCoefficientErrors": errors, "sectionBounds": bounds, **result, **screening})
        cases.extend(local)
        configurations.append({"configurationId": config["id"], "airfoil": config["airfoil"],
                               "polarFixture": config["polarFixture"], "polarSha256": digest,
                               "definition": config, "status": "pass" if all(c["numericalStatus"] == "pass" for c in local) else "failed",
                               "counts": counts(local)})
    files = ["scripts/check-rotor-bet.py", "scripts/generate-neuralfoil-polar.py", "native/Cargo.lock",
             "native/rust-toolchain.toml", "native/bet/Cargo.toml", "native/bet/examples/propeller_points.rs"]
    files += [p.relative_to(ROOT).as_posix() for p in sorted((ROOT / "native/bet/src").glob("*.rs"))]
    report = {"schemaVersion": 2, "task": "TASK-033", "suiteSha256": suite_digest,
              "provenance": "neural-surrogate", "measuredFidelity": "unvalidated",
              "status": "pass" if all(c["numericalStatus"] == "pass" for c in cases) else "failed",
              "executableSha256": POLAR.sha(executable.read_bytes()),
              "toolchain": subprocess.check_output(["rustc", "--version"], cwd=ROOT / "native", text=True).strip(),
              "sourceInputs": [{"file": p, "sha256": POLAR.sha((ROOT / p).read_bytes())} for p in files],
              "configurations": configurations,
              "assumptions": ["Synthetic spanwise geometry and per-configuration registered NeuralFoil polar",
                              "Mach=0 coefficients repeated through Mach=0.3 as an incompressible approximation; no compressibility data",
                              "Annular model uses original Prandtl tip/hub losses and rotor-plane swirl",
                              "Confidence uses all contributing cells in the final-section bounding rectangle",
                              "CM and transition data remain in the polar; this BET kernel uses CL/CD only"],
              "tolerance": {"absolute": ABS_TOL, "relative": REL_TOL}, "cases": cases, "counts": counts(cases)}
    report_path = Path(report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_bytes(POLAR.encode(report))
    return report


def counts(cases):
    return {"numerical": len(cases), "screened": sum(not c["flags"] for c in cases),
            "flagged": sum(bool(c["flags"]) for c in cases)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=SUITE)
    parser.add_argument("--report", type=Path, default=REPORT)
    args = parser.parse_args()
    report = run(args.config, args.report)
    print(json.dumps({"status": report["status"], "counts": report["counts"], "report": str(args.report)}))
    raise SystemExit(0 if report["status"] == "pass" else 1)


if __name__ == "__main__":
    main()
