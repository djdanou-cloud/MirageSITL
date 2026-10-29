# Справочный каталог аппаратных датчиков ArduPilot

<!-- source-sha256: cd792f933e019ad4069caaca3d17de9baf3291f644638bdf58e48ae7667dc3c6 -->

Английский источник: [Source of truth](../hardware/ardupilot-sensors.md).

## 1. Назначение и область применения

В этом каталоге задокументированы промышленные датчики серийного уровня, используемые в экосистеме ArduPilot (CubePilot, Holybro, Matek, CUAV, Mauch, Sensirion, u-blox, LightWare, Garmin и Ainstein). Дешёвые любительские отладочные модули и некалиброванные клоны намеренно исключены.

Приведённые ниже спецификации служат аппаратным эталоном для:

* **Пресетов датчиков в профиле ЛА и вкладки конфигурации Sensors:** выбора бортовых и внешних датчиков, смещений точек установки, ориентаций и реалистичных диапазонов ошибок (`Ideal` против `With specified errors`).
* **Распределения ответственности за ошибки с автопилотом и генерации параметров (TASK-087, TASK-089):** сопоставления физических характеристик датчиков с моделями датчиков MirageSITL (`packages/sensors/`) и параметрами ArduPilot `INS_*`, `BARO_*`, `COMPASS_*`, `GPS*_*`, `BATT_*`, `ARSPD_*` и `RNGFND*_*`.
* **Физики датчиков Фазы 12 (TASK-114, TASK-115, TASK-116, TASK-117, TASK-118) и мониторинга питания силовой установки (TASK-092, TASK-104):** предоставления подтверждённых даташитами спектральных плотностей шума, нестабильностей смещения нуля, задержек преобразования, температурных дрейфов и динамических диапазонов как в единицах даташитов производителей, так и в контрактных единицах СИ MirageSITL (`RadS`, `Mps2`, `Pa`, `Gauss`, `M`, `Mps`, `ms`).

---

## 2. Перевод единиц для контрактов MirageSITL

Интерфейсы датчиков MirageSITL ([`IdealSensors`](../../packages/sensors/src/ideal.ts) и [`SensorNoise`](../../packages/sensors/src/noise.ts)) работают в единицах СИ и гауссах в связанной системе координат FRD и локальной навигационной системе NED:

* **Угловая скорость (`RadS`):** $1\text{ dps (deg/s)} = \frac{\pi}{180}\text{ rad/s} \approx 0.01745329\text{ rad/s}$; $1\text{ mdps}/\sqrt{\text{Hz}} \approx 1.745329 \times 10^{-5}\text{ rad/s}/\sqrt{\text{Hz}}$.
* **Кажущееся ускорение (`Mps2`):** $1\text{ }g = 9.80665\text{ m/s}^2$; $1\text{ }\mu g/\sqrt{\text{Hz}} = 9.80665 \times 10^{-6}\text{ m/s}^2/\sqrt{\text{Hz}}$.
* **Давление (`Pa`):** $1\text{ hPa} = 1\text{ mbar} = 100\text{ Pa}$; $1\text{ psi} = 6894.757\text{ Pa}$. Вблизи уровня моря в МСА $\Delta h \approx -0.0843\text{ m/Pa}$.
* **Магнитная индукция (`Gauss`):** $1\text{ Gauss (G)} = 100\text{ }\mu\text{T} = 100{,}000\text{ nT} = 1000\text{ mG}$; $1\text{ }\mu\text{T} = 0.01\text{ G}$; $1\text{ nT} = 10^{-5}\text{ G}$.
* **Ограниченный по полосе дискретный СКО-шум:** Для спектральной плотности белого шума $N_d$ (на $\sqrt{\text{Hz}}$), пропущенной через фильтр нижних частот первого порядка с частотой среза $f_c\text{ (Hz)}$ (`bandwidthHz` в [`SensorNoise`](../../packages/sensors/src/noise.ts)), эквивалентное непрерывное СКО после фильтра составляет $\sigma = N_d \sqrt{\frac{\pi}{2} f_c} \approx 1.2533 \, N_d \sqrt{f_c}$.

---

## 3. Инерциальные измерительные блоки (6-осевые ИИБ: гироскоп + акселерометр)

