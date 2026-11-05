import { columnText, readDataFlash, type DataFlashColumn, type DataFlashGroup, type DataFlashLog } from "@mirage/dataflash/reader";

// Create an experiment from a real log (TASK-182, S15): a log and an interval give what they can, field by field. Each field of the
// report is `extracted` with the message it came from, `user-supplied` through the UI, or `missing`, and what is missing is listed,
// never filled in. A run starts on the ground at home with stock simulated sensors: this is an experiment with this log's place and
// settings, not a replay of it, and the report says which values were read but cannot be used. TASK-183 compares against the log.
// Times are the log's own clock, TimeUS. Cold path.

export type ExtractionStatus = "extracted" | "user-supplied" | "missing";
export type ExtractionGroup = "initial conditions" | "parameters" | "task and control" | "weather" | "aircraft";
export interface ExtractionField {
  readonly key: string;
  readonly label: string;
  readonly group: ExtractionGroup;
  readonly status: ExtractionStatus;
  /** What the field holds, as a person reads it; null when missing. */
  readonly value: string | null;
  /** The log message it came from, or `the user`; null when missing. */
  readonly source: string | null;
  /** What becomes of it, when that is not obvious. */
  readonly note?: string;
}
export interface LogParameter { readonly name: string; readonly value: number; readonly defaultValue: number | null }
export interface SkippedParameter { readonly name: string; readonly value: number; readonly why: string }
export interface LogCommand { readonly timeS: number; readonly text: string }
export interface LogExtraction {
  readonly name: string;
  readonly bytes: number;
  /** The interval asked for, and all the log has. */
  readonly interval: { readonly fromS: number; readonly toS: number };
  readonly span: { readonly fromS: number; readonly toS: number };
  readonly fields: readonly ExtractionField[];
  /** Latitude and longitude in degrees, altitude in metres, heading in degrees; null when the log does not give the place. */
  readonly home: readonly [number, number, number, number] | null;
  /** What the new run will boot with: values the log held at the interval's start that differ from their defaults. */
  readonly parameters: readonly LogParameter[];
  /** What the log held and the run will not take, and why. */
  readonly skipped: readonly SkippedParameter[];
  readonly modes: readonly LogCommand[];
  readonly commands: readonly LogCommand[];
}

/** What a run on this machine sets itself, or what describes other hardware: a real log's calibration means nothing to a simulated sensor. */
const NOT_FOR_THIS_RUN: readonly (readonly [RegExp, string])[] = [
  [/^SIM_/, "A SITL setting of the run that wrote the log, not of the aircraft"],
  [/^(STAT_|FORMAT_VERSION$|SYSID_SW_)/, "A counter or version the firmware keeps"],
  [/(_DEVID$|_DEV_ID\d*$|_GND_PRESS$|^BARO_GND_TEMP$|^MIS_TOTAL$)/, "The firmware writes this itself as it starts"],
  [/^MAV\d+_/, "A telemetry rate the ground station that flew the log asked for"],
  [/^(SERIAL|BRD_|CAN_|NTF_|GPS\d?_|RNGFND|BATT\d?_MONITOR|BATT\d?_.*PIN)/, "It describes the hardware that wrote the log"],
  [/^(INS\d?_(ACC|GYR)|INS_POS|COMPASS_|AHRS_TRIM)/, "A calibration of the sensors that wrote the log"],
  [/^(FRAME_|MOT_PWM_|SERVO\d+_|SCR_|LOG_|SIM_)/, "The aircraft profile and the Logging tab set this for a run"],
];
const SIMULATED_TIME = 1e-6;

