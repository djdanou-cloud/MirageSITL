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
* **Comparability:** ratings compare runs over the same terrain. Runs over the
  one-tile CC0 fixture (`fixture`) are much lighter than runs over the
  generated FABDEM terrain, Overture buildings and material drape (`geodata`)
  and overstate performance.

## 3. Ratings by combination

| Machine | Screen | GPU (class) | Terrain | Rating, 60 FPS | Rating, 120 FPS |
| --- | --- | --- | --- | --- | --- |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | fixture | 70-90 (provisional) | not run |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | geodata | 33-53 (provisional) | not run |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | geodata | 62-82 (provisional) | 0-20 (provisional) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | fixture | 90 (excellent) | not run |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 69 (usable) | not run |

Notes:

* **MacBook Air M4:** 2026-10-21, before the P3-P6 scene (no buildings, no
  material drape, no scripted flight) in a floating window with an emulated
  viewport. The flight component is therefore 0 and the missed-refresh count
  was not recorded. It does not count for the gate and must be re-run.
* **RTX 4050 on the external display:** P7 captures of 2026-10-22 over the
  Israel area. Missed refreshes are the reported intervals over 18.5 ms (a
  lower bound); GPU memory is the Windows GPU-process peak; the terrain cache
  and flight state are not in the summaries. Discrete GPU: never decides.
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
* **MacBook M5:** 2026-10-22 with the pre-rewrite harness over the fixture
  terrain. Frame pacing was excellent (median 16.665 ms, p99 17.670 ms, no
  missed refresh), but the scripted flight fell after about 11 s and the
  canvas was the 1710 x 985 window, not 1920 x 1080 at 1x. The second run of
  that day is excluded because the machine slept through it with the lid
  closed.

## 4. Gate status

`node scripts/gpu-ratings.mjs decide` reports **`BLOCKED_EXTERNAL`**: three
integrated GPUs have been tested (Apple M4, Intel Graphics in the RTX 4050
laptop, Apple M5). The Intel iGPU has gate-eligible runs on both backends and
both FAIL (frame-clock p99 27.685 ms on WebGL2 and 24.040 ms on WebGPU,
displayed p99 57.041 and 50.008 ms; mean rating 69). The M4 and M5 have no
gate-eligible run yet, so the least performant integrated GPU is unknown; if
it is the Intel iGPU, TASK-073 fails. The Macs need 10-minute WebGL2 and
WebGPU captures on a 1920 x 1080 display at 1x scale (an external 1920 x 1080 monitor
or a 1920 x 1080 scaled mode with the window filling the screen at DPR 1).

## 5. All runs

| Machine | Screen | GPU (class) | Backend / profile | Canvas | Terrain | Median / p99 ms | Missed | Gate | Rating |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | fixture | 16.680 / 17.665 | n/a | INFO | 70-90 (provisional: missed refreshes not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 27.085 | 1579 | INFO | 32-52 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 27.085 | 1477 | INFO | 34-54 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | webgl2 60 FPS | 1920 x 1200 at 1x | geodata | 14.280 / 21.920 | 1080 | INFO | 54-74 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | webgpu 60 FPS | 1920 x 1200 at 1x | geodata | 7.040 / 20.930 | 0 | INFO | 70-90 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | webgl2 120 FPS | 1920 x 1200 at 1x | geodata | 14.080 / 22.320 | 36780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | webgpu 120 FPS | 1920 x 1200 at 1x | geodata | 13.770 / 21.040 | 21780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | webgl2 60 FPS | 1710 x 985 at 1x | fixture | 16.665 / 17.670 | 0 | INFO | 90 (excellent) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.655 / 27.685 | 447 | FAIL | 63 (usable) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 24.040 | 378 | FAIL | 75 (good) |

## 6. Adding a run

```bash
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 60 --geodata PATH --machine "LABEL" --screen "LABEL" --out test-results/gpu/LABEL-webgl2-60
node scripts/gpu-ratings.mjs add test-results/gpu/LABEL-webgl2-60/run-record.json
node scripts/gpu-ratings.mjs table
node scripts/gpu-ratings.mjs decide
```

Run every combination on AC power with the lid open and the machine left
alone for the whole capture: the application's instructor keys pause, reset or
inject faults. Paste the `table` output into sections 3 and 5 (here and in the
Russian mirror), update section 4 from `decide`, and run `npm run check:docs`.
