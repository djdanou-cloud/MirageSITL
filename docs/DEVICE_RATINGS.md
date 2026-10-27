# Device ratings (TASK-073)

English source. [Russian mirror](ru/DEVICE_RATINGS.md).

This document lists every computer, screen and GPU combination on which the
G3 scene has been measured, with a rating out of 100 for how well MirageSITL
runs on it. The ratings are informational: by user decision of 2026-10-23 they
do not decide whether TASK-073 passes. The gate is defined in
[PROJECT_ROADMAP.md](PROJECT_ROADMAP.md) (TASK-073) and in
`docs/benchmarks/render-matrix.json`; the run records behind every row are in
`docs/benchmarks/device-results.json`.

## 1. What decides TASK-073

* **Gate profile:** a 1920 x 1080 canvas on a display at 1x scale (page
  `devicePixelRatio` 1; the renderers always draw at pixel ratio 1), 60 FPS profile,
  on a display above 58 Hz, on an **integrated GPU** (Apple Silicon, Intel
  integrated graphics, AMD Radeon Graphics). Measured for 600 s after 60 s
  warmup with terrain, FPV and thermal active and the scripted flight airborne
  for the whole window.
* **Limits (unchanged):** median <= 16.680 ms and p99 <= 17.665 ms (rounded to
  0.001 ms), GPU residency <= 2 GiB and CPU residency <= 512 MiB.
* **Displayed frames (user decision 2026-10-22):** PresentMon displayed-frame
  times (how long each frame stayed on screen) meet the same median and p99
  limits. On Windows a gate-eligible run without PresentMon data is
  `BLOCKED_EXTERNAL`; without a display-timing source (macOS) the run records
  `displaySource: unavailable` and the frame clock alone decides.
* **Gate device:** the **least performant integrated GPU** among all tested
  ones, that is, the one with the lowest mean rating over its gate-eligible
  WebGL2 and WebGPU runs (ties go to the worse p99). TASK-073 passes only when
  that device passes on **both WebGL2 and WebGPU**. Until every tested
  integrated GPU has gate-eligible runs on both backends, the least performant
  one is unknown and the decision is `BLOCKED_EXTERNAL`.
* **Everything else** (discrete GPUs, other canvas sizes and scales, 120 FPS
  profiles, historical runs) is measured and rated here but never decides.

## 2. How a run is rated

Each valid run receives a score out of 100 against the target interval
`T = 1000 / min(display refresh, profile FPS)` ms:

```text
rating = 50 pacing + 20 sustain + 10 median + 10 features + 10 memory

pacing   = 1 at p99 <= 1.06 T, 0 at p99 >= 2 T, linear between
sustain  = 1 - missed / (0.05 * expected frames), floored at 0
           (an interval of k target periods misses k - 1 refreshes)
median   = 1 at p50 <= T, 0 at p50 >= 1.5 T, linear between
features = 1 when terrain, FPV and thermal were held and the scripted
           flight stayed airborne with live input for the whole window
memory   = 1 - max(GPU peak / 2 GiB, CPU peak / 512 MiB), floored at 0

90-100 excellent, 75-89 good, 50-74 usable, below 50 poor
```

* **Combination rating:** the mean of the latest 60 FPS WebGL2 and WebGPU run
  ratings for that machine, screen and GPU (or the single one that exists);
  120 FPS is rated separately.
* **Provisional ratings:** historical records that lack an input (missed
  refreshes, flight state or residency) score 0 for that part and show a range
  up to the score the missing part could add. They become exact when the
  combination is re-run with the current harness.
* **No rating:** software or headless GPUs, windows shorter than 600 s or
  warmups shorter than 60 s, hidden tabs, canvases that changed size, and runs
  the machine slept through (wall time leading monotonic time by more than 2 s;
  macOS pauses `performance.now()` while asleep) are `BLOCKED_EXTERNAL` and not
  rated.
