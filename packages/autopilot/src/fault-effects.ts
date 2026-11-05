import type { EffectId } from "@mirage/protocol";

// ArduPilot's own fault parameters behind the `ardupilot` effects of TASK-168. Each name is in the pinned source catalog, which
// tests/fault-effects.test.ts checks, along with the source that gives each its meaning:
// SIM_ACC_FAIL_MSK and SIM_GYR_FAIL_MSK: AP_InertialSensor_SITL stops generating samples for the instances in the mask.
// SIM_GPS1_LCKTIME = 32767, its largest: SIM_GPS.cpp has no lock until that many seconds, about 9 h of simulated time. SIM_GPS1_ENABLE would
// also end the lock, but it is the group's AP_PARAM_FLAG_ENABLE: writing 0 hides the group and renumbers ArduPilot's whole parameter list.
// SIM_BAROn_DISABLE: AP_Baro_SITL stops. SIM_BAROn_FREEZE: it reports the last altitude.
// SIM_MAGn_FAIL: AP_Compass_SITL stops.

export interface FaultParameter { readonly name: string; readonly on: number }
const INSTANCES = 7;
export const ARDUPILOT_FAULT_PARAMETERS = {
  "sensor.imu.missing": [{ name: "SIM_ACC_FAIL_MSK", on: INSTANCES }, { name: "SIM_GYR_FAIL_MSK", on: INSTANCES }],
  "sensor.gnss.missing": [{ name: "SIM_GPS1_LCKTIME", on: 32767 }],
  "sensor.baro.missing": [{ name: "SIM_BARO_DISABLE", on: 1 }, { name: "SIM_BAR2_DISABLE", on: 1 }, { name: "SIM_BAR3_DISABLE", on: 1 }],
  "sensor.baro.frozen": [{ name: "SIM_BARO_FREEZE", on: 1 }, { name: "SIM_BAR2_FREEZE", on: 1 }, { name: "SIM_BAR3_FREEZE", on: 1 }],
  "sensor.mag.missing": [{ name: "SIM_MAG1_FAIL", on: 1 }, { name: "SIM_MAG2_FAIL", on: 1 }, { name: "SIM_MAG3_FAIL", on: 1 }],
} as const satisfies Partial<Record<EffectId, readonly FaultParameter[]>>;
export function faultParameters(effect: EffectId): readonly FaultParameter[] | null {
  return Object.hasOwn(ARDUPILOT_FAULT_PARAMETERS, effect) ? ARDUPILOT_FAULT_PARAMETERS[effect as keyof typeof ARDUPILOT_FAULT_PARAMETERS] : null;
}
