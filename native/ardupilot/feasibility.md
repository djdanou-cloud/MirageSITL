# ArduPilot feasibility evidence

The source lock records observed SHA-256 bytes at the official commit, not an executable firmware digest. No native binary or WASM firmware has been built in this iteration. The JSON protocol pin remains unchanged. Run the reproducible probe from repository root; use the source lock URLs to retrieve exact upstream files with TLS and compare hashes before analysis. Detailed capability observations and required implementation are in docs/decisions/ardupilot-wasm.md.

This gate admits no runtime mode. A future positive decision requires a real HAL/scheduler/storage/network port, license review, compiler/artifact identity and successful native parity, followed by TASK-045–047. Node runtime availability and software unit tests alone are insufficient.


TASK-045 continuation (2026-10-19) supersedes the original TASK-044 no-build observations above: the unchanged upstream wasm board has a reproducible local artifact and verified real Chromium Worker/pthread boot, serial parameter readbacks, persistent EEPROM recovery and shutdown. TASK-042/059 provide separate real native flight/fault references. TASK-046 still owns MirageSITL browser HAL/physics/time coupling, TASK-047 owns flight parity, and artifact redistribution retains its decision gate. No browser flight mode is enabled by this local bootstrap evidence.
