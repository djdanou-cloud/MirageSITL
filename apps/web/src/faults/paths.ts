import type { EffectFamily, EffectId } from "@mirage/protocol";

// How each effect of the tab reaches a run with ArduPilot (TASK-168, TASK-169), as a person reads it. The physics truth never changes for
// a sensor or link effect; a motor fault changes the physical actuation.

export const FAMILY_LABELS: Readonly<Partial<Record<EffectFamily, string>>> = {
  fault: "Interference and motor faults",
  delivery: "Frozen readings and lost links",
  ardupilot: "ArduPilot's own sensor faults",
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
};