const groupOf = (log: DataFlashLog, name: string): DataFlashGroup | null => log.groups.find(group => group.name === name && group.count > 0) ?? null;
const column = (group: DataFlashGroup | null, name: string): DataFlashColumn | null => group?.columns.find(item => item.name === name) ?? null;
const timeS = (group: DataFlashGroup, row: number): number => Number(column(group, "TimeUS")?.values[row] ?? Number.NaN) * SIMULATED_TIME;
/** A numeric field in its unit. */
const numberAt = (group: DataFlashGroup | null, name: string, row: number): number | null => {
  const item = column(group, name);
  if (!item) return null;
  const value = Number(item.values[row]) * item.valueScale;
  return Number.isFinite(value) ? value : null;
};
/** The last row at or before `time`, and failing that the first row of the interval; null when neither is in it. */
function rowAt(group: DataFlashGroup | null, time: number, toS: number, keep: (row: number) => boolean = () => true): number | null {
  if (!group) return null;
  let found: number | null = null;
  for (let row = 0; row < group.count; row++) {
    if (!keep(row)) continue;
    const at = timeS(group, row);
    if (at <= time) found = row;
    else if (found === null && at <= toS) return row;
    else break;
  }
  return found;
}
const fixed = (value: number | null, digits: number) => (value === null ? "unknown" : value.toFixed(digits));

export function logSpan(log: DataFlashLog): { readonly fromS: number; readonly toS: number } | null {
  let from = Number.POSITIVE_INFINITY, to = Number.NEGATIVE_INFINITY;
  for (const group of log.groups) {
    if (group.name === "FMT" || group.name === "FMTU" || group.name === "UNIT" || group.name === "MULT" || !column(group, "TimeUS") || group.count === 0) continue;
    from = Math.min(from, timeS(group, 0));
    to = Math.max(to, timeS(group, group.count - 1));
  }
  return from <= to ? { fromS: from, toS: to } : null;
}

/**
 * What a log holds over an interval. Throws when the interval does not lie in the log. Each `missing` field is the disclosure the
 * wizard shows; the aircraft is always missing here, since a log never holds its mass and geometry, and the user supplies it.
 */
