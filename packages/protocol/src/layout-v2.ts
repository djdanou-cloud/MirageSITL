/**
 * ABI v2 shared memory layout (docs/SPECS_SHARED_MEMORY.md section 3).
 * Independent of v1: a v1 buffer is never interpreted as v2. All shared words
 * are accessed through Atomics on an Int32Array; float payloads are packed
 * through a local little-endian DataView.
 */
export type PhysicsHz = 400 | 800 | 1200;
export const PHYSICS_HZ_V2: readonly PhysicsHz[] = [400, 800, 1200];

export const ABI_VERSION_V2 = 2;
export const MAGIC_V2 = 0x4d534954;
export const HEADER_BYTES_V2 = 64;
export const STATE_STRIDE_V2 = 192;
export const CAPACITY_V2 = 256;
export const PILOT_BYTES_V2 = 64;
export const PILOT_OFFSET_V2 = HEADER_BYTES_V2 + CAPACITY_V2 * STATE_STRIDE_V2; // 49,216
export const SHARED_BYTES_V2 = PILOT_OFFSET_V2 + PILOT_BYTES_V2; // 49,280
export const MAX_CATCH_UP_V2 = 8;
export const INITIAL_EPOCH_V2 = 1;
/** Sentinel for autopilot_mode, calibrated_mode_slot, and requested_mode. */
export const UNKNOWN_U32 = 0xffffffff;

export const HEADER_WORDS_V2 = HEADER_BYTES_V2 / 4;
export const STATE_WORDS_V2 = STATE_STRIDE_V2 / 4;
export const PILOT_WORDS_V2 = PILOT_BYTES_V2 / 4;
export const PILOT_WORD_OFFSET_V2 = PILOT_OFFSET_V2 / 4;

/** Header v2 word indices (byte offset / 4). */
export const HeaderV2 = {
  Magic: 0, Version: 1, HeaderBytes: 2, StateStride: 3, Capacity: 4,
  Published: 5, Overruns: 6, DroppedSteps: 7, PhysicsHz: 8, SessionEpoch: 9,
  MaxCatchUp: 10, RuntimeFlags: 11, PilotOffset: 12, PilotBytes: 13,
} as const;
export const RuntimeFlagV2 = { Ready: 1, Running: 2, Fault: 4 } as const;

/**
 * State v2 byte offsets relative to `64 + slot*192`. Keys other than seqlock
 * and reserved match FlightStateV2 properties; u64 values store lo32 at the
 * lower address and hi32 at offset + 4.
 */
export const StateOffsetV2 = {
  seqlock: 0, sampleId: 4, tickId: 8, simTimeS: 16,
  northM: 24, eastM: 32, downM: 40,
  qw: 48, qx: 52, qy: 56, qz: 60,
  vnMps: 64, veMps: 68, vdMps: 72,
  anMps2: 76, aeMps2: 80, adMps2: 84,
  pRadS: 88, qRadS: 92, rRadS: 96,
  specificForceXBodyMps2: 100, specificForceYBodyMps2: 104, specificForceZBodyMps2: 108,
  trueAirspeedMps: 112, batteryVoltage: 116, batteryCurrentA: 120, ambientPressurePa: 124,
  scheduledWallTimeMs: 128, groundClearanceM: 136, referenceRotorRpm: 140,
  vehicleFlags: 144, ekfFlags: 148, ewFlags: 152, sensorValidMask: 156,
  epoch: 160, modelId: 164, autopilotMode: 168, autopilotHealth: 172,
  lastActuatorTick: 176, autopilotStatusAgeMs: 184, reserved: 188,
} as const;

/** Pilot mailbox v2 byte offsets relative to PILOT_OFFSET_V2. */
export const PilotOffsetV2 = {
  seqlock: 0, expectedEpoch: 4, sampledWallTimeMs: 8,
  roll: 16, pitch: 20, yaw: 24, throttle: 28, flags: 32,
  calibratedModeSlot: 36, requestedMode: 40, deviceGeneration: 44, inputSampleId: 48,
  reserved: 52,
} as const;
export const PILOT_RESERVED_WORDS_V2 = 3;

