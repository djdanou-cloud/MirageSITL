#!/usr/bin/env python3
"""Deterministic generator for tests/fixtures/contact/nasa-drop.json.

Reads the byte-exact Docling archives in tests/fixtures/contact/nasa/, verifies
their SHA-256, extracts the level-surface vertical drop measurements of
NASA TM X-3561 by exact quotes, and converts the U.S. Customary values (the
units in which the report says measurements were made) to the repository SI
vocabulary. Every quantity must be matched exactly once; nothing is
interpolated, digitized from figures or extrapolated.

Usage (run from the repository root, Python 3.9+ standard library only):
  python3 -I tests/fixtures/contact/generate_nasa_drop.py          # write
  python3 -I tests/fixtures/contact/generate_nasa_drop.py --check  # verify
"""
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "nasa-drop.json"

# Exact SI definitions of the source units.
FT_M = 0.3048
IN_M = 0.0254
LBM_KG = 0.45359237
LBF_N = 4.4482216152605
PSI_PA = LBF_N / IN_M**2
G0_MPS2 = 9.80665

ARCHIVES = {
    "tmX3561": {
        "path": "nasa/nasa-tm-x-3561.md",
        "sha256": "8cf5d33d1d2afbd4a28af064901fcf82910dad25e9e3ce916b2249e5d12c4c39",
        "ntrsId": "19780003109",
    },
    "tp2353": {
        "path": "nasa/nasa-tp-2353.md",
        "sha256": "1a2a73a922c4b76b174968a554e7390c5e5d717322965ff959c056655b6b3aad",
        "ntrsId": "19840024308",
    },
    "report1248": {
        "path": "nasa/naca-report-1248.md",
        "sha256": "e49485f4d8a44c151f09b39fff8c67fbb2fbf8441fb5aa19566ec5c1594630ba",
        "ntrsId": "19930092250",
    },
}


def load(key):
    entry = ARCHIVES[key]
    data = (HERE / entry["path"]).read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != entry["sha256"]:
        raise SystemExit(f"Archive hash mismatch: {entry['path']}: {actual}")
    # Docling wrote CRLF; quotes and line numbers use LF-normalized text.
    return data.decode("utf-8").replace("\r\n", "\n").split("\n")


def find(lines, pattern):
    """Returns (match, 1-based line) for a pattern that matches exactly one line."""
    regex = re.compile(pattern)
    hits = [(regex.search(line), number) for number, line in enumerate(lines, 1)]
    hits = [(match, number) for match, number in hits if match]
    if len(hits) != 1:
        raise SystemExit(f"Expected exactly one match for {pattern!r}, found {len(hits)}")
    return hits[0]


def number(text):
    return float(text.replace(" ", ""))


def rounded(value):
    # Fixed 12 significant digits keeps the JSON stable across platforms.
    return float(f"{value:.12g}")


def quantity(si_value, si_unit, source_value, source_unit, quote, line, printed=None):
    entry = {
        "value": rounded(si_value),
        "unit": si_unit,
        "source": {"value": source_value, "unit": source_unit, "quote": quote, "line": line},
    }
    if printed is not None:
        printed_text, printed_unit, printed_scale = printed
        printed_value = number(printed_text)
        # The report rounds its SI conversions; accept half a unit of the last
        # printed digit plus 0.5 percent for the report's own rounding.
        decimals = len(printed_text.split(".")[1]) if "." in printed_text else 0
        allowance = 0.5 * 10 ** -decimals * printed_scale + 0.005 * abs(si_value)
        if abs(si_value - printed_value * printed_scale) > allowance:
            raise SystemExit(f"Converted {si_value} disagrees with printed {printed_value} {printed_unit}")
        entry["printedSi"] = {"value": printed_value, "unit": printed_unit}
    return entry