* **Comparability:** ratings compare runs over the same terrain and scene.
  From lightest to heaviest: `demo` (the 2026-10-17 demo scene, no terrain,
  FPV or thermal), `fixture` (the one-tile CC0 fixture), `stress-tileset`
  (341 synthetic untextured tiles) and `geodata` (generated FABDEM terrain,
  Overture buildings and material drape, the current acceptance scene).
  Lighter scenes overstate performance. A combination's rating uses its latest
  runs, so the terrain column shows the terrain behind that rating.

## 3. Ratings by combination

| Machine | Screen | GPU (class) | Terrain | Rating, 60 FPS | Rating, 120 FPS |
| --- | --- | --- | --- | --- | --- |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | geodata | 33-53 (provisional) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | stress-tileset | 29 (poor) | not run |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | fixture | 70-90 (provisional) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 62-82 (provisional) | 0-20 (provisional) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | fixture | 90 (excellent) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 69 (usable) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 92 (excellent) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling, only display | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 100 (excellent) | not run |

Notes:

* **MacBook Air M4:** 2026-10-21, before the P3-P6 scene (no buildings, no
  material drape, no scripted flight) in a floating window with an emulated
  viewport. The flight component is therefore 0 and the missed-refresh count
  was not recorded. It does not count for the gate and must be re-run.
* **RTX 4050 on the external display:** the rating is from the P7 captures of
  2026-10-22 over the Israel area. Missed refreshes are the reported intervals
  over 18.5 ms (a lower bound); GPU memory is the Windows GPU-process peak; the
  terrain cache and flight state are not in the summaries. Discrete GPU: never
  decides. Earlier runs on the same combination, lighter scenes: the
  2026-10-17 demo scene rated 72-82 (median 16.670 ms, p99 19.910 ms,
  43 missed refreshes in 600 s, recomputed from the committed intervals), and
  the 2026-10-21 stress-tileset captures with the vehicle parked rated 66
  under Balanced power (p99 23.880 ms, 349 missed) and 29 under maximum
  performance power (p99 34.260 ms, 947 missed; the GPU kept dropping to idle
  clocks). The 2026-10-17 WebGPU demo probe (120 s), the two demo probes on
  the internal panel (120 s and 30 s) and the 10 s P6 WebGPU smoke run are
  listed but not rated: they are shorter than 600 s.
* **Intel iGPU on the internal 144 Hz panel:** P7 panel runs of 2026-10-22 at
  1920 x 1200, so not gate-eligible. Frames and missed refreshes are derived
  from the reported mean FPS. WebGPU at 60 FPS rated 70-90 and WebGL2 54-74;
  the 120 FPS profile reached only 58.7 and 83.7 FPS on average.
* **Intel iGPU on the external display (gate runs):** 2026-10-23, Chrome 155
  with `--force_low_power_gpu`, Balanced power, 1920 x 1080 at 1x on the
  external 59.88 Hz monitor over the Israel area, with terrain, FPV and thermal
  held and the scripted flight airborne for the whole 600 s. Both runs FAIL.
  WebGL2: median 16.655 ms, p99 27.685 ms, 447 missed refreshes; PresentMon
  displayed median 17.052 ms and p99 57.041 ms, and 10,191 of 35,660 presented
  frames were never displayed. WebGPU: median 16.670 ms, p99 24.040 ms, 378
  missed; displayed p99 50.008 ms, 3,929 of 35,713 never displayed. The Chrome
  GPU process used only shared memory (no dedicated VRAM), so both backends
  rendered on the Intel GPU (GPU busy median 11.4 and 11.2 ms). The external
  monitor is driven by the NVIDIA GPU, so every frame crosses adapters and is
  composed by DWM (present mode `Composed: Flip`); a 1920 x 1080 display
  driven by the Intel GPU itself has not been measured. The historical rows of
  this laptop now carry the full renderer strings their captures recorded.
