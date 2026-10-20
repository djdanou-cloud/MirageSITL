# Apple Silicon Mac M4 Acceptance & Comprehensive Test Procedure

English source of truth. [Russian mirror](../ru/mac-m4-final-test.md).

Date: 2026-10-20 · Target Hardware: Apple Silicon M4 (macOS) · Scope: Full repository validation and [TASK-073](../PROJECT_ROADMAP.md#task-073--gpu-acceptance-harness) resolution.

---

## 1. Overview & Objectives

This document specifies the verification procedure for MirageSITL on an Apple Silicon Mac M4 host. It serves two purposes:
1. **Full-Spectrum Verification:** Exercise every component on Apple Silicon ARM64, including strict TypeScript contracts, native Rust kernels with trapping WebAssembly allocators, atomic `SharedArrayBuffer` ring buffers, and high-rate physics stepping using POSIX high-resolution timers.
2. **`TASK-073` Resolution:** Execute the 10-minute (600 s) visible full-feature GPU trace (Metal WebGPU / WebGL2 at 1080p DPR 1 with terrain, FPV, and thermal enabled) after 60 s warmup, compute its SHA-256 hash, and execute `scripts/bench-render.mjs` to advance `TASK-073` from `BLOCKED_EXTERNAL` to `DONE`.

---

## 2. Hardware & Host Environment Setup

### 2.1 Hardware Requirements
- **Host Device:** Apple Silicon M4 (MacBook Pro, Mac mini, or iMac).
- **Power Connection:** Connected to AC power (mains) throughout testing to avoid battery-saver throttling or frame decimation.
- **Display Resolution:** Physical or external display set to 1920×1080 at Device Pixel Ratio (DPR) 1.0.

### 2.2 Software Prerequisites
Verify toolchains in Terminal:

```bash
# 1. Xcode command-line tools
xcode-select --install

# 2. Node.js 24 LTS (matching repository .nvmrc)
nvm install 24
nvm use 24
node --version # Must report v24.x.x

# 3. Pinned Rust Toolchain (matching native/rust-toolchain.toml)
rustup default 1.97.0
rustup target add wasm32-unknown-unknown

# 4. Google Chrome or Chromium for macOS with native Metal WebGPU support
```

### 2.3 Workspace Setup

```bash
git clone https://github.com/djdanou-cloud/MirageSITL.git
cd MirageSITL
git checkout main

# Frozen dependency install
npm ci
npx playwright install chromium
```

---

## 3. Stage 1 — Static Analysis & Documentation Integrity

Verify that the codebase compiles with zero errors and that all 20 bilingual documentation pairs remain synchronized:

```bash
# 1. Bilingual documentation hash, link, and layout integrity
node scripts/check-docs.mjs

# 2. Strict TypeScript typechecking across all 12 packages and web app
npm run typecheck

# 3. ESLint with zero-warning enforcement
npm run lint

# 4. Vite production bundle compilation
npm run build

# 5. Git whitespace and format check
git diff --check
```

---

## 4. Stage 2 — Native Rust ARM64 & WebAssembly Verification

Verify that scalar blade-element kernels, C ABI arenas, and wasm32 trapping allocators run cleanly on Apple Silicon ARM64:

```bash
# 1. Native ARM64 cargo checks
cargo check --manifest-path native/Cargo.toml --workspace --locked

# 2. Run all 62 native Rust tests
cargo test --manifest-path native/Cargo.toml --workspace --locked

# 3. Verify 1,000,000-step zero-allocation gate in Rust
cargo test --manifest-path native/Cargo.toml --test allocation --locked

# 4. Check wasm32 compilation with trapping allocator
cargo check --manifest-path native/Cargo.toml -p mirage-bet --target wasm32-unknown-unknown --locked

# 5. Build production scalar and simd128 WASM artifacts with SHA-256 manifests
node scripts/build-wasm.mjs

# 6. Verify native Rapier contact C ABI binding
node scripts/build-contact.mjs --native --test-native
```

---

## 5. Stage 3 — Unit Test Suite & Real-Time Physics Benchmarks

Verify all domain unit tests and run high-rate physics benchmarks. macOS POSIX high-resolution timers (`kqueue` / `mach_absolute_time`) verify delivered step rates without Windows timer quantum (~15.6 ms) rate drops:

```bash
# 1. Full Vitest unit test suite
npm test

# 2. Benchmark fixed-step physics loop at 400, 800, and 1200 Hz
node scripts/bench-physics.mjs

# 3. Wind and atmospheric turbulence benchmarks
node scripts/bench-wind.mjs

# 4. 4,000,000-tick sensor pipeline allocation benchmark
node scripts/bench-sensors.mjs all

# 5. Electronic warfare and radio links benchmarks (400, 800, 1200 Hz)
node scripts/bench-links-ew.mjs all 400
node scripts/bench-links-ew.mjs all 800
node scripts/bench-links-ew.mjs all 1200

# 6. AAR (After-Action Review) 10 Hz recording queue benchmark
node scripts/bench-aar.mjs 400
node scripts/bench-aar.mjs 800
node scripts/bench-aar.mjs 1200

# 7. Terrain scenario and collision chunk benchmark
node scripts/bench-terrain-scenarios.mjs 400
node scripts/bench-terrain-scenarios.mjs 800
node scripts/bench-terrain-scenarios.mjs 1200
```

---

## 6. Stage 4 — Playwright Browser Test Suite on M4 GPU

Execute the end-to-end browser suites using Apple Silicon Metal acceleration:

```bash
# 1. Standard browser test suite
npm run test:browser

# 2. Hardware-accelerated browser checks using Apple Silicon Metal backend
MIRAGE_BROWSER_GPU="hardware" npx playwright test tests/browser/render-backends.spec.ts

# 3. Fisheye lens shader vs CPU oracle
npx playwright test tests/browser/fpv.spec.ts

# 4. Thermal LWIR shader radiometry checks
npx playwright test tests/browser/thermal.spec.ts

# 5. Accessibility audit (axe-core WCAG 2.1 AA)
npx playwright test tests/browser/accessibility.spec.ts
```

---

## 7. Stage 5 — Executing TASK-073 (M4 GPU Acceptance Gate)

### 7.1 Acceptance Criteria (`scripts/bench-render.mjs`)
- **Device:** `M4`, **GPU:** `Apple M4`, **OS:** `macOS`, **Source:** `hardware`.
- **Backend:** `webgpu` (or `webgl2`), **FPS:** `60` (or `120`).
- **Profile:** 1920×1080 at DPR 1.0 in a visible, un-occluded window.
- **Features Active:** `production = true`, `terrain = true`, `fpv = true`, `thermal = true`.
- **Duration:** `warmupS >= 60`, `durationS >= 600` (10 minutes).
- **Thresholds:**
  - $p99 \le 16.67\text{ ms}$ (60 FPS) or $\le 8.33\text{ ms}$ (120 FPS).
  - GPU residency $\le 2\text{ GiB}$ ($2,147,483,648\text{ B}$).
  - CPU cache $\le 512\text{ MiB}$ ($536,870,912\text{ B}$).

### 7.2 Capture Procedure

1. **Start Production Preview Server:**
   ```bash
   npm run build
   npx vite preview apps/web --host 127.0.0.1 --port 5174 --strictPort &
   ```

2. **Execute 11-Minute Visible Capture:**
   ```bash
   mkdir -p test-results/m4
   node scripts/probe-laptop.mjs \
     --backend webgpu \
     --warmup 60 \
     --seconds 600 \
     --out test-results/m4
   ```
   *Note: Keep the browser window visible on screen during the 10-minute capture so macOS does not throttle `requestAnimationFrame`.*

3. **Format Evidence Payload (`test-results/m4/gpu-m4-webgpu-60.json`):**
   Ensure the output JSON includes the required fields:
   ```json
   {
     "schemaVersion": 1,
     "source": "hardware",
     "device": "M4",
     "gpu": "Apple M4",
     "os": "macOS",
     "browser": "Chrome 130",
     "powerMode": "AC",
     "backend": "webgpu",
     "fps": 60,
     "width": 1920,
     "height": 1080,
     "dpr": 1,
     "warmupS": 60,
     "durationS": 600,
     "visible": true,
     "production": true,
     "terrain": true,
     "fpv": true,
     "thermal": true,
     "frameMs": [ ...600 seconds of measured rAF intervals... ],
     "gpuBytes": 1048576000,
     "cpuBytes": 314572800
   }
   ```

4. **Run Acceptance Validator:**
   ```bash
   M4_SHA256=$(shasum -a 256 test-results/m4/gpu-m4-webgpu-60.json | awk '{print $1}')
   node scripts/bench-render.mjs --input test-results/m4/gpu-m4-webgpu-60.json --sha256 $M4_SHA256
   ```

5. **Verify PASS in Validation Artifact:**
   Check `test-results/validation/gpu-report.json`:
   ```json
   {
     "schemaVersion": 1,
     "kind": "gpu-report",
     "status": "PASS",
     "reasons": [],
     "metrics": {
       "p99FrameMs": 14.2,
       "p50FrameMs": 16.6,
       "measuredFrames": 36000
     }
   }
   ```

---

## 8. Stage 6 — Release Gate & Roadmap Finalization

After `gpu-report.json` passes:

```bash
# 1. Run release validator across all gates (verifies G3-gpu PASS)
node scripts/validate-release.mjs demo

# 2. Synchronize bilingual documentation
node scripts/check-docs.mjs
```

When updating [`PROJECT_ROADMAP.md`](../PROJECT_ROADMAP.md) and [`docs/ru/PROJECT_ROADMAP.md`](../ru/PROJECT_ROADMAP.md):
- Set `TASK-073` status to `DONE — Apple M4 10-minute full-feature trace certified on macOS (Metal WebGPU).`
- Record the baseline commit, p99 frame time, memory metrics, and SHA-256 of the capture artifact.
