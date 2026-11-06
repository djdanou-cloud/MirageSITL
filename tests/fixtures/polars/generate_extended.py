#!/usr/bin/env python3
"""Writes the full-range section polars of TASK-097 from their source tables.

Each table covers alpha from -180 to 180 degrees at every degree, the source's
Reynolds axis and Mach nodes 0, 0.3, 0.5 and 0.7. Inside the source's alpha range
at Mach 0 it holds the source's values. Everything else is a model, stated below
and in docs/SPECS_SIMULATION_ENGINES.md, not measured data:

* Forward extension (Viterna and Corrigan 1982): from the source edge,
  C_D = C_Dmax sin^2 a + B2 cos a and C_L = C_Dmax sin a cos a + A2 cos^2 a / sin a,
  with B2 and A2 from the values at the edge. The negative side uses the curves on
  |a| with its own edge values and C_L's sign reversed. Over 15 degrees past the edge a
  cubic Hermite joins the source's value and slope to the curves' value and slope.
* Reverse flow (the factor is NREL AirfoilPrep's): for a > 90, C_L(a) = -0.7 C_L(180 - a)
  and C_D(a) = C_D(180 - a); for a < -90 with -180 - a. Periodic at +-180. A smoothstep
  over 80 to 100 degrees joins the forward and reverse curves.
* Prandtl-Glauert lift inside each row's attached range, faded out over 5 degrees.
* Korn and Lock drag rise: C_Dw = 20 (M - M_cr)^4 above M_cr = M_dd - (0.1/80)^(1/3),
  M_dd = 0.87 - t/c - |C_L|/10.

Every cell outside the source's alpha range has confidence 0, so that using it keeps
raising the low-confidence flag. Run from the repository root; standard library only.
"""
import hashlib
import json
import math
from pathlib import Path

DIR = Path("tests/fixtures/polars")
ALPHA_DEG = list(range(-180, 181))
MACH = [0.0, 0.3, 0.5, 0.7]
BLADE_ASPECT_RATIO = 10.0
CD_MAX = 1.11 + 0.018 * BLADE_ASPECT_RATIO
REVERSE_LIFT_FACTOR = 0.7
EDGE_JOIN_DEG = 15.0
JOIN_FROM_DEG, JOIN_TO_DEG = 80.0, 100.0
ATTACHED_FADE_DEG = 5.0
KORN_KAPPA = 0.87
LOCK_RISE = (0.1 / 80.0) ** (1.0 / 3.0)
AUGMENTATION_REYNOLDS = 2e5
CONFIDENCE_DIGITS, COEFFICIENT_DIGITS = 3, 6