* **Intel iGPU on its own panel (gate runs):** 2026-10-23, the same setup on
  the internal panel set to 1920 x 1080 at 60 Hz and 100% scaling, so the
  Intel GPU drives the display (the NVIDIA GPU stayed idle in P8). Both runs
  FAIL and rate 38. Every presented frame was displayed (present mode
  `Hardware Composed: Independent Flip`), but about 3% were held for two
  refreshes: WebGL2 median 16.670 ms, p99 42.430 ms, 1,061 missed refreshes,
  displayed p99 33.395 ms; WebGPU median 16.665 ms, p99 41.965 ms, 1,035
  missed, displayed p99 33.375 ms. GPU busy median 11.4 and 11.9 ms, p99 15.2
  and 18.5 ms. Frame pacing is worse here than through the NVIDIA-driven
  monitor, so the cross-adapter copy is not what makes this GPU fail. A 45 s
  pacing diagnosis (WebGL2) attributes the late frames to lost vertical-blank
  signals: 281 of 282 late presents coincide with a Chrome `GpuVSyncThread`
  wait of two or three refreshes, Chrome drops those frames (`BACKFILL`) and
  the Intel GPU sits idle meanwhile; per-frame CPU and GPU work match on-time
  frames. On an idle page on the same panel only 4 of about 3,593 refreshes
  lost their signal, so the loss comes with the scene's load. Neither 13 ms of
  synthetic GPU work per frame (0.36% late) nor 15 ms of main-thread CPU work
  per frame (0.2% late) reproduces it. A bisection found the cause in the
  harness itself: the `nvidia-smi` sampler that `check-gpu-perf.mjs` polls at
  1 Hz delays the Intel panel's vertical-blank signal on each query (full
  scene: 0.37% late without it, 1.99% with it at 1 Hz, 12.55% at 10 Hz;
  PresentMon and `typeperf` add nothing). These runs' failures are therefore
  at least partly a measurement artefact; they stay recorded as measured.
* **Intel iGPU on its own panel without `nvidia-smi` (gate runs):** 2026-10-24,
  the same setup after `check-gpu-perf.mjs` stopped querying `nvidia-smi` for a
  GPU that is not NVIDIA (clocks recorded as unavailable with the reason). Both
  still FAIL, narrowly, and rate 92 and 91: WebGL2 median 16.665 ms, p99
  19.960 ms, 88 missed refreshes, displayed p99 19.297 ms; WebGPU median
  16.665 ms, p99 20.140 ms, 81 missed, displayed p99 19.926 ms. Every frame was
  displayed (`Hardware Composed: Independent Flip`); GPU busy median 12.3 and
  12.1 ms, p99 15.2 and 18.3 ms.
* **Intel iGPU on its own panel as the only display (gate runs):**
  2026-10-24, the same harness with the external monitor disconnected, so the
  internal panel (1920 x 1080 at 60 Hz, 100% scaling) was the only and
  therefore the primary display. Chrome on Windows takes its frame clock from
  the primary display's vertical blank (`ui/gl/vsync_thread_win_dxgi.cc`); in
  the earlier panel runs the primary display was the external monitor driven
  by the NVIDIA GPU, so those runs were paced by another display's clock. Both
  runs PASS and rate 100: WebGL2 median 16.665 ms, p99 17.310 ms, 0 missed
  refreshes, displayed p99 17.279 ms; WebGPU median 16.665 ms, p99 17.310 ms,
  2 missed, displayed p99 17.281 ms. Every frame was displayed (`Hardware
  Composed: Independent Flip`); GPU busy median 13.6 and 13.7 ms, p99 15.1 and
  15.0 ms (WebGPU: 48 of 41,399 presents above 16.67 ms, against 633 of 41,340
  in the previous WebGPU run).
