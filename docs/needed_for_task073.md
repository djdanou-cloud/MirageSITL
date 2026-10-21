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
