import { validateVehicleManifest, type VehicleManifest } from './vehicle-manifest.ts';

// Deterministic ArduPilot parameter profile from a v2 vehicle manifest
// (TASK-087). Only parameter names with repository evidence are emitted:
// FRAME_CLASS/FRAME_TYPE/MOT_PWM_MIN/MOT_PWM_MAX (scripts/sitl/driver.mjs,
// scripts/prepare-autopilot-parity.mjs, packages/autopilot/src/external-sitl.ts)
// and MOT_BAT_VOLT_MIN/MOT_BAT_VOLT_MAX (scripts/prepare-autopilot-parity.mjs).

export const ARDUPILOT_PROFILE_VERSION = 1;

/**
 * `.parm` text: two comment lines, then `NAME value` lines sorted by name,
 * LF line endings and a final newline. Throws when the vehicle lacks the
 * data a parameter needs; nothing is defaulted.
 */
export function ardupilotParameterProfile(vehicle: { readonly sha256: string; readonly manifest: VehicleManifest }): string {
  if (!/^[a-f0-9]{64}$/.test(vehicle.sha256)) throw new Error('Invalid manifest hash');
  const manifest = validateVehicleManifest(vehicle.manifest);
  const frame = manifest.ardupilot;
  // validateVehicleManifest admits only the evidenced quad X frame and checks its geometry.
  if (!frame) throw new Error('The vehicle declares no ArduPilot frame');
  let pwmMinUs = 0, pwmMaxUs = 0;
  for (const rotor of manifest.rotors) {
    const motor = manifest.motors.find(item => item.rotorId === rotor.id);
    const esc = motor && manifest.escs.find(item => item.motorId === motor.id);
    if (!esc) throw new Error(`Rotor ${rotor.id} has no motor and ESC; MOT_PWM_MIN/MAX need every ESC range`);
    if (pwmMaxUs === 0) { pwmMinUs = esc.pwmMinUs; pwmMaxUs = esc.pwmMaxUs; }
    // MOT_PWM_MIN/MAX are shared by all motor outputs.
    else if (esc.pwmMinUs !== pwmMinUs || esc.pwmMaxUs !== pwmMaxUs) throw new Error('ESC PWM ranges differ; MOT_PWM_MIN/MAX are shared');
  }
  const parameters: [string, number][] = [
    ['FRAME_CLASS', frame.frameClass], ['FRAME_TYPE', frame.frameType],
    // No MirageSITL path delivers battery voltage before TASK-092, so voltage
    // compensation stays disabled exactly as in the TASK-047 parity defaults.
    ['MOT_BAT_VOLT_MAX', 0], ['MOT_BAT_VOLT_MIN', 0],
    ['MOT_PWM_MAX', pwmMaxUs], ['MOT_PWM_MIN', pwmMinUs],
  ];
  parameters.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lines = [`# MirageSITL ArduPilot parameter profile v${ARDUPILOT_PROFILE_VERSION}`,
    `# modelId ${manifest.modelId}; manifest sha256 ${vehicle.sha256}`];
  for (const [name, value] of parameters) lines.push(`${name} ${String(value)}`);
  return lines.join('\n') + '\n';
}
