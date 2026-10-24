# What TASK-073 still needs

English source. [Russian mirror](ru/needed_for_task073.md).

This document lists everything TASK-073 (GPU acceptance harness, see
[PROJECT_ROADMAP.md](PROJECT_ROADMAP.md)) is still missing, why each item
matters for the G3 gate, and exactly what the operator must supply, decide or
do so the agent can finish it. It describes `main` at commit `4dcae07`
(2026-10-21) plus the RTX 4050 work on branch `task-073-render-profile`.

## 1. Where the task stands

### 1.1 Two implementations exist

* **On `main` (Mac/Cursor work, commit `4dcae07`):** `?g3=1` selects the
  production measurement scene (`apps/web/src/render/g3-mode.ts`,
  `apps/web/src/render/g3-passes.ts`): mounted FPV camera, fisheye remap,
  analog video and synthetic LWIR thermal camera, WebGL2 only.
  `scripts/check-gpu-perf.mjs` measures it with the one-tile CC0 fixture
  (`tests/fixtures/tiles/`) and scores it through `scripts/gpu-trace.mjs` and
  `scripts/bench-render.mjs`. The operator accepted the 60 FPS limits
  **median <= 16.680 ms and p99 <= 17.665 ms** and a 59.88 Hz panel; the
  120 FPS limit stays **p99 <= 8.33 ms**. The DoD adds that the flight image
  must fill the active physical display.
* **On branch `task-073-render-profile` (commit `bf53d57`, not merged):**
  `?profile=full` (`apps/web/src/render/sensor-views.ts`) renders the same
  camera chain as insets, `scripts/generate-render-tileset.mjs` produces a
  deterministic synthetic CC0 stress terrain (8 km, 341 tiles),
  `scripts/capture-render.mjs` captures fullscreen and samples the browser
  GPU process memory through Windows counters. A local, uncommitted
  `scripts/diagnose-render.mjs` attributes late frames with WebGL2 GPU timer
  queries. This branch changes `apps/web/src/FlightScene.tsx`,
  `apps/web/package.json`, the roadmap and other files that `4dcae07` also
  changed, so it does not merge cleanly.

### 1.2 Results so far

| Device and profile | Timing | Presentation | Status |
| --- | --- | --- | --- |
| M4, WebGL2, 60 FPS | median 16.680 ms, p99 17.665 ms (accepted limits) | Chrome floated in an emulated 1920 x 1080 window on a 2560 x 1440 desktop; native panel 2560 x 1664 | Not accepted: image does not fill the display |
| M4, WebGL2, 120 FPS | not run | MacBook Air panel refreshes at 59.88 Hz | `BLOCKED_EXTERNAL` |
| M4, WebGPU | not run | — | `BLOCKED_EXTERNAL`: no WebGPU fisheye/thermal pass |
| RTX 4050, WebGL2, 60 FPS, balanced power | median 16.670 ms, **p99 23.880 ms** | fullscreen 1920 x 1080 DPR 1 on a 1920 x 1080 display, but the flight canvas was 1316 x 640 inside the application layout | **FAIL** (p99 > 17.665 ms) |
| RTX 4050, WebGL2, 60 FPS, maximum-performance power | **median 16.685 ms, p99 34.260 ms** | as above | **FAIL** (median > 16.680 ms, p99 > 17.665 ms) |
| RTX 4050, WebGL2, 120 FPS | not run | no >=120 Hz display on the NVIDIA output | `BLOCKED_EXTERNAL` |
| RTX 4050, WebGPU | not run | — | `BLOCKED_EXTERNAL` |

Both RTX 4050 captures used the branch harness (600 s after 60 s warmup,
Chrome 155, Windows 11, AC power, synthetic stress terrain) and were scored by
`main`'s analyzer under the accepted limits:

* **Balanced power:** 35,754 frames, 349 missed refreshes of 36,000 (0.97%),
  GPU in power state P8 at 210–360 MHz of 3105 MHz (about 2 W, NVIDIA clock
  reason "GPU idle").
* **Maximum-performance power** (operator-set NVIDIA per-program setting for
  `chrome.exe`, Windows "Best performance", vendor Performance profile):
  35,151 frames, 947 missed refreshes (2.63%), longest frame 96.5 ms. The GPU
  switched between P5 and P8 299 times at 420–450 MHz, still with clock reason
  "GPU idle", at 54–64 °C. The result was worse, not better.
