# Windows laptop verification — 2026-10-17

English source. [Russian mirror](../ru/laptop-validation-2026-10-17.md).

## Machine and scope

Source checkpoint: `ca78ef6`, following the original `1eb44f1` hardware baseline.
Windows 11, Intel Core 7 240H (10 cores / 16 logical processors),
16,763,666,432 bytes RAM, RTX 4050 Laptop GPU (6141 MiB reported VRAM),
NVIDIA driver 561.00 and Intel integrated graphics. Windows used its balanced
power scheme. Chrome was 155.0.8059.84; Node was 24.19.0; Rust was pinned to
1.97.0. Raw machine/display/GPU metadata and commands are under
`test-results/laptop/`.

Windows reports a 1920x1080 60 Hz output on NVIDIA and a 1920x1200 144 Hz
output on Intel. A browser window's display matters to visible frame cadence;
the existence of an RTX GPU alone does not establish a 120 FPS presentation.
No display, driver, power-plan or flight-controller settings were changed.

All browser work used the demo or explicit test harnesses. No test opened the
physical serial port, armed physical hardware, injected sensors or commanded
actuators. The original USB observations remain a separate
[hardware checkpoint](local-hardware-2026-10-17.md).

## Verified software fixes

* Repository attributes now preserve LF source and hashed fixture bytes while
  preserving the byte-exact NASA archives. Hash goldens were not regenerated.
* The physics benchmark imports absolute paths through file URLs. Release
  inventory normalizes Windows separators after resolving real paths and
  preserves traversal, root, symlink and hash checks.
* The compiler-host regression canonicalizes intercepted filenames. The
  release test uses a directory junction to exercise containment without
  requiring Windows file-symlink privileges.
* Playwright starts Vite with the current Node executable, and fixture module
  URLs escape names and normalize separators. npm need not be on PATH after
  locked dependencies are installed. An explicit hardware profile removes
  software GPU launch flags.
* The Serial UI waits for decoder readiness before opening the selected port.
  Cold startup has a separate 5-second deadline; the 500 ms per-chunk deadline
  remains intact. Browser regressions cover 900 ms startup delay, failed
  startup without device opening, fragmented frames and stream release.
* The 610-s synthetic thermal calibration case has an explicit 20-s test-runner
  timeout. Its simulation length, noise seed, pixel count, numerical tolerances
  and interruption limits are unchanged; it is not a wall-time performance gate.
* An identical duplicate dependency key was removed without changing the
  resolved dependency graph or lockfile.

The full initial suite had 420 PASS, 27 FAIL and 17 pending. The final suite has
465 PASS, zero FAIL and zero pending, including real native/WASM-backed tests.
The native Rust workspace separately passed 46 tests with none ignored.
The complete functional Chrome suite passed 49 tests, failed none and skipped
one WebGPU test because the software adapter was unavailable. A visible native
NVIDIA WebGPU run is recorded separately; a software skip was not relabeled PASS.
Typecheck, strict lint, documentation checks and the production build passed.

The original failures are retained, including the full run with 462 PASS /
2 FAIL and the browser run with 46 PASS / 1 FAIL / 1 skipped. Its 800 Hz pacing
failure occurred under competing workloads; the subsequent sequential browser
run passed the unchanged rate limit. Earlier cold Serial failure prompted the
startup fix. The earlier Rust target installation conflict did not recur;
installed-target inspection and successful native/WASM executions are the
evidence for local availability, not a claim about its original cause.

## Visible NVIDIA captures on the 60 Hz output

Both captures used a production-built demo, 1920x1080 viewport, DPR1, 60 seconds
of warmup, a visible page and the actual RTX 4050 adapter. WebGPU used its native
backend without fallback. Neither capture had a page error or visibility change.
The build before and after final software checks had identical asset bytes.
The earlier probe source is archived as `probe-laptop-initial.source.txt`.

| Backend | Measured duration | Frames | Average FPS | p50 / p95 / p99 interval | Maximum interval |
| --- | --- | --- | --- | --- | --- |
| WebGL2 | 600.0052 s | 35995 | 59.9911 | 16.670 / 17.640 / 19.910 ms | 34.365 ms |
| WebGPU | 120.002465 s | 7193 | 59.9404 | 16.665 / 17.635 / 19.645 ms | 34.270 ms |

Both p99 values miss the roadmap's 16.67 ms threshold. Similar cadence across
backends and the 60 Hz output suggest presentation/scheduling constraints, but
these observations do not isolate a GPU, compositor or application root cause.
No threshold, resolution or assertion was relaxed to obtain a pass.

The probe's PASS means acquisition completed with the requested backend and
without captured page/visibility errors. It is **not** a GPU acceptance verdict.
Intervals are measured with requestAnimationFrame, not GPU timer queries or
independent physical presentation instrumentation.

