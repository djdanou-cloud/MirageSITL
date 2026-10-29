# ArduPilot Hardware Sensor Reference Catalog

English source. [Russian mirror](../ru/ardupilot-sensors.md).

## 1. Purpose and Scope

This catalog documents industry-standard, production-grade sensors used across the ArduPilot ecosystem (CubePilot, Holybro, Matek, CUAV, Mauch, Sensirion, u-blox, LightWare, Garmin, and Ainstein). Low-grade hobbyist breakout modules and uncalibrated clones are intentionally excluded.

The specifications below serve as the hardware reference for:

* **Aircraft profile sensor presets and the Sensors configuration tab:** selecting onboard and external sensors, mounting offsets, orientations, and realistic error envelopes (`Ideal` versus `With specified errors`).
* **Autopilot error ownership and parameter generation (TASK-087, TASK-089):** mapping physical sensor characteristics to MirageSITL sensor models (`packages/sensors/`) and ArduPilot `INS_*`, `BARO_*`, `COMPASS_*`, `GPS*_*`, `BATT_*`, `ARSPD_*`, and `RNGFND*_*` parameters.
* **Phase 12 sensor physics (TASK-114, TASK-115, TASK-116, TASK-117, TASK-118) and propulsion power monitoring (TASK-092, TASK-104):** providing datasheet-backed noise densities, bias instabilities, conversion delays, thermal drifts, and dynamic ranges in both manufacturer datasheet units and MirageSITL SI contract units (`RadS`, `Mps2`, `Pa`, `Gauss`, `M`, `Mps`, `ms`).

---

## 2. Unit Conversions for MirageSITL Contracts

MirageSITL sensor interfaces ([`IdealSensors`](../../packages/sensors/src/ideal.ts) and [`SensorNoise`](../../packages/sensors/src/noise.ts)) operate in SI and Gauss units in the FRD body frame and NED local navigation frame:

* **Angular rate (`RadS`):** $1\text{ dps (deg/s)} = \frac{\pi}{180}\text{ rad/s} \approx 0.01745329\text{ rad/s}$; $1\text{ mdps}/\sqrt{\text{Hz}} \approx 1.745329 \times 10^{-5}\text{ rad/s}/\sqrt{\text{Hz}}$.
* **Specific force (`Mps2`):** $1\text{ }g = 9.80665\text{ m/s}^2$; $1\text{ }\mu g/\sqrt{\text{Hz}} = 9.80665 \times 10^{-6}\text{ m/s}^2/\sqrt{\text{Hz}}$.
* **Pressure (`Pa`):** $1\text{ hPa} = 1\text{ mbar} = 100\text{ Pa}$; $1\text{ psi} = 6894.757\text{ Pa}$. Near sea level in ISA, $\Delta h \approx -0.0843\text{ m/Pa}$.
* **Magnetic flux density (`Gauss`):** $1\text{ Gauss (G)} = 100\text{ }\mu\text{T} = 100{,}000\text{ nT} = 1000\text{ mG}$; $1\text{ }\mu\text{T} = 0.01\text{ G}$; $1\text{ nT} = 10^{-5}\text{ G}$.
* **Band-limited discrete RMS noise:** For a white noise density $N_d$ (per $\sqrt{\text{Hz}}$) filtered by a first-order low-pass pole at $f_c\text{ (Hz)}$ (`bandwidthHz` in [`SensorNoise`](../../packages/sensors/src/noise.ts)), the equivalent continuous-time post-filter RMS is $\sigma = N_d \sqrt{\frac{\pi}{2} f_c} \approx 1.2533 \, N_d \sqrt{f_c}$.

---

## 3. Inertial Measurement Units (6-Axis IMU: Gyroscope + Accelerometer)

Relevant tasks: TASK-035, TASK-087, TASK-089, TASK-114, TASK-115.
ArduPilot parameters: `INS_GYR*_CAL`, `INS_ACC*_ID`, `INS_GYRO_FILTER`, `INS_ACCEL_FILTER`, `INS_HNTCH_*`, `INS_POS1_X/Y/Z`..`INS_POS3_X/Y/Z`.

