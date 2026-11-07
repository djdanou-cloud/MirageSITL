# Матрица возможностей прошивок для HITL

<!-- source-sha256: 5c9ba8eb5d162b12ec0fb6b17af3c1fa165c98a074eef102dd141e8eaa0b97b2 -->

Английский источник: [Source of truth](../hardware/hitl-matrix.md).

Статус: BLOCKED_EXTERNAL. Ни один профиль платы не проверен на оборудовании.
`evaluateHitlCapability` (`packages/autopilot/src/hitl-capabilities.ts`) —
единственный источник вердикта READY, а `AutopilotSession.connect("hitl")`
отклоняет всё остальное. Доступность SITL не доказывает поддержку HITL.

## Проверка

HITL получает READY, только когда выполнено всё перечисленное:

1. Анализ исходников на закреплённом коммите показывает, что стек принимает
   HIL_SENSOR и HIL_GPS и отправляет HIL_ACTUATOR_CONTROLS.
2. Профиль платы фиксирует плату, стек/версию/git SHA прошивки, флаги сборки,
   дату проверки, оператора и SHA-256 пакета доказательств.
3. Подключённый автопилот сообщает git SHA профиля (AUTOPILOT_VERSION),
   выставляет MAV_MODE_FLAG_HIL_ENABLED (32) в base_mode HEARTBEAT и отправил
   HIL_ACTUATOR_CONTROLS в течение последних 100 мс.

Отсутствие доказательств даёт BLOCKED_EXTERNAL с точным требованием; стек, в
исходниках которого нет пути для сообщения, получает UNSUPPORTED.

## Доказательства по исходникам прошивок

| Стек | Закреплённый коммит | Вход HIL_SENSOR | Вход HIL_GPS | Выход HIL_ACTUATOR_CONTROLS | Вердикт |
| --- | --- | --- | --- | --- | --- |
| ArduPilot | fb773567896014da007bca58358704d4a0d8516f | нет | нет | нет | UNSUPPORTED |
| PX4 | 4d7e4de77742c3ae8187ffc998ed6d04629c611b | только в режиме HIL | в режиме HIL или с use_hil_gps | да (поток) | нужна проверенная плата |

ArduPilot: GCS_Common.cpp (sha256 b660c5f53a99c89b58fa400c96321aa9ceb6906ae89ccde70e6fb2cc0b91ad8c),
обработчики MAVLink для Copter/Plane, GCS.h и AP_InertialSensor не содержат
обработчиков этих сообщений; внешний GNSS принимается через GPS_INPUT. Для
симуляции ArduPilot используется backend JSON SITL (TASK-041/042).

PX4: mavlink_receiver.cpp (sha256 2e22f0d3e22a48f2793202f7e9dba3526afbb5da8221ab3a78d461008364571b)
декодирует HIL_SENSOR только при включённом режиме HIL; HIL_ACTUATOR_CONTROLS.hpp
(sha256 1ac5017c301c73801d1e8329024fb5f54183fbe58292e56ef29b2bc6b6b903b7) —
поток MAVLink. Поддержка в исходниках не означает поддержку платы.

## Проверенные профили плат

Нет для версии 1. TASK-051 — предложение версии 2: произвести прошивку ArduPilot 4.6.3 или новее с `env SIM_ENABLED 1` и, для Hybrid SITL, с `AP_SIM_JSON_ENABLED 1`, загрузить этот образ на дрон, снять пропеллеры и захватить `AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539, `SIM_OH_MASK` и отключение кабеля. Прототип без дрона — `node --experimental-strip-types scripts/run-virtual-hitl.mjs`. Он не создаёт прошивку дрона. PX4 не входит в это предложение. `HIL_ACTUATOR_CONTROLS` остаётся отдельным программным гейтом TASK-050.
