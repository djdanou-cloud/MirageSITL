import catalogFile from '../../../tests/fixtures/sitl/frames.json' with { type: 'json' };
import type { AircraftProfile } from './profile.ts';
import { sinCos } from './trig.ts';

// ArduPilot frame and allocation parameters of an aircraft profile (TASK-142,
// S03). The only source is the TASK-128 catalog of the pinned firmware
// (tests/fixtures/sitl/frames.json): its stock X frames and its stock
// scripting-matrix frame, whose parameters TASK-128 set, read back and flew
// on native ArduCopter. A profile whose motors sit at a stock frame's azimuths
// with its spins, on equal arms, uses that frame; any other controllable
// layout uses the scripting matrix with a generated Lua file. Anything else is
// refused with structured reasons. Configuration-time code only.

export type FrameKind = 'stock' | 'stock-scripting';
export type FrameReasonCode = 'no-yaw-authority' | 'no-roll-authority' | 'no-pitch-authority' | 'dependent-axes';
export type FrameNoteCode =
  | 'stock-frame' | 'scripting-frame' | 'stock-spin-mismatch' | 'stock-unequal-arms' | 'coaxial-level-differs'
  | 'thrust-axis-tilt-ignored' | 'thirty-two-channel-packets';
export interface FrameIssue<Code extends string> {
  readonly code: Code;
  readonly message: string;
}
export interface MappedMotor {
  readonly motorId: number;
  /** ArduPilot servo output, SERVOn. */
  readonly output: number;
  /** ArduPilot motor number, 1-based (Motor1 is motor 1). */
  readonly ardupilotMotor: number;
  /** SERVOn_FUNCTION value of that motor. */
  readonly servoFunction: number;
  /** ArduPilot-normalized factors: the largest roll, pitch and yaw magnitudes are 0.5. */
  readonly rollFactor: number;
  readonly pitchFactor: number;
  readonly yawFactor: number;
  readonly testOrder: number;
}
export interface ParameterValue {
  readonly name: string;
  readonly value: number;
}
interface Source {
  readonly ardupilotCommit: string;
  readonly firmwareVersion: string;
  readonly catalogSchemaVersion: number;
}
export type FrameConfiguration =
  | {
    readonly ok: true;
    /** The profile version the parameters belong to, or null for an unsaved profile. */
    readonly profileSha256: string | null;
    readonly source: Source;
    readonly kind: FrameKind;
    /** The catalog frame whose layout the profile matches, or null. */
    readonly catalogFrameId: string | null;
    readonly frameClass: number;
    readonly frameType: number;
    readonly servoPacketChannels: 16 | 32;
    /** In ascending motor ID order. */
    readonly motors: readonly MappedMotor[];
    readonly parameters: readonly ParameterValue[];
    /** The Lua file of a scripting frame, for the SITL scripts directory; null for a stock frame. */
    readonly script: string | null;
    readonly notes: readonly FrameIssue<FrameNoteCode>[];
  }
  | {
    readonly ok: false;
    readonly profileSha256: string | null;
    readonly source: Source;
    readonly reasons: readonly FrameIssue<FrameReasonCode>[];
    readonly notes: readonly FrameIssue<FrameNoteCode>[];
  };

interface CatalogMotor {
  readonly motor: number;
  readonly azimuthDeg: number;
  readonly spin: 'CCW' | 'CW';
  readonly heightM: number;
  readonly testOrder: number;
  readonly rollFactor: number;
  readonly pitchFactor: number;
  readonly normalizedYawFactor: number;
}
interface CatalogFrame {
  readonly id: string;
  readonly kind: FrameKind;
  readonly frameClass: number;
  readonly frameType: number;
  readonly servoPacketChannels: 16 | 32;
  readonly motors: readonly CatalogMotor[];
}
interface FrameCatalog {
  readonly source: Source;
  readonly frames: readonly CatalogFrame[];
  /** SERVOn_FUNCTION value of ArduPilot motor m at index m - 1. */
  readonly motorFunctions: readonly number[];
  readonly servoCapacity: number;
  readonly servo32Enable: string;
  readonly scriptingEnable: string;
}

/** Azimuths that agree to this are the same stock motor position. */
const AZIMUTH_TOLERANCE_DEG = 1e-9;
/** Raw factors below this, relative to the largest, carry no authority. */
const AUTHORITY_TOLERANCE = 1e-9;

