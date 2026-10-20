# Свидетельства осуществимости ArduPilot
<!-- source-sha256: eb56457e9877a91babeb54d93da75eb9429f4b741f6d0548c2382cd4da7c558a -->

Английский источник: [Source of truth](../../native/ardupilot/feasibility.md).

`native/ardupilot/source.lock.json` закрепляет коммит ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` и пофайловые дайджесты SHA-256, совпадающие с оракулом JSON-протокола TASK-041; `native/ardupilot/toolchain.lock.json` закрепляет Emscripten `4.0.15`; `native/ardupilot/wasm-artifact.manifest.json` закрепляет локально собранный артефакт ArduCopter `--board wasm` (`arducopter.wasm` и `arducopter.js`, `local-only-pending-gpl-review`). Подробные наблюдения по возможностям и оставшаяся работа приведены в [ardupilot-wasm.md](ardupilot-wasm.md).

TASK-045 (DONE) собирает воспроизводимый WASM-артефакт из неизменённой штатной платы `wasm` и проверяет допуск и запуск в Node (`scripts/smoke-ardupilot-wasm.mjs`), а также запуск в изолированном выделенном Worker Chromium с pthread, чтение параметров MAVLink2 с проверкой CRC, восстановление атомарных 16 КиБ IndexedDB-снимков EEPROM при штатном и внезапном перезапуске и очистку собственных Worker (`test-results/validation/task-045-completion.json`). TASK-042, TASK-043 и TASK-059 (DONE) дают отдельные проверенные эталоны нативного полёта ArduCopter SITL, живого допуска прогрева EKF и РЭБ/отказов.

TASK-046 добавляет отдельную локальную HAL-сборку, атомарный mailbox и реальный поток прошивки/BET; актуальная приёмка описана в `scripts/build-ardupilot-hal.mjs`, `scripts/check-ardupilot-hal.mjs` и дорожной карте. Проверка только компилятора/исходников `probe-ardupilot-wasm` не исполняет эти шлюзы; ложные флаги означают отсутствие проверки этим инструментом. Производственный полёт не допущен до паритета TASK-047 и решения о распространении. Локальные проверки не включают READY браузерного автопилота.
