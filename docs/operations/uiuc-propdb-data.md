# UIUC propeller database: local archive and measured fixture

English source. [Russian mirror](../ru/uiuc-propdb-data.md).

## What was supplied

On 2026-10-17 the operator placed an unpacked copy of the UIUC Propeller
Database (Vols 1-4, archive README dated 6/27/2022) at `UIUC-propDB/` in the
checkout root. It is a copy of the
[UIUC Propeller Data Site](https://m-selig.ae.illinois.edu/props/propDB.html):
117 MB in 3,652 files, of which 1,994 are data tables under `volume-*/data/`.
The rest are photos, plots, HTML pages, four AIAA papers, the Brandt thesis and two wind-tunnel correction notes.

| Table kind | Header | Vol 1 | Vol 2 | Vol 3 | Vol 4 |
| --- | --- | --- | --- | --- | --- |
| Advance-ratio sweep at fixed RPM | `J CT CP eta` | 898 | 292 | 279 | 128 |
| Static RPM sweep | `RPM CT CP` | 139 | 68 | 40 | 17 |
| Blade geometry | `r/R c/R beta` | 79 | 53 | 0 | 0 |
| Other (`nr640_thick.txt`, `r/R t/c`) | — | 0 | 1 | 0 | 0 |

The [inventory](../../data/uiuc-propdb/inventory.json) records every data
table's path, bytes and SHA-256 hash, the per-volume counts and the aggregate
digest `0b00acaffdacef96f21973960ea3bb7a64b94d385fef5b00b6323b8330c42069`.
That digest is the SHA-256 of the sorted `path<TAB>sha256<LF>` lines; the
generator rejects any other copy. Two tables print a `RPM average = N` line
before their header; 412 tables use CRLF line endings. Hashes cover raw bytes.

## Rights and storage status

The site requests a citation and states no explicit license:

> J.B. Brandt, R.W. Deters, G.K. Ananda, O.D. Dantsker, and M.S. Selig
> (insert date downloaded), UIUC Propeller Database, Vols 1-4, University of
> Illinois at Urbana-Champaign, retrieved from
> https://m-selig.ae.illinois.edu/props/propDB.html.

The raw archive is therefore **not committed**; `UIUC-propDB/` is untracked.
The repository stores only the hashed inventory, the DA4002/DA4022 numeric
fixture (a small subset of measured values with per-file provenance) and the
SDA1075 coordinates transcribed from the cited paper. Committing or
redistributing the full archive is an operator decision; see the
recommendations below.

## Database-wide audit

The generator applies two oracles that do not depend on any MirageSITL model to
all 26,045 advance-ratio points (23,382 with J > 0, CT > 0 and CP > 0):

* **eta consistency:** |eta − J·CT/CP| must not exceed the printed rounding
  bound plus 1e-3. Vol 1 (3–4 decimals) matches within rounding. In the
  six-decimal Vols 2–4 the printed eta differs from J·CT/CP by up to 4.06e-4,
  consistent with eta reduced per sample and then averaged.
* **Froude bound:** eta ≤ 2/(1 + sqrt(1 + 8·CT/(π·J²))), the ideal
  actuator-disk efficiency at the same thrust coefficient.

Result: 0 inconsistent points and 0 points above the Froude bound.

## Fixture used by TASK-033

`tests/fixtures/rotors/uiuc-propellers.json` holds 14 configurations: the
DA4002 (8 hub pitch settings, 5 and 9 in) and DA4022 (5 and 9 in, 2/3/4
blades). They total 716 advance-ratio points in 61 runs plus 242 static
points, each table carrying its source path and SHA-256. Each configuration
also carries its measured geometry. Only these 3D-printed propellers were
selected. Deters, Ananda and Selig (AIAA 2014-2151, section III and Appendix A)
publish their airfoil: SDA1075 along the whole rectangular blade. Every other
propeller in the database has measured chord/twist but no published airfoil,
so a blade-element comparison would rest on an unknown polar.

The comparison model, tolerances and the current failed result are specified
in the [engine specification](../SPECS_SIMULATION_ENGINES.md) section
"UIUC propeller database comparison (TASK-033)".

## Regenerate and verify

Standard-library Python 3.9+, from the repository root, with the archive at
`UIUC-propDB/` or elsewhere via `--source`:

```bash
python3 -I tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py
python3 -I tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py --check
python3 -I tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py --check --source /path/to/UIUC-propDB
node scripts/validate-models.mjs
npx --no-install vitest run tests/uiuc-propeller.test.ts
```

`--check` compares both generated files byte for byte and exits non-zero
on any difference. It also fails when the README, data digest, cited paper
or SDA1075 transcription hash differs. Unit tests do not need the archive:
they verify the registered fixture hash, recompute the inventory digest
rule from the committed file list and match the transcription. They also
recompute the audit and check the thin-airfoil and Froude oracles through
the native runner.

## Recommendations for the archive

1. Keep the unpacked archive outside Git (or add `UIUC-propDB/` to
   `.gitignore`) until the rights question is settled. The inventory makes
   any later copy verifiable byte for byte, so nothing is lost by not
   committing it.
2. To store it in the repository, record that operator decision. Then commit only
   `volume-*/data/*.txt` (about 1,994 small text files) under
   `data/uiuc-propdb/`, not the photos, plots and papers. Optionally ask the
   UIUC authors for explicit redistribution terms first.
3. Done on 2026-10-17: an XFOIL 6.99 polar for SDA1075 (Re 2e4–2e5) now
   runs as a second comparison. DA4002 9-in configurations largely pass. The
   DA4022 errors point to tip loss and inflow modeling, not to airfoil data.
   An airfoil-measured polar would still be stronger evidence.
4. Later uses: JSBSim propeller tables (`C_THRUST`/`C_POWER` versus J) now
   exist for six propellers in `data/jsbsim/engine/` (TASK-086; native load in
   JSBSim v1.2.3 verified 2026-10-18); measured load-torque curves for the
   TASK-022/025 shaft and ESC references; and replacing the arbitrary demo
   rotor geometry with a measured propeller. Each needs its own task and
   tolerance declaration.

## Supplied AirfoilPrep and coordinate inputs (TASK-033, 2026-10-18)

The local `airfoilprep_v2-02-03.xls` workbook by Craig Hansen of Windward
Engineering LLC is a preprocessing reference. The official
[AirfoilPrep description](https://nrel.sitefinity.cloud/wind/nwtc/airfoil-prep)
identifies interpolation, Viterna extrapolation, Du lift augmentation and
Eggers drag correction. These methods transform existing aerodynamic data;
they do not measure an airfoil. The supplied `coord_seligFmt/` is a local copy
of the [UIUC coordinates database](https://m-selig.ae.illinois.edu/ads/coord_database.html).
Its normalized x/c,y/c geometry can feed a solver, but contains no measured
CL/CD versus angle of attack, Reynolds number or Mach.

`scripts/audit-airfoil-inputs.py` uses the read-only `xlrd==2.0.2` reader and
Python 3.9+. Install the reader in a local virtual environment or cache; it
is not a runtime dependency. From the repository root, with that reader on
the Python import path:

```bash
python scripts/audit-airfoil-inputs.py
python scripts/audit-airfoil-inputs.py --check
python -m unittest discover -s tests -p test_airfoil_inputs.py
```

The report is `test-results/validation/airfoil-inputs.json`. The script pins
the workbook SHA-256 and a sorted per-file aggregate for all 1,665 coordinate
files. It rejects changed sources. The coordinate parser accepts 1,655 files
as normalized single-element contours and records ten unsupported files with
reasons. Unsupported does not mean scientifically invalid: multi-element,
non-normalized and differently formatted data require separate adapters.
Neither filenames nor headers identify SDA1075 in the accepted subset; a
separate full-folder text search also found no SDA1075. The current DA4002/
DA4022 comparison therefore retains the published 61-point SDA1075
transcription in `tests/fixtures/rotors/uiuc/sda1075.dat`.

Seven saved `TableExtrap` output points from 30 to 90 degrees agree with an
independent positive-branch Viterna calculation within 1e-12 for CL and CD.
Inputs are the saved example's last input point (20.1 degrees) and B6 CDmax.
This is an arithmetic regression against saved values, not a recalculation
of Excel or execution of its macros. The example has no established SDA1075
measurement provenance and is not imported as an airfoil polar. The eight
sheet names, source hashes, individual errors and unsupported filenames are
recorded by the report. Both supplied resources remain local and ignored by
Git; the workbook is unchanged.

Verification: seven Python tests pass, including malformed/nonfinite data,
Lednicer count rejection, contour ordering, the existing SDA1075 transcription,
source mutation rejection and the saved Viterna branch. Regeneration followed
by `--check` passes. TASK-033 remains blocked on physical fidelity: existing
XFOIL/UIUC comparison failures, tip-loss/inflow modeling and missing measured
airframe validation are not resolved by this source preparation. NASA measured
fidelity remains deferred under the user's earlier decision; its historical
failed comparison is preserved. This increment does not change the validation
runner, acceptance tolerances or production aerodynamic behavior.

### Subsequent source-backed continuation

The later TASK-033 continuation uses all three supplied sources: AIAA 2014-2151
for the experiment, `Robert_Deters.md` for geometry/induction/low-Re limits, and
the local PROPID 5.3 manual/program for conventions and a bounded turbine smoke.
`node scripts/check-propid.mjs --run` records source hashes and exact agreement
of the dissertation's SDA1075 table with the existing 61-point transcription.
Its turbine smoke does not establish propeller parity. Raw copyrighted source
documents and PROPID remain local; none is copied into a fixture or committed.

The additional [airfoil-research repository](https://github.com/neel542/airfoil-research/tree/27c6eb2a37e4f157ae62bd485b3686949b103698)
was reviewed at the linked commit. Its static UIUC files match our existing
14 cases exactly, so its measured points are duplicates. Its BEM/root-finding
and uncertainty methods are useful references, but its NeuralFoil/XFOIL
predictions, Re>=40000 reporting window and filled polar gaps are not adopted
as our acceptance policy. The review runs no Python from that repository.

Unlike the earlier source-only audit, the continuation adds an offline annular
BEM sensitivity run (`node scripts/check-propeller-bem.mjs`) and updates the
main reporter to reference v2/schema v5. NASA is explicitly deferred with its
historical failure archived, not passed. Current JSBSim evidence replaces
obsolete blocker prose while historical diagnostics remain visible. Details,
equations, limits and paired results are in the engine specification's
TASK-033 continuation section. The annular run completes numerically, but
fixed-tolerance propeller fidelity still fails; low-Re polar accuracy and
uncovered alpha/Re remain unresolved.
