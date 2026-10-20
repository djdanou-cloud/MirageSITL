# Процедура комплексного тестирования и приёмки на Apple Silicon Mac M4

<!-- source-sha256: 1902500bea5e5493a42443e2f4d540233c75b383e996e270de9b3712da79a062 -->

Английский источник: [Source of truth](../hardware/mac-m4-final-test.md).

Дата: 2026-10-20 · Целевое оборудование: Apple Silicon M4 (macOS) · Объём: Полная валидация репозитория и закрытие [TASK-073](PROJECT_ROADMAP.md#task-073--gpu-acceptance-harness).

---

## 1. Обзор и цели

Настоящий документ определяет процедуру проверки MirageSITL на хост-системе Apple Silicon Mac M4. Он решает две задачи:
1. **Полномасштабная верификация:** Проверка каждого компонента на Apple Silicon ARM64, включая строгие контракты TypeScript, нативные ядра Rust с аварийным аллокатором WebAssembly, атомарные кольцевые буферы `SharedArrayBuffer` и высокочастотный шаг физики с использованием высокоточных таймеров POSIX.
2. **Закрытие `TASK-073`:** Выполнение 10-минутного (600 с) видимого полнофункционального захвата GPU (Metal WebGPU / WebGL2 при 1080p DPR 1 с включёнными terrain, FPV и thermal) после 60 с прогрева, вычисление его хэша SHA-256 и запуск `scripts/bench-render.mjs` для перевода `TASK-073` из `BLOCKED_EXTERNAL` в `DONE`.

---

## 2. Настройка аппаратного и системного окружения

### 2.1 Требования к оборудованию
- **Хост-устройство:** Apple Silicon M4 (MacBook Pro, Mac mini или iMac).
- **Подключение питания:** Обязательное подключение к сети переменного тока (AC) на протяжении всего тестирования во избежание троттлинга или энергосберегающего прореживания кадров.
- **Разрешение экрана:** Физический или внешний дисплей, настроенный на 1920×1080 при коэффициенте пикселей устройства (DPR) 1.0.

### 2.2 Необходимое ПО
Проверьте наличие инструментария в терминале:

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

### 2.3 Подготовка репозитория

```bash
git clone https://github.com/djdanou-cloud/MirageSITL.git
cd MirageSITL
git checkout main

# Frozen dependency install
npm ci
npx playwright install chromium
```

---

## 3. Этап 1 — Статический анализ и целостность документации

Проверка компиляции кодовой базы без ошибок и синхронизации всех 20 двуязычных пар документации:

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

## 4. Этап 2 — Проверка нативного Rust ARM64 и WebAssembly

Проверка корректной работы скалярных ядер лопастных элементов, арен C ABI и аварийных аллокаторов wasm32 на Apple Silicon ARM64:

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

## 5. Этап 3 — Набор юнит-тестов и бенчмарки физики реального времени

Проверка всех доменных юнит-тестов и запуск высокочастотных бенчмарков физики. Высокоточные таймеры POSIX macOS (`kqueue` / `mach_absolute_time`) подтверждают фактическую частоту шагов без просадок из-за кванта таймера Windows (~15.6 мс):

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

## 6. Этап 4 — Набор тестов браузера Playwright на GPU M4

Выполнение сквозных браузерных тестов с аппаратным ускорением Apple Silicon Metal:

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

## 7. Этап 5 — Выполнение TASK-073 (Приёмочный порог GPU M4)

### 7.1 Критерии приёмки (`scripts/bench-render.mjs`)
- **Устройство:** `M4`, **GPU:** `Apple M4`, **ОС:** `macOS`, **Источник:** `hardware`.
- **Бэкенд:** `webgpu` (или `webgl2`), **FPS:** `60` (или `120`).
- **Профиль:** 1920×1080 при DPR 1.0 в видимом, не перекрытом окне.
- **Активные компоненты:** `production = true`, `terrain = true`, `fpv = true`, `thermal = true`.
- **Длительность:** `warmupS >= 60`, `durationS >= 600` (10 минут).
- **Пороги:**
  - $p99 \le 16.67\text{ ms}$ (60 FPS) или $\le 8.33\text{ ms}$ (120 FPS).
  - Резидентность GPU $\le 2\text{ GiB}$ ($2,147,483,648\text{ B}$).
  - Кэш CPU $\le 512\text{ MiB}$ ($536,870,912\text{ B}$).

### 7.2 Процедура захвата

1. **Запуск сервера предварительного просмотра:**
   ```bash
   npm run build
   npx vite preview apps/web --host 127.0.0.1 --port 5174 --strictPort &
   ```

2. **Выполнение 11-минутного видимого захвата:**
   ```bash
   mkdir -p test-results/m4
   node scripts/probe-laptop.mjs \
     --backend webgpu \
     --warmup 60 \
     --seconds 600 \
     --out test-results/m4
   ```
   *Примечание: Держите окно браузера видимым на экране в течение 10 минут, чтобы macOS не замедляла `requestAnimationFrame`.*

3. **Формирование файла с данными (`test-results/m4/gpu-m4-webgpu-60.json`):**
   Убедитесь, что результирующий JSON содержит требуемые поля:
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

4. **Запуск приёмочного валидатора:**
   ```bash
   M4_SHA256=$(shasum -a 256 test-results/m4/gpu-m4-webgpu-60.json | awk '{print $1}')
   node scripts/bench-render.mjs --input test-results/m4/gpu-m4-webgpu-60.json --sha256 $M4_SHA256
   ```

5. **Проверка вердикта PASS в артефакте валидации:**
   Проверьте файл `test-results/validation/gpu-report.json`:
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

## 8. Этап 6 — Финализация ворот релиза и дорожной карты

После получения статуса `PASS` в `gpu-report.json`:

```bash
# 1. Run release validator across all gates (verifies G3-gpu PASS)
node scripts/validate-release.mjs demo

# 2. Synchronize bilingual documentation
node scripts/check-docs.mjs
```

При обновлении [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md) и [docs/PROJECT_ROADMAP.md](../PROJECT_ROADMAP.md):
- Измените статус `TASK-073` на `DONE — Apple M4 10-minute full-feature trace certified on macOS (Metal WebGPU).`
- Зафиксируйте базовый коммит, время кадра p99, метрики памяти и хэш SHA-256 файла измерений.