* Peak GPU-process dedicated memory 147 MiB and 140 MiB (<= 2 GiB); terrain
  cache 12.5 MiB (<= 512 MiB).

Diagnosis (WebGL2 GPU timer queries, 120 s per profile after 20 s warmup):

| Power setting | p99 demo / terrain / full | Intervals over 25 ms, demo / terrain / full |
| --- | --- | --- |
| Balanced | 21.4 / 22.2 / 23.6 ms | 31 / 30 / 52 |
| Maximum performance | 41.1 / 40.6 / 34.8 ms | 131 / 135 / 138 |

Main-thread work stays under 6 ms per frame with no long tasks in any run, and
GPU timer values follow the clock state rather than the scene. In the balanced
trace 63% of intervals over 18.5 ms are requestAnimationFrame timestamp
jitter (paired with a short interval, summing to two refreshes). The misses
are dominated by GPU power-state behaviour under Windows hybrid graphics, not
by scene cost: even the plain demo scene fails.

## 2. Missing items and how to supply them

Each item says what is missing, why it matters for G3, what the operator
provides or decides, and what the agent then does. **Agent work** needs only
a go-ahead.

### 2.1 One harness instead of two

* **Missing:** a single measurement path. `?g3=1` and `?profile=full` overlap.
* **Operator decides:** which one stays. Recommended: keep `main`'s `?g3=1`
  and `scripts/check-gpu-perf.mjs` as the only harness, and port from the
  branch what `main` lacks: the stress tileset generator, fullscreen on the
  physical display, the Windows GPU-process memory sampler, `nvidia-smi` clock
  sampling and the diagnosis script. Then retire `?profile=full`.
* **Agent then (agent work):** ports those pieces onto `main` in a new branch,
  re-runs the tests and documentation checks, and deletes or closes
  `task-073-render-profile`.

### 2.2 Resolution rule versus "fill the display"

* **Missing:** a profile both rules accept. `assessGpu` accepts only
  1920 x 1080 at DPR 1, while the DoD requires the flight image to fill the
  active physical display. The M4 desktop is 2560 x 1440 (native panel
  2560 x 1664, Retina DPR 2), so a full-screen image there is not
  1920 x 1080 DPR 1. On the RTX 4050 the external display is 1920 x 1080, but
  the flight canvas still occupies only part of the application layout.
* **Operator decides one of:**
  1. **Keep 1920 x 1080 DPR 1** and supply a display that is exactly
     1920 x 1080 at 1x scaling for each device (an external 1920 x 1080 monitor
     for the Mac; the existing external monitor for the RTX 4050); or
  2. **Change the contract** so the profile resolution is the display's
     native resolution and DPR (a documented, versioned analyzer and matrix
     change in both languages; it does not change the frame-time limits).
* **Agent then (agent work):** makes the measured flight canvas cover the whole
  display in the measurement mode (no side panels), records a full-display
  screenshot and the drawing-buffer size in the evidence, and implements
  option 2 if chosen.

### 2.3 RTX 4050 frame time and power configuration

* **Missing:** an RTX 4050 capture that meets median <= 16.680 ms and
  p99 <= 17.665 ms with the GPU actually clocked up.
* **Already tried:** the per-program NVIDIA setting, Windows "Best performance"
  and the vendor Performance profile (section 1.2). The GPU still never left
  P5 and the driver kept reporting "GPU idle", so this setting is not the lever.
* **Operator provides next:** these are system settings the agent does not
  change.
  1. NVIDIA Control Panel → Manage 3D settings → **Global settings** → Power
     management mode → **Prefer maximum performance** (in addition to the
     `chrome.exe` entry).
  2. If the GPU still stays at P5 or below: switch the laptop to
     **dGPU-only / MUX "Ultimate" mode** (ASUS Armoury Crate → GPU Mode),
     reboot, and confirm in Windows Display settings which adapter drives the
     measured display. This removes the Windows hybrid-graphics path that
     currently treats the load as idle.
  3. Tell the agent which of these was done.
* **Agent then:** reruns the 10-minute capture and the diagnosis with clock
  sampling, keeps every power configuration as separate evidence and reports
  all of them. The limits are not changed.

### 2.4 Displays of 120 Hz or more

