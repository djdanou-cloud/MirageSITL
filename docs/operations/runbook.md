# Local validation and release runbook

Use the existing isolated checkout; preserve local changes. Node is pinned by .nvmrc; Rust 1.97.0 and wasm32-unknown-unknown by native/rust-toolchain.toml. Install npm dependencies with npm ci. In the cloud activate CARGO_HOME=/workspace/.cache/mirage-cargo, RUSTUP_HOME=/workspace/.cache/mirage-rustup and prepend CARGO_HOME/bin to PATH; do not repurpose HOME. Run lint, typecheck, check:docs, CI=true npm test, npm run build and locked native tests. Start npm run dev; verify HTTP, COOP same-origin, COEP require-corp and the actual Worker READY state. Start at zero throttle, arm, fly, pause and reset. Browser tests use system Chromium only when available. A clean restored-machine installation/startup has not yet been executed for release certification.

All new evidence commands are local. With no trace they write BLOCKED_EXTERNAL and exit 2; invalid evidence exits 1. They never deploy, tag or push. Inspect report reasons and preserve original captures plus exact byte hashes. Trace files are bounded to 32 MiB. CLI analyzers stamp sourceRevision and validatorSha256; retain inputSha256 and use matching code/report identities. Re-run evidence after relevant code/config changes.

```bash
node scripts/run-sitl.mjs
node scripts/probe-ardupilot-wasm.mjs
node scripts/bench-hitl.mjs --input /path/to/hitl-trace.json --sha256 <SHA256>
node scripts/report-ekf.mjs --input /path/to/ew-trace.json --sha256 <SHA256>
node scripts/bench-render.mjs --input /path/to/gpu-trace.json --sha256 <SHA256>
node scripts/validate-release.mjs --input /path/to/system-evidence.json --sha256 <SHA256>
node scripts/release-manifest.mjs --input /path/to/release-input.json --sha256 <SHA256>
node scripts/bench-terrain-scenarios.mjs 400
```

SITL requires MIRAGE_SITL_SOURCE at the pinned clean commit, MIRAGE_SITL_BINARY with MIRAGE_SITL_BINARY_SHA256, and an operator-owned MIRAGE_SITL_DRIVER with MIRAGE_SITL_DRIVER_SHA256. No secrets are required. The Node driver receives --binary and --parameters, owns firmware/bridge lifecycle and outputs only a JSON trace after cleanup. It must actually run the JSON backend, drive RC/commands and record original autopilot diagnostics; the demo does not supply this missing production driver. Native ELF and source checks reject absent/fake inputs; hashes establish declared identity but not reproducibility of a locally built binary. Retain build logs/toolchain evidence separately. The parent creates a private working directory, bounds stdout/stderr to 16 MiB, enforces 120 s and terminates its owned POSIX process group on failure. Windows descendant containment still requires a verified driver/job-object implementation; do not use global kill commands. Never delete shared source/build caches during cleanup.

A release input contains schemaVersion=1, artifacts [{path,sha256,license}], systemReportPath and systemReportSha256. Inventory is limited to 4096 files, 64 MiB/file and 512 MiB total from apps/web/dist, packages/wasm-bet/dist or test-results/validation. Traversal, symlink escape, duplicates, absent licenses and mismatched hashes are rejected. The output records actual file sizes/hashes, source revision/dirty state, npm lock hash, dataset registry hash and Node version. Complete dependency-license review, actual compiler versions and clean-machine/raw G0–G4 evidence are still prerequisites: inventory generation deliberately remains BLOCKED_EXTERNAL even for a supplied green summary. It cannot authorize publication.

For rollback restore an explicitly selected known release in a separate deployment workflow; never reset or clean the working checkout. Stop only processes/groups owned by the current run, close Serial through its UI, and terminate the Workers created by that session. Keep diagnostic captures when a gate fails. No deployment credentials, automatic rollback or target-hardware acceptance are assumed.

Accessibility checklist: keyboard Tab reaches the skip link and core actions; Enter operates the focused action; visible focus persists; typing in text/select controls suppresses instructor shortcuts; 390px layout has no horizontal overflow; denied Serial permission produces one announcement and focus returns without repeated prompts; importing AAR keeps the live flight. Automated axe and browser checks cover these software paths. A physical transmitter/FC, assistive-screen-reader session and live autopilot UI remain separate unrun checks.
