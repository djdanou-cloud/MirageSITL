# ArduPilot feasibility evidence

English source. [Russian mirror](../../docs/ru/feasibility.md).

`native/ardupilot/source.lock.json` pins upstream ArduPilot commit `8ab6afde107a91df1b5f60ade8f333cb8a61b190` and per-file SHA-256 digests matching the TASK-041 JSON protocol oracle; `native/ardupilot/toolchain.lock.json` pins Emscripten `4.0.15`; `native/ardupilot/wasm-artifact.manifest.json` pins the locally built `--board wasm` ArduCopter artifact (`arducopter.wasm` and `arducopter.js`, `local-only-pending-gpl-review`). Detailed capability observations and remaining work are in [docs/decisions/ardupilot-wasm.md](../../docs/decisions/ardupilot-wasm.md).

TASK-045 (DONE) builds a reproducible WASM artifact from the unchanged upstream `wasm` board and verifies Node admission/boot (`scripts/smoke-ardupilot-wasm.mjs`) plus isolated Chromium dedicated-Worker/pthread boot, CRC-valid MAVLink2 parameter readbacks, atomic 16 KiB IndexedDB EEPROM checkpoint recovery across graceful/abrupt restarts, and owned Worker cleanup (`test-results/validation/task-045-completion.json`). TASK-042, TASK-043 and TASK-059 (DONE) provide separate verified native ArduCopter SITL flight, live EKF warmup admission and EW/fault references.

`node scripts/probe-ardupilot-wasm.mjs` still exits `BLOCKED_EXTERNAL` (exit 2) for production browser flight mode: MirageSITL browser HAL/scheduler/physics/mailbox coupling (TASK-046), native-vs-WASM closed-loop flight parity (TASK-047) and the GPL-3.0-or-later redistribution review (`BLOCKED_DECISION`) remain open. Local diagnostic bootstrap does not enable browser autopilot READY.