| Sensor Model | Manufacturer | Reference Autopilots | Gyro Noise Density | Accel Noise Density | Full-Scale Range (ArduPilot Default) | Turn-On Bias & Thermal Drift | Max Internal ODR & Interface |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ICM-42688-P** | TDK InvenSense | Cube Orange+, Pixhawk 6X / 6C, Matek H743 | $2.8\text{ mdps}/\sqrt{\text{Hz}}$ ($4.89 \times 10^{-5}\text{ rad/s}/\sqrt{\text{Hz}}$) | $70\text{ }\mu g/\sqrt{\text{Hz}}$ ($6.87 \times 10^{-4}\text{ m/s}^2/\sqrt{\text{Hz}}$) | $\pm 2000\text{ dps}$ ($34.91\text{ rad/s}$), $\pm 16\text{ }g$ ($156.91\text{ m/s}^2$) | Gyro: $\pm 0.5\text{ dps}$ ($8.73 \times 10^{-3}\text{ rad/s}$), $\pm 0.005\text{ dps/}^\circ\text{C}$; Accel: $\pm 20\text{ mg}$ ($0.196\text{ m/s}^2$), $\pm 0.15\text{ mg/}^\circ\text{C}$ | $32\text{ kHz}$ ($1\text{–}4\text{ kHz}$ in ArduPilot), SPI |
| **ICM-45686** | TDK InvenSense | Pixhawk 6X (Rev 6+), Cube Orange+ (late revs) | $3.8\text{ mdps}/\sqrt{\text{Hz}}$ ($6.63 \times 10^{-5}\text{ rad/s}/\sqrt{\text{Hz}}$) | $70\text{ }\mu g/\sqrt{\text{Hz}}$ ($6.87 \times 10^{-4}\text{ m/s}^2/\sqrt{\text{Hz}}$) | $\pm 4000\text{ dps}$ ($69.81\text{ rad/s}$), $\pm 32\text{ }g$ ($313.81\text{ m/s}^2$) | Gyro: $\pm 0.5\text{ dps}$ ($8.73 \times 10^{-3}\text{ rad/s}$), $\pm 0.005\text{ dps/}^\circ\text{C}$; Accel: $\pm 15\text{ mg}$ ($0.147\text{ m/s}^2$), $\pm 0.10\text{ mg/}^\circ\text{C}$ | $6.4\text{ kHz}$ (BalancedGyro architecture), SPI |
| **BMI088** | Bosch Sensortec | Pixhawk 6X, Pixhawk 5X, CUAV X7+ | $14.0\text{ mdps}/\sqrt{\text{Hz}}$ ($2.44 \times 10^{-4}\text{ rad/s}/\sqrt{\text{Hz}}$) | $160\text{–}190\text{ }\mu g/\sqrt{\text{Hz}}$ ($1.57\text{–}1.86 \times 10^{-3}\text{ m/s}^2/\sqrt{\text{Hz}}$) | $\pm 2000\text{ dps}$ ($34.91\text{ rad/s}$), $\pm 24\text{ }g$ ($235.36\text{ m/s}^2$) | Gyro: $\pm 1.0\text{ dps}$ ($1.75 \times 10^{-2}\text{ rad/s}$), $\pm 0.015\text{ dps/}^\circ\text{C}$; Accel: $\pm 30\text{ mg}$ ($0.294\text{ m/s}^2$), $\pm 0.20\text{ mg/}^\circ\text{C}$ | Gyro: $2.0\text{ kHz}$, Accel: $1.6\text{ kHz}$, SPI |
| **ICM-20649** | TDK InvenSense | Cube Orange / Orange+ (secondary wide-range IMU) | $15.0\text{ mdps}/\sqrt{\text{Hz}}$ ($2.62 \times 10^{-4}\text{ rad/s}/\sqrt{\text{Hz}}$) | $250\text{ }\mu g/\sqrt{\text{Hz}}$ ($2.45 \times 10^{-3}\text{ m/s}^2/\sqrt{\text{Hz}}$) | $\pm 4000\text{ dps}$ ($69.81\text{ rad/s}$), $\pm 30\text{ }g$ ($294.20\text{ m/s}^2$) | Gyro: $\pm 5.0\text{ dps}$ ($8.73 \times 10^{-2}\text{ rad/s}$), $\pm 0.02\text{ dps/}^\circ\text{C}$; Accel: $\pm 50\text{ mg}$ ($0.490\text{ m/s}^2$), $\pm 0.50\text{ mg/}^\circ\text{C}$ | Gyro: $9.0\text{ kHz}$, Accel: $4.5\text{ kHz}$, SPI |

