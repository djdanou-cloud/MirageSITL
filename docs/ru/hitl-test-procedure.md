# Стенд ArduPilot Simulation-on-Hardware и Hybrid SITL
<!-- source-sha256: 81bdd0ded606e3a64dcb8026594bc2f6e2ab4b7bf55cf207f9a43e819c7278d4 -->

Статус: предложение версии 2. Версия 1 не требует этот стенд. Цель — образ прошивки ArduPilot 4.6.3 или новее, собранный для Hybrid SITL и Simulation-on-Hardware, который можно загрузить на дрон и проверить там. Анализатор не открывает последовательный порт и не включает актуаторы. PX4 вне области. PASS не вызывает `AutopilotSession.connect("hitl")` и не включает браузерный READY. Виртуальный прогон JSON — прототип канала физики. Он не создаёт прошивку дрона.

Нижняя граница записанной прошивки — ArduPilot 4.6.3 и новее. Классические `HIL_SENSOR` / `HIL_GPS` / `HIL_ACTUATOR_CONTROLS` не являются этим стендом. Принимаются два режима:

1. **Hybrid SITL**, виртуальный этап, без дрона. JSON-бэкенд физики ArduPilot ([sitl-with-JSON](https://ardupilot.org/dev/docs/sitl-with-JSON.html)): UDP-порт 9002, magic `18458` для 16 каналов PWM или `29569` для 32. Для copter `SIM_RATE_HZ` не ниже 400. Для plane, rover и blimp не ниже 50. Частота должна делить 1000000 без остатка. `node --experimental-strip-types scripts/run-virtual-hitl.mjs` выполняет 60 с кадров copter на 400 Гц через `ExternalSitlLockstep` на этом компьютере. Источник происхождения — `virtual-sitl`, `execution` равен `virtual`, `droneConnected` равен false, а короткий git — закреплённый коммит протокола `8ab6afde`. Этот запуск не наблюдает версию автопилота.
2. **Simulation-on-Hardware**, записанный этап, дрон подключается позже. Прошивка собрана с `env SIM_ENABLED 1` ([sim-on-hardware](https://ardupilot.org/dev/docs/sim-on-hardware.html)), версия не ниже 4.6.3. Наблюдаемые параметры: `AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539 и `SIM_OH_MASK` в диапазоне 0..65535. Пропеллеры снимают до включения любого канала маски. Heartbeat от ArduPilot (`autopilot` 3) идёт всё окно, промежуток не больше 2.5 с. Плата с `AP_SIM_JSON_ENABLED 1` и `--simclass JSON` — это Hybrid SITL с размещением `board`, и пропеллеры всё равно должны быть сняты.

Записанные трассы используют `execution` `recorded`. Виртуальная трасса не может выбрать Simulation-on-Hardware.

1. Для виртуального этапа выполнить команду выше. COM-порт не открывать.
2. Для записанного этапа снять пропеллеры, закрепить аппарат и записать плату, версию прошивки, короткий git из 8 символов и `SIM_OH_MASK`. Нативный ELF SITL `fa37bf619bce116d410931f1b7d24ea72ed444ba529379df0db9738742ecb186` и браузерный WASM `556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38` не являются образами Simulation-on-Hardware.
3. Записать 60–3600 с. Версия схемы — 2. Происхождение — `{source, operator, recordedAt, firmwareSha256, modelSha256}`. `source` равен `virtual-sitl`, `native-sitl` или `hardware` по режиму. Остановка виртуального участника или отключение платы устанавливает `unplug.linkLost` и `unplug.actuatorsDisabled` в true в пределах 5 с после последней выборки.
4. Хешировать точные байты JSON и выполнить `node scripts/bench-hitl.mjs --input PATH --sha256 HEX`. Отчёт — `test-results/validation/hitl-report.json`. Отсутствующий вход даёт код 2. Некорректные данные или нарушенный предел дают код 1.

Юнит-тесты и виртуальный запуск не принимают полётный контроллер. Не запрашивать секреты и идентификаторы последовательных устройств в чате.
