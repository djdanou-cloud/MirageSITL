# Native macOS SITL feasibility (TASK-127)

English source. [Russian mirror](../ru/macos-sitl.md).

Status: PASS on 2026-10-29. This records the native launch evidence
for D-02; it does not select a virtual machine/container or a release package.
The supported Phase 1 path is stock ArduCopter on Apple Silicon, a Node 24
owned-process driver, a pymavlink 2.4.50 sidecar and MirageSITL's Rust body WASM.
The aircraft is the existing synthetic quad X, not a measured aircraft model.

## Executable and ownership contract

The source must be clean at the commit in `scripts/sitl.lock.json`, including
initialized submodules at their pinned revisions. A source pin and the supplied
binary/driver SHA-256 are checked before launch. The binary must be a regular
file with execute permission. `scripts/sitl/native-binary.ts` accepts thin,
little-endian Mach-O64 `MH_EXECUTE` matching the macOS host, or matching ELF64
EXEC/PIE on Linux. It checks complete load/program-header tables, bounded file
segments, executable code and a Mach-O entry command. Magic-only files, shared
libraries, scripts, wrong architectures and truncated tables are rejected.
Universal/fat Mach-O and 32-bit binaries are outside this admission contract.

The parent starts a dedicated POSIX process group. Deadlines, output overflow
and driver exit terminate that group, including descendants whose pipes are
already closed; unrelated processes remain outside the group. Firmware and the
Python sidecar use private working directories and dedicated loopback ports.
A capture directory must be new; failed attempts are retained separately.
The driver records the host/format, hashes the executable and every source input,
and verifies unchanged source bytes at completion. Historical Linux captures
remain historical; the added host record does not invalidate their schema.

## Local stock build

Use a fresh checkout and external build/virtual-environment directories. No
firmware patch is applied, including the opt-in IMU-noise-floor patch. The
following is the checked local recipe; initial dependency acquisition needs
network access. No system Python packages or shell startup files are changed.

```bash
# Source is a fresh checkout at this exact commit.
git -C .cache/task-127/ardupilot rev-parse HEAD
# Expected: 8ab6afde107a91df1b5f60ade8f333cb8a61b190
git -C .cache/task-127/ardupilot submodule update --init --recursive --depth 1 modules/waf modules/mavlink modules/gtest modules/gsoap modules/littlefs modules/lwip modules/DroneCAN/DSDL modules/DroneCAN/libcanard modules/DroneCAN/dronecan_dsdlc modules/DroneCAN/pydronecan
python3 -m venv .cache/task-127/venv
.cache/task-127/venv/bin/python -m pip install pymavlink==2.4.50 empy==3.3.4 dronecan==1.0.27 pexpect==4.9.0 pyserial==3.5
cd .cache/task-127/ardupilot
../venv/bin/python waf configure --board sitl --out ../build-stock
../venv/bin/python waf --out ../build-stock copter -j 8
```

Return to the repository root for flight. The output is
`.cache/task-127/build-stock/sitl/bin/arducopter`. Preserve the configure/build
logs, full submodule identities, Python package freeze and binary SHA-256.
Use the [runbook](../operations/runbook.md) for
flight variables and audits, with a new capture directory and separate output
reports. `MIRAGE_SITL_IMU_NOISE_FLOOR=ardupilot` keeps the stock firmware terms.

## Acceptance and limits

Acceptance uses the existing 800 Hz JSON physics and 100 Hz scored trace:
real arm, at least 3 m takeoff, hover at 10 m ±1 m for at least 10 s, then
land below 0.5 m and disarm. Arming checks and EKF3 remain enabled. Every
accepted sample needs fresh healthy autopilot diagnostics. The parent retains
its 120 s wall deadline. The independent raw MAVLink audit and capture audit
must both pass, with no source/identity mismatch or unexplained frame gap.

This task does not establish the 16-motor path (TASK-128), synchronized pause
(TASK-129), launcher installation (TASK-151/152), measured model fidelity,
browser autopilot READY or real-time/GPU performance.

## Observed result — 2026-10-29

