# ArduPilot Simulation-on-Hardware and Hybrid SITL bench

Status: version 2 proposal. Version 1 does not require this bench. The goal is an ArduPilot 4.6.3 or newer firmware image, built for Hybrid SITL and Simulation-on-Hardware, that can be loaded on the drone and tested there. The analyzer does not open a serial port and does not enable actuators. PX4 is out of scope. A PASS does not call `AutopilotSession.connect("hitl")` and does not enable browser READY. The virtual JSON run is a prototype of the physics link. It does not produce the drone firmware.

ArduPilot 4.6.3 and newer is the recorded-firmware floor. Classic `HIL_SENSOR` / `HIL_GPS` / `HIL_ACTUATOR_CONTROLS` are not this bench. Two modes are accepted:

1. **Hybrid SITL**, virtual stage, no drone. ArduPilot's JSON physics backend ([sitl-with-JSON](https://ardupilot.org/dev/docs/sitl-with-JSON.html)): UDP port 9002, magic `18458` for 16 PWM channels or `29569` for 32. Copter `SIM_RATE_HZ` is at least 400. Plane, rover and blimp are at least 50. The rate must divide 1000000. `node --experimental-strip-types scripts/run-virtual-hitl.mjs` runs 60 s of copter frames at 400 Hz through `ExternalSitlLockstep` on this computer. Provenance source is `virtual-sitl`, `execution` is `virtual`, `droneConnected` is false, and the git short hash is the pinned protocol commit `8ab6afde`. That run does not observe an autopilot version.
2. **Simulation-on-Hardware**, recorded stage, drone connected later. Firmware built with `env SIM_ENABLED 1` ([sim-on-hardware](https://ardupilot.org/dev/docs/sim-on-hardware.html)), version at least 4.6.3. Observed parameters `AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539, and `SIM_OH_MASK` in 0..65535. Props are removed before any masked servo is enabled. Heartbeats come from ArduPilot (`autopilot` 3) for the whole window, with no gap above 2.5 s. A board built with `AP_SIM_JSON_ENABLED 1` and `--simclass JSON` is Hybrid SITL placement `board` and still requires props removed.

Recorded traces use `execution` `recorded`. Virtual traces cannot select Simulation-on-Hardware.

1. For the virtual stage, run the command above. Do not open a COM port.
2. For the recorded stage, remove propellers, secure the vehicle, and record board, firmware version, the 8-character git short hash, and `SIM_OH_MASK`. The native SITL ELF `fa37bf619bce116d410931f1b7d24ea72ed444ba529379df0db9738742ecb186` and the browser WASM `556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38` are not Simulation-on-Hardware images.
3. Record 60–3600 s. Schema version is 2. Provenance is `{source, operator, recordedAt, firmwareSha256, modelSha256}`. `source` is `virtual-sitl`, `native-sitl`, or `hardware` as required by the mode. Stopping the virtual peer, or unplugging a board, sets `unplug.linkLost` and `unplug.actuatorsDisabled` to true within 5 s of the last sample.
4. Hash the exact JSON bytes and run `node scripts/bench-hitl.mjs --input PATH --sha256 HEX`. The report is `test-results/validation/hitl-report.json`. Missing input exits 2. Invalid data or a failed limit exits 1.

Unit tests and the virtual run do not accept a flight controller. Never request secret values or serial device identifiers in chat.
