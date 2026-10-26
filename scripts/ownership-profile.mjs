// Prints the validated ArduPilot parameter profile for a sensor-error ownership
// choice (TASK-089), checked against the pinned-source catalog.
//
//   node scripts/ownership-profile.mjs --imu-noise-floor ardupilot|off [--path native-json|browser-hal]
//   node scripts/ownership-profile.mjs --matrix MATRIX.json
//
// --imu-noise-floor ardupilot (the default choice) prints no settings: the
// firmware keeps its own defaults. "off" prints SIM_ACC_FLOOR 0 and
// SIM_GYR_FLOOR 0, which only firmware built by scripts/build-ardupilot-sitl.mjs
// defines; unpatched firmware skips unknown defaults-file names silently, so
// confirm the values with a parameter read back from the running firmware.
// Exit 0 printed, 1 invalid choice or matrix.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { imuNoiseFloorMatrix, isImuNoiseFloorSetting, ownershipParameterProfile, parseArduPilotCatalog } from "../packages/autopilot/src/error-ownership.ts";

const catalogPath = fileURLToPath(new URL("../tests/fixtures/sitl/ardupilot-catalog.json", import.meta.url));

export function profileFor(args) {
  const catalog = parseArduPilotCatalog(JSON.parse(readFileSync(catalogPath, "utf8")));
  if (args.length === 2 && args[0] === "--matrix") return ownershipParameterProfile(JSON.parse(readFileSync(args[1], "utf8")), catalog);
  if ((args.length === 2 || args.length === 4) && args[0] === "--imu-noise-floor" && (args.length === 2 || args[2] === "--path")) {
    const setting = args[1], path = args[3] ?? "native-json";
    if (!isImuNoiseFloorSetting(setting)) throw new Error("--imu-noise-floor must be ardupilot or off");
    if (path !== "native-json" && path !== "browser-hal") throw new Error("--path must be native-json or browser-hal");
    return ownershipParameterProfile(imuNoiseFloorMatrix(setting, path), catalog);
  }
  throw new Error("Expected --imu-noise-floor ardupilot|off [--path native-json|browser-hal] or --matrix MATRIX.json");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(profileFor(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