* **Missing:** both 120 FPS profiles (p99 <= 8.33 ms).
* **RTX 4050:** the external monitor is 60 Hz; the internal 144 Hz panel is
  wired to the Intel iGPU, so it does not measure the NVIDIA presentation path
  cleanly. **Operator provides one of:** dGPU-only / MUX "Ultimate" mode
  (ASUS Armoury Crate → GPU Mode, reboot, confirm the panel runs on the NVIDIA
  adapter at 144 Hz), or an external monitor of at least 120 Hz on the port
  wired to the NVIDIA GPU, set to 1920 x 1080 at 120/144 Hz.
* **M4:** the MacBook Air panel refreshes at 59.88 Hz and cannot run the
  120 FPS profile. **Operator provides:** an external monitor of at least
  120 Hz connected to the Mac (1920 x 1080 if section 2.2 option 1 is
  chosen).
* **Agent then:** runs `--fps 120` on each device.

### 2.5 Terrain: real data instead of fixtures

* **Missing:** realistic terrain. `main` measures with the one-tile CC0
  fixture (10,092 bytes of tile residency on the M4); the branch stress
  tileset is 341 synthetic untextured tiles (12.5 MiB). Neither stresses the
  2 GiB / 512 MiB budgets, and neither is real ground.
* **Operator provides one of:**
  1. **Google Photorealistic 3D Tiles** through the TASK-063 proxy
     (`services/tiles-worker/`): a Google Cloud project with billing and the
     **Map Tiles API** enabled, an API key restricted to that API, a
     Cloudflare account and explicit authorization to deploy the Worker, and
     the allowed origin/session configuration. The operator stores the key
     **only** as a Worker secret (`wrangler secret put`); it never goes into
     chat, the repository, URLs or logs. Policy limits remain: memory-only use,
     TTL 0, no prefetch, no offline copies, no R2 persistence (see
     [terrain-licensing.md](decisions/terrain-licensing.md)).
  2. **A licensed or owned 3D Tiles dataset** (own photogrammetry, a
     commercial dataset, or an export whose license allows local use): the
     tileset folder outside the repository, the license document, the exact
     attribution string, the origin (`latDeg,lonDeg,ellipsoidalHeightM`) and a
     SHA-256 of the license evidence.
  3. **An elevation model:** DEM GeoTIFF tiles for the area (for example
     Copernicus GLO-30) with source URL and license; the agent writes a
     DEM-to-3D-Tiles converter (**agent work**).
* **Also needed:** the **area of operation** (centre coordinates and radius),
  preferably inside the supported Israel coverage.

### 2.6 Maps: land-cover and OpenStreetMap layers

* **Missing:** the three ESA WorldCover 2021 v200 Israel tiles are committed
  and decoded (TASK-069) but not wired into the scene; no OpenStreetMap
  extract exists; the runtime `DataManifest` is not registered.
* **Why:** without material classes, thermal emissivity and surface
  properties cannot vary with the ground.
* **Operator provides:** an OSM extract downloaded by the operator (for
  example Geofabrik `israel-and-palestine-latest.osm.pbf`, ODbL) with download
  date and SHA-256, kept outside the repository unless committing is
  authorized; confirmation that the area of operation lies within the
  existing WorldCover tiles (`N27E033`, `N30E033`, `N33E033`), or further
  tiles per [worldcover-data.md](operations/worldcover-data.md).
* **Agent then (agent work):** registers the `DataManifest`, drapes
  WorldCover/OSM classes on the terrain and feeds class-dependent emissivity
  and heat parameters into the thermal G-buffer.

### 2.7 Thermal: physical temperatures and a real instrument

* **Missing:**
  * **agent work:** both implementations use synthetic temperatures
    (`main`: `290 K + 18 K * clamp(1 - d / 80 m)` by distance; branch:
    `291 K + 14 K * max(0, n . sun)`). The TASK-070 heat balance
    (`ThermalField`, solar ephemeris, shadows) and the TASK-072 shutter/NUC are
    not coupled to the rendered scene;
  * **operator data:** only the `synthetic-lwir-640` profile exists; no
    measured instrument, so no CADEX or other parity can be claimed.
* **Operator provides (for a measured profile):** camera model and data sheet
  (resolution, band, NETD, frame rate, lens horizontal FOV, radiometric or
  not); raw pre-palette frames of a blackbody or reference plate at several
  known temperatures (for example 10 °C steps from 0 to 60 °C) with ambient
  temperature; paired real scene recordings with time, place and weather (air
  temperature, humidity, wind, cloud cover); known local material
  emissivities; file hashes and permission to store them.
* **Agent then:** builds a measured `InstrumentProfile` with a calibration
  data hash, couples the TASK-070 solver to terrain materials and runs the
  shutter/NUC in the measurement scene.

