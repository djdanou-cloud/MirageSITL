# ArduPilot browser feasibility decision

Decision: BLOCKED_EXTERNAL for firmware execution; TASK-044 research gate is implemented. TASK-045–047 remain open. A Node WebAssembly runtime is not an ArduPilot browser port. Firmware commit 8ab6afde107a91df1b5f60ade8f333cb8a61b190 matches TASK-041's JSON oracle. Source paths, HTTPS links, actual byte hashes and lengths are pinned in native/ardupilot/source.lock.json. The four official source files were downloaded and inspected on 2026-10-17.

| Capability | Observed evidence | Required work |
| --- | --- | --- |
| Scheduler | AP_HAL_SITL/Scheduler.cpp uses pthread_self and native thread/semaphore behavior | Implement cooperative lockstep clock, bounded thread/interrupt semantics and shutdown |
| UART/network | AP_HAL_SITL/UARTDriver.cpp uses native networking/UART endpoints | Replace native sockets with bounded Worker mailboxes and I/O bridge |
| Storage | AP_HAL_SITL/Storage.cpp uses open/pread/pwrite and flash files | Provide virtual persistent storage, atomic initialization and recovery |
| Compiler | Pinned emsdk 4.0.15 installed outside the repository (2026-10-17); the probe detects it, including Windows .bat wrappers | Provide a POSIX build host and ArduPilot's Python build packages, then compile actual firmware (TASK-045) |
| Browser memory | Probe records runtime WebAssembly/SAB availability only | Verify fixed memory, module exports, scheduler and allocator under load |
| Licensing | COPYING.txt is pinned; GPL source was inspected | Review complete firmware/dependency license obligations and corresponding-source distribution |
| Parity | No native flight driver/trace or WASM artifact is available | Native/WASM arm/takeoff/land/failsafe and 30 s trajectory parity |

Run node scripts/probe-ardupilot-wasm.mjs. It writes test-results/validation/ardupilot-wasm-feasibility.json and exits 2 while the port is absent. An optional MIRAGE_ARDUPILOT_SOURCE directory is checked against per-file source hashes; MIRAGE_EMCC selects an explicit compiler. Neither a found compiler nor matching source files changes unimplemented capabilities to true. No loader, HAL stub or empty firmware module is supplied.
