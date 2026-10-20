# Решение об осуществимости ArduPilot в браузере
<!-- source-sha256: 3c32928cb90a1ed006caf7e452b6982877896f982c929ca434fab6a9adbe7a7c -->

Английский источник: [Source of truth](../decisions/ardupilot-wasm.md).

Решение (TASK-044/045/046): upstream ArduCopter собирается и запускается в Node и
изолированном Chromium Worker с Emscripten pthread и постоянным EEPROM IndexedDB
(TASK-045). TASK-046 добавляет отдельную локальную HAL-сборку, версионированный
атомарный mailbox датчиков/PWM и сопряжение времени симуляции. Текущие результаты
приёмки находятся в дорожной карте. Полный native/WASM паритет полёта (TASK-047)
и распространение артефактов GPL-3.0-or-later (`BLOCKED_DECISION`) остаются
открытыми; проверка компилятора и успешный запуск не включают READY.

Базовый коммит `8ab6afde107a91df1b5f60ade8f333cb8a61b190` совпадает с JSON-эталоном
TASK-041. Upstream-плата `libraries/AP_HAL_SITL/hwdef/wasm` использует
`HAL_SITL_WASM_ENABLED`, `PROXY_TO_PTHREAD` и экспортированный serial-мост.
`native/ardupilot/source.lock.json` закрепляет байты исходников;
`native/ardupilot/toolchain.lock.json` закрепляет SDK/компилятор/субмодули;
`native/ardupilot/wasm-artifact.manifest.json` — неизменные байты TASK-045.
Патч TASK-046, входы сборки и отдельные хеши артефактов находятся в
`.cache/task-046/build-identity.json` отдельно от исходного манифеста.

| Возможность | Граница реализованных доказательств | Оставшаяся работа |
| --- | --- | --- |
| Планировщик | Запуск pthread TASK-045; mailbox TASK-046 допускает один шаг физики на запрос прошивки и сохраняет остановленное время. WASM использует futex wait/wake с ожидаемым значением, native-проверки — условную переменную. | Замкнутый native/WASM паритет полёта и допуск производственного режима (TASK-047). |
| UART/network | `--serial0 wasm` экспортирует `ardupilot_serial_write/read/read_available`; TCP serial-порты `none`, networking и UDP RC отключены. MAVLink heartbeat/параметры с верным CRC проверяются отдельно от mailbox датчиков/PWM. | Допуск полного браузерного полёта и маршрутизации UI после TASK-047. |
| Хранилище | Атомарный EEPROM 16 KiB IndexedDB, профили с привязкой идентичности и сохранение `WP_SPD` при штатных/аварийных перезапусках TASK-045. HAL повторно использует хранилище и предоставляет явные checkpoint/disposal. | Полётные сценарии параметров/checkpoint относятся к TASK-047; HAL disposal не обещает неявного финального сохранения. |
| Компилятор | emsdk 4.0.15 в WSL Ubuntu; исходные побайтово одинаковые WASM TASK-045 `556d97fa...` и glue `b158a7b8...` отделены от HAL-патча. | Upstream CI использует Emscripten 6.0.8; смена закреплённой версии проекта — отдельное решение. |
| Память браузера | Допуск проверяет разделяемую память: 256 начальных / 32768 максимальных страниц (16 MiB / 2 GiB). HAL отклоняет замену памяти; изолированные проверки аллокатора ядра не сертифицируют все аллокации прошивки. | Продолжительный полный полёт, аллокатор и время на целевом устройстве требуют отдельной квалификации. |
| Лицензирование | `GPL-3.0-or-later`; прошивка остаётся `local-only-pending-gpl-review` вне репозитория/public/dist. | Проверить обязательства распространения прошивки/зависимостей (`BLOCKED_DECISION`). |
| Паритет | Нативные эталоны полёта/EKF/РЭБ (TASK-042/043/059) отделены от реального браузерного обмена HAL и разоружённого потока NACA6409. | Native/WASM arm/takeoff/land/failsafe и сравнение траекторий 30 с (TASK-047). |

`node scripts/probe-ardupilot-wasm.mjs` остаётся проверкой компилятора/исходников.
Его ложные флаги исполнения означают отсутствие проверки этим инструментом,
а не отсутствие реализации boot/storage/HAL. Код 2 не сертифицирует полёт.
`MIRAGE_ARDUPILOT_SOURCE` задаёт исходники, `MIRAGE_EMCC` — компилятор.
Исходные доказательства сборки/запуска/хранилища дают
`node scripts/build-ardupilot-wasm.mjs`,
`node scripts/smoke-ardupilot-wasm.mjs DIR` и
`tests/browser/ardupilot-wasm.spec.ts`.
Отдельные проверки сборки HAL/ядра/полной прошивки:
`node scripts/build-ardupilot-hal.mjs`,
`node scripts/check-ardupilot-hal.mjs` и `tests/browser/wasm-hal.spec.ts`.
`MIRAGE_HAL_ARTIFACT_DIR` явно выбирает локальную HAL-прошивку браузерного теста.
Сохраняйте хеши исходников/артефактов/отчётов и отделяйте измеренную аэродинамику,
готовность оценивателя, аллокатор всей прошивки и паритет полёта.