export const VehicleFlagV2 = {
  GroundContact: 1 << 0, InputFailsafe: 1 << 1, Armed: 1 << 2, ActuatorValid: 1 << 3,
  AutopilotStatusValid: 1 << 4, ModelOutsideValidity: 1 << 5, Paused: 1 << 6,
} as const;
export const EkfFlagV2 = {
  AttitudeValid: 1 << 0, HorizontalVelocityValid: 1 << 1, VerticalVelocityValid: 1 << 2,
  AbsoluteHorizontalPositionValid: 1 << 3, AbsoluteVerticalPositionValid: 1 << 4,
} as const;
export const EwFlagV2 = {
  GnssJamming: 1 << 0, PositionStep: 1 << 1, VelocityDrift: 1 << 2, MagneticAnomaly: 1 << 3, MotorFault: 1 << 4,
} as const;
export const SensorValidV2 = {
  Imu: 1 << 0, Gnss: 1 << 1, Magnetometer: 1 << 2, Barometer: 1 << 3, Airspeed: 1 << 4, Terrain: 1 << 5,
} as const;
export const AutopilotHealthV2 = {
  HeartbeatFresh: 1 << 0, EkfReportFresh: 1 << 1, LinkHealthy: 1 << 2, CapabilityVerified: 1 << 3,
} as const;
export const PilotFlagV2 = { Connected: 1 << 0, Armed: 1 << 1 } as const;

/** Assigned-bit masks; unassigned bits must be zero. */
export const VEHICLE_FLAGS_MASK_V2 = 0x7f;
export const EKF_FLAGS_MASK_V2 = 0x1f;
export const EW_FLAGS_MASK_V2 = 0x1f;
export const SENSOR_VALID_MASK_V2 = 0x3f;
export const AUTOPILOT_HEALTH_MASK_V2 = 0x0f;
export const PILOT_FLAGS_MASK_V2 = 0x03;
export const RUNTIME_FLAGS_MASK_V2 = 0x07;
export const MAX_MODE_SLOT_V2 = 5;

export function isPhysicsHz(value: unknown): value is PhysicsHz {
  return value === 400 || value === 800 || value === 1200;
}

/** The ABI assumes little-endian IEEE754 hosts; check once during initialization. */
export function assertLittleEndianHost(): void {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('ABI v2 requires a little-endian host');
}

/** Allocates and fully initializes a v2 buffer. Magic is stored last, after every other header word. */
export function createSharedMemoryV2(hz: PhysicsHz = 400): SharedArrayBuffer {
  assertLittleEndianHost();
  if (!isPhysicsHz(hz)) throw new Error('Unsupported physics rate');
  const buffer = new SharedArrayBuffer(SHARED_BYTES_V2);
  const words = new Int32Array(buffer);
  Atomics.store(words, HeaderV2.Version, ABI_VERSION_V2);
  Atomics.store(words, HeaderV2.HeaderBytes, HEADER_BYTES_V2);
  Atomics.store(words, HeaderV2.StateStride, STATE_STRIDE_V2);
  Atomics.store(words, HeaderV2.Capacity, CAPACITY_V2);
  Atomics.store(words, HeaderV2.PhysicsHz, hz);
  Atomics.store(words, HeaderV2.SessionEpoch, INITIAL_EPOCH_V2);
  Atomics.store(words, HeaderV2.MaxCatchUp, MAX_CATCH_UP_V2);
  Atomics.store(words, HeaderV2.PilotOffset, PILOT_OFFSET_V2);
  Atomics.store(words, HeaderV2.PilotBytes, PILOT_BYTES_V2);
  Atomics.store(words, HeaderV2.Magic, MAGIC_V2);
  return buffer;
}

/** Rejects any buffer that is not a complete, initialized v2 layout, including every v1 buffer. */
export function validateSharedMemoryV2(buffer: unknown): asserts buffer is SharedArrayBuffer {
  assertLittleEndianHost();
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== SHARED_BYTES_V2) {
    throw new Error('Invalid ABI v2 shared memory size');
  }
  const words = new Int32Array(buffer);
  const word = (index: number) => Atomics.load(words, index) >>> 0;
  if (word(HeaderV2.Magic) !== MAGIC_V2 || word(HeaderV2.Version) !== ABI_VERSION_V2 ||
    word(HeaderV2.HeaderBytes) !== HEADER_BYTES_V2 || word(HeaderV2.StateStride) !== STATE_STRIDE_V2 ||
    word(HeaderV2.Capacity) !== CAPACITY_V2 || word(HeaderV2.MaxCatchUp) !== MAX_CATCH_UP_V2 ||
    word(HeaderV2.PilotOffset) !== PILOT_OFFSET_V2 || word(HeaderV2.PilotBytes) !== PILOT_BYTES_V2 ||
    !isPhysicsHz(word(HeaderV2.PhysicsHz)) || word(HeaderV2.SessionEpoch) === 0 ||
    (word(HeaderV2.RuntimeFlags) & ~RUNTIME_FLAGS_MASK_V2) !== 0 ||
    word(14) !== 0 || word(15) !== 0) {
    throw new Error('Shared memory ABI v2 mismatch');
  }
}
