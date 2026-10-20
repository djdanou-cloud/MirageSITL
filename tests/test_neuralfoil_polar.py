"""Independent interpolation and provenance checks for the selected polar."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("polar", ROOT / "scripts/generate-neuralfoil-polar.py")
polar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(polar)


def fixture():
    return {
        "schemaVersion": 1, "airfoil": "NACA6409", "provenance": "neural-surrogate",
        "alphaDeg": [-10, 0, 10], "reynolds": [10000, 1000000], "mach": [0],
        "cl": [[-1, 0, 1], [1, 2, 3]], "cd": [[0.02] * 3] * 2,
        "cm": [[-0.1] * 3] * 2, "analysisConfidence": [[0.95] * 3, [0.95, 0.95, 0.2]],
        "topXtr": [[0.5] * 3] * 2, "botXtr": [[0.5] * 3] * 2,
    }


class NeuralFoilPolarTests(unittest.TestCase):
    def test_airfoil_identity_is_configurable_and_checked(self):
        value = fixture()
        value["airfoil"] = "NACA0012"
        polar.validate(value, "NACA0012")
        with self.assertRaises(ValueError):
            polar.validate(value, "NACA6409")
        for name in ["NACA0000", "NACA6012", "SDA1075", "../naca0012"]:
            with self.assertRaises(ValueError):
                polar.airfoil_name(name)

    def test_second_generated_airfoil_has_independent_symmetric_geometry_and_data(self):
        import aerosandbox as asb
        import neuralfoil as nf
        path = ROOT / "tests/fixtures/polars/naca0012-neuralfoil.json"
        data = json.loads(path.read_bytes())
        polar.validate(data, "NACA0012")
        coordinates = data["geometry"]["coordinates"]
        for i in range(199):
            self.assertAlmostEqual(coordinates[i][0], coordinates[-1-i][0], places=12)
            self.assertAlmostEqual(coordinates[i][1], -coordinates[-1-i][1], places=12)
        raw = nf.get_aero_from_airfoil(asb.Airfoil("naca0012"), alpha=5, Re=100000,
                                      n_crit=9, xtr_upper=1, xtr_lower=1, model_size="xxxlarge")
        r, a = data["reynolds"].index(100000), data["alphaDeg"].index(5)
        for name, key in polar.FIELDS.items():
            self.assertAlmostEqual(data[name][r][a], float(raw[key][0]), places=10)

    def test_generated_geometry_is_naca6409(self):
        data = json.loads(polar.OUTPUT.read_text())
        coordinates = data["geometry"]["coordinates"]
        self.assertEqual(len(coordinates), 399)
        # Opposite surface pairs recover the defining camber line and thickness.
        for i in range(199):
            upper, lower = coordinates[i], coordinates[-1 - i]
            x = (upper[0] + lower[0]) / 2
            camber = (upper[1] + lower[1]) / 2
            expected = (0.06 / 0.4**2 * (0.8 * x - x*x) if x <= 0.4 else
                        0.06 / 0.6**2 * (0.2 + 0.8 * x - x*x))
            thickness = 5 * 0.09 * (0.2969 * math.sqrt(x) - 0.126*x - 0.3516*x*x
                                     + 0.2843*x**3 - 0.1015*x**4)
            self.assertAlmostEqual(camber, expected, places=12)
            self.assertAlmostEqual(math.dist(upper, lower) / 2, thickness, places=12)

    def test_payload_is_registered_as_synthetic_and_preserves_low_confidence(self):
        raw = polar.OUTPUT.read_bytes()
        data = json.loads(raw)
        polar.validate(data)
        self.assertEqual(data["alphaDeg"], polar.ALPHA)
        self.assertEqual(data["reynolds"], polar.REYNOLDS)
        registry = json.loads((ROOT / "tests/fixtures/registry.json").read_text())
        entry = next(e for e in registry["fixtures"] if e["path"] == "polars/naca6409-neuralfoil.json")
        self.assertEqual(entry["manifest"]["sourceSha256"], polar.sha(raw))
        self.assertEqual(entry["manifest"]["provenance"]["kind"], "synthetic")
        self.assertTrue(any(v < 0.9 for row in data["analysisConfidence"] for v in row))

    def test_selected_points_match_direct_neuralfoil_calls(self):
        import aerosandbox as asb
        import neuralfoil as nf
        data = json.loads(polar.OUTPUT.read_text())
        # Recompute separated points without the generator's vector assembly.
        for reynolds, alpha in [(5000, -15), (60000, 0), (1000000, 10)]:
            raw = nf.get_aero_from_airfoil(asb.Airfoil("naca6409"), alpha=alpha, Re=reynolds,
                                          n_crit=9, xtr_upper=1, xtr_lower=1, model_size="xxxlarge")
            r, a = data["reynolds"].index(reynolds), data["alphaDeg"].index(alpha)
            for name, key in polar.FIELDS.items():
                self.assertAlmostEqual(data[name][r][a], float(raw[key][0]), places=10)

    def test_log_reynolds_and_linear_alpha_interpolation(self):
        result = polar.lookup(fixture(), -5, 100000, 0)
        self.assertAlmostEqual(result["cl"], 0.5, places=12)
        self.assertAlmostEqual(result["cd"], 0.02, places=12)
        self.assertEqual(result["flags"], [])

    def test_low_confidence_corner_is_not_averaged_away(self):
        self.assertIn("low-confidence", polar.lookup(fixture(), 5, 100000, 0)["flags"])
        self.assertEqual(polar.lookup(fixture(), 0, 1000000, 0)["flags"], [])

    def test_bounds_and_mach_are_flagged_without_extrapolation(self):
        result = polar.lookup(fixture(), -30, 1000, 0.2)
        self.assertIn("outside-table", result["flags"])
        self.assertIn("unsupported-mach", result["flags"])
        self.assertEqual(result["cl"], -1)
        for value in [math.nan, math.inf, -math.inf]:
            with self.assertRaises(ValueError):
                polar.lookup(fixture(), value, 100000, 0)

    def test_rejects_wrong_section_provenance_shape_and_coefficients(self):
        for key, value in [("airfoil", "SDA1075"), ("provenance", "measured"),
                           ("alphaDeg", [0, 0]), ("reynolds", [0, 1000000]),
                           ("cd", [[-1] * 3] * 2), ("cl", [[math.nan] * 3] * 2),
                           ("analysisConfidence", [[1.1] * 3] * 2)]:
            bad = copy.deepcopy(fixture())
            bad[key] = value
            with self.assertRaises(ValueError, msg=key):
                polar.validate(bad)


if __name__ == "__main__":
    unittest.main()
