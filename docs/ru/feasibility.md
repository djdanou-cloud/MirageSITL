# Свидетельства осуществимости ArduPilot
<!-- source-sha256: fc0a765ad33fce977837967844f546050aa6f6dc96e238f8e084099bbc165970 -->

Английский источник: [Source of truth](../../native/ardupilot/feasibility.md).

`native/ardupilot/source.lock.json` закрепляет коммит ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` и пофайловые дайджесты SHA-256, совпадающие с оракулом JSON-протокола TASK-041; `native/ardupilot/toolchain.lock.json` закрепляет Emscripten `4.0.15`; `native/ardupilot/wasm-artifact.manifest.json` закрепляет локально собранный артефакт ArduCopter `--board wasm` (`arducopter.wasm` и `arducopter.js`, `local-only-pending-gpl-review`). Подробные наблюдения по возможностям и оставшаяся работа приведены в [ardupilot-wasm.md](ardupilot-wasm.md).

TASK-045 (DONE) собирает воспроизводимый WASM-артефакт из неизменённой штатной платы `wasm` и проверяет допуск и запуск в Node (`scripts/smoke-ardupilot-wasm.mjs`), а также запуск в изолированном выделенном Worker Chromium с pthread, чтение параметров MAVLink2 с проверкой CRC, восстановление атомарных 16 КиБ IndexedDB-снимков EEPROM при штатном и внезапном перезапуске и очистку собственных Worker (`test-results/validation/task-045-completion.json`). TASK-042, TASK-043 и TASK-059 (DONE) дают отдельные проверенные эталоны нативного полёта ArduCopter SITL, живого допуска прогрева EKF и РЭБ/отказов.

`node scripts/probe-ardupilot-wasm.mjs` по-прежнему завершается с `BLOCKED_EXTERNAL` (код 2) для рабочего браузерного режима полёта: сопряжение браузерного HAL/планировщика/физики/mailbox MirageSITL (TASK-046), паритет замкнутого полёта между нативной и WASM-сборками (TASK-047) и проверка условий распространения под GPL-3.0-or-later (`BLOCKED_DECISION`) остаются открытыми. Локальный диагностический запуск не включает браузерный режим автопилота READY.
