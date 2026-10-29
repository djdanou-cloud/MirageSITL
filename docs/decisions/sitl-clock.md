# External SITL clock ownership (TASK-129)

English source. [Russian mirror](../ru/sitl-clock.md).

Status: PASS on 2026-10-29. This records D-03. MirageSITL physics owns simulated
time when it is the JSON lockstep peer and the reply does not set `no_lockstep`.
ArduPilot source is unchanged. The aircraft is the synthetic quad X already used
by TASK-127, not a measured model, and this record does not enable browser
autopilot READY.

## Clock-compatible connections

Pause may be offered only for a connection in the first row. TASK-153 uses this
classification before it enables pause.

| Connection | Simulated time while the next JSON reply is withheld |
| --- | --- |
| `--model JSON`, MirageSITL is the physics peer, reply omits `no_lockstep` | Frozen. `JSON::recv_fdm` blocks. `time_now_us` advances only after a reply whose timestamp increases by a positive amount below 0.1 s. `Scheduler::stop_clock` is not called during the wait, so `AP_HAL::millis()` stays at the retained simulation time. |
| JSON reply with `no_lockstep` true | Not frozen. `recv_fdm` returns immediately and advances time at the SITL loop rate. |
| Built-in SITL frame model, `--model` other than JSON | Not frozen. That model advances time itself. |
| HITL at commit `8ab6afde107a91df1b5f60ade8f333cb8a61b190` | No `HIL_SENSOR` handler (TASK-050). Not a pause path. |

`--speedup` only paces `Aircraft::sync_frame_time` after simulated time has
already advanced. It does not own the clock. The achieved simulated/wall ratio
is host-limited. Paused wall time is excluded from the ratio and from simulated
duration.

A parameter read or write sent during the hold is not answered while the main
scheduler is blocked inside `recv_fdm`. The bytes wait on the TCP socket and are
applied after resume. RC override and a GCS heartbeat continue on wall time from
the controlling peer; they do not advance simulated time. The bridge sends a
WebSocket ping every 1 s and closes a session only after 5 s without a pong.
Physics-payload silence is not idle.

The retained servo datagram is answered once at release. A later copy of that
same datagram is the frozen resend still queued in the socket. It is discarded
without a second reply and without a duplicate count. A second reply would make
`SIM_JSON` increment `frame_counter` again. The probe parameter is always the
frame baseline plus 1, then restored to the baseline. A second hold does not add
another 1 to an unrestored value.

## Reproduce

The binary, source pin and Python environment are the TASK-127 stock build.
Each capture directory must be new. Reports stay under `.cache/task-129/`.

```bash
export MIRAGE_SITL_SOURCE="$PWD/.cache/task-127/ardupilot"
export MIRAGE_SITL_BINARY="$PWD/.cache/task-127/build-stock/sitl/bin/arducopter"
export MIRAGE_SITL_PYTHON="$PWD/.cache/task-127/venv/bin/python"
node scripts/run-sitl-pause.mjs holds 2 .cache/task-129/holds-004
.cache/task-127/venv/bin/python scripts/sitl/check-pause-raw.py --input .cache/task-129/holds-004
node scripts/check-sitl-pause.mjs --input .cache/task-129/holds-004 --output .cache/task-129/holds-004-audit.json
node scripts/run-sitl-pause.mjs continuous 20 .cache/task-129/fast-003
.cache/task-127/venv/bin/python scripts/sitl/check-pause-raw.py --input .cache/task-129/fast-003
node scripts/check-sitl-pause.mjs --input .cache/task-129/fast-003 --output .cache/task-129/fast-003-audit.json
node scripts/run-sitl-pause.mjs continuous 2 .cache/task-129/realtime-001
.cache/task-127/venv/bin/python scripts/sitl/check-pause-raw.py --input .cache/task-129/realtime-001
node scripts/check-sitl-pause.mjs --input .cache/task-129/realtime-001 --output .cache/task-129/realtime-001-audit.json
```

## Observed result — 2026-10-29

PASS on Apple M5, macOS 25.6.0, Node 24.22.1, pymavlink 2.4.50. Stock ArduCopter
commit `8ab6afde107a91df1b5f60ade8f333cb8a61b190`, arm64 Mach-O SHA-256
`d47c1f64934f1911e4d6fb88da8aa18c21c9e438f3ae687b0e56eb13807e08e4`. Physics is
800 Hz. Declared before the runs: a pause is 60–65 s wall; retained truth is
unchanged; the resumed step matches scalar WASM within 1e-10 m, m/s and
quaternion units; simulated time advances 1/800 s per accepted frame; after the
hover resume, GUIDED and arm stay up with a healthy EKF and a 10 m ±1 m hold for
at least 10 s. Each input file is at most 64 MiB, and a capture is at most
96,000 steps and 300 s wall.

| Run | Requested `--speedup` | Simulated s | Wall s | Paused wall s | Achieved sim/active wall |
| --- | --- | --- | --- | --- | --- |
| holds 2 | 2 | 87.04125 | 163.973484667 | 120.102767125 | 1.9840398077982284 |
| continuous 20 | 20 | 84.02125 | 7.43142975 | 0 | 11.306202551400018 |
| continuous 2 | 2 | 84.05125 | 42.578584709 | 0 | 1.9740263931843125 |

All three audits exited 0. Scalar WASM replay error was 0. The holds capture
has 69,633 physics frames and 4,361 scored samples.

The ground hold started at 41.2475 simulated seconds and lasted 60.052204958 s
wall. The hover hold started at 54.40875 s and lasted 60.050562167 s wall. Each
hold repeated the same servo datagram 53 times after the retained frame. From
1 s after the hold began until release, the firmware sent no scheduler
telemetry. `SYSTEM_TIME.time_boot_ms` advanced 0.2 s across each hold. During
each hold the sidecar sent 288 `HEARTBEAT` and 288 `RC_CHANNELS_OVERRIDE`
frames, and the bridge stayed open with 60 pings. `WP_SPD` was set to 11 at
each hold and read back only after resume, then restored to 10 before the next
phase. The final read-back is 10.

Hover ran from 52.41125 s to 64.61125 s. The 10.2025 s after the hover hold
stayed inside 10 m ±1 m, armed, in GUIDED, with healthy EKF flags. No STATUSTEXT
in that span matched a failsafe or an EKF reset. DataFlash XKF4 from the hold
through the following simulated second has fault status 0, primary lane 0, and
one position-reset offset. A position-offset change at 41.14 s finished before
the ground hold. `EKF_YAW_RESET` (event 62) at 48.788 s matches the unpaused
speedup-20 flight's yaw reset at 48.24 s, during takeoff, not either resume.

Requested speedup 20 achieved 11.31 on this M5. The model was not simplified.
The host is the limit.

This does not pause from the Run tab (TASK-155), connect to a SITL the user
started (TASK-153), or cover a 16-motor frame.
