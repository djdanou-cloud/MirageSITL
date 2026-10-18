"""Read-only local source checks; run with Python unittest, not the hot loop.

python -m unittest discover -s tests -p test_airfoil_inputs.py
"""
import importlib.util
import math
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("airfoil_inputs", ROOT / "scripts/audit-airfoil-inputs.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SeligInputs(unittest.TestCase):
    def contour(self):
        # Independent analytic double-wedge contour with ten nonrepeated points.
        return "wedge\n" + "\n".join(f"{x} {y}" for x, y in [
            (1, 0), (.8, .02), (.6, .04), (.4, .04), (.2, .02),
            (0, 0), (.2, -.02), (.4, -.04), (.6, -.04), (.8, -.02), (1, 0)])

    def test_selig_contour_and_dimensionless_values(self):
        name, points = MODULE.parse_selig(self.contour())
        self.assertEqual(name, "wedge")
        self.assertEqual(points[5], (0, 0))
        self.assertEqual(len(points), 11)

    def test_lednicer_count_record_is_not_geometry(self):
        with self.assertRaisesRegex(ValueError, "normalized"):
            MODULE.parse_selig(self.contour().replace("wedge\n", "wedge\n61 61\n"))

    def test_nonfinite_and_malformed_coordinates(self):
        for bad in ["nan .02", "inf .02", ".8 text", ".8 .02 extra"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                MODULE.parse_selig(self.contour().replace("0.8 0.02", bad))

    def test_reversed_and_scrambled_contours(self):
        for bad in [self.contour().replace("1 0\n", "0 0\n", 1), self.contour().replace("0.6 0.04", "0.9 0.04")]:
            with self.assertRaises(ValueError):
                MODULE.parse_selig(bad)

    def test_current_sda1075_retains_published_geometry(self):
        name, points = MODULE.parse_selig((ROOT / "tests/fixtures/rotors/uiuc/sda1075.dat").read_text())
        self.assertEqual(name, "SDA1075")
        self.assertEqual(len(points), 61)
        self.assertTrue(all(math.isfinite(value) for p in points for value in p))

    def test_workbook_source_mutation_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "changed.xls"
            path.write_bytes(b"not the reviewed workbook")
            with self.assertRaisesRegex(ValueError, "differs"):
                MODULE.workbook_audit(path)

    def test_supplied_workbook_saved_viterna_branch(self):
        # This verifies independent formula arithmetic, not Excel recalculation.
        result = MODULE.workbook_audit(ROOT / "airfoilprep_v2-02-03.xls")
        self.assertFalse(result["macrosExecuted"])
        self.assertFalse(result["recalculated"])
        rows = result["savedExampleCheck"]["positiveBranch"]
        self.assertEqual([r["alphaDeg"] for r in rows], list(range(30, 91, 10)))
        self.assertLess(max(max(r["clError"], r["cdError"]) for r in rows), 1e-12)


if __name__ == "__main__":
    unittest.main()