### 2.8 WebGL2 and WebGPU

* **Missing:** the fisheye, analog and thermal passes are WebGL
  `ShaderMaterial`s; `scripts/check-gpu-perf.mjs --backend webgpu` exits
  `BLOCKED_EXTERNAL`.
* **Operator decides:** whether G3 requires WebGPU full-feature captures
  (`docs/benchmarks/render-matrix.json` lists both backends) or WebGL2 is the
  accepted production backend.
* **Agent then (agent work, if required):** ports the passes to three.js node
  materials (TSL/WGSL), adds CPU-oracle tests on real WebGPU hardware
  (software Chromium skips WebGPU) and captures WebGPU on both devices.

### 2.9 Flight during the capture

* **Missing:** the vehicle stays on the ground, so terrain streaming under
  motion and LOD changes are not exercised.
* **Operator decides one of:** a **scripted flight** (agent work: a
  deterministic virtual gamepad path — take-off, circuit at fixed altitude and
  speed, landing — recorded as instrumentation), or a **manual flight** with a
  transmitter for 11 minutes.

### 2.10 GPU memory measurement

* **Missing:** a consistent residency source. `main` reports the tileset cache
  estimate; the branch also samples the Windows `GPU Process Memory` counters
  (an upper bound for the whole browser GPU process). macOS has no equivalent
  per-process counter in the harness.
* **Operator decides:** whether the application-side estimate is acceptable on
  macOS, or whether an OS measurement is required there.
* **Agent then (agent work):** records both sources where available and states
  which one the gate uses.

### 2.11 Presentation-time measurement

* **Missing:** independent display-side timing. requestAnimationFrame
  timestamps jitter by about ±2 ms on the Windows/D3D11 setup even for the demo.
  This only adds evidence; it does not change the analyzer or its limits.
* **Operator provides:** on Windows, permission to download and run Intel
  PresentMon (a signed GitHub release), or install it and give the path; on
  macOS, Xcode Instruments (Metal System Trace) if display timing is wanted
  there.
* **Agent then:** records display-change intervals beside the capture and
  reports both distributions.

### 2.12 Repository housekeeping

* **Operator decides:** what happens to `task-073-render-profile` (see 2.1),
  whether to commit `scripts/diagnose-render.mjs`, and whether to force-add
  the `test-results/render/` and `test-results/m4` evidence (ignored by
  `.gitignore`).
* Git has no user identity configured on the RTX 4050 laptop; the agent
  commits with the identity of the existing history,
  `djdanou-cloud <djdanou@gmail.com>`, per command. Set
  `git config user.name/user.email` to change that.

## 3. Checklist

| Item | Owner | What the agent needs | How to deliver |
| --- | --- | --- | --- |
| Single harness | Operator decision | Keep `?g3=1` and port branch pieces, or another choice | Chat |
| Resolution rule | Operator decision | Exact 1920 x 1080 displays, or native-resolution contract change | Chat |
| GPU clocking on RTX 4050 | Operator | NVIDIA global setting, then MUX mode if needed | Say which was done |
| High refresh (>=120 Hz) displays | Operator | RTX 4050: MUX mode or external monitor; M4: external monitor | Say which display |
| Real terrain | Operator | Google key + Cloudflare deploy authorization, or licensed tileset + license + attribution + origin, or DEM tiles | Secret via `wrangler secret put`; files outside the repo with SHA-256 |
| Area of operation | Operator | Centre coordinates and radius | Chat |
| OSM extract | Operator | `.osm.pbf`, date, SHA-256, license | Local path |
| Thermal instrument | Operator | Data sheet, blackbody frames, scene recordings, hashes | Local path |
| WebGPU scope | Operator decision | Required or optional | Chat |
| Flight during capture | Operator decision | Scripted or manual | Chat |
| Memory source on macOS | Operator decision | Application estimate or OS measurement | Chat |
| PresentMon / Instruments | Operator | Permission or installed path | Chat |
| Heat-balance coupling, material drape, WebGPU ports, full-display canvas, DEM converter, scripted flight, harness merge | Agent | Go-ahead | Chat |
| Evidence commits | Operator decision | Which result folders to force-add | Chat |

## 4. Rules that stay in force

* Never paste API keys, tokens or passwords into chat, URLs, the repository or
  logs; secrets go into the deployment's secret store by the operator.