function invalid(message: string): never {
  throw new Error(`Invalid TASK-128 frame catalog: ${message}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function num(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be a finite number`);
  return value;
}
function str(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') invalid(`${label} must be text`);
  return value;
}
function listOf(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be a list`);
  const items: readonly unknown[] = value;
  return items;
}

/** Validates the fields of the TASK-128 catalog this module uses. Cold. */
export function parseFrameCatalog(input: unknown): FrameCatalog {
  if (!isRecord(input) || input.schemaVersion !== 1) invalid('unsupported schema');
  const limits = input.limits;
  if (!isRecord(limits)) invalid('limits missing');
  const functions = listOf(input.motorFunctions, 'motor functions').map((item, index) => {
    if (!isRecord(item) || item.motor !== index + 1) invalid('motor functions must list motors 1, 2, … in order');
    return num(item.function, `function of motor ${index + 1}`);
  });
  const frames = listOf(input.frames, 'frames').map((item): CatalogFrame => {
    if (!isRecord(item)) invalid('frame must be an object');
    const id = str(item.id, 'frame ID');
    if (item.kind !== 'stock' && item.kind !== 'stock-scripting') invalid(`frame ${id} has an unknown kind`);
    if (item.servoPacketChannels !== 16 && item.servoPacketChannels !== 32) invalid(`frame ${id} has an unknown packet width`);
    const motors = listOf(item.motors, `motors of ${id}`).map((entry, index): CatalogMotor => {
      if (!isRecord(entry) || entry.motor !== index + 1) invalid(`frame ${id} must list motors 1, 2, … in order`);
      if (entry.spin !== 'CCW' && entry.spin !== 'CW') invalid(`frame ${id} motor ${index + 1} has an unknown spin`);
      return {
        motor: index + 1, azimuthDeg: num(entry.azimuthDeg, 'azimuth'), spin: entry.spin, heightM: num(entry.heightM, 'height'),
        testOrder: num(entry.testOrder, 'test order'), rollFactor: num(entry.rollFactor, 'roll factor'),
        pitchFactor: num(entry.pitchFactor, 'pitch factor'), normalizedYawFactor: num(entry.normalizedYawFactor, 'yaw factor'),
      };
    });
    if (motors.length !== num(item.motorCount, 'motor count')) invalid(`frame ${id} motor count`);
    return {
      id, kind: item.kind, frameClass: num(item.frameClass, 'frame class'), frameType: num(item.frameType, 'frame type'),
      servoPacketChannels: item.servoPacketChannels, motors,
    };
  });
  if (frames.filter(frame => frame.kind === 'stock-scripting').length !== 1) invalid('exactly one scripting frame expected');
  return {
    source: {
      ardupilotCommit: str(input.ardupilotCommit, 'commit'), firmwareVersion: str(input.firmwareVersion, 'firmware version'),
      catalogSchemaVersion: 1,
    },
    frames, motorFunctions: functions,
    servoCapacity: num(limits.sitlServoCapacity, 'servo capacity'),
    servo32Enable: str(limits.servo32EnableParameter, 'servo 32 parameter'),
    scriptingEnable: str(limits.scriptingEnableParameter, 'scripting parameter'),
  };
}

const raw: unknown = catalogFile;
const CATALOG = parseFrameCatalog(raw);
/** Every name this module may write: the frame and output names TASK-128 set and read back on the pinned firmware. */
export const FRAME_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  'FRAME_CLASS', 'FRAME_TYPE', CATALOG.servo32Enable, CATALOG.scriptingEnable,
  ...Array.from({ length: CATALOG.servoCapacity }, (_, index) => `SERVO${index + 1}_FUNCTION`),
]);

function wrapDeg(value: number): number {
  let wrapped = value % 360;
  if (wrapped <= -180) wrapped += 360;
  if (wrapped > 180) wrapped -= 360;
  return wrapped;
}
function profileMotorGeometry(profile: AircraftProfile) {
  const arms = new Map(profile.arms.map(arm => [arm.id, arm]));
  return profile.motors.map(motor => {
    // The profile check guarantees every motor names one of its arms.
    const arm = arms.get(motor.armId)!;
    const { sin, cos } = sinCos(arm.azimuthRad);
    return {
      motor, arm, azimuthDeg: wrapDeg(arm.azimuthRad * 180 / Math.PI), spin: motor.spin === 'ccw' ? 'CCW' as const : 'CW' as const,
      xM: arm.lengthM * cos, yM: arm.lengthM * sin,
    };
  });
}
type Geometry = ReturnType<typeof profileMotorGeometry>;

/** Pairs each profile motor with the catalog motor at its azimuth; null unless the pairing is one to one. */
function pairByAzimuth(geometry: Geometry, frame: CatalogFrame, withSpin: boolean): (CatalogMotor | null)[] | null {
  if (frame.motors.length !== geometry.length) return null;
  const taken = new Set<number>();
  const pairs = geometry.map(item => {
    const match = frame.motors.find(motor => !taken.has(motor.motor) && (!withSpin || motor.spin === item.spin) &&
      Math.abs(wrapDeg(motor.azimuthDeg - item.azimuthDeg)) <= AZIMUTH_TOLERANCE_DEG);
    if (match) taken.add(match.motor);
    return match ?? null;
  });
  return pairs.every(pair => pair !== null) ? pairs : null;
}
function rank(rows: readonly (readonly number[])[]): number {
  const m = rows.map(row => Float64Array.from(row));
  const columns = m[0]?.length ?? 0;
  let r = 0;
  for (let c = 0; c < columns && r < m.length; c++) {
    let pivot = r;
    for (let i = r + 1; i < m.length; i++) if (Math.abs(m[i]![c]!) > Math.abs(m[pivot]![c]!)) pivot = i;
    const top = m[pivot]!;
    if (Math.abs(top[c]!) <= AUTHORITY_TOLERANCE) continue;
    m[pivot] = m[r]!;
    m[r] = top;
    for (let i = r + 1; i < m.length; i++) {
      const row = m[i]!, f = row[c]! / top[c]!;
      for (let k = c; k < columns; k++) row[k] = row[k]! - f * top[k]!;
    }
    r++;
  }
  return r;
}
function normalize(values: readonly number[]): number[] {
  const largest = Math.max(...values.map(Math.abs));
  return values.map(value => (value === 0 ? 0 : 0.5 * value / largest));
}

/** One `NAME value` line per parameter: the ArduPilot parameter file of the frame. */
export function parameterFileText(parameters: readonly ParameterValue[]): string {
  return parameters.map(parameter => `${parameter.name} ${parameter.value}\n`).join('');
}

/**
 * The frame, output functions and allocation of a validated profile. A stock
 * frame needs equal arms and every motor at one of its azimuths with its
 * spin; otherwise the scripting matrix is used, if the layout can control
 * thrust, roll, pitch and yaw independently.
 */
export function frameConfiguration(profile: AircraftProfile, profileSha256: string | null = null): FrameConfiguration {
  const geometry = profileMotorGeometry(profile);
  const notes: FrameIssue<FrameNoteCode>[] = [];
  const tilted = profile.arms.filter(arm => arm.outwardTiltRad !== 0 || arm.sideTiltRad !== 0).map(arm => arm.id);
  if (tilted.length > 0) {
    notes.push({
      code: 'thrust-axis-tilt-ignored',
      message: `Arms ${tilted.join(', ')} are tilted. ArduPilot's matrix allocation assumes vertical thrust axes: the simulation applies the tilt, the allocation does not compensate for it.`,
    });
  }
  const equalArms = profile.arms.every(arm => arm.lengthM === profile.arms[0]!.lengthM);
  const stock = CATALOG.frames.filter(frame => frame.kind === 'stock');
  for (const frame of stock) {
    const pairs = pairByAzimuth(geometry, frame, true);
    if (!pairs) continue;
    if (!equalArms) {
      notes.push({ code: 'stock-unequal-arms', message: `The motors sit at the azimuths of stock ${frame.id} with its spins, but the arms differ in length; stock allocation assumes equal arms, so the scripting matrix is used.` });
      break;
    }
    const matched = pairs.map(pair => pair!);
    const levelsDiffer = geometry.some((item, index) => item.motor.level !== 'single' &&
      (item.motor.level === 'upper') !== (matched[index]!.heightM < 0));
    if (levelsDiffer) {
      notes.push({ code: 'coaxial-level-differs', message: `Some coaxial motors are on the other level than in stock ${frame.id}. ArduPilot allocates by azimuth and spin only, so the frame still applies.` });
    }
    notes.push({ code: 'stock-frame', message: `Stock ${frame.id} (FRAME_CLASS ${frame.frameClass}, FRAME_TYPE ${frame.frameType}) of the pinned firmware.` });
    const motors = geometry.map((item, index): MappedMotor => {
      const motor = matched[index]!;
      return {
        motorId: item.motor.id, output: item.motor.output, ardupilotMotor: motor.motor, servoFunction: CATALOG.motorFunctions[motor.motor - 1]!,
        rollFactor: motor.rollFactor, pitchFactor: motor.pitchFactor, yawFactor: motor.normalizedYawFactor, testOrder: motor.testOrder,
      };
    });
    return finish(profileSha256, frame, frame.id, motors, null, notes);
  }
  for (const frame of stock) {
    if (pairByAzimuth(geometry, frame, false) && !pairByAzimuth(geometry, frame, true)) {
      notes.push({ code: 'stock-spin-mismatch', message: `The motors sit at the azimuths of stock ${frame.id}, but their spins differ from it, so the stock frame would allocate yaw wrongly; the scripting matrix is used.` });
    }
  }
  const largestArm = Math.max(...profile.arms.map(arm => arm.lengthM));
  const roll = geometry.map(item => -item.yM / largestArm);
  const pitch = geometry.map(item => item.xM / largestArm);
  const yaw = geometry.map(item => (item.spin === 'CCW' ? 1 : -1));
  const reasons: FrameIssue<FrameReasonCode>[] = [];
  if (yaw.every(value => value === yaw[0])) {
    reasons.push({ code: 'no-yaw-authority', message: 'Every motor turns the same way, so no allocation can control yaw. Give both spin directions.' });
  }
  if (Math.max(...roll.map(Math.abs)) <= AUTHORITY_TOLERANCE) {
    reasons.push({ code: 'no-roll-authority', message: 'No motor is off the body x axis, so no allocation can control roll.' });
  }
  if (Math.max(...pitch.map(Math.abs)) <= AUTHORITY_TOLERANCE) {
    reasons.push({ code: 'no-pitch-authority', message: 'No motor is off the body y axis, so no allocation can control pitch.' });
  }
  if (reasons.length === 0 && rank([geometry.map(() => 1), roll, pitch, yaw]) < 4) {
    reasons.push({ code: 'dependent-axes', message: `With ${geometry.length} motors in this layout, thrust, roll, pitch and yaw cannot be controlled independently; ArduPilot's matrix needs at least four motors in a layout that separates them.` });
  }
  if (reasons.length > 0) return deepFreeze<FrameConfiguration>({ ok: false, profileSha256, source: CATALOG.source, reasons, notes });
  // The parser checked there is exactly one scripting frame.
  const scripting = CATALOG.frames.find(frame => frame.kind === 'stock-scripting')!;
  const flown = pairByAzimuth(geometry, scripting, true) && equalArms ? scripting.id : null;
  notes.push({ code: 'scripting-frame', message: `No stock frame of the pinned firmware matches, so the stock scripting matrix is used: ${CATALOG.scriptingEnable} 1 and the generated Lua file in the SITL scripts directory.${flown ? ` TASK-128 flew this layout as ${flown}.` : ''}` });
  notes.push({ code: 'thirty-two-channel-packets', message: `The scripting frame uses ${CATALOG.servo32Enable} 1 and 32-channel servo packets, as TASK-128 flew it; motors stay on outputs 1 to 16.` });
  const rollN = normalize(roll), pitchN = normalize(pitch), yawN = normalize(yaw);
  const motors = geometry.map((item, index): MappedMotor => ({
    motorId: item.motor.id, output: item.motor.output, ardupilotMotor: index + 1, servoFunction: CATALOG.motorFunctions[index]!,
    rollFactor: rollN[index]!, pitchFactor: pitchN[index]!, yawFactor: yawN[index]!, testOrder: index + 1,
  }));
  let script = `-- MirageSITL frame of aircraft profile ${profileSha256 ?? '(unsaved)'} through the stock MotorsMatrix scripting interface.\n`;
  geometry.forEach((_, index) => {
    script += `MotorsMatrix:add_motor_raw(${index}, ${roll[index]!}, ${pitch[index]!}, ${yaw[index]!}, ${index + 1})\n`;
  });
  script += `assert(MotorsMatrix:init(${geometry.length}), "MirageSITL frame init failed")\n`;
  script += `motors:set_frame_string("MirageSITL matrix")\ngcs:send_text(6, "MirageSITL frame ready: ${geometry.length}")\n`;
  return finish(profileSha256, scripting, flown, motors, script, notes);
}