* **MacBook M5:** 2026-10-22 with the pre-rewrite harness over the fixture
  terrain. Frame pacing was excellent (median 16.665 ms, p99 17.670 ms, no
  missed refresh), but the scripted flight fell after about 11 s and the
  canvas was the 1710 x 985 window, not 1920 x 1080 at 1x. The second run of
  that day is excluded because the machine slept through it with the lid
  closed.

## 4. Gate status

`node scripts/gpu-ratings.mjs decide` reports **`BLOCKED_EXTERNAL`**: three
integrated GPUs have been tested (Apple M4, Intel Graphics in the RTX 4050
laptop, Apple M5). The Intel iGPU's latest gate-eligible pair, on its own
panel as the only (and therefore primary) display, PASSES on both backends
(p99 17.310 ms on WebGL2 and WebGPU, displayed p99 17.279 and 17.281 ms,
rating 100); its six earlier runs, with an external monitor on the NVIDIA GPU
as the primary display, all FAIL. On Windows, gate captures therefore run on
the primary display. The M4 and M5 have no gate-eligible run yet, so the least
performant integrated GPU is still unknown. The Macs need 10-minute WebGL2 and
WebGPU captures on a 1920 x 1080 display at 1x scale (an external 1920 x 1080 monitor
or a 1920 x 1080 scaled mode with the window filling the screen at DPR 1).

## 5. All runs

| Machine | Screen | GPU (class) | Backend / profile | Canvas | Terrain | Median / p99 ms | Missed | Gate | Rating |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | demo | 16.670 / 19.910 | 43 | INFO | 72-82 (provisional: memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | demo | 16.665 / 19.645 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), paced at 60 Hz | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | demo | 16.665 / 19.565 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 125% scaling | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1536 x 826 at 1.25x | demo | 16.670 / 19.005 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1316 x 640 at 1x | stress-tileset | 16.670 / 23.880 | 349 | INFO | 66 (usable) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1316 x 640 at 1x | stress-tileset | 16.685 / 34.260 | 947 | INFO | 29 (poor) |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | fixture | 16.680 / 17.665 | n/a | INFO | 70-90 (provisional: missed refreshes not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | n/a | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 27.085 | 1579 | INFO | 32-52 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 27.085 | 1477 | INFO | 34-54 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1200 at 1x | geodata | 14.280 / 21.920 | 1080 | INFO | 54-74 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1200 at 1x | geodata | 7.040 / 20.930 | 0 | INFO | 70-90 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 120 FPS | 1920 x 1200 at 1x | geodata | 14.080 / 22.320 | 36780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 120 FPS | 1920 x 1200 at 1x | geodata | 13.770 / 21.040 | 21780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | webgl2 60 FPS | 1710 x 985 at 1x | fixture | 16.665 / 17.670 | 0 | INFO | 90 (excellent) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.655 / 27.685 | 447 | FAIL | 63 (usable) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 24.040 | 378 | FAIL | 75 (good) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 42.430 | 1061 | FAIL | 38 (poor) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 41.965 | 1035 | FAIL | 38 (poor) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 19.960 | 88 | FAIL | 92 (excellent) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 20.140 | 81 | FAIL | 91 (excellent) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling, only display | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 17.310 | 0 | PASS | 100 (excellent) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling, only display | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 17.310 | 2 | PASS | 100 (excellent) |

## 6. Adding a run

```bash
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 60 --geodata PATH --machine "LABEL" --screen "LABEL" --out test-results/gpu/LABEL-webgl2-60
node scripts/gpu-ratings.mjs add test-results/gpu/LABEL-webgl2-60/run-record.json
node scripts/gpu-ratings.mjs table
node scripts/gpu-ratings.mjs decide
```

Run every combination on AC power with the lid open and the machine left
alone for the whole capture: the application's instructor keys pause, reset or
inject faults. On Windows, capture on the primary display: Chrome paces every
window by the primary display's vertical blank. Paste the `table` output into sections 3 and 5 (here and in the
Russian mirror), update section 4 from `decide`, and run `npm run check:docs`.