* Only the operator changes G3 limits, as an explicit recorded decision (as on
  2026-10-21). The agent never relaxes limits, the catch-up cap or the
  analyzer to make a capture pass; failing captures stay recorded as FAIL.
* Synthetic data stays labelled synthetic; land classes are not temperatures;
  no CADEX parity without measured data.
* Software or headless GPUs never certify hardware gates; missing devices stay
  `BLOCKED_EXTERNAL`.

## 5. Operator answers (2026-10-21)

| Item | Answer |
| --- | --- |
| Harness (2.1) | `?g3=1` on `main` stays; the agent ports what it lacks from `task-073-render-profile` |
| Resolution (2.2) | Baseline requirement: 1920 x 1080 above 58 Hz. Other modes (2560 x 1440, 2560 x 1664, 120 Hz, 144 Hz) are desirable, not required: test them and report what does not work |
| Power (2.3) | NVIDIA settings are fixed; retest |
| High refresh (2.4) | Covered by the resolution answer: desirable, not required |
| Terrain (2.5) | The operator supplies a 3D Tiles set. Area of operation centred at 32.20065261195932 N, 34.87163838506722 E, radius up to 1 km for now; centre and radius must be configuration, not code |
| Maps (2.6) | Geofabrik extract supplied in the repository root (see section 6) |
| Thermal (2.7) | Open-source approximated profile: public FLIR Boson 640 data sheet values (640 x 512, LWIR 8–14 µm, NETD about 50 mK), a generated fixed-pattern-noise/drift map feeding the TASK-072 NUC, a public thermal dataset sample (FLIR ADAS / free FLIR thermal dataset) with estimated weather as a visual parity target, and `EmissivityTable_thermoworks.txt` for material emissivities, all with file hashes |
| WebGPU (2.8) | Required |
| Flight (2.9) | Scripted flight during capture |
| macOS memory (2.10) | Application-side estimate accepted |
| PresentMon (2.11) | Permission granted to download and run it |

## 6. Inputs received and checked

| Input | Location | Size | SHA-256 | Check |
| --- | --- | --- | --- | --- |
| OSM extract | `israel-and-palestine-261020.osm.pbf` (repository root, untracked) | 120,580,259 B | `59ac7350c78fc90d77f65fdc670c1d3248c8b218d9f8bbb4cee4c6ef9b22a2a5` | Valid `OSMHeader` blob; the Geofabrik file name carries the 2026-10-20 snapshot date; ODbL |
| Emissivity table | `EmissivityTable_thermoworks.txt` (repository root, untracked) | 3,190 B | `e920dd7738072d282570870dfacf156dced3b2ff411c7b0b2f7917ee6475e080` | 126 rows, UTF-8, CRLF |
| WorldCover coverage | `data/worldcover/2021-v200/israel/` tile `N30E033` | — | inventory hashes | The area centre lies inside tile `N30E033` and inside the supported Israel box |
| PresentMon | GitHub `GameTechDev/PresentMon` release v2.6.0, `PresentMon-2.6.0-x64.exe` | 980,320 B | recorded on download | Not downloaded yet |

Findings in the emissivity table that the mapping must handle explicitly:

* Ranges such as `0.81 – 0.86` and a prefixed value `@1.00`: the parser keeps
  the minimum and maximum; the mapping uses the midpoint and records the range.
* Duplicate names with different values (`Glass: frosted` 0.96 and 0.70).
* Values far from other common references (`Gravel` 0.28, `Cement` 0.54); the
  mapping does not use them for terrain without operator confirmation.
* No entries for vegetation (grass, trees, crops), asphalt or bare desert soil
  other than `Soil` and `Sand`, which dominate WorldCover and OSM classes in the
  area of operation (section 7, question 3).

## 7. Open questions before or during the work

1. **3D Tiles delivery:** folder path, license and attribution text, and
   whether the tileset heights are ellipsoidal (WGS84) or orthometric (geoid);
   the origin height at the area centre is needed for placement.
2. **Refresh threshold:** the current check admits a display at 59 Hz or
   above (`refresh + 1 >= fps`). The answer says "above 58 Hz". Should the
   accepted 60 FPS display rule become "above 58 Hz"? This is a contract
   change only the operator can make.
3. **Missing emissivities:** approve proxy values for vegetation, asphalt and
   desert soil (proposal: vegetation 0.97 from `Food & Organic Materials`,
   asphalt 0.93 from `Paper: tar` 0.92 / `Lacquer` family, bare soil 0.92 from
   `Soil: dry`, sand 0.90), or supply a second source.