Связанные задачи: TASK-035, TASK-087, TASK-089, TASK-114, TASK-115.
Параметры ArduPilot: `INS_GYR*_CAL`, `INS_ACC*_ID`, `INS_GYRO_FILTER`, `INS_ACCEL_FILTER`, `INS_HNTCH_*`, `INS_POS1_X/Y/Z`..`INS_POS3_X/Y/Z`.

| Модель датчика | Производитель | Эталонные автопилоты | Плотность шума гироскопа | Плотность шума акселерометра | Полный диапазон (по умолчанию в ArduPilot) | Смещение при включении и температурный дрейф | Макс. внутренняя частота (ODR) и интерфейс |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ICM-42688-P** | TDK InvenSense | Cube Orange+, Pixhawk 6X / 6C, Matek H743 | $2.8\text{ mdps}/\sqrt{\text{Hz}}$ ($4.89 \times 10^{-5}\text{ rad/s}/\sqrt{\text{Hz}}$) | $70\text{ }\mu g/\sqrt{\text{Hz}}$ ($6.87 \times 10^{-4}\text{ m/s}^2/\sqrt{\text{Hz}}$) | $\pm 2000\text{ dps}$ ($34.91\text{ rad/s}$), $\pm 16\text{ }g$ ($156.91\text{ m/s}^2$) | Гироскоп: $\pm 0.5\text{ dps}$ ($8.73 \times 10^{-3}\text{ rad/s}$), $\pm 0.005\text{ dps/}^\circ\text{C}$; Акселерометр: $\pm 20\text{ mg}$ ($0.196\text{ m/s}^2$), $\pm 0.15\text{ mg/}^\circ\text{C}$ | $32\text{ kHz}$ ($1\text{–}4\text{ kHz}$ в ArduPilot), SPI |
| **ICM-45686** | TDK InvenSense | Pixhawk 6X (Rev 6+), Cube Orange+ (поздние ревизии) | $3.8\text{ mdps}/\sqrt{\text{Hz}}$ ($6.63 \times 10^{-5}\text{ rad/s}/\sqrt{\text{Hz}}$) | $70\text{ }\mu g/\sqrt{\text{Hz}}$ ($6.87 \times 10^{-4}\text{ m/s}^2/\sqrt{\text{Hz}}$) | $\pm 4000\text{ dps}$ ($69.81\text{ rad/s}$), $\pm 32\text{ }g$ ($313.81\text{ m/s}^2$) | Гироскоп: $\pm 0.5\text{ dps}$ ($8.73 \times 10^{-3}\text{ rad/s}$), $\pm 0.005\text{ dps/}^\circ\text{C}$; Акселерометр: $\pm 15\text{ mg}$ ($0.147\text{ m/s}^2$), $\pm 0.10\text{ mg/}^\circ\text{C}$ | $6.4\text{ kHz}$ (архитектура BalancedGyro), SPI |
| **BMI088** | Bosch Sensortec | Pixhawk 6X, Pixhawk 5X, CUAV X7+ | $14.0\text{ mdps}/\sqrt{\text{Hz}}$ ($2.44 \times 10^{-4}\text{ rad/s}/\sqrt{\text{Hz}}$) | $160\text{–}190\text{ }\mu g/\sqrt{\text{Hz}}$ ($1.57\text{–}1.86 \times 10^{-3}\text{ m/s}^2/\sqrt{\text{Hz}}$) | $\pm 2000\text{ dps}$ ($34.91\text{ rad/s}$), $\pm 24\text{ }g$ ($235.36\text{ m/s}^2$) | Гироскоп: $\pm 1.0\text{ dps}$ ($1.75 \times 10^{-2}\text{ rad/s}$), $\pm 0.015\text{ dps/}^\circ\text{C}$; Акселерометр: $\pm 30\text{ mg}$ ($0.294\text{ m/s}^2$), $\pm 0.20\text{ mg/}^\circ\text{C}$ | Гироскоп: $2.0\text{ kHz}$, Акселерометр: $1.6\text{ kHz}$, SPI |
| **ICM-20649** | TDK InvenSense | Cube Orange / Orange+ (вторичный широкодиапазонный ИИБ) | $15.0\text{ mdps}/\sqrt{\text{Hz}}$ ($2.62 \times 10^{-4}\text{ rad/s}/\sqrt{\text{Hz}}$) | $250\text{ }\mu g/\sqrt{\text{Hz}}$ ($2.45 \times 10^{-3}\text{ m/s}^2/\sqrt{\text{Hz}}$) | $\pm 4000\text{ dps}$ ($69.81\text{ rad/s}$), $\pm 30\text{ }g$ ($294.20\text{ m/s}^2$) | Гироскоп: $\pm 5.0\text{ dps}$ ($8.73 \times 10^{-2}\text{ rad/s}$), $\pm 0.02\text{ dps/}^\circ\text{C}$; Акселерометр: $\pm 50\text{ mg}$ ($0.490\text{ m/s}^2$), $\pm 0.50\text{ mg/}^\circ\text{C}$ | Гироскоп: $9.0\text{ kHz}$, Акселерометр: $4.5\text{ kHz}$, SPI |