export function extractFromLog(name: string, bytes: Uint8Array, interval: { readonly fromS: number; readonly toS: number }): LogExtraction {
  const log = readDataFlash(bytes), span = logSpan(log);
  if (!span) throw new Error(`${name} holds no timed records`);
  const { fromS, toS } = interval;
  if (!(fromS <= toS) || !(toS >= span.fromS) || !(fromS <= span.toS)) throw new Error(`The interval ${fromS} s to ${toS} s does not lie in this log, which runs from ${span.fromS.toFixed(2)} s to ${span.toS.toFixed(2)} s`);
  const fields: ExtractionField[] = [];
  const found = (key: string, label: string, group: ExtractionGroup, value: string, source: string, note?: string) => fields.push({ key, label, group, status: "extracted", value, source, ...(note === undefined ? {} : { note }) });
  const missing = (key: string, label: string, group: ExtractionGroup, note?: string) => fields.push({ key, label, group, status: "missing", value: null, source: null, ...(note === undefined ? {} : { note }) });
  const start = "A run starts on the ground at home, so this is read and not flown from.";

  // Where it was.
  const orgn = groupOf(log, "ORGN"), att = groupOf(log, "ATT");
  const originRow = rowAt(orgn, fromS, toS), attitudeRow = rowAt(att, fromS, toS);
  const yaw = numberAt(att, "Yaw", attitudeRow ?? 0);
  let home: LogExtraction["home"] = null;
  const lat = originRow === null ? null : numberAt(orgn, "Lat", originRow), lng = originRow === null ? null : numberAt(orgn, "Lng", originRow), alt = originRow === null ? null : numberAt(orgn, "Alt", originRow);
  if (lat !== null && lng !== null && alt !== null) {
    home = [lat, lng, alt, attitudeRow === null || yaw === null ? 0 : yaw];
    found("home", "Home", "initial conditions", `${lat.toFixed(7)}°, ${lng.toFixed(7)}°, ${alt.toFixed(2)} m`, "ORGN", "The new run starts here.");
  } else missing("home", "Home", "initial conditions", "The new run starts at the Run tab's own home.");
  if (attitudeRow !== null) found("attitude", "Attitude at the start", "initial conditions", `roll ${fixed(numberAt(att, "Roll", attitudeRow), 2)}°, pitch ${fixed(numberAt(att, "Pitch", attitudeRow), 2)}°, yaw ${fixed(yaw, 2)}°`, "ATT", start);
  else missing("attitude", "Attitude at the start", "initial conditions");
  const xkf = groupOf(log, "XKF1"), coreOf = (group: DataFlashGroup) => (row: number) => numberAt(group, "C", row) === 0;
  const stateRow = xkf ? rowAt(xkf, fromS, toS, coreOf(xkf)) : null;
  if (xkf && stateRow !== null) {
    found("position", "Position from the origin", "initial conditions", `north ${fixed(numberAt(xkf, "PN", stateRow), 2)} m, east ${fixed(numberAt(xkf, "PE", stateRow), 2)} m, down ${fixed(numberAt(xkf, "PD", stateRow), 2)} m`, "XKF1, core 0", start);
    found("velocity", "Velocity at the start", "initial conditions", `north ${fixed(numberAt(xkf, "VN", stateRow), 2)} m/s, east ${fixed(numberAt(xkf, "VE", stateRow), 2)} m/s, down ${fixed(numberAt(xkf, "VD", stateRow), 2)} m/s`, "XKF1, core 0", start);
  } else { missing("position", "Position from the origin", "initial conditions"); missing("velocity", "Velocity at the start", "initial conditions"); }
  const bat = groupOf(log, "BAT"), batRow = bat ? rowAt(bat, fromS, toS, row => numberAt(bat, "Inst", row) === 0) : null;
  if (bat && batRow !== null) found("battery", "Battery at the start", "initial conditions", `${fixed(numberAt(bat, "Volt", batRow), 2)} V, ${fixed(numberAt(bat, "CurrTot", batRow), 1)} mAh used`, "BAT", "The aircraft profile's battery starts full.");
  else missing("battery", "Battery at the start", "initial conditions");

  // What it was set to.
  const parm = groupOf(log, "PARM"), names = column(parm, "Name"), values = column(parm, "Value"), defaults = column(parm, "Default");
  const held = new Map<string, LogParameter>();
  if (parm && names && values) {
    for (let row = 0; row < parm.count; row++) {
      if (timeS(parm, row) > fromS && held.has(columnText(names, row))) continue;
      const parameter = columnText(names, row), fallback = defaults ? Number(defaults.values[row]) : Number.NaN;
      held.set(parameter, { name: parameter, value: Number(values.values[row]), defaultValue: Number.isFinite(fallback) ? fallback : null });
    }
  }
  const parameters: LogParameter[] = [], skipped: SkippedParameter[] = [];
  for (const parameter of [...held.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (parameter.defaultValue !== null && parameter.value === parameter.defaultValue) continue;
    const refused = NOT_FOR_THIS_RUN.find(([pattern]) => pattern.test(parameter.name));
    if (refused) skipped.push({ name: parameter.name, value: parameter.value, why: refused[1] });
    else parameters.push(parameter);
  }
  if (held.size > 0) {
    found("parameters", "Parameters", "parameters", `${held.size} in the log; ${parameters.length} differ from their defaults and go to the new run, ${skipped.length} do not`, "PARM");
    const firmwareFrame = [held.get("FRAME_CLASS"), held.get("FRAME_TYPE")];
    if (firmwareFrame[0] && firmwareFrame[1]) found("frame", "Frame in the log", "aircraft", `FRAME_CLASS ${firmwareFrame[0].value}, FRAME_TYPE ${firmwareFrame[1].value}`, "PARM", "The chosen aircraft profile sets the frame of the new run.");
    else missing("frame", "Frame in the log", "aircraft");
  } else { missing("parameters", "Parameters", "parameters", "The new run boots with the aircraft profile's parameters alone."); missing("frame", "Frame in the log", "aircraft"); }

  // What it was told to do.
  const modeGroup = groupOf(log, "MODE"), modeName = column(modeGroup, "Mode"), modes: LogCommand[] = [];
  const modeRow = rowAt(modeGroup, fromS, toS);
  if (modeGroup && modeRow !== null) {
    for (let row = modeRow; row < modeGroup.count; row++) {
      const at = timeS(modeGroup, row);
      if (at > toS) break;
      modes.push({ timeS: at, text: `Mode ${numberAt(modeGroup, "ModeNum", row) ?? (modeName ? Number(modeName.values[row]) : "unknown")}` });
    }
    found("modes", "Flight modes", "task and control", modes.map(mode => `${mode.timeS.toFixed(2)} s: ${mode.text}`).join("; "), "MODE", "Not replayed: the new run flies what the Run tab asks of it.");
  } else missing("modes", "Flight modes", "task and control");
  const commands: LogCommand[] = [];
  const cmd = groupOf(log, "CMD");
  if (cmd) for (let row = 0; row < cmd.count; row++) { const at = timeS(cmd, row); if (at >= fromS && at <= toS) commands.push({ timeS: at, text: `Mission item ${numberAt(cmd, "CNum", row) ?? "?"}, command ${numberAt(cmd, "CId", row) ?? "?"}` }); }
  const mavc = groupOf(log, "MAVC");
  if (mavc) for (let row = 0; row < mavc.count; row++) { const at = timeS(mavc, row); if (at >= fromS && at <= toS) commands.push({ timeS: at, text: `MAVLink command ${numberAt(mavc, "Cmd", row) ?? "?"}` }); }
  commands.sort((a, b) => a.timeS - b.timeS);
  if (cmd || mavc) found("commands", "Commands in the interval", "task and control", `${commands.length}`, [cmd ? "CMD" : "", mavc ? "MAVC" : ""].filter(Boolean).join(", "), "Not replayed: a mission or a command stream is a flight task of its own.");
  else missing("commands", "Commands in the interval", "task and control", "The log records none, so what the aircraft was told to do is not known.");
  const rcin = groupOf(log, "RCIN");
  let sticks = 0;
  if (rcin) for (let row = 0; row < rcin.count; row++) { const at = timeS(rcin, row); if (at >= fromS && at <= toS) sticks++; }
  if (sticks > 0) found("pilot", "Pilot input", "task and control", `${sticks} samples in the interval`, "RCIN", "Not replayed.");
  else missing("pilot", "Pilot input", "task and control");

  // What the air was doing.
  const xkf2 = groupOf(log, "XKF2"), windRow = xkf2 ? rowAt(xkf2, fromS, toS, coreOf(xkf2)) : null;
  if (xkf2 && windRow !== null) found("wind", "Wind", "weather", `north ${fixed(numberAt(xkf2, "VWN", windRow), 2)} m/s, east ${fixed(numberAt(xkf2, "VWE", windRow), 2)} m/s`, "XKF2, core 0", "The EKF's estimate, not a measurement; not applied to the new run. Set the weather yourself if you want it.");
  else missing("wind", "Wind", "weather");
  const baro = groupOf(log, "BARO"), baroRow = baro ? rowAt(baro, fromS, toS, row => numberAt(baro, "I", row) === 0) : null;
  const pressure = baroRow === null ? null : numberAt(baro, "Press", baroRow), temperature = baroRow === null ? null : numberAt(baro, "Temp", baroRow);
  if (pressure !== null) found("pressure", "Air pressure", "weather", `${pressure.toFixed(0)} Pa`, "BARO", "Not applied to the new run.");
  else missing("pressure", "Air pressure", "weather");
  if (temperature !== null) found("temperature", "Sensor temperature", "weather", `${temperature.toFixed(1)} °C`, "BARO", "The barometer's own temperature, not the air's; not applied to the new run.");
  else missing("temperature", "Sensor temperature", "weather");
  missing("turbulence", "Turbulence", "weather", "No log holds it.");

  // What it was: a log never holds this.
  missing("aircraft", "Aircraft profile", "aircraft", "Choose the aircraft for the new run; a log does not hold its mass, geometry or propulsion.");
  const version = groupOf(log, "VER"), fws = column(version, "FWS");
  if (version && fws) found("firmware", "Firmware in the log", "aircraft", columnText(fws, 0), "VER", "The new run flies the build the Run tab chooses.");
  else missing("firmware", "Firmware in the log", "aircraft");
  return { name, bytes: bytes.length, interval: { fromS, toS }, span, fields, home, parameters, skipped, modes, commands };
}

/** A field the user supplied in the wizard, in place of its missing one. */
export function withSupplied(extraction: LogExtraction, key: string, value: string): LogExtraction {
  if (!extraction.fields.some(field => field.key === key && field.status !== "extracted")) throw new Error(`${key} is not missing from this extraction`);
  return { ...extraction, fields: extraction.fields.map(field => (field.key === key ? { ...field, status: "user-supplied", value, source: "the user" } : field)) };
}
export const missingFields = (extraction: LogExtraction) => extraction.fields.filter(field => field.status === "missing");