def build():
    tm = load("tmX3561")
    tp = load("tp2353")
    naca = load("report1248")

    # Bibliographic identity, from the report documentation page.
    find(tm, r"^1\. Report No\. NASA TM X-3561$")
    find(tm, r"^5\. Report Date November 1977$")
    find(tm, r"^Edwin L\. Fasanella, John R\. McGehee, and M\. Susan Pappas$")
    find(tp, r"^NASA-TP-2353 19840024308$")
    find(naca, r"^REPORT 1248$")
    _, units_line = find(tm, r"Measurements were made in U\.S\. Customary Units\.")
    _, sign_line = find(tm, r"A downward direction was chosen for positive acceleration\.")

    rig = {}
    m, line = find(tm, r"^\| Drop mass \(mass acting on gear\), kg \(Ibm\)\s*\|\s*(1490)\s*\|\s*\((3280)\)\s*\|$")
    rig["dropMassKg"] = quantity(number(m[2]) * LBM_KG, "kg", number(m[2]), "lbm", m[0], line, (m[1], "kg", 1))
    m, line = find(tm, r"^\| Hub mass \(wheel, tire, and piston\), kg \(Ibm\)\s*\|\s*(25\.3)\s*\|\s*\((55\.7)\)\s*\|$")
    rig["hubMassKg"] = quantity(number(m[2]) * LBM_KG, "kg", number(m[2]), "lbm", m[0], line, (m[1], "kg", 1))
    m, line = find(tm, r"^\| Maximum shock strut stroke, m \(ft\)\s*\|\s*(0\.229)\s*\|\s*\((0\.75)\)\s*\|$")
    rig["maxStrutStrokeM"] = quantity(number(m[2]) * FT_M, "m", number(m[2]), "ft", m[0], line, (m[1], "m", 1))
    m, line = find(tm, r"^\| Unloaded diameter of tire, d, m \(ft\)\s*\|\s*(0\.552) \((1\.81)\)\s*\|$")
    rig["tireUnloadedRadiusM"] = quantity(number(m[2]) * FT_M / 2, "m", number(m[2]), "ft (diameter)", m[0], line, (m[1], "m (diameter)", 0.5))
    m, line = find(tm, r"^\| Maximum width of undeHected tire, w, m \(ft\)\s*\|\s*(0\.175) \((0\.5735)\)\s*\|$")
    rig["tireWidthM"] = quantity(number(m[2]) * FT_M, "m", number(m[2]), "ft", m[0], line, (m[1], "m", 1))
    m, line = find(tm, r"The tire was inflated to (414) kPa \((60) psig\) for all tests\.")
    rig["tireInflationGaugePa"] = quantity(number(m[2]) * PSI_PA, "Pa", number(m[2]), "psig", m[0], line, (m[1], "kPa", 1000))
    m, line = find(tm, r"gauge pressure for the fully extended gear was (1917) ± (69) kPa \((278) ± (10) psig\)")
    rig["strutChargingGaugePa"] = quantity(number(m[3]) * PSI_PA, "Pa", number(m[3]), "psig", m[0], line, (m[1], "kPa", 1000))
    rig["strutChargingGaugePa"]["uncertainty"] = quantity(number(m[4]) * PSI_PA, "Pa", number(m[4]), "psig", m[0], line, (m[2], "kPa", 1000))
    m, line = find(tm, r"crushed with a constant force level of about (16\.00) kN \((3600) lbf\)")
    rig["honeycombCrushForceN"] = quantity(number(m[2]) * LBF_N, "N", number(m[2]), "lbf", m[0], line, (m[1], "kN", 1000))
    m, line = find(tm, r"Honeycomb cruish from (2\.54) cm \((1\.0) in\.\) to (5\.08) cm \((2\.0) in\.\) was allowed before tire contact\.")
    rig["honeycombPreContactCrushM"] = {
        "min": quantity(number(m[2]) * IN_M, "m", number(m[2]), "in", m[0], line, (m[1], "cm", 0.01)),
        "max": quantity(number(m[4]) * IN_M, "m", number(m[4]), "in", m[0], line, (m[3], "cm", 0.01)),
    }
    m, line = find(tm, r"the friction force is less -than (44) N \((10) lbf\)")
    rig["levelAxialFrictionMaxN"] = quantity(number(m[2]) * LBF_N, "N", number(m[2]), "lbf", m[0], line, (m[1], "N", 1))
    m, line = find(tm, r"Only a (17\.0)-cm \((6\.7)-in\.\) drop is required for the gear to accelerate, under gravity, to an impact velocity of (1\.8) m/s \((6) ft/s\)")
    drop_height = quantity(number(m[2]) * IN_M, "m", number(m[2]), "in", m[0], line, (m[1], "cm", 0.01))
    # Independent consistency: free fall from the quoted height gives the quoted speed.
    if abs((2 * G0_MPS2 * drop_height["value"]) ** 0.5 - number(m[4]) * FT_M) > 0.01:
        raise SystemExit("Drop height and impact velocity disagree")
    rig["freeFallHeightFor6FpsM"] = drop_height

    m, velocity_line = find(tm, r"vertical drops were conducted at impact velocities of (1\.2), (1\.5), and (1\.8) m/s \((4), (5), and (6) ft/s\) onto a level surface")
    sink = [quantity(number(m[4 + i]) * FT_M, "m/s", number(m[4 + i]), "ft/s", m[0], velocity_line, (m[1 + i], "m/s", 1)) for i in range(3)]
    _, drops_line = find(tm, r"consisted of three drops at each impact velocity")
    m, stroke_line = find(tm, r"varied from (5\.6) cm \((2\.2) in\.\) for the 1\.2-m/s \(4-ft/s\) impact velocity to (11\.2) cm \((4\.4) in\.\) for the 1\.8-m/s \(6-ft/s\) impact velocity\.")
    stroke4 = quantity(number(m[2]) * IN_M, "m", number(m[2]), "in", m[0], stroke_line, (m[1], "cm", 0.01))
    stroke6 = quantity(number(m[4]) * IN_M, "m", number(m[4]), "in", m[0], stroke_line, (m[3], "cm", 0.01))
    m, line = find(tm, r"maximum stroking distance for drops on the level, 50, and 100 surfaces are approximately (9\.4) cm \((3\.7) in\.\)")
    stroke5 = quantity(number(m[2]) * IN_M, "m", number(m[2]), "in", m[0], line, (m[1], "cm", 0.01))
    m, accel_line = find(tm, r"which occurs for the 1\.8-m/s \(6-ft/s\) case does not exceed -(1\.6)g")
    accel_bound = quantity(-number(m[1]) * G0_MPS2, "m/s^2", -number(m[1]), "g (standard gravity)", m[0], accel_line)
    m, line = find(tm, r"For the 1\.2-m/s· \(4-ft/s\) drop, the rebound occurs at (0\.15) s")
    rebound4 = quantity(number(m[1]), "s", number(m[1]), "s", m[0], line)

    case_ids = ["level-4fps", "level-5fps", "level-6fps"]
    strokes = [stroke4, stroke5, stroke6]
    cases = []
    for index, case_id in enumerate(case_ids):
        measured = {
            "maxStrutStrokeM": strokes[index],
            # The 6 ft/s case has the largest magnitude; the bound covers all three.
            "minUpperMassAccelerationDownMps2": accel_bound,
        }
        if case_id == "level-4fps":
            measured["honeycombReboundTimeS"] = rebound4
        cases.append({
            "id": case_id,
            "surfaceInclinationRad": 0.0,
            "sinkRateMps": sink[index],
            "dropsPerCase": {"value": 3, "unit": "1", "source": {"quote": "consisted of three drops at each impact velocity", "line": drops_line}},
            "measured": measured,
        })

    return {
        "formatVersion": 1,
        "id": "nasa-tm-x-3561-drop-v1",
        "datasetId": "NASA-TM-X-3561-DropTest",
        "conventions": {
            "frame": "NED; vertical axis positive down",
            "accelerationSign": "kinematic vertical acceleration, positive down (source line %d)" % sign_line,
            "standardGravityMps2": G0_MPS2,
            "sourceUnits": "U.S. Customary are the measured values (source line %d); printedSi records the report's own rounded SI conversion as a cross-check" % units_line,
            "conversionFactors": {"ftToM": FT_M, "inToM": IN_M, "lbmToKg": LBM_KG, "lbfToN": LBF_N, "psiToPa": rounded(PSI_PA), "gToMps2": G0_MPS2},
            "instrumentBandwidth": "accelerometer and pressure signals filtered flat to 100 Hz (filter order not stated)",
        },
        "source": {
            "reportId": "NASA TM X-3561",
            "ntrsId": ARCHIVES["tmX3561"]["ntrsId"],
            "title": "Experimental and Analytical Determination of Characteristics Affecting Light Aircraft Landing-Gear Dynamics",
            "authors": ["Edwin L. Fasanella", "John R. McGehee", "M. Susan Pappas"],
            "organization": "NASA Langley Research Center, Hampton, VA",
            "reportDate": "1977-11",
            "referenceUrl": "https://ntrs.nasa.gov/citations/" + ARCHIVES["tmX3561"]["ntrsId"],
            "archive": ARCHIVES["tmX3561"]["path"],
            "archiveSha256": ARCHIVES["tmX3561"]["sha256"],
            "license": "Public-Domain-US-Gov",
            "notes": "NTRS id taken from the supplied file name; the Docling text omits it. Test dates are not stated; acquiredAt uses the report date.",
        },
        "relatedSources": [
            {
                "reportId": "NASA TP-2353",
                "ntrsId": ARCHIVES["tp2353"]["ntrsId"],
                "title": "Validation of an Active Gear, Flexible Aircraft Take-Off and Landing Analysis (AGFATL)",
                "authors": ["John R. McGehee"],
                "reportDate": "1984-09",
                "referenceUrl": "https://ntrs.nasa.gov/citations/" + ARCHIVES["tp2353"]["ntrsId"],
                "archive": ARCHIVES["tp2353"]["path"],
                "archiveSha256": ARCHIVES["tp2353"]["sha256"],
                "used": False,
                "reason": "Drop-test (5.5 ft/s) force and stroke results exist only as figure images; the Docling text has no tabulated values.",
            },
            {
                "reportId": "NACA Report 1248",
                "ntrsId": ARCHIVES["report1248"]["ntrsId"],
                "title": "An Experimental Study of Applied Ground Loads in Landing",
                "authors": ["Benjamin Milwitzky", "Dean C. Lindquist", "Dexter M. Potter"],
                "reportDate": "1955",
                "referenceUrl": "https://ntrs.nasa.gov/citations/" + ARCHIVES["report1248"]["ntrsId"],
                "archive": ARCHIVES["report1248"]["path"],
                "archiveSha256": ARCHIVES["report1248"]["sha256"],
                "used": False,
                "reason": "Forward-speed spin-up tests on a 15-degree inclined gear; per-test results are in figures, and the text gives only instrument full-scale ranges.",
            },
        ],
        "rig": rig,
        "cases": cases,
        "acceptance": {
            "relativeTolerance": 0.1,
            "penetrationToleranceM": 0.002,
            "impulseRelativeTolerance": 0.01,
            "decelerationWindowS": 0.01,
            "notes": "Declared from the source before model evaluation: 10 percent on measured envelopes; 2 mm (twice Rapier's default allowed linear error) for penetration; 1 percent impulse balance; a 10 ms window matches the 100 Hz instrument bandwidth.",
        },
    }


def main():
    text = json.dumps(build(), indent=2, ensure_ascii=True) + "\n"
    if "--check" in sys.argv[1:]:
        if not OUTPUT.exists() or OUTPUT.read_text("utf-8") != text:
            raise SystemExit("nasa-drop.json is stale; rerun the generator")
        print("nasa-drop.json matches the archived sources")
        return
    OUTPUT.write_text(text, "utf-8")
    print(f"wrote {OUTPUT.name} sha256={hashlib.sha256(text.encode('utf-8')).hexdigest()}")


if __name__ == "__main__":
    main()