### Примечания по архитектуре ИИБ

* **Резервирование и термостатирование:** Промышленные полётные контроллеры (Cube Orange+, Pixhawk 6X) объединяют три разнородных ИИБ (например, малошумящий ICM-42688-P в паре с устойчивыми к насыщению при перегрузках BMI088 или ICM-20649/ICM-45686) на механически виброизолированных подвесах из вспененного эластомера или силикона с замкнутым ПИД-контуром обогрева (`BRD_HEAT_TARG` обычно $45\text{–}65^\circ\text{C}$) для устранения температурного дрейфа нуля.
* **Внутризапусковая стабильность смещения нуля:** Типичная нестабильность смещения нуля МЭМС-датчиков в полёте составляет $1.5\text{–}4.0\text{ deg/h}$ ($7.27 \times 10^{-6}\text{ – }1.94 \times 10^{-5}\text{ rad/s}$) для гироскопов и $0.02\text{–}0.05\text{ mg}$ ($2.0\text{–}4.9 \times 10^{-4}\text{ m/s}^2$) для акселерометров.

---

## 4. Барометры (статическое атмосферное давление)

Связанные задачи: TASK-034, TASK-035, TASK-089, TASK-116.
Параметры ArduPilot: `BARO1_DEVID`, `BARO_PRIMARY`, `BARO_EXT_BUS`, `GND_EFFECT_COMP`, `EK3_GND_EFF_DZ`, `BARO1_WCF_ENABLE`.

