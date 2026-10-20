# ArduPilot browser feasibility decision

English source. [Russian mirror](../ru/ardupilot-wasm.md).

Decision (TASK-044/045/046): upstream ArduCopter builds and boots in Node and an
isolated Chromium Worker with Emscripten pthreads and persistent IndexedDB EEPROM
(TASK-045). TASK-046 adds a separate local HAL-enabled build, versioned atomic
sensor/PWM mailbox and simulation-time coupling. Current acceptance results are
in the roadmap. Native/WASM full flight parity (TASK-047) and GPL-3.0-or-later
artifact redistribution (`BLOCKED_DECISION`) remain open; neither a compiler
probe nor successful boot enables browser autopilot READY.

The base commit is `8ab6afde107a91df1b5f60ade8f333cb8a61b190`, matching TASK-041's
JSON oracle. The upstream board is `libraries/AP_HAL_SITL/hwdef/wasm`, with
`HAL_SITL_WASM_ENABLED`, `PROXY_TO_PTHREAD` and an exported serial byte bridge.
`native/ardupilot/source.lock.json` pins source bytes;
`native/ardupilot/toolchain.lock.json` pins SDK/compiler/submodules;
`native/ardupilot/wasm-artifact.manifest.json` pins unchanged TASK-045 bytes.
TASK-046's patch, build inputs and distinct artifact hashes are recorded in
`.cache/task-046/build-identity.json`, separately from the original manifest.

| Capability | Implemented evidence boundary | Remaining work |
| --- | --- | --- |
| Scheduler | TASK-045 pthread boot; TASK-046 mailbox permits one physics step per firmware request and retains a paused clock. WASM uses expected-value futex wait/wake; native probes use a condition variable. | Closed-loop native/WASM flight parity and production mode admission (TASK-047). |
| UART/network | `--serial0 wasm` exports `ardupilot_serial_write/read/read_available`; TCP serial ports are `none`, networking and UDP RC disabled. CRC-valid MAVLink heartbeat/parameter checks are separate from the sensor/PWM mailbox. | Admit full browser flight and its UI routing after TASK-047. |
| Storage | Atomic 16 KiB IndexedDB EEPROM, identity-bound profiles and `WP_SPD` persistence across graceful/abrupt TASK-045 restarts. HAL sessions reuse the same storage and expose explicit checkpoint/disposal. | Flight parameter/checkpoint scenarios belong to TASK-047; no implicit final save is promised by HAL disposal. |
| Compiler | emsdk 4.0.15 on WSL Ubuntu; original byte-identical TASK-045 WASM `556d97fa...` and glue `b158a7b8...` remain distinct from HAL-patched outputs. | Upstream CI uses Emscripten 6.0.8; changing this project's pin is a separate decision. |
| Browser memory | Admission checks shared memory limits: 256 initial / 32768 maximum pages (16 MiB / 2 GiB). HAL binding rejects memory replacement; isolated kernel allocation probes do not certify all firmware allocations. | Sustained full-flight memory/allocator and target-device timing qualification remain separate. |
| Licensing | `GPL-3.0-or-later`; firmware remains `local-only-pending-gpl-review`, outside repository/public/dist outputs. | Review firmware/dependency redistribution obligations (`BLOCKED_DECISION`). |
| Parity | Native flight/EKF/EW references (TASK-042/043/059) and real browser HAL exchange/disarmed NACA6409 dataflow are distinct evidence. | Native/WASM arm/takeoff/land/failsafe and 30 s trajectory comparison (TASK-047). |

`node scripts/probe-ardupilot-wasm.mjs` remains a compiler/source capability
probe. Its false execution flags mean not verified by that probe; they do not
claim boot/storage/HAL is unimplemented. It exits 2 without certifying flight.
`MIRAGE_ARDUPILOT_SOURCE` selects source paths and `MIRAGE_EMCC` selects a compiler.
Use `node scripts/build-ardupilot-wasm.mjs`,
`node scripts/smoke-ardupilot-wasm.mjs DIR` and
`tests/browser/ardupilot-wasm.spec.ts` for original build/boot/storage evidence.
Use `node scripts/build-ardupilot-hal.mjs`,
`node scripts/check-ardupilot-hal.mjs` and
`tests/browser/wasm-hal.spec.ts` for the separate HAL build/kernel/full-firmware
checks. `MIRAGE_HAL_ARTIFACT_DIR` explicitly selects the local HAL browser input.
Preserve source/artifact/report hashes and keep measured aerodynamics, estimator
readiness, full firmware allocator qualification and flight parity distinct.
