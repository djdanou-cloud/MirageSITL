import { expect, it } from "vitest";
import { validateMotorConfig } from "../packages/physics/src/motor-config";
it("admits only finite positive torque-model configuration", () => {
  const c = {
    kind: "torque",
    resistanceOhm: 0.2,
    torqueConstantNmPerA: 0.02,
    currentLimitA: 10,
    commandTauS: 0.1,
  };
  expect(Object.isFrozen(validateMotorConfig(c))).toBe(true);
  for (const value of [
    { ...c, kind: "governor" },
    { ...c, resistanceOhm: 0 },
    { ...c, currentLimitA: NaN },
    { ...c, omegaTarget: 100 },
    null,
  ])
    expect(() => validateMotorConfig(value)).toThrow();
});