### IMU Architecture Notes

* **Redundancy & Heating:** Enterprise flight controllers (Cube Orange+, Pixhawk 6X) combine three heterogeneous IMUs (e.g., low-noise ICM-42688-P paired with high-clipping-threshold BMI088 or ICM-20649/ICM-45686) on mechanically isolated foam or silicone mounts with closed-loop PID heater resistors (`BRD_HEAT_TARG` typically $45\text{–}65^\circ\text{C}$) to eliminate thermal bias drift.
* **In-Run Bias Stability:** Typical MEMS in-run bias instability is $1.5\text{–}4.0\text{ deg/h}$ ($7.27 \times 10^{-6}\text{ to }1.94 \times 10^{-5}\text{ rad/s}$) for gyroscopes and $0.02\text{–}0.05\text{ mg}$ ($2.0\text{–}4.9 \times 10^{-4}\text{ m/s}^2$) for accelerometers.

---

## 4. Barometers (Static Atmospheric Pressure)

Relevant tasks: TASK-034, TASK-035, TASK-089, TASK-116.
ArduPilot parameters: `BARO1_DEVID`, `BARO_PRIMARY`, `BARO_EXT_BUS`, `GND_EFFECT_COMP`, `EK3_GND_EFF_DZ`, `BARO1_WCF_ENABLE`.