4. **Boson lens and frame rate:** which lens horizontal FOV (Boson 640 lenses
   range from about 18° to 95°) and 60 Hz or the export-limited 9 Hz.
5. **Thermal reference sample:** the FLIR datasets require registration and
   have their own terms; the operator downloads one sample sequence, notes the
   license and the capture time/place, and gives the path.
6. **Old branch:** may the agent delete `task-073-render-profile` locally and on
   origin after porting its pieces?
7. **Large inputs:** may the agent add `*.osm.pbf` and the 3D Tiles drop folder
   to `.gitignore`, so the 120 MB extract cannot be committed by accident?
8. **M4 runs:** the operator runs the M4 captures on the Mac (or provides an
   SSH host); the agent cannot reach the Mac from this laptop.

## 8. Execution plan after "go"

Every phase lands on a new branch from `main` (`task-073-g3`), with tests and
both documentation languages updated in the same change. No limit changes;
pushes only on instruction.

| Phase | Work | Needs |
| --- | --- | --- |
| P0 | Branch, ignore rules, input hash record, PresentMon download into `.cache/tools` with hash | Questions 6–7 |
| P1 | `?g3=1` harness: full-display flight canvas at exactly 1920 x 1080 DPR 1, Windows GPU-process memory and `nvidia-smi` sampling, PresentMon capture, `scripts/diagnose-render.mjs` adapted to `?g3=1`, area-of-operation configuration (centre, radius) | — |
| P2 | Scripted flight: deterministic virtual gamepad (take-off, circuit inside the configured radius, landing) recorded in the evidence | — |
| P3 | Terrain from the supplied 3D Tiles at the configured area; the synthetic stress tileset relocated to the same origin as a stand-in until then | Question 1 |
| P4 | Maps: OSM PBF reader for the radius (roads, buildings, land use, water) plus the WorldCover window, registered in a runtime `DataManifest` with hashes, producing a material-class raster | — |
| P5 | Thermal: `ApproximatedInstrumentProfile` (Boson 640 values), generated fixed-pattern-noise map through the TASK-072 shutter/NUC, TASK-070 `ThermalField` per material class with emissivities from the table, rendered in the G-buffer | Questions 3–5 |
| P6 | WebGPU: fisheye, analog and thermal passes as three.js node materials (TSL) with CPU-oracle tests on the RTX 4050; check the tiles loader under `WebGPURenderer` | — |
| P7 | Captures on the RTX 4050: 1920 x 1080 baseline for WebGL2 and WebGPU (10 min after 60 s warmup), plus informational runs on the 144 Hz panel and other modes, each with PresentMon and clock samples; M4 runs by the operator | Question 8 |
| P8 | Evidence and documentation in both languages; commit; push on instruction | — |

## 9. Operator answers, second round (2026-10-22)

These answers resolve section 7 and change phases P0, P3 and P5 of section 8.

| Question | Answer |
| --- | --- |
| Emissivity gaps | Find the missing values from public sources (results below) |
| Stand-in emissivities | Approved: vegetation 0.97, asphalt 0.93, bare soil 0.92, sand 0.90 |
| Refresh rule | The accepted 60 FPS display rule becomes "above 58 Hz"; 59.88 Hz and 60 Hz qualify |
| Tileset source | The agent builds 3D Tiles with the pipeline below instead of receiving a tileset |
| Boson lens | The standard lens at 60 Hz |
| Thermal reference sample | Public FLIR thermal dataset sample; the operator has settled the licensing question |
| Old branch | The agent may delete `task-073-render-profile` locally and on origin |
| `.gitignore` | The agent may ignore `*.osm.pbf` and the generated tiles folder |
| M4 | The operator will provide an M4 later |

### 9.1 Emissivity values from public sources (8–14 µm)

| Class | Literature value | Used value | Source |
| --- | --- | --- | --- |
| Healthy green vegetation, grass, crops | 0.96–0.99; grass about 0.983 | 0.97 (approved) | Lillesand et al. 2008 table; arXiv 2001.09191 band average |
| Trees | about 0.977 | 0.97 (approved vegetation value) | arXiv 2001.09191 |
| Dry vegetation, dry grass | 0.88–0.94 | 0.91 (midpoint) | Lillesand et al. 2008 table |
| Asphalt | 0.94–0.97; about 0.946 | 0.93 (approved; below the literature range, recorded as such) | Lillesand et al. 2008 table; arXiv 2001.09191 |
| Bare dry soil | 0.92–0.96; about 0.955 | 0.92 (approved) | Lillesand et al. 2008 table; arXiv 2001.09191 |
| Sand | 0.90 (ThermoWorks) | 0.90 (approved) | `EmissivityTable_thermoworks.txt` |
| Concrete, built-up | 0.92 (ThermoWorks) | 0.92 | `EmissivityTable_thermoworks.txt` |
| Water | 0.95 (ThermoWorks) | 0.95 | `EmissivityTable_thermoworks.txt` |