function finish(
  profileSha256: string | null, frame: CatalogFrame, catalogFrameId: string | null,
  motors: readonly MappedMotor[], script: string | null, notes: readonly FrameIssue<FrameNoteCode>[],
): FrameConfiguration {
  const parameters: ParameterValue[] = [
    { name: 'FRAME_CLASS', value: frame.frameClass },
    { name: 'FRAME_TYPE', value: frame.frameType },
    { name: CATALOG.servo32Enable, value: frame.servoPacketChannels === 32 ? 1 : 0 },
  ];
  if (frame.kind === 'stock-scripting') parameters.push({ name: CATALOG.scriptingEnable, value: 1 });
  for (let output = 1; output <= frame.servoPacketChannels; output++) {
    const motor = motors.find(item => item.output === output);
    parameters.push({ name: `SERVO${output}_FUNCTION`, value: motor?.servoFunction ?? 0 });
  }
  for (const parameter of parameters) {
    if (!FRAME_PARAMETER_NAMES.has(parameter.name)) throw new Error(`${parameter.name} is not a TASK-128 catalog parameter`);
  }
  const configuration: FrameConfiguration = {
    ok: true, profileSha256, source: CATALOG.source, kind: frame.kind, catalogFrameId, frameClass: frame.frameClass,
    frameType: frame.frameType, servoPacketChannels: frame.servoPacketChannels, motors, parameters, script, notes,
  };
  return deepFreeze(configuration);
}
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