def smoothstep(x):
    t = min(max(x, 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def interpolate(axis, values, x):
    """Linear in x on a strictly increasing axis; x must lie on the axis."""
    low, high = 0, len(axis) - 1
    while high - low > 1:
        middle = (low + high) // 2
        if axis[middle] <= x:
            low = middle
        else:
            high = middle
    t = (x - axis[low]) / (axis[high] - axis[low])
    return values[low] + t * (values[high] - values[low])


def hermite(x, y0, slope0, y1, slope1):
    """The cubic with these values and slopes (per degree) at 0 and at EDGE_JOIN_DEG."""
    t = x / EDGE_JOIN_DEG
    h = EDGE_JOIN_DEG
    return ((2 * t**3 - 3 * t**2 + 1) * y0 + (t**3 - 2 * t**2 + t) * h * slope0
            + (-2 * t**3 + 3 * t**2) * y1 + (t**3 - t**2) * h * slope1)


def derivative(curve, deg):
    """Central difference per degree of an analytic curve; only a join's end slope."""
    return (curve(deg + 1e-3) - curve(deg - 1e-3)) / 2e-3


def viterna(edge_deg, cl_edge, cd_edge):
    """The curves for one side, as functions of |a| in degrees, from the values at the edge."""
    a_s = math.radians(edge_deg)
    b2 = (cd_edge - CD_MAX * math.sin(a_s) ** 2) / math.cos(a_s)
    a2 = (cl_edge - CD_MAX * math.sin(a_s) * math.cos(a_s)) * math.sin(a_s) / math.cos(a_s) ** 2

    def lift(deg):
        a = math.radians(deg)
        return CD_MAX * math.sin(a) * math.cos(a) + a2 * math.cos(a) ** 2 / math.sin(a)

    def drag(deg):
        a = math.radians(deg)
        return CD_MAX * math.sin(a) ** 2 + b2 * math.cos(a)

    return lift, drag


class Row:
    """One Reynolds row at Mach 0: the source inside its range and the extension outside it."""

    def __init__(self, axis, cl, cd):
        self.axis, self.cl, self.cd = axis, cl, cd
        self.low, self.high = axis[0], axis[-1]
        step = axis[-1] - axis[-2]
        self.slope_high = ((cl[-1] - cl[-2]) / step, (cd[-1] - cd[-2]) / step)
        self.slope_low = ((cl[1] - cl[0]) / (axis[1] - axis[0]), (cd[1] - cd[0]) / (axis[1] - axis[0]))
        self.high_lift, self.high_drag = viterna(self.high, cl[-1], cd[-1])
        self.low_lift, self.low_drag = viterna(-self.low, -cl[0], cd[0])
        zero = [i for i, a in enumerate(axis) if a >= 0.0][0]
        # The fade ends inside the source range, so that the extension itself is the same at every Mach node.
        self.attached_high = min(max(axis[zero:], key=lambda a: interpolate(axis, cl, a)), self.high - ATTACHED_FADE_DEG)
        self.attached_low = max(min(axis[: zero + 1], key=lambda a: interpolate(axis, cl, a)), self.low + ATTACHED_FADE_DEG)

    def forward(self, deg):
        """C_L and C_D for |deg| up to the reverse-flow join; continues analytically past 90."""
        if self.low <= deg <= self.high:
            return interpolate(self.axis, self.cl, deg), interpolate(self.axis, self.cd, deg)
        if deg > self.high:
            past = deg - self.high
            if past >= EDGE_JOIN_DEG:
                return self.high_lift(deg), self.high_drag(deg)
            end = self.high + EDGE_JOIN_DEG
            return (hermite(past, self.cl[-1], self.slope_high[0], self.high_lift(end), derivative(self.high_lift, end)),
                    hermite(past, self.cd[-1], self.slope_high[1], self.high_drag(end), derivative(self.high_drag, end)))
        size = -deg
        past = self.low - deg
        if past >= EDGE_JOIN_DEG:
            return -self.low_lift(size), self.low_drag(size)
        end = -self.low + EDGE_JOIN_DEG
        # In |a|, the source's slopes change sign; C_L is reversed for the curves' positive form.
        return (-hermite(past, -self.cl[0], self.slope_low[0], self.low_lift(end), derivative(self.low_lift, end)),
                hermite(past, self.cd[0], -self.slope_low[1], self.low_drag(end), derivative(self.low_drag, end)))

    def reverse(self, deg):
        mirrored = 180.0 - deg if deg > 0.0 else -180.0 - deg
        cl, cd = self.forward(mirrored)
        return -REVERSE_LIFT_FACTOR * cl, cd

    def at(self, deg):
        """The Mach 0 coefficients at any alpha in [-180, 180]."""
        size = abs(deg)
        if size <= JOIN_FROM_DEG:
            return self.forward(deg)
        if size >= JOIN_TO_DEG:
            return self.reverse(deg)
        forward, reverse = self.forward(deg), self.reverse(deg)
        w = smoothstep((size - JOIN_FROM_DEG) / (JOIN_TO_DEG - JOIN_FROM_DEG))
        return forward[0] + w * (reverse[0] - forward[0]), forward[1] + w * (reverse[1] - forward[1])

    def attached_weight(self, deg):
        """1 between this row's largest and smallest C_L, 0 from 5 degrees beyond them."""
        if deg > self.attached_high:
            return 1.0 - smoothstep((deg - self.attached_high) / ATTACHED_FADE_DEG)
        if deg < self.attached_low:
            return 1.0 - smoothstep((self.attached_low - deg) / ATTACHED_FADE_DEG)
        return 1.0


def at_mach(row, deg, mach, thickness):
    cl0, cd0 = row.at(deg)
    gain = 1.0 / math.sqrt(1.0 - mach * mach) - 1.0
    cl = cl0 * (1.0 + row.attached_weight(deg) * gain)
    critical = KORN_KAPPA - thickness - abs(cl) / 10.0 - LOCK_RISE
    wave = 20.0 * (mach - critical) ** 4 if mach > critical else 0.0
    return cl, cd0 + wave


def thickness_of(coordinates):
    """Largest distance between the surfaces at equal x, as a fraction of the unit chord."""
    x = [point[0] for point in coordinates]
    y = [point[1] for point in coordinates]
    nose = x.index(min(x))
    upper = sorted(zip(x[: nose + 1], y[: nose + 1]))
    lower = sorted(zip(x[nose:], y[nose:]))
    upper_x, upper_y = [p[0] for p in upper], [p[1] for p in upper]
    lower_x, lower_y = [p[0] for p in lower], [p[1] for p in lower]
    span = [i / 2000.0 for i in range(2001)]
    return max(interpolate(upper_x, upper_y, s) - interpolate(lower_x, lower_y, s) for s in span)


def zero_lift_alpha(axis, cl):
    """The first zero crossing of C_L at or above the most negative attached angle."""
    best = None
    for i in range(len(axis) - 1):
        if cl[i] <= 0.0 < cl[i + 1]:
            crossing = axis[i] + (0.0 - cl[i]) * (axis[i + 1] - axis[i]) / (cl[i + 1] - cl[i])
            if best is None or abs(crossing) < abs(best):
                best = crossing
    if best is None:
        raise ValueError("no zero-lift angle")
    return best


def build(identifier, source_name, airfoil, coordinates, source):
    source_bytes = (DIR / source_name).read_bytes()
    axis, reynolds = source["alphaDeg"], source["reynolds"]
    rows = [Row(axis, source["cl"][r], source["cd"][r]) for r in range(len(reynolds))]
    # Rounded before use, so that the table holds what its record states.
    thickness = round(thickness_of(coordinates), 5)
    confidence_rows = source.get("analysisConfidence")
    cl, cd, confidence = [], [], []
    for mach in MACH:
        cl_rows, cd_rows, confidence_table = [], [], []
        for r, row in enumerate(rows):
            cells = [at_mach(row, deg, mach, thickness) for deg in ALPHA_DEG]
            # Adding 0.0 leaves no negative zero, which a JSON import does not keep.
            cl_rows.append([round(c[0], COEFFICIENT_DIGITS) + 0.0 for c in cells])
            cd_rows.append([round(c[1], COEFFICIENT_DIGITS) + 0.0 for c in cells])
            if confidence_rows is None:
                inside = [1.0 if row.low <= deg <= row.high else 0.0 for deg in ALPHA_DEG]
            else:
                inside = [round(interpolate(axis, confidence_rows[r], deg), CONFIDENCE_DIGITS) if row.low <= deg <= row.high else 0.0 for deg in ALPHA_DEG]
            confidence_table.append(inside)
        cl.append(cl_rows)
        cd.append(cd_rows)
        confidence.append(confidence_table)
    reference = min(range(len(reynolds)), key=lambda r: abs(math.log(reynolds[r] / AUGMENTATION_REYNOLDS)))
    return {
        "schemaVersion": 2,
        "id": identifier,
        "airfoil": airfoil,
        "provenance": "extended-model",
        "source": {"file": source_name, "id": source.get("id"), "sha256": hashlib.sha256(source_bytes).hexdigest(), "alphaRangeDeg": [axis[0], axis[-1]]},
        "generator": {"file": "generate_extended.py", "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
        "model": {
            "forward": "Viterna and Corrigan 1982 from the source edge, joined to the source's value and slope by a cubic Hermite over 15 deg",
            "cdMax": CD_MAX, "bladeAspectRatio": BLADE_ASPECT_RATIO,
            "reverse": "C_L(a) = -0.7 C_L(+-180 - a), C_D(a) = C_D(+-180 - a) (NREL AirfoilPrep), joined over 80 to 100 deg",
            "compressibility": "Prandtl-Glauert lift in each row's attached range, faded out over 5 deg; Korn and Lock drag rise",
            "kornKappa": KORN_KAPPA, "thicknessRatio": thickness,
            "confidence": "The source's inside its alpha range at every Mach node; 0 outside it. Not measured accuracy.",
        },
        "limitations": [
            "Outside the source range these are empirical curves, not predictions of this airfoil",
            "Above Mach 0.7 the lookup clamps and flags",
            "No measured-fidelity claim",
        ],
        "rotationalAugmentation": {
            "model": "Snel et al. 1994: dC_L = 3 (c/r)^2 (2 pi (a - a0) - C_L), faded out between 30 and 50 deg from a0, an engineering limit",
            "liftSlopePerRad": 2.0 * math.pi,
            "zeroLiftAlphaRad": round(math.radians(zero_lift_alpha(axis, source["cl"][reference])), 8),
            "referenceReynolds": reynolds[reference],
        },
        "alphaDeg": ALPHA_DEG,
        "reynolds": reynolds,
        "mach": MACH,
        "cl": cl,
        "cd": cd,
        "analysisConfidence": confidence,
    }


def write(table, name):
    path = DIR / name
    path.write_text(json.dumps(table, separators=(",", ":")) + "\n", encoding="utf-8")
    print(name, path.stat().st_size, "bytes")


def main():
    for identifier, source_name, name in (
        ("naca6409-extended-v1", "naca6409-neuralfoil.json", "naca6409-extended.json"),
        ("naca0012-extended-v1", "naca0012-neuralfoil.json", "naca0012-extended.json"),
    ):
        source = json.loads((DIR / source_name).read_text(encoding="utf-8"))
        write(build(identifier, source_name, source["airfoil"], source["geometry"]["coordinates"], source), name)
    source = json.loads((DIR / "sda1075-xfoil.json").read_text(encoding="utf-8"))
    uiuc = json.loads(Path("tests/fixtures/rotors/uiuc-propellers.json").read_text(encoding="utf-8"))
    coordinates = uiuc["airfoils"]["SDA1075"]["coordinates"]
    write(build("sda1075-extended-v1", "sda1075-xfoil.json", source["airfoil"], coordinates, source), "sda1075-extended.json")


if __name__ == "__main__":
    main()