Soil emissivity rises with moisture, mainly in 8–9.5 µm; the model uses the dry
values for the area of operation. Sources:
[Lillesand et al. 2008 values via SEOS](https://seos-project.eu/earthspectra/earthspectra-c02-p04.html),
[arXiv 2001.09191](https://arxiv.org/pdf/2001.09191).

### 9.2 Boson 640 lens

Teledyne FLIR lists eight Boson 640 lenses (73 mm 6°, 55 mm 8°, 36 mm 12°,
24 mm 18°, 18 mm 24°, 14 mm 32°, 8.7 mm 50°, 4.9 mm 95°) and does not name a
standard one ([FOV comparison](https://oem.flir.com/boson-family/boson-fov-comparison/)).
The agent uses the **8.7 mm, 50° horizontal FOV** lens at **60 Hz**: it is the
in-production general-purpose wide lens for small UAS. The profile records the
lens as a selected configuration, not as a measured instrument.

### 9.3 Terrain and buildings pipeline

* **Bounding box:** configurable; default Israel `34.2,29.4,35.9,33.4`
  (min lon, min lat, max lon, max lat). The runtime area of operation (centre
  32.20065261195932 N, 34.87163838506722 E, radius up to 1 km) stays a separate
  configuration.
* **Buildings:** `overturemaps download --bbox=34.2,29.4,35.9,33.4 -f geojson --type=building -o israel_buildings.geojson`,
  loaded into PostGIS and converted by `pg2b3dm` into a hierarchical 3D Tiles
  1.1 tileset with GLB content and WGS84 ellipsoidal heights.
* **Terrain:** FABDEM bare-earth 1° tiles covering the box (Copernicus GLO-30
  is a surface model that includes buildings and trees, so it is used only if
  FABDEM is unavailable); heights converted from EGM2008 orthometric to WGS84
  ellipsoidal with GDAL/PROJ (`gdalwarp` with `EPSG:4326+3855` to
  `EPSG:4979`, PROJ grid `us_nga_egm08_25.tif`; geoid separation in the area
  about +18 to +20 m), then cut into quantized-mesh tiles by a pure-Python
  tiler (`pydelatin` + `quantized-mesh-encoder`) because `ctb-tile` and
  `tin-terrain` need system packages.
* **Viewer:** `3d-tiles-renderer` 0.5.3 includes `QuantizedMeshPlugin`, so
  terrain (quantized mesh, `layer.json`) and buildings (3D Tiles) load as two
  tile sources. `TilesScene` currently binds one source and is extended to two.
* **Checks:** a building footprint and the terrain under it must agree within
  2 m in ellipsoidal height at sample points, so the buildings neither float
  nor sink; a test fails if the geoid step is skipped.
* **Licenses and attribution:** Overture buildings (ODbL/CDLA per Overture
  release), FABDEM (CC BY-NC-SA 4.0, non-commercial; a commercial use needs a
  Fathom license), Copernicus DEM credit line, EGM2008 (NGA, public). All are
  recorded in the dataset manifest with hashes.
* **Tooling:** WSL Ubuntu 26.04 has Python 3.14, pip, g++ and curl but no GDAL,
  PostGIS, `pg2b3dm` or terrain tiler, and `sudo` needs a password. The agent
  installs them in user space without `sudo`: micromamba with `gdal`, `proj`,
  `postgresql`, `postgis` and Python packages (`overturemaps`, `pydelatin`,
  `quantized-mesh-encoder`), and `pg2b3dm` as a .NET tool. Outputs go to an
  ignored folder outside Git (`.cache/geodata/`).
* **Download sizes (estimates):** FABDEM tiles for the box about 0.3 GB,
  Overture buildings GeoJSON for Israel about 1–3 GB, micromamba packages about
  1.5 GB, EGM2008 grid about 80 MB.

### 9.4 Revised phases

| Phase | Change from section 8 |
| --- | --- |
| P0 | Also delete `task-073-render-profile` (local and origin) after porting, and add `*.osm.pbf` and `.cache/geodata/` ignore rules |
| P1 | The accepted 60 FPS display rule becomes "above 58 Hz" in `scripts/gpu-trace.mjs` and its tests, both languages documented |
| P3 | Build terrain and buildings with the section 9.3 pipeline; the viewer loads both sources for the configured area |
| P5 | Use the section 9.1 emissivities and the section 9.2 lens; fetch one public FLIR thermal dataset sample sequence as the visual reference |

## 10. Status after phases P3-P7 (2026-10-22)

| Item | State |
| --- | --- |
| Terrain and buildings (P3) | Done: FABDEM quantized-mesh terrain with verified geoid conversion, 2.87 million Overture buildings as 3D Tiles |
| Material maps (P4) | Done: 1 m OSM and WorldCover class raster, cross-checked against `MaterialMap` (99.98%) |
| Thermal (P5) | Done: approximated Boson 640 profile, generated fixed pattern through the shutter/NUC, per-class heat balance with evapotranspiration, 3 x 3 detector-area supersampling; one FLIR ADAS thermal video kept as a visual reference |
| WebGPU (P6) | Done: fisheye, analog, thermal G-buffer and thermal camera passes as TSL node materials, oracle-tested on the RTX 4050 |
| Image quality | Aliasing removed in all views; analog FPV noise halved at the operator's request |
| Captures (P7) | RTX 4050 on the external 1920 x 1080 60 Hz display: median within 16.680 ms, p99 27.085 ms on WebGL2 and WebGPU: `FAIL`. Internal 144 Hz panel: Chrome rendered on the Intel iGPU at 1920 x 1200: `FAIL` (surface and p99) |
| Device rule | By user decision, Windows integrated GPUs are accepted devices; every verdict records the GPU |
| Display gate | By user decision, PresentMon displayed-frame times must meet the same limits as the frame clock; all P7 captures fail it, including the `--disable-direct-composition` runs whose frame clock passes (displayed p99 33.4 ms) |

Still needed for a `PASS`:

* **Frame pacing:** on this laptop the p99 misses happen while the GPU is busy for less than half of a refresh. They follow GPU power-state
  changes under Windows hybrid graphics, not scene cost. A run with the GPU locked to a high clock (the operator's driver tools) or another
  machine would show whether the scene meets the limit.
* **Baseline surface on the panel:** set the panel to 1920 x 1080 at 144 Hz, 100% scaling, so the 60 and 120 FPS profiles can be scored.
* **RTX 4050 on the panel:** assign Chrome to the high-performance GPU in Windows graphics settings; otherwise the panel runs on the iGPU.
* **M4:** repeat the 60 FPS capture with the scene filling the display (the operator provides the Mac).

## 11. Operator answers, third round (2026-10-23)

These answers replace the device and resolution rules of sections 2.2, 2.4 and
5 for the gate.

| Question | Answer |
| --- | --- |
| What decides TASK-073 | A 1920 x 1080 canvas at 1x scale on an integrated GPU, 60 FPS, on WebGL2 and WebGPU, at the accepted limits (median 16.680 ms, p99 17.665 ms) |
| Which integrated GPU | The least performant of the tested ones |
| Other machines, screens and GPUs | Tested, but they do not decide; recorded in [DEVICE_RATINGS.md](DEVICE_RATINGS.md) |
| Rating | Every computer + screen + GPU combination gets a score out of 100: pacing 50, sustained FPS 20, median 10, features and flight 10, memory headroom 10 |

The harness, analyzer and registry implementing this are `scripts/check-gpu-perf.mjs`,
`scripts/gpu-trace.mjs` and `scripts/gpu-ratings.mjs`. Still needed: 10-minute
WebGL2 and WebGPU captures at 1920 x 1080 and 1x on every tested integrated GPU
(Apple M4, Intel Graphics in the RTX 4050 laptop, Apple M5), with the machine on
AC power, the lid open and the machine untouched.

Intel Graphics in the RTX 4050 laptop: done on 2026-10-24, both backends PASS
(rating 100) on the internal panel as the only display. On Windows the capture
must run on the primary display, because Chrome takes its frame clock from the
primary display's vertical blank; the earlier panel runs beside a primary
external monitor failed for that reason (see [DEVICE_RATINGS.md](DEVICE_RATINGS.md)).
Still needed: the Apple M4 and M5 captures.