PASS on Apple M5, macOS 26.6 (25G72), Xcode command-line tools at
`/Library/Developer/CommandLineTools`, Apple Clang 21.0.0
(`clang-2100.1.1.101`), Node 24.22.1 and Python 3.9.6. Waf's stock configuration
and `copter -j 8` built the clean pinned source without a patch. The native
arm64 Mach-O binary is 5,364,104 bytes; SHA-256 `d47c1f64934f1911e4d6fb88da8aa18c21c9e438f3ae687b0e56eb13807e08e4`.
The toolchain/package/submodule identities and log hashes are in the local
`.cache/task-127/build-manifest.json`.

Initial attempts stopped on missing littlefs, DroneCAN compiler and lwIP
submodules; their logs are retained as `build-stock-attempt-001.log` through
`003.log`. After initializing the pinned dependencies, attempt `004.log`
passed in 84.348 s. Upstream's deprecated `-ld_classic` linker warning remains;
no warning policy, flight limit or firmware feature was changed to pass.

The final capture is `.cache/task-127/capture-002`, with its harness report,
`capture-002-audit.json` and `completion.json` beside it. It records:

* 67,257 physics frames at 800 Hz and 4,161 scored samples at 100 Hz;
* 84.07125 simulated seconds in 42.587271542 wall seconds;
* 10.2 s hold, truth altitude 9.763922418321018–9.989905957377403 m and
  autopilot altitude 9.753–9.989 m; final truth altitude 0 m, disarmed;
* 31,952 original observations matched by pymavlink 2.4.50 to CRC-checked
  MAVLink bytes; no CRC failures in the live admission parser;
* zero duplicate, gap, dropped, restart, stale, invalid or resend counters;
  6,224 PWM clamped values all occur during warmup and are independently
  counted from the captured packets;
* native READY first at 41.27 simulated seconds; stock ArduPilot IMU error
  terms retained, with no injected MirageSITL EW case;
* firmware ended with bounded SIGKILL escalation and Python exited 0;
  both owned PIDs were verified absent afterward.

Capture `001` also passed before the final ELF entry-point rejection fix; it
is a superseded snapshot and is not reused to verify the final source. The
new fixture first failed when an ELF shared object with entry 0 was admitted,
then passed after checking that the entry maps into an executable load segment.
The ownership regression first reproduced a TERM-resistant descendant surviving
closed pipes; it now passes and verifies an unrelated process remains alive.

Checks on final code: 20 tests in eight admission/ownership/flight/warmup files,
15 tests in three real-loopback JSON/bridge/state files, typecheck, web build,
checkout lint (excluding unrelated `.claude/worktrees/**`), bilingual docs and
`git diff --check` pass. The web build retains its existing chunk-size warning.
TASK-143 sensor files and the historical tracked `test-results/` are unchanged.
Raw captures, build products and local reports remain ignored; no firmware or
external source is added to the tracked repository.

## Re-verification — 2026-10-30

The uncommitted TASK-127 tree was flown again on baseline `78b4ee0` with the
same Mac, toolchain and binary, because earlier captures do not verify a later
tree. Capture `.cache/task-127/capture-004` passed with exit 0 from the harness,
`scripts/sitl/check-raw.py` (31,953 observations matched to CRC-checked bytes)
and `scripts/check-sitl-capture.mjs`, whose report is kept as
`capture-004-audit.json` beside the capture; the tracked historical TASK-042
report is unchanged. It records 67,257 physics frames, 4,161
scored samples and 84.07125 simulated seconds in 42.586 wall seconds; a 10.19 s
hold at truth altitude 9.786–9.987 m and autopilot altitude 9.757–9.989 m;
landing at 0 m and disarm; first native READY at 41.27 simulated seconds with
zero bad CRCs; and zero duplicate, gap, dropped, restart, stale, invalid or
resend counters. Firmware ended by bounded SIGKILL escalation and Python
exited 0. Ten focused admission/flight/MAVLink/bridge test files (50 tests),
typecheck, lint, web build and bilingual docs pass on the same tree.
