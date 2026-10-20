# Матрица возможностей прошивок для HITL

<!-- source-sha256: fe52ac999e38851e1ca430d2efec3ec34b757a590c4275c2218868f47b57ad8a -->

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
| ArduPilot | 8ab6afde107a91df1b5f60ade8f333cb8a61b190 | нет | нет | нет | UNSUPPORTED |
| PX4 | 4d7e4de77742c3ae8187ffc998ed6d04629c611b | только в режиме HIL | в режиме HIL или с use_hil_gps | да (поток) | нужна проверенная плата |

ArduPilot: GCS_Common.cpp (sha256 345233ce691a29f21e66d50b81ce75db9672eb29e9d39ac2d0e9e139e92836ec),
обработчики MAVLink для Copter/Plane, GCS.h и AP_InertialSensor не содержат
обработчиков этих сообщений; внешний GNSS принимается через GPS_INPUT. Для
симуляции ArduPilot используется backend JSON SITL (TASK-041/042).

PX4: mavlink_receiver.cpp (sha256 2e22f0d3e22a48f2793202f7e9dba3526afbb5da8221ab3a78d461008364571b)
декодирует HIL_SENSOR только при включённом режиме HIL; HIL_ACTUATOR_CONTROLS.hpp
(sha256 1ac5017c301c73801d1e8329024fb5f54183fbe58292e56ef29b2bc6b6b903b7) —
поток MAVLink. Поддержка в исходниках не означает поддержку платы.

## Проверенные профили плат

Нет. Чтобы добавить записанный профиль Simulation-on-Hardware, прошить
ArduPilot 4.6.3 или новее, собранный с `env SIM_ENABLED 1`, снять пропеллеры и
захватить `AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539,
`SIM_OH_MASK` и отключение кабеля. Текущий этап TASK-051 не использует дрон:
виртуальный Hybrid SITL запускается командой
`node --experimental-strip-types scripts/run-virtual-hitl.mjs`. PX4 не входит
в этот стенд. `HIL_ACTUATOR_CONTROLS` остаётся отдельным программным гейтом
TASK-050 и не принимает Simulation-on-Hardware.
