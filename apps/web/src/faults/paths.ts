import type { EffectFamily, EffectId } from "@mirage/protocol";

// How each effect of the tab reaches a run with ArduPilot (TASK-168, TASK-169), as a person reads it. The physics truth never changes for
// a sensor or link effect; a motor fault changes the physical actuation.

export const FAMILY_LABELS: Readonly<Partial<Record<EffectFamily, string>>> = {
  fault: "Interference and motor faults",
  delivery: "Frozen readings and lost links",
  ardupilot: "ArduPilot's own sensor faults",
  barometer: "Barometer pressure errors",
  gnss: "GNSS satellites and signals",
};
export const EFFECT_PATHS: Readonly<Partial<Record<EffectId, string>>> = {
  "motor.loss": "Changes the physical thrust of one motor in the physics, on its tick.",
  "ew.gnss-jamming": "Written to ArduPilot's simulated receiver as parameters: fewer satellites, worse accuracy, and no fix at high severity. Each write takes a moment and is logged.",
  "ew.position-step": "Added to the north and east position on the state line, on its tick. A vertical offset is refused, because the height there also feeds the barometer.",
  "ew.velocity-drift": "Added to the north and east position and velocity on the state line, on each tick. A vertical drift is refused, because the height there also feeds the barometer.",
  "ew.magnetic": "The rotation turns the attitude on the state line, from which SITL makes the magnetometer, on its tick. The bias is written to SIM_MAGn_OFS, added to the Sensors tab's value.",
  "sensor.imu.frozen": "ArduPilot keeps receiving the last gyro and accelerometer values on the state line.",
  "sensor.gnss.frozen": "ArduPilot keeps receiving the last north and east position and velocity on the state line. Height goes on, because it also feeds the barometer.",
  "sensor.mag.frozen": "ArduPilot keeps receiving the last attitude on the state line, from which SITL makes the magnetometer.",
  "link.pilot": "Stick commands stop at the bridge. GUIDED does not read the sticks, so nothing may show unless you fly by hand.",
  "link.gcs": "All MAVLink stops at the bridge in both directions, so parameter writes and telemetry stop too.",
  "sensor.imu.missing": "Written to SIM_ACC_FAIL_MSK and SIM_GYR_FAIL_MSK. ArduPilot's main loop stops, and turning this off cannot reach it: the run has to end.",
  "sensor.gnss.missing": "Written to SIM_GPS1_LCKTIME, the delay before the receiver locks, past any run. It reports no fix.",
  "sensor.baro.missing": "Written to SIM_BAROn_DISABLE.",
  "sensor.baro.frozen": "Written to SIM_BAROn_FREEZE.",
  "sensor.mag.missing": "Written to SIM_MAGn_FAIL.",
  "gnss.constellation": "Worked out about 5 times a second from the vehicle's position: the tracked satellites go to SIM_GPS1_NUMSATS and σ·HDOP to SIM_GPS1_ACC. Each write is logged.",
  "gnss.atmosphere": "The position error the delays leave goes to SIM_GPS1_GLTCH, on top of what it held, about 5 times a second.",
  "gnss.terrain": "Satellites the run's terrain hides are left out of the solution; on the synthetic pad nothing is hidden. Written with the other GNSS effects about 5 times a second.",
  "gnss.jamming-budget": "Satellites below the tracking threshold are left out; without four the receiver's lock is held off through SIM_GPS1_LCKTIME, and it comes back when they return.",
  "gnss.receiver": "The other GNSS effects are worked out once per epoch of ArduPilot's receiver (SIM_GPS1_HZ), and each position error is written to SIM_GPS1_GLTCH its lag (SIM_GPS1_LAG_MS) after its epoch.",
  "gnss.code-noise": "Added to each satellite's range before the position solution, whose error goes to SIM_GPS1_GLTCH with the other GNSS effects.",
  "gnss.multipath": "Added to each satellite's range before the position solution, whose error goes to SIM_GPS1_GLTCH with the other GNSS effects.",
  "gnss.jammer": "Worked out from the vehicle's true position at each solution: lost satellites lower SIM_GPS1_NUMSATS, and without enough the lock is held off through SIM_GPS1_LCKTIME. The flight itself is untouched.",
  "baro.position-error": "Worked out on each tick from the vehicle's speed through the air, and written with the other barometer errors to SIM_BAROn_GLITCH about 10 times a second, on top of the Sensors tab's bias. Each write is logged.",
  "baro.ground-cushion": "Worked out on each tick from the rotors' thrust and the barometer's height above the ground, and written to SIM_BAROn_GLITCH about 10 times a second.",
  "baro.prop-wash": "Worked out on each tick from the rotors' thrust, and written to SIM_BAROn_GLITCH about 10 times a second.",
  "baro.drift": "Grows from the moment it goes on, and is written to SIM_BAROn_GLITCH about 10 times a second.",
  "baro.pressure-trend": "Grows from the moment it goes on, and is written to SIM_BAROn_GLITCH about 10 times a second; only the barometer sees it.",
};