| Sensor Model | Manufacturer | Reference Hardware | RMS Pressure Noise (`Pa`) | Equivalent Sea-Level Altitude Noise (`M`) | Absolute Offset & Thermal Drift | Conversion Time & Typical ODR | Operating Range (`Pa`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **MS5611-01BA03** | TE Connectivity | Cube Orange+ (Dual), Pixhawk 6C, Matek H743 | $1.2\text{–}1.5\text{ Pa}$ ($\text{OSR}=4096$) | $0.10\text{–}0.13\text{ m}$ | $\pm 150\text{ Pa}$ abs, $\pm 1.5\text{ Pa/}^\circ\text{C}$ | $8.22\text{ ms}$ per P/T step ($50\text{–}100\text{ Hz}$), SPI / I2C | $1000\text{–}120000\text{ Pa}$ |
| **BMP388 / BMP390** | Bosch Sensortec | Pixhawk 6X (Dual), Holybro DroneCAN nodes | $0.5\text{–}0.8\text{ Pa}$ (BMP388), $0.2\text{–}0.3\text{ Pa}$ (BMP390) | $0.04\text{–}0.07\text{ m}$ ($0.02\text{ m}$ BMP390) | $\pm 50\text{ Pa}$ abs ($\pm 30\text{ Pa}$ BMP390), $\pm 0.5\text{ Pa/}^\circ\text{C}$ | $4.8\text{–}12.0\text{ ms}$ ($50\text{–}200\text{ Hz}$), SPI / I2C | $30000\text{–}125000\text{ Pa}$ |
| **ICP-20100** | TDK InvenSense | Pixhawk 6X (newer revs), CUAV 7+ | $0.5\text{ Pa}$ (Low-Noise mode) | $0.04\text{ m}$ | $\pm 100\text{ Pa}$ abs, $\pm 0.5\text{ Pa/}^\circ\text{C}$ | $7.0\text{ ms}$ ($40\text{–}120\text{ Hz}$), SPI / I2C | $30000\text{–}110000\text{ Pa}$ |
| **DPS310 / DPS368** | Infineon | Matek H743-WING / SLIM, mRo boards | $0.5\text{ Pa}$ ($16\times$ oversampling) | $0.04\text{ m}$ | $\pm 60\text{ Pa}$ abs, $\pm 0.5\text{ Pa/}^\circ\text{C}$ | $3.6\text{–}27.6\text{ ms}$ ($32\text{–}128\text{ Hz}$), SPI / I2C | $30000\text{–}120000\text{ Pa}$ |

---

## 5. Magnetometers (3-Axis Compass)

Relevant tasks: TASK-034, TASK-035, TASK-089, TASK-108, TASK-118.
ArduPilot parameters: `COMPASS_DEV_ID*`, `COMPASS_USE*`, `COMPASS_ORIENT*`, `COMPASS_OFS*`, `COMPASS_MOT_*`.

| Sensor Model | Manufacturer | Reference Hardware | RMS Field Noise (`Gauss` / `uT`) | Full-Scale Field Range (`Gauss`) | Sensitivity / Resolution | Max ODR & Interface | Physical Technology & Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RM3100** | PNI Sensor | CUAV C-RTK 9P, Holybro H-RTK F9P, mRo DroneCAN | $0.00015\text{–}0.0003\text{ G}$ ($15\text{–}30\text{ nT}$ at 200 cycles) | $\pm 8.0\text{ G}$ ($\pm 800\text{ }\mu\text{T}$) | $0.00013\text{ G/LSB}$ ($13\text{ nT}$) | $75\text{–}150\text{ Hz}$, SPI / DroneCAN | Magneto-inductive coil array; zero permanent-magnet latch-up, negligible hysteresis, industrial reference standard |
| **IST8310** | iSentek | Holybro M8N / M9N / M10, standard Pixhawk GPS pucks | $0.003\text{–}0.005\text{ G}$ ($0.3\text{–}0.5\text{ }\mu\text{T}$) | $\pm 16.0\text{ G}$ (X/Y), $\pm 25.0\text{ G}$ (Z) | $0.003\text{ G/LSB}$ ($0.3\text{ }\mu\text{T}$), $0.1\%$ FS non-linearity | $200\text{ Hz}$, I2C / DroneCAN | AMR sensor; most widely deployed external compass across standard ArduPilot GPS masts |
| **BMM150 / BMM350** | Bosch Sensortec | Pixhawk 6X / 6C, CubePilot Here4, Holybro DroneCAN | $0.003\text{ G}$ (BMM150), $0.0019\text{ G}$ (BMM350) | $\pm 13.0\text{ G}$ X/Y, $\pm 25.0\text{ G}$ Z ($\pm 20.0\text{ G}$ BMM350) | $0.003\text{ G}$ (BMM150) | $100\text{–}400\text{ Hz}$, I2C / I3C / DroneCAN | FlipCore (BMM150) / TMR (BMM350); BMM350 is immune to magnetic shock |
| **ICM-20948 (AK09916)** | TDK / AKM | CubePilot Here3+, Cube Orange+ internal backup | $0.0015\text{–}0.003\text{ G}$ ($0.15\text{–}0.3\text{ }\mu\text{T}$) | $\pm 49.0\text{ G}$ ($\pm 4900\text{ }\mu\text{T}$) | $0.0015\text{ G/LSB}$ ($0.15\text{ }\mu\text{T}$) | $100\text{ Hz}$, I2C / DroneCAN | Hall-effect magnetometer integrated inside the ICM-20948 9-axis package |

---

## 6. GNSS Receivers (GPS / Galileo / BeiDou / GLONASS)

Relevant tasks: TASK-036, TASK-053, TASK-059, TASK-089, TASK-117.
ArduPilot parameters: `GPS1_TYPE` (`1`=Auto, `2`=u-blox, `9`=DroneCAN, `14`=MAVLink), `GPS1_DELAY_MS`, `GPS1_POS_X/Y/Z`, `GPS1_RATE_MS`.

| Module / Receiver | Core GNSS Engine | Transport & Protocol | Horizontal Position Accuracy (CEP) | Vertical Position Accuracy | Velocity Accuracy (RMS) | Update Rate (`Hz`) | Typical Transport Lag (`GPS_DELAY_MS`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Holybro M9N / CubePilot Here3+** | u-blox **NEO-M9N** (4-constellation concurrent L1) | UART (`UBX`) or DroneCAN (`GPS1_TYPE=9`) | $1.5\text{ m}$ (3D Fix), $1.0\text{ m}$ (SBAS) | $2.5\text{–}3.0\text{ m}$ | $0.05\text{ m/s}$ | $10\text{–}25\text{ Hz}$ ($10\text{–}15\text{ Hz}$ with 4 constellations) | $100\text{–}120\text{ ms}$ (legacy default $220\text{ ms}$) |
| **CubePilot Here4 / Holybro H-RTK F9P** | u-blox **ZED-F9P** (Dual-band L1/L2 RTK) | DroneCAN (`9`) or UART (`2`) | $1.5\text{ m}$ (Standalone), $0.01\text{ m} + 1\text{ ppm}$ (RTK Fixed) | $1.5\text{ m}$ (Standalone), $0.015\text{ m}$ (RTK Fixed) | $0.05\text{ m/s}$ | $10\text{–}20\text{ Hz}$ | $80\text{–}100\text{ ms}$ |
| **Holybro M10 / Matek M10Q-5883** | u-blox **MAX-M10S** (Ultra-low-power L1) | UART (`UBX`, `GPS1_TYPE=2`) | $1.5\text{ m}$ | $3.0\text{ m}$ | $0.05\text{ m/s}$ | $10\text{ Hz}$ (4 constellations) | $100\text{–}120\text{ ms}$ |

---

## 7. Battery Voltage and Current Monitors (Power Modules)

Relevant tasks: TASK-026, TASK-087, TASK-089, TASK-092, TASK-104.
ArduPilot parameters: `BATT_MONITOR` (`4`=Analog Voltage and Current, `8`=DroneCAN-BatteryInfo, `29`=INA2xx), `BATT_VOLT_MULT`, `BATT_AMP_PERVLT`, `BATT_AMP_OFFSET`, `BATT_FS_VOLTSRC`.

| Power Module | Sensing Architecture & IC | ArduPilot Interface (`BATT_MONITOR`) | Voltage Range & Accuracy | Current Range & Accuracy | RMS Noise & Quantization | Bandwidth & Sample Rate |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Mauch HS-050 / HS-100 / HS-200** | Allegro **ACS758 / ACS770** Hall-effect current sensor + precision divider | Analog ADC (`4`) or DroneCAN via Mauch Sensor Hub (`8`) | $4\text{S–}14\text{S}$ ($14\text{–}60\text{ V}$), $\pm 0.05\text{ V}$ calibrated | $50\text{ A}$ / $100\text{ A}$ / $200\text{ A}$, $\pm 1.0\text{–}1.5\%$ FS | Current RMS noise: $0.15\text{–}0.35\text{ A}$; minimal thermal zero drift | $120\text{ kHz}$ analog BW, sampled by autopilot ADC at $10\text{–}50\text{ Hz}$ |
| **Holybro PM02D / PM06D / CUAV CAN PMU** | Texas Instruments **INA226 / INA238** 16-bit digital shunt monitor | I2C (`29`) or DroneCAN (`8`) | Up to $36\text{ V}$ (INA226) or $85\text{ V}$ (INA238), $\pm 0.1\%$ gain error | $60\text{–}120\text{ A}$ continuous ($180\text{ A}$ peak), $\pm 0.5\%$ shunt error | Voltage LSB: $1.25\text{ mV}$; Current LSB: $2.5\text{–}5.0\text{ mA}$ | $50\text{–}100\text{ Hz}$ digital reporting |
| **CubePilot Power Brick Mini** | Precision resistive shunt + differential amplifier | Analog ADC (`4`) | Up to $8\text{S}$ ($33.6\text{ V}$), $\pm 1.0\%$ | $60\text{ A}$ continuous ($100\text{ A}$ burst), $\pm 2.0\%$ | Voltage RMS noise: $\approx 0.02\text{ V}$; Current RMS noise: $\approx 0.10\text{ A}$ | Sampled by autopilot ADC at $10\text{–}50\text{ Hz}$ |

---

## 8. Airspeed / Differential Pressure Sensors (Fixed-Wing & VTOL)

Relevant tasks: TASK-034, TASK-089, TASK-110, TASK-118.
ArduPilot parameters: `ARSPD_TYPE` (`1`=I2C-MS4525, `3`=I2C-SDP3X, `8`=DroneCAN, `13`=I2C-MS5525), `ARSPD_RATIO`, `ARSPD_AUTOCAL`, `ARSPD_TUBE_ORDER`.

| Sensor Model | Manufacturer | ArduPilot Interface (`ARSPD_TYPE`) | Differential Pressure Range (`Pa`) | RMS Noise & Zero-Offset Error (`Pa`) | Thermal Drift & Span Accuracy | Sample Rate & Tube/Sensor Lag |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Sensirion SDP31 / SDP33** | Sensirion (Holybro, Matek, CubePilot modules) | I2C (`3`) or DroneCAN (`8`) | $\pm 500\text{ Pa}$ (SDP31, $\approx 28\text{ m/s}$), $\pm 1500\text{ Pa}$ (SDP33, $\approx 50\text{ m/s}$) | Noise: $0.03\text{–}0.10\text{ Pa}$ RMS; Zero offset: $< 0.05\text{ Pa}$ | Zero temperature drift on offset; $\pm 3.0\%$ of reading | $100\text{–}200\text{ Hz}$, $< 5\text{ ms}$ internal response (calorimetric mass-flow principle) |
| **MS5525DSO-SB001DS** | TE Connectivity | I2C (`13`) or DroneCAN (`8`) | $\pm 1\text{ psi}$ ($\pm 6894.76\text{ Pa}$, up to $\approx 105\text{ m/s}$) | Noise: $1.5\text{–}3.0\text{ Pa}$ RMS; Zero offset: $\pm 10\text{–}25\text{ Pa}$ | $\pm 0.25\%$ FS non-linearity; requires pre-flight zero calibration | $50\text{–}100\text{ Hz}$, $2\text{–}8\text{ ms}$ ADC conversion |
| **MS4525DO** | TE Connectivity | I2C (`1`) | $\pm 1\text{ psi}$ ($\pm 6894.76\text{ Pa}$) | Noise: $2.0\text{–}4.0\text{ Pa}$ RMS; Zero offset: $\pm 20\text{ Pa}$ | $\pm 1.0\%$ Total Error Band | $100\text{ Hz}$, $\approx 5\text{ ms}$ |

---

## 9. Rangefinders / Laser and Radar Altimeters (AGL)

Relevant tasks: TASK-089, TASK-100, TASK-118.
ArduPilot parameters: `RNGFND1_TYPE`, `RNGFND1_MIN_CM`, `RNGFND1_MAX_CM`, `RNGFND1_POS_X/Y/Z`, `RNGFND1_ORIENT`.

| Sensor Model | Manufacturer | ArduPilot Interface (`RNGFND1_TYPE`) | Operating Range (`M`) | Range Accuracy / $1\sigma$ Noise (`M`) | Beam Divergence | Update Rate & Latency |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SF11/C** or **LW20/C** | LightWare Optoelectronics | Serial (`7` / `20`) or I2C (`7` / `20`) | $0.2\text{–}100\text{ m}$ (LW20/C), $0.2\text{–}120\text{ m}$ (SF11/C) | $\pm 0.03\text{–}0.10\text{ m}$ | $0.3^\circ\text{–}0.5^\circ$ ($5.2\text{–}8.7\text{ mrad}$) | $20\text{–}48\text{ Hz}$ (SF11/C), up to $388\text{ Hz}$ (LW20/C), $\approx 20\text{ ms}$ lag |
| **LIDAR-Lite v3HP** | Garmin | I2C (`15`) or PWM (`5`) | $0.05\text{–}40\text{ m}$ ($70\%$ reflectivity target) | $\pm 0.025\text{ m}$ ($< 2\text{ m}$), $\pm 0.05\text{ m}$ ($> 2\text{ m}$) | $8.0\text{ mrad}$ ($\approx 0.46^\circ$) | $50\text{–}200\text{ Hz}$, $10\text{–}20\text{ ms}$ lag |
| **US-D1 Radar Altimeter** | Ainstein | Serial (`27`) or DroneCAN (`32`) | $0.5\text{–}50\text{ m}$ ($24\text{ GHz}$ all-weather radar) | $\pm 0.04\text{ m}$ or $2\%$ of range | $12^\circ \times 30^\circ$ ($0.21 \times 0.52\text{ rad}$) | $100\text{ Hz}$, $\approx 10\text{ ms}$ lag |

---

## 10. Reference Flight Controller Board Sensor Suites

When offering board-level presets in the aircraft editor, the following combinations represent standard ArduPilot hardware configurations:

1. **CubePilot Cube Orange+ + Here3+ / Here4 + Mauch HS-100 (Industrial Multirotor / VTOL):**
   * **IMUs:** ICM-42688-P (primary), ICM-45686 / ICM-20948 (secondary), ICM-20649 (tertiary wide-range), temperature-regulated.
   * **Barometers:** Dual MS5611-01BA03.
   * **Magnetometers:** External BMM150/BMM350 (Here4) or AK09916 (Here3+) on DroneCAN; internal AK09916 backup.
   * **GNSS:** u-blox ZED-F9P (Here4) or NEO-M9N (Here3+) via DroneCAN.
   * **Battery Monitor:** Mauch HS-100 (ACS758 Hall sensor) or CubePilot Power Brick Mini.
2. **Holybro Pixhawk 6X + H-RTK F9P + PM02D + SDP3X (Commercial VTOL / Fixed-Wing):**
   * **IMUs:** ICM-45686 / ICM-42688-P + BMI088 (triple-redundant, vibration-isolated, heated).
   * **Barometers:** Dual BMP388 or ICP-20100.
   * **Magnetometers:** External RM3100 (H-RTK F9P) or BMM150.
   * **GNSS:** u-blox ZED-F9P or NEO-M9N.
   * **Battery Monitor:** Holybro PM02D (TI INA226 digital I2C monitor).
   * **Airspeed:** Sensirion SDP31/SDP33 (`ARSPD_TYPE=3` or `8`).
3. **Matek H743-WING + Matek M10Q-5883 + MS5525DSO (Compact Fixed-Wing / Long-Range UAV):**
   * **IMU:** Single ICM-42688-P (unheated).
   * **Barometer:** Single Infineon DPS310 or TE MS5611.
   * **Magnetometer:** External IST8310 / BMM150 on GPS puck.
   * **GNSS:** u-blox MAX-M10S (`GPS1_TYPE=2`).
   * **Battery Monitor:** Onboard resistive shunt + analog ADC (`BATT_MONITOR=4`).
   * **Airspeed:** TE Connectivity MS5525DSO (`ARSPD_TYPE=13`) or Sensirion SDP3X (`ARSPD_TYPE=3`).

---

## 11. Authoritative Sources

* ArduPilot Documentation — Autopilot Hardware Options (`common-autopilots`), Positioning & Compass (`common-positioning-landingpage`), Barometers, Airspeed Sensors (`common-airspeed-sensors`), Rangefinders (`common-rangefinder-landingpage`), and Power Modules (`common-powermodule-landingpage`): `https://ardupilot.org/copter/docs/common-autopilots.html`
* CubePilot Cube Orange+ & Here3+ / Here4 Hardware Specifications: `https://docs.cubepilot.org/`
* Holybro Pixhawk 6X / 6C, PM02D / PM06D, and H-RTK Series Specifications: `https://docs.holybro.com/`
* TDK InvenSense Datasheets: ICM-42688-P (DS-000347), ICM-45686 (DS-000577), ICM-20649 (DS-000189), ICP-20100 (DS-000406).
* Bosch Sensortec Datasheets: BMI088 (BST-BMI088-DS001), BMP388 / BMP390 (BST-BMP388-DS001 / BST-BMP390-DS002), BMM150 / BMM350.
* TE Connectivity Datasheets: MS5611-01BA03, MS5525DSO-SB001DS, MS4525DO.
* PNI Sensor RM3100 Geomagnetic Sensor Datasheet & iSentek IST8310 3-Axis Magnetometer Datasheet.
* u-blox NEO-M9N, ZED-F9P, and MAX-M10S Data Sheets and Integration Manuals.
* Sensirion SDP31 / SDP33 Digital Differential Pressure Sensor Datasheet.
* LightWare SF11/C and LW20/C Product Manuals, Garmin LIDAR-Lite v3HP Operation Manual, and Ainstein US-D1 Technical Specification.
