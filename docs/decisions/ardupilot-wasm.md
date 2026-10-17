# ArduPilot browser feasibility decision

Decision (revised 2026-10-17 by TASK-045): firmware builds and runs as WebAssembly, but MirageSITL browser integration remains open. The TASK-044 research gate inspected four HAL files and missed that ArduPilot at the pinned commit 8ab6afde107a91df1b5f60ade8f333cb8a61b190 already ships an upstream `wasm` board (`libraries/AP_HAL_SITL/hwdef/wasm`, `HAL_SITL_WASM_ENABLED`, Emscripten toolchain, pthreads via `PROXY_TO_PTHREAD`, and an exported serial byte bridge). Upstream CI builds that board and runs a Node MAVLink smoke test. The commit matches TASK-041's JSON oracle, and source paths and hashes are pinned in native/ardupilot/source.lock.json.

| Capability | Observed evidence | Required work |
| --- | --- | --- |
| Scheduler | Upstream wasm board runs SITL threads as Emscripten pthreads (shared memory, Worker pool of 4) | Lockstep with MirageSITL simulation time and bounded shutdown when hosted in the app (TASK-046) |
| UART/network | `--serial0 wasm` routes a serial port through exported `ardupilot_serial_write/read/read_available`; networking and UDP RC are disabled; TCP serial ports must be set to `none` | Connect the bridge to the MirageSITL MAVLink/Worker mailboxes (TASK-046) |
| Storage | Emscripten file system; first boot erases and initializes virtual EEPROM in memory | Persistent parameter storage, atomic initialization and recovery across Worker restarts |
| Compiler | Pinned emsdk 4.0.15 builds ArduCopter for `--board wasm` on a WSL Ubuntu host; three clean builds are byte-identical | Upstream CI uses Emscripten 6.0.8; changing the project pin is a separate decision |
| Browser memory | Shared memory imported with 256 initial and 32768 maximum pages (16 MiB to 2 GiB, growth allowed); admission checks the limits against a budget | Verify the artifact in a browser Worker under COOP/COEP and measure memory under load |
| Licensing | GPL-3.0-or-later; artifacts are kept outside the repository (`local-only-pending-gpl-review`) | Review firmware/dependency obligations before distributing the artifact (BLOCKED_DECISION) |
| Parity | Native ArduCopter SITL ELF and WASM artifact now build from the same source; no flight driver or trace comparison yet | Native/WASM arm/takeoff/land/failsafe and 30 s trajectory parity (TASK-047) |

Run node scripts/probe-ardupilot-wasm.mjs for the capability record (exit 2 while browser integration is absent), node scripts/build-ardupilot-wasm.mjs to build the artifact and its manifest, and node scripts/smoke-ardupilot-wasm.mjs DIR to admit and boot it. MIRAGE_ARDUPILOT_SOURCE is checked against per-file source hashes, and MIRAGE_EMCC selects an explicit compiler. A Node boot shows that the firmware runs; it is not browser, physics-coupling or flight evidence.