| Модель датчика | Производитель | Эталонное оборудование | СКО-шум давления (`Pa`) | Эквивалентный шум высоты на уровне моря (`M`) | Абсолютное смещение и температурный дрейф | Время преобразования и типичная частота | Рабочий диапазон (`Pa`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **MS5611-01BA03** | TE Connectivity | Cube Orange+ (двойной), Pixhawk 6C, Matek H743 | $1.2\text{–}1.5\text{ Pa}$ ($\text{OSR}=4096$) | $0.10\text{–}0.13\text{ m}$ | $\pm 150\text{ Pa}$ абс., $\pm 1.5\text{ Pa/}^\circ\text{C}$ | $8.22\text{ ms}$ на шаг P/T ($50\text{–}100\text{ Hz}$), SPI / I2C | $1000\text{–}120000\text{ Pa}$ |
| **BMP388 / BMP390** | Bosch Sensortec | Pixhawk 6X (двойной), узлы Holybro DroneCAN | $0.5\text{–}0.8\text{ Pa}$ (BMP388), $0.2\text{–}0.3\text{ Pa}$ (BMP390) | $0.04\text{–}0.07\text{ m}$ ($0.02\text{ m}$ BMP390) | $\pm 50\text{ Pa}$ абс. ($\pm 30\text{ Pa}$ BMP390), $\pm 0.5\text{ Pa/}^\circ\text{C}$ | $4.8\text{–}12.0\text{ ms}$ ($50\text{–}200\text{ Hz}$), SPI / I2C | $30000\text{–}125000\text{ Pa}$ |
| **ICP-20100** | TDK InvenSense | Pixhawk 6X (новые ревизии), CUAV 7+ | $0.5\text{ Pa}$ (режим малого шума) | $0.04\text{ m}$ | $\pm 100\text{ Pa}$ абс., $\pm 0.5\text{ Pa/}^\circ\text{C}$ | $7.0\text{ ms}$ ($40\text{–}120\text{ Hz}$), SPI / I2C | $30000\text{–}110000\text{ Pa}$ |
| **DPS310 / DPS368** | Infineon | Matek H743-WING / SLIM, платы mRo | $0.5\text{ Pa}$ ($16\times$ передискретизация) | $0.04\text{ m}$ | $\pm 60\text{ Pa}$ абс., $\pm 0.5\text{ Pa/}^\circ\text{C}$ | $3.6\text{–}27.6\text{ ms}$ ($32\text{–}128\text{ Hz}$), SPI / I2C | $30000\text{–}120000\text{ Pa}$ |

---

## 5. Магнитометры (3-осевой компас)

Связанные задачи: TASK-034, TASK-035, TASK-089, TASK-108, TASK-118.
Параметры ArduPilot: `COMPASS_DEV_ID*`, `COMPASS_USE*`, `COMPASS_ORIENT*`, `COMPASS_OFS*`, `COMPASS_MOT_*`.

| Модель датчика | Производитель | Эталонное оборудование | СКО-шум поля (`Gauss` / `uT`) | Полный диапазон поля (`Gauss`) | Чувствительность / разрешение | Макс. частота и интерфейс | Физический принцип и примечания |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RM3100** | PNI Sensor | CUAV C-RTK 9P, Holybro H-RTK F9P, mRo DroneCAN | $0.00015\text{–}0.0003\text{ G}$ ($15\text{–}30\text{ nT}$ при 200 циклах) | $\pm 8.0\text{ G}$ ($\pm 800\text{ }\mu\text{T}$) | $0.00013\text{ G/LSB}$ ($13\text{ nT}$) | $75\text{–}150\text{ Hz}$, SPI / DroneCAN | Магнитоиндуктивная матрица катушек; отсутствие остаточного намагничивания, пренебрежимо малый гистерезис, промышленный эталон |
| **IST8310** | iSentek | Holybro M8N / M9N / M10, стандартные модули GPS Pixhawk | $0.003\text{–}0.005\text{ G}$ ($0.3\text{–}0.5\text{ }\mu\text{T}$) | $\pm 16.0\text{ G}$ (X/Y), $\pm 25.0\text{ G}$ (Z) | $0.003\text{ G/LSB}$ ($0.3\text{ }\mu\text{T}$), нелинейность $0.1\%$ ПШ | $200\text{ Hz}$, I2C / DroneCAN | АМР-датчик; наиболее распространённый внешний компас на стандартных мачтах GPS ArduPilot |
| **BMM150 / BMM350** | Bosch Sensortec | Pixhawk 6X / 6C, CubePilot Here4, Holybro DroneCAN | $0.003\text{ G}$ (BMM150), $0.0019\text{ G}$ (BMM350) | $\pm 13.0\text{ G}$ X/Y, $\pm 25.0\text{ G}$ Z ($\pm 20.0\text{ G}$ BMM350) | $0.003\text{ G}$ (BMM150) | $100\text{–}400\text{ Hz}$, I2C / I3C / DroneCAN | FlipCore (BMM150) / ТМР (BMM350); BMM350 нечувствителен к магнитному удару |
| **ICM-20948 (AK09916)** | TDK / AKM | CubePilot Here3+, внутренний резерв Cube Orange+ | $0.0015\text{–}0.003\text{ G}$ ($0.15\text{–}0.3\text{ }\mu\text{T}$) | $\pm 49.0\text{ G}$ ($\pm 4900\text{ }\mu\text{T}$) | $0.0015\text{ G/LSB}$ ($0.15\text{ }\mu\text{T}$) | $100\text{ Hz}$, I2C / DroneCAN | Магнитометр на эффекте Холла, интегрированный в 9-осевой корпус ICM-20948 |

---

## 6. Приёмники ГНСС (GPS / Galileo / BeiDou / ГЛОНАСС)

Связанные задачи: TASK-036, TASK-053, TASK-059, TASK-089, TASK-117.
Параметры ArduPilot: `GPS1_TYPE` (`1`=Auto, `2`=u-blox, `9`=DroneCAN, `14`=MAVLink), `GPS1_DELAY_MS`, `GPS1_POS_X/Y/Z`, `GPS1_RATE_MS`.

| Модуль / приёмник | Базовый чипсет ГНСС | Транспорт и протокол | Точность горизонтального положения (КВО / CEP) | Точность вертикального положения | Точность скорости (СКО) | Частота обновления (`Hz`) | Типичная транспортная задержка (`GPS_DELAY_MS`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Holybro M9N / CubePilot Here3+** | u-blox **NEO-M9N** (одновременный приём 4 созвездий L1) | UART (`UBX`) или DroneCAN (`GPS1_TYPE=9`) | $1.5\text{ m}$ (3D Fix), $1.0\text{ m}$ (SBAS) | $2.5\text{–}3.0\text{ m}$ | $0.05\text{ m/s}$ | $10\text{–}25\text{ Hz}$ ($10\text{–}15\text{ Hz}$ при 4 созвездиях) | $100\text{–}120\text{ ms}$ (устаревшее значение по умолчанию $220\text{ ms}$) |
| **CubePilot Here4 / Holybro H-RTK F9P** | u-blox **ZED-F9P** (двухчастотный L1/L2 RTK) | DroneCAN (`9`) или UART (`2`) | $1.5\text{ m}$ (автономно), $0.01\text{ m} + 1\text{ ppm}$ (RTK Fixed) | $1.5\text{ m}$ (автономно), $0.015\text{ m}$ (RTK Fixed) | $0.05\text{ m/s}$ | $10\text{–}20\text{ Hz}$ | $80\text{–}100\text{ ms}$ |
| **Holybro M10 / Matek M10Q-5883** | u-blox **MAX-M10S** (сверхмалопотребляющий L1) | UART (`UBX`, `GPS1_TYPE=2`) | $1.5\text{ m}$ | $3.0\text{ m}$ | $0.05\text{ m/s}$ | $10\text{ Hz}$ (4 созвездия) | $100\text{–}120\text{ ms}$ |

---

## 7. Датчики напряжения и тока батареи (модули питания)

Связанные задачи: TASK-026, TASK-087, TASK-089, TASK-092, TASK-104.
Параметры ArduPilot: `BATT_MONITOR` (`4`=Analog Voltage and Current, `8`=DroneCAN-BatteryInfo, `29`=INA2xx), `BATT_VOLT_MULT`, `BATT_AMP_PERVLT`, `BATT_AMP_OFFSET`, `BATT_FS_VOLTSRC`.

| Модуль питания | Архитектура измерения и ИС | Интерфейс ArduPilot (`BATT_MONITOR`) | Диапазон и точность напряжения | Диапазон и точность тока | СКО-шум и шаг квантования | Полоса пропускания и частота опроса |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Mauch HS-050 / HS-100 / HS-200** | Датчик тока на эффекте Холла Allegro **ACS758 / ACS770** + прецизионный делитель | Аналоговый АЦП (`4`) или DroneCAN через Mauch Sensor Hub (`8`) | $4\text{S–}14\text{S}$ ($14\text{–}60\text{ V}$), $\pm 0.05\text{ V}$ после калибровки | $50\text{ A}$ / $100\text{ A}$ / $200\text{ A}$, $\pm 1.0\text{–}1.5\%$ ПШ | СКО-шум тока: $0.15\text{–}0.35\text{ A}$; минимальный температурный дрейф нуля | Аналоговая полоса $120\text{ kHz}$, опрос АЦП автопилота на $10\text{–}50\text{ Hz}$ |
| **Holybro PM02D / PM06D / CUAV CAN PMU** | 16-битный цифровой монитор шунта Texas Instruments **INA226 / INA238** | I2C (`29`) или DroneCAN (`8`) | До $36\text{ V}$ (INA226) или $85\text{ V}$ (INA238), ошибка усиления $\pm 0.1\%$ | $60\text{–}120\text{ A}$ длительно ($180\text{ A}$ пик), точность шунта $\pm 0.5\%$ | МЗР напряжения: $1.25\text{ mV}$; МЗР тока: $2.5\text{–}5.0\text{ mA}$ | Цифровая выдача $50\text{–}100\text{ Hz}$ |
| **CubePilot Power Brick Mini** | Прецизионный резистивный шунт + дифференциальный усилитель | Аналоговый АЦП (`4`) | До $8\text{S}$ ($33.6\text{ V}$), $\pm 1.0\%$ | $60\text{ A}$ длительно ($100\text{ A}$ импульс), $\pm 2.0\%$ | СКО-шум напряжения: $\approx 0.02\text{ V}$; СКО-шум тока: $\approx 0.10\text{ A}$ | Опрос АЦП автопилота на $10\text{–}50\text{ Hz}$ |

---

## 8. Датчики воздушной скорости / дифференциального давления (самолёты и VTOL)

Связанные задачи: TASK-034, TASK-089, TASK-110, TASK-118.
Параметры ArduPilot: `ARSPD_TYPE` (`1`=I2C-MS4525, `3`=I2C-SDP3X, `8`=DroneCAN, `13`=I2C-MS5525), `ARSPD_RATIO`, `ARSPD_AUTOCAL`, `ARSPD_TUBE_ORDER`.

| Модель датчика | Производитель | Интерфейс ArduPilot (`ARSPD_TYPE`) | Диапазон дифференциального давления (`Pa`) | СКО-шум и смещение нуля (`Pa`) | Температурный дрейф и точность диапазона | Частота опроса и задержка тракта |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Sensirion SDP31 / SDP33** | Sensirion (модули Holybro, Matek, CubePilot) | I2C (`3`) или DroneCAN (`8`) | $\pm 500\text{ Pa}$ (SDP31, $\approx 28\text{ m/s}$), $\pm 1500\text{ Pa}$ (SDP33, $\approx 50\text{ m/s}$) | Шум: $0.03\text{–}0.10\text{ Pa}$ СКО; Смещение нуля: $< 0.05\text{ Pa}$ | Нулевой температурный дрейф смещения; $\pm 3.0\%$ от показания | $100\text{–}200\text{ Hz}$, внутренний отклик $< 5\text{ ms}$ (калориметрический микропотоковый принцип) |
| **MS5525DSO-SB001DS** | TE Connectivity | I2C (`13`) или DroneCAN (`8`) | $\pm 1\text{ psi}$ ($\pm 6894.76\text{ Pa}$, до $\approx 105\text{ m/s}$) | Шум: $1.5\text{–}3.0\text{ Pa}$ СКО; Смещение нуля: $\pm 10\text{–}25\text{ Pa}$ | Нелинейность $\pm 0.25\%$ ПШ; требует предполетной калибровки нуля | $50\text{–}100\text{ Hz}$, преобразование АЦП $2\text{–}8\text{ ms}$ |
| **MS4525DO** | TE Connectivity | I2C (`1`) | $\pm 1\text{ psi}$ ($\pm 6894.76\text{ Pa}$) | Шум: $2.0\text{–}4.0\text{ Pa}$ СКО; Смещение нуля: $\pm 20\text{ Pa}$ | Суммарная погрешность $\pm 1.0\%$ | $100\text{ Hz}$, $\approx 5\text{ ms}$ |

---

## 9. Дальномеры / лазерные и радиолокационные высотомеры (AGL)

Связанные задачи: TASK-089, TASK-100, TASK-118.
Параметры ArduPilot: `RNGFND1_TYPE`, `RNGFND1_MIN_CM`, `RNGFND1_MAX_CM`, `RNGFND1_POS_X/Y/Z`, `RNGFND1_ORIENT`.

| Модель датчика | Производитель | Интерфейс ArduPilot (`RNGFND1_TYPE`) | Рабочий диапазон (`M`) | Точность дальности / СКО $1\sigma$ (`M`) | Расходимость луча | Частота обновления и задержка |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SF11/C** или **LW20/C** | LightWare Optoelectronics | Serial (`7` / `20`) или I2C (`7` / `20`) | $0.2\text{–}100\text{ m}$ (LW20/C), $0.2\text{–}120\text{ m}$ (SF11/C) | $\pm 0.03\text{–}0.10\text{ m}$ | $0.3^\circ\text{–}0.5^\circ$ ($5.2\text{–}8.7\text{ mrad}$) | $20\text{–}48\text{ Hz}$ (SF11/C), до $388\text{ Hz}$ (LW20/C), задержка $\approx 20\text{ ms}$ |
| **LIDAR-Lite v3HP** | Garmin | I2C (`15`) или PWM (`5`) | $0.05\text{–}40\text{ m}$ (отражательная способность $70\%$) | $\pm 0.025\text{ m}$ ($< 2\text{ m}$), $\pm 0.05\text{ m}$ ($> 2\text{ m}$) | $8.0\text{ mrad}$ ($\approx 0.46^\circ$) | $50\text{–}200\text{ Hz}$, задержка $10\text{–}20\text{ ms}$ |
| **US-D1 Radar Altimeter** | Ainstein | Serial (`27`) или DroneCAN (`32`) | $0.5\text{–}50\text{ m}$ (всепогодный радар $24\text{ GHz}$) | $\pm 0.04\text{ m}$ или $2\%$ от дальности | $12^\circ \times 30^\circ$ ($0.21 \times 0.52\text{ rad}$) | $100\text{ Hz}$, задержка $\approx 10\text{ ms}$ |

---

## 10. Эталонные комплекты датчиков полётных контроллеров

При формировании готовых пресетов плат в редакторе ЛА следующие комбинации представляют стандартные аппаратные конфигурации ArduPilot:

1. **CubePilot Cube Orange+ + Here3+ / Here4 + Mauch HS-100 (промышленный мультиротор / VTOL):**
   * **ИИБ:** ICM-42688-P (основной), ICM-45686 / ICM-20948 (вторичный), ICM-20649 (третичный широкодиапазонный), с термостатированием.
   * **Барометры:** Двойной MS5611-01BA03.
   * **Магнитометры:** Внешний BMM150/BMM350 (Here4) или AK09916 (Here3+) по шине DroneCAN; внутренний резервный AK09916.
   * **ГНСС:** u-blox ZED-F9P (Here4) или NEO-M9N (Here3+) по DroneCAN.
   * **Монитор батареи:** Mauch HS-100 (датчик Холла ACS758) или CubePilot Power Brick Mini.
2. **Holybro Pixhawk 6X + H-RTK F9P + PM02D + SDP3X (коммерческий VTOL / самолёт):**
   * **ИИБ:** ICM-45686 / ICM-42688-P + BMI088 (тройное резервирование, виброизоляция, подогрев).
   * **Барометры:** Двойной BMP388 или ICP-20100.
   * **Магнитометры:** Внешний RM3100 (H-RTK F9P) или BMM150.
   * **ГНСС:** u-blox ZED-F9P или NEO-M9N.
   * **Монитор батареи:** Holybro PM02D (цифровой I2C-монитор TI INA226).
   * **Воздушная скорость:** Sensirion SDP31/SDP33 (`ARSPD_TYPE=3` или `8`).
3. **Matek H743-WING + Matek M10Q-5883 + MS5525DSO (компактный самолёт / БПЛА большой дальности):**
   * **ИИБ:** Одиночный ICM-42688-P (без подогрева).
   * **Барометр:** Одиночный Infineon DPS310 или TE MS5611.
   * **Магнитометр:** Внешний IST8310 / BMM150 в модуле GPS.
   * **ГНСС:** u-blox MAX-M10S (`GPS1_TYPE=2`).
   * **Монитор батареи:** Встроенный резистивный шунт + аналоговый АЦП (`BATT_MONITOR=4`).
   * **Воздушная скорость:** TE Connectivity MS5525DSO (`ARSPD_TYPE=13`) или Sensirion SDP3X (`ARSPD_TYPE=3`).

---

## 11. Авторитетные источники

* Документация ArduPilot — Autopilot Hardware Options (`common-autopilots`), Positioning & Compass (`common-positioning-landingpage`), Barometers, Airspeed Sensors (`common-airspeed-sensors`), Rangefinders (`common-rangefinder-landingpage`) и Power Modules (`common-powermodule-landingpage`): `https://ardupilot.org/copter/docs/common-autopilots.html`
* Аппаратные спецификации CubePilot Cube Orange+ и Here3+ / Here4: `https://docs.cubepilot.org/`
* Спецификации серий Holybro Pixhawk 6X / 6C, PM02D / PM06D и H-RTK: `https://docs.holybro.com/`
* Даташиты TDK InvenSense: ICM-42688-P (DS-000347), ICM-45686 (DS-000577), ICM-20649 (DS-000189), ICP-20100 (DS-000406).
* Даташиты Bosch Sensortec: BMI088 (BST-BMI088-DS001), BMP388 / BMP390 (BST-BMP388-DS001 / BST-BMP390-DS002), BMM150 / BMM350.
* Даташиты TE Connectivity: MS5611-01BA03, MS5525DSO-SB001DS, MS4525DO.
* Даташит геомагнитного датчика PNI Sensor RM3100 и даташит 3-осевого магнитометра iSentek IST8310.
* Спецификации и руководства по интеграции u-blox NEO-M9N, ZED-F9P и MAX-M10S.
* Даташит цифровых датчиков дифференциального давления Sensirion SDP31 / SDP33.
* Руководства по эксплуатации LightWare SF11/C и LW20/C, Garmin LIDAR-Lite v3HP и техническая спецификация Ainstein US-D1.