WebGL2 heap snapshots were 9,519,245 bytes after warmup and 11,556,287 at the
end; WebGPU was 12,503,700 then 12,461,704 bytes. These are browser heap samples,
not proof of leak absence, scene VRAM or terrain cache residency. One system-wide
NVIDIA sample during WebGL2 showed 1281 MiB, 67% utilization and 58 C; it includes
other applications and cannot satisfy the scene's memory gate. The operator
confirmed a visible scene, readable controls and no observed blank/flickering
areas during the first capture; saved screenshots were also inspected.

## CPU allocation and wall-clock timing

Physics, combined link/EW kernels, AAR production encoding/handoff and
terrain/scenario polling passed their allocation probes at 400, 800 and
1200 Hz. They retained zero incremental bytes/step, zero observed GC in measured
windows and working allocating controls. The ideal/noise/scheduler/latency sensor
composition and wind probes also passed. These are the measured library graphs;
they do not establish complete production integration or physical fidelity.

The physics benchmark's separate five-second Node wall-clock captures show:

| Target | Executed rate | Dropped ticks | Compute p99 | Wakeup lateness p99 |
| --- | --- | --- | --- | --- |
| 400 Hz | 400.532 Hz | 0 | 1.2 us | 15.76 ms |
| 800 Hz | 516.710 Hz | 1426 | 1.1 us | 16.06 ms |
| 1200 Hz | 519.573 Hz | 3415 | 1.3 us | 15.99 ms |

The 800/1200 Hz **delivered-rate checks fail**, even though their compute and
allocation probes pass. In this Node/Windows path, approximately 16 ms wakeups
exceed the bounded catch-up allowance at the higher rates. The 400 Hz run catches
up without drops, but its jitter still does not establish hard real time.
The benchmark's exit code covers its allocation gate; it must not be used as
a green verdict for the separately reported rate. The browser Worker 800 Hz
regression passed its unchanged 720–880 Hz range in the sequential run. Node
timers and browser Worker timing are separate measurements. No catch-up limit,
timer threshold or overload policy was relaxed to hide the misses.

## Acceptance boundaries

### 144 Hz panel and native GPU follow-up

The operator confirmed placement on the 144 Hz laptop panel before measurement.
The fixed 1920x1080 CSS viewport capture lasted 120.001095 s after 60 s warmup:
7199 frames, 59.9911 FPS, p99 19.565 ms. The operator reported controls clipped
inside the window. This capture is timing evidence, not a visual layout pass.

The native-window follow-up used 1536x826 CSS pixels at DPR 1.25 on the same
panel. The operator confirmed that clipping was gone and all controls were
visible before measurement. Document client/scroll widths both measured 1521 px;
the rightmost controls ended at 1486.8 px. After 10 s warmup, 30.00003 s produced
1800 frames, 59.99994 FPS and p99 19.005 ms, with no page errors or visibility
changes. The fix is the probe's native viewport option; application CSS did not
change. A 144 Hz panel still did not produce 120 FPS in these captures. The
limiting compositor/browser/application cause remains unresolved.

Evidence: `test-results/laptop/144hz/` and `144hz-native/`, including operator
ready markers, viewport metadata, raw frame intervals and screenshots.

The native-GPU renderer suite initially passed four tests and failed two:
WebGPU's scene-disposal check expected zero geometries while Three.js retained
its renderer-owned output geometry. An empty-scene warmup independently measures
the baseline (one geometry, two textures); the textured box adds one geometry
and one texture. Scene disposal returns exactly to that baseline; full renderer
disposal leaves zero geometries and textures. Assertions now check both ownership
boundaries rather than changing the expected count to an unexplained constant.
The rerun passed all six tests, including WebGPU and backend switching, with
zero skips. This verifies tracked resource lifecycles, not byte-level VRAM.
The software-profile renderer regression was rerun separately after this change.

### Final local outcome

Windows portability, decoder startup and test-harness resource accounting are
fixed. Native/WASM execution, real GPU rendering and visible layout inspection
are now available locally. Software suites and build checks pass as recorded
above. The failed high-rate Node delivery, GPU p99/120 FPS targets and NASA
contact fidelity remain explicit failures; missing production/HITL evidence
remains blocked. These results do not authorize physical actuation.

TASK-073 now has real target-device demo evidence. It remains BLOCKED_EXTERNAL
for the full production terrain/FPV/thermal matrix, cache/VRAM accounting and M4.
The observed 60 Hz demo p99 misses are retained separately from missing evidence.
TASK-042/043/050/051/059/079 remain blocked by their firmware, production driver,
HIL/profile, timed integration and real scenario/EW dependencies. A physical
controller and a laptop GPU do not complete those contracts.

The NASA contact model still fails measured stroke/deceleration envelopes;
numerical parity passing does not repair missing tire/strut physics. Release
and system acceptance retain their independent missing-provider, production,
clean-machine and hardware gates. No flight or release certification is claimed.
