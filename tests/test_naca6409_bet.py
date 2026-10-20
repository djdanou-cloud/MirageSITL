"""Independent force arithmetic, screening and native parser rejection tests."""
import importlib.util
import copy
import math
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("bet", Path(__file__).resolve().parents[1] / "scripts/check-rotor-bet.py")
bet = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bet)


def constant():
    return {"alphaDeg": [-90, 90], "reynolds": [1, 1e9], "cl": [[1, 1], [1, 1]],
            "cd": [[0.02, 0.02], [0.02, 0.02]], "analysisConfidence": [[1, 1], [1, 0.1]]}


class NacaBetTests(unittest.TestCase):
    def test_zero_axial_flow_matches_closed_form_load_sum(self):
        rpm = 3000
        thrust, power, sections = bet.loads(constant(), rpm, 0, 0)
        omega = 2 * math.pi * rpm / 60
        width = (0.15 - 0.045) / 28
        r2 = sum((0.045 + (k + 0.5) * width)**2 for k in range(28))
        r3 = sum((0.045 + (k + 0.5) * width)**3 for k in range(28))
        scale = 0.5 * 1.225 * omega**2 * 0.025 * width * 2
        self.assertAlmostEqual(thrust, scale * r2, places=12)
        self.assertAlmostEqual(power, scale * 0.02 * omega * r3, places=12)
        self.assertEqual(len(sections), 28)

    def test_independent_log_interpolation_and_clamping(self):
        table = {"alphaDeg": [-10, 10], "reynolds": [1e4, 1e6],
                 "cl": [[-1, 1], [1, 3]], "cd": [[0.02] * 2] * 2}
        self.assertAlmostEqual(bet.sample(table, 0, 1e5)[0], 1.0, places=12)
        self.assertEqual(bet.sample(table, -math.pi, 1e3), [-1, 0.02])

    def test_screening_does_not_average_bad_corner_away(self):
        result = bet.coverage(constant(), [-0.01, 0.01, 1e4, 1e6])
        self.assertEqual(result["minimumBoundingBoxConfidence"], 0.1)
        self.assertIn("low-confidence", result["flags"])
        self.assertNotIn("outside-table", result["flags"])
        self.assertIn("outside-table", bet.coverage(constant(), [-2, 2, 0.1, 1e10])["flags"])

    def test_rejects_missing_nonfinite_malformed_or_nonconverged_native_output(self):
        for row in ("err", "ok 1 2 3 4 5 0", "ok nan 2 3 4 5 0 0", "ok 1 2 3 4 5 7 0", "ok 1 2 3 4 -1 0 0"):
            with self.assertRaises(ValueError):
                bet.parse_output("\n".join([row] * len(bet.DEFAULT["operatingPoints"])), "", False)
        stdout = "\n".join(["ok 1 2 3 4 0 0 0"] * len(bet.DEFAULT["operatingPoints"]))
        with self.assertRaises(ValueError):
            bet.parse_output(stdout, "", True)
        stderr = "\n".join(["bem 0 0 0 0 0 0 1 2 0 0 1 2"] * len(bet.DEFAULT["operatingPoints"]))
        with self.assertRaises(ValueError):
            bet.parse_output(stdout, stderr, True)

    def test_request_preserves_the_new_airfoil_coefficients(self):
        data, _ = bet.read_polar()
        lines = bet.request(data).splitlines()
        self.assertEqual(lines[0], "polar 121 10 2")
        self.assertEqual(lines[3], "0 0.3")
        flat = [v for row in data["cl"] for v in row]
        self.assertEqual([float(v) for v in lines[4].split()], flat + flat)

    def test_geometric_scaling_obeys_force_and_power_dimensions(self):
        scaled = copy.deepcopy(bet.DEFAULT)
        scaled["rotor"]["radiusM"] *= 2
        first = bet.loads(constant(), 3000, 0.2, 2, bet.DEFAULT)
        second = bet.loads(constant(), 3000, 0.2, 4, scaled)
        self.assertAlmostEqual(second[0] / first[0], 16, places=12)
        self.assertAlmostEqual(second[1] / first[1], 32, places=12)

    def test_blade_count_changes_section_loads_without_global_state(self):
        three = copy.deepcopy(bet.DEFAULT)
        three["rotor"]["bladeCount"] = 3
        first = bet.loads(constant(), 3000, 0, 0)
        second = bet.loads(constant(), 3000, 0, 0, three)
        self.assertAlmostEqual(second[0] / first[0], 1.5, places=12)
        self.assertAlmostEqual(second[1] / first[1], 1.5, places=12)
        self.assertEqual(first, bet.loads(constant(), 3000, 0, 0))

    def test_spanwise_geometry_uses_each_configuration(self):
        suite, _ = bet.read_suite()
        tapered = suite["configurations"][1]
        stations = bet.geometry(tapered)
        self.assertEqual(len(stations), 40)
        self.assertAlmostEqual(sum(s[3] for s in stations), 0.15, places=12)
        self.assertGreater(stations[0][1], stations[-1][1])
        self.assertGreater(stations[0][2], stations[-1][2])
        self.assertNotEqual(bet.request(constant(), tapered).splitlines()[6],
                            bet.request(constant()).splitlines()[6])

    def test_multiple_airfoils_are_selected_by_configuration(self):
        suite, _ = bet.read_suite()
        cambered, _ = bet.read_polar(suite["configurations"][0])
        symmetric, _ = bet.read_polar(suite["configurations"][2])
        self.assertEqual(symmetric["airfoil"], "NACA0012")
        self.assertAlmostEqual(bet.sample(symmetric, 0, 1e5)[0], 0, places=10)
        self.assertGreater(bet.sample(cambered, 0, 1e5)[0], 0.1)

    def test_invalid_configurations_fail_before_native_execution(self):
        suite, _ = bet.read_suite()
        for key, value in [("bladeCount", 0), ("strips", 65), ("strips", 28.0),
                           ("radiusM", math.nan), ("rootRadiusRatio", 1),
                           ("span", [[0.3, 0.1, 15], [0.3, 0.1, 15]])]:
            bad = copy.deepcopy(suite)
            bad["configurations"][0]["rotor"][key] = value
            with self.assertRaises(ValueError, msg=key):
                bet.validate_suite(bad)
        for key, value in [("airfoil", "SDA1075"), ("polarFixture", "../secret.json"),
                           ("operatingPoints", [[0, 0]]), ("operatingPoints", [[1000, 0], [1000, 0]])]:
            bad = copy.deepcopy(suite)
            bad["configurations"][0][key] = value
            with self.assertRaises(ValueError, msg=key):
                bet.validate_suite(bad)
        with self.assertRaises(ValueError):
            bet.validate_suite({**suite, "configurations": [suite["configurations"][0]] * 2})
        with self.assertRaises(ValueError):
            bet.validate_suite({**suite, "unknown": 1})


if __name__ == "__main__":
    unittest.main()
