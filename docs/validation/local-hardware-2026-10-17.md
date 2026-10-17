# Local ArduPilot USB diagnostics — 2026-10-17

English source. [Russian mirror](../ru/local-hardware-2026-10-17.md).

## Scope and provenance

Baseline: `1eb44f1dd5d9464ece93817face3c1e9e9e42465`; Windows; Node 24.19.0.
Original captures and software reports are retained under
`test-results/hardware/`. These observations establish USB telemetry access,
not physical HITL or flight acceptance. Operator confirms USB power only with
the battery disconnected and suspects this aircraft has no GPS.

The serial port was COM20, opened at 115200, 8N1, DTR/RTS disabled. The first
capture received only; the second transmitted ten MAV_CMD_REQUEST_MESSAGE
(512) queries, 410 bytes total. No arming, mode, parameter, calibration,
RC override, motor, servo or HIL sensor commands were transmitted. All 61
passive and 206 query-capture heartbeats report disarmed and HIL disabled.
Reported disarming does not independently establish physical motor isolation.

## Observations

| Check | Result | Evidence and limitation |
| --- | --- | --- |
| USB identity | PASS | ArduPilot device; VID 1209, PID 5741; exact board model unverified. |
| Firmware identity | PASS | Reported 4.6.3 stable; custom version 3fc7011a; system/component 1/1. This is not a firmware binary SHA-256. |
| MAVLink integrity | PASS | 67 passive and 252 query-capture frames; no CRC failures or sequence gaps in complete decoded frames. |
| IMU sanity | PASS | Healthy/enabled; acceleration [-12, 0, -1001] milli-g, gyro [3, 0, 5] mrad/s. Single sample, not a drift/calibration test. |
| Barometer sanity | PASS | Healthy/enabled; 1011.5405 hPa, 38.59 C. No independent reference. |
| Compass | BLOCKED | Reported absent/disabled; zero magnetic sample. Verify whether fitted and configured. |
| GPS | BLOCKED | Reported absent; no fix or satellites. GPS-dependent acceptance requires fitted hardware. |
| Battery | BLOCKED | Battery disconnected; reported 3 mV. Reported 99% is not valid battery-health evidence. |
| Physical radio | BLOCKED | RC absent; firmware reports PreArm: RC not found. |
| Actuator reporting | PASS | Channels 1–4 report 1000 us, 5–8 zero; no physical actuation performed. |
| EKF integration | BLOCKED | Diagnostic flags 167 received; no timed admission/flight evidence. |

Serial buffering and pre-existing queued heartbeats prevent per-frame freshness,
rate or scheduling claims. USB CDC's selected baud is not proof of an external
UART wire rate. No listeners were found on checked UDP ports
14550/14551/14555/14560/9002; this is not a complete network inventory.

The passive capture SHA-256 is
`5e996d6bb607ac9af9754676e6ffcc37509d700ec02041c477c8f403bb914638`.
The query capture SHA-256 is
`b026643bd47943e57a276896db85d608d852ec266f6592547fd82ece20d48329`.
The raw firmware identity contains device identifiers; do not reuse captures
as generic fixtures or publish them beyond the authorized repository scope.

## Software baseline and next work

The focused seven-file MAVLink/Serial/HIL/lifecycle run passed 38/38 tests.
The complete initial run registered 464 tests: 420 passed, 27 failed and 17
pending, with three suite setup errors. Typecheck, lint and Vite production
build passed. The isolated thermal retry passed 4/4 after its full-run failure.
Initial sandbox runs failed before assertions with EPERM on temporary renames;
unrestricted reruns produced the recorded counts.

Failures include CRLF conversion (`core.autocrlf=true`) changing exact source
hashes and breaking LF-specific parsers, Windows path handling in release
inventory/dynamic imports/compiler-host tests, and a conflicting Rust 1.97.0
WASM target installation. Browser checks could not start their configured npm
server because npm was missing from PATH. Preserve the failed reports; fixes
require fresh evidence rather than rewriting those outcomes.

The repository now prescribes LF for source text and preserves the NASA
Docling archives as byte-exact binary attributes. The initial README and
ballistic hashes were independently checked against Git blobs: normalizing
only CRLF to LF reproduces the expected hashes. No fixture goldens or mirror
hashes were changed to hide checkout conversion.

TASK-038/048 telemetry development now has real USB hardware. TASK-043 and its
dependent UI gates still require production integration. TASK-050/051 remain
blocked: HIL is off, no verified board profile/build flags exist, and the
repository's pinned ArduPilot HIL message path is unsupported. A 60-second
200/400 Hz exchange and approved unplug test have not run. TASK-042/059/079
still need their pinned driver/firmware and real flight/EW/scenario traces.

Next local scope: TASK-002/003/014/017/073/080/082 portability and laptop
verification. Detect the actual browser GPU, run functional browser checks and
400/800/1200 Hz probes, and preserve FAIL separately from missing evidence.
RTX hardware availability does not complete TASK-073: its full-feature
production scene, visible 1080p profile, 60-second warmup, 10-minute capture
and memory budgets remain mandatory.
