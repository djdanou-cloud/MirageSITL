/** Configuration-only schema for the torque ESC. No separate RPM governor. */
export interface MotorConfig {
  readonly kind: "torque";
  readonly resistanceOhm: number;
  readonly torqueConstantNmPerA: number;
  readonly currentLimitA: number;
  readonly commandTauS: number;
}
export function validateMotorConfig(value: unknown): MotorConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !("kind" in value) ||
    value.kind !== "torque" ||
    !("resistanceOhm" in value) ||
    !("torqueConstantNmPerA" in value) ||
    !("currentLimitA" in value) ||
    !("commandTauS" in value)
  )
    throw new Error("Invalid motor schema");
  const { resistanceOhm, torqueConstantNmPerA, currentLimitA, commandTauS } =
    value;
  if (
    typeof resistanceOhm !== "number" ||
    !Number.isFinite(resistanceOhm) ||
    resistanceOhm <= 0 ||
    typeof torqueConstantNmPerA !== "number" ||
    !Number.isFinite(torqueConstantNmPerA) ||
    torqueConstantNmPerA <= 0 ||
    typeof currentLimitA !== "number" ||
    !Number.isFinite(currentLimitA) ||
    currentLimitA <= 0 ||
    typeof commandTauS !== "number" ||
    !Number.isFinite(commandTauS) ||
    commandTauS <= 0
  )
    throw new Error("Invalid motor parameters");
  return Object.freeze({
    kind: "torque",
    resistanceOhm,
    torqueConstantNmPerA,
    currentLimitA,
    commandTauS,
  });
}
