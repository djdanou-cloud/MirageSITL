# SPECS_SHARED_MEMORY.md

Document version: 1.0 · 2026-10-15. Runtime baseline: commit `e3bb6b4`.
English is the source of truth. [Russian mirror](ru/SPECS_SHARED_MEMORY.md).

**The running application uses ABI v2 and Control Protocol v2 (TASK-085):
the v2 state ring, pilot mailbox, SPSC queues (TASK-013), `init-v2`, and the
command processor. ABI v1 remains implemented and tested in
`packages/protocol` but is no longer used by the application; removing it
requires a recorded decision.** TASK-008/009 implement the v2 layout and transport;
TASK-010 implements commands. Do not assign EKF/EW meanings to v1 reserved
words without changing the ABI version. Task IDs are defined in
[PROJECT_ROADMAP.md](PROJECT_ROADMAP.md).

## 1. Common conventions

* SI units; world NED (North, East, Down), body FRD (Forward, Right, Down).
* Quaternion `(w,x,y,z)` actively rotates FRD into NED; its norm is one.
* `accelerationNed` is kinematic acceleration `dv/dt`, including gravity.
  Ideal accelerometer specific force is `f_body = R(q)^T (a_ned - g_ned)`.
* Target Apple Silicon/x86-64 systems use little-endian IEEE754 values.
  Float payloads are packed with a **local** DataView; shared words use Atomics.
* Main allocates memory once and uses structured clone for SAB, **without a
  transfer list**. Require a secure context, COOP `same-origin`, COEP
  `require-corp`, and `crossOriginIsolated=true`. External resources need
  compatible CORS/CORP headers.
* Each region has a single writer. Never read a shared Float64Array directly.
  Neither endpoint may spin indefinitely or wait for the other endpoint.
* The render ring provides bounded interpolation history; it is neither an
  AAR archive nor a sensor queue.

## 2. ABI v1 (legacy regression contract)

Source: `packages/protocol/src/index.ts`; `ABI_VERSION=1`, `MAGIC=0x4d534954`.
Total size: `64 + 256*128 + 64 = 32,896 bytes`.

| Region | Absolute Byte Offset | Bytes | Writer |
| --- | ---: | ---: | --- |
| Header | 0 | 64 | Main initializes; Worker updates counters |
| State ring | 64 | 32,768 | Worker |
| Pilot mailbox | 32,832 | 64 | Main |

### Header v1 (absolute offsets)

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | magic | magic |
| 4 | u32 | version | abi_version = 1 |
| 8 | u32 | slots | capacity = 256 |
| 12 | u32 | int32 words | state_words = 32 |
| 16 | u32 | publications | published |
| 20 | u32 | events | overruns |
| 24 | u32 | wall intervals | dropped_steps |
| 28..63 | u32[9] | — | reserved_zero |

### State v1 (slot-relative offsets)

For slot `i`: `absolute = 64 + i*128 + offset`, where `0<=i<256`.

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | steps | tick (v1 tick_id) |
| 8 | f64 | s | sim_time |
| 16 / 24 / 32 | f64 × 3 | m | north / east / down |
| 40 / 44 / 48 / 52 | f32 × 4 | unit quaternion | qw / qx / qy / qz |
| 56 / 60 / 64 | f32 × 3 | m/s | vn / ve / vd |
| 68 / 72 / 76 | f32 × 3 | m/s² | an / ae / ad |
| 80 / 84 / 88 | f32 × 3 | rad/s | p / q / r |
| 92 | f32 | [0,1] | demo_spool |
| 96 | f32 | V | demo_battery_voltage |
| 100 | u32 | bitmask | flags: bit0 OnGround, bit1 InputFailsafe |
| 104 | f64 | ms since time origin epoch | scheduled_wall_time_ms |
| 112..127 | u32[4] | — | reserved_zero; **no EKF/EW fields** |

### Pilot mailbox v1 (offsets relative to 32,832)

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | — | reserved_zero |
| 8 | f64 | wall ms | sampled_wall_time_ms |
| 16 / 20 / 24 | f32 × 3 | [-1,1] | roll / pitch / yaw |
| 28 | f32 | [0,1] | throttle |
| 32 | u32 | bitmask | bit0 Connected, bit1 Armed |
| 36..63 | u32[7] | — | reserved_zero |

`sim_time=tick/400`. Input age uses actual wall time rather than the
presentation deadline. Accept ages of 0..250 ms. NaN, disconnected, or
disarmed input produces zero target thrust while preserving spool decay.
Reset does not reset `published`. End the session **before u32 published
wraps**, approximately 124 days at 400 Hz. V1 has no session epoch or flight modes.

Implemented postMessage protocol:

```ts
export type MainToPhysicsV1 =
  | { type: 'init'; version: 1; buffer: SharedArrayBuffer }
  | { type: 'start' | 'pause' | 'reset' | 'dispose'; requestId: number };
export type PhysicsToMainV1 =
  | { type: 'ready'; version: 1; hz: 400 }
  | { type: 'ack'; command: 'start' | 'pause' | 'reset' | 'dispose'; requestId: number }
  | { type: 'error'; message: string };
```

## 3. ABI v2

State stride is **192 bytes**, capacity is **256**. Main SAB size is
`64 + 256*192 + 64 = 49,280 bytes`. Other layouts are not recognized as v2.
Reject mismatched version, size, magic, stride, or capacity. Never silently
interpret a v1 buffer as v2.

| Region | Absolute Byte Offset | Bytes | Writer |
| --- | ---: | ---: | --- |
| Header | 0 | 64 | Main initializes; Worker updates diagnostics |
| State ring | 64 | 49,152 | Physics Worker |
| Pilot mailbox | 49,216 | 64 | Main |

### Header v2

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | magic | magic = 0x4d534954 |
| 4 | u32 | version | abi_version = 2 |
| 8 | u32 | bytes | header_bytes = 64 |
| 12 | u32 | bytes | state_stride = 192 |
| 16 | u32 | slots | capacity = 256 |
| 20 | u32 | publications | published (Worker) |
| 24 | u32 | events | overruns (Worker) |
| 28 | u32 | wall intervals | dropped_steps (Worker) |
| 32 | u32 | Hz | physics_hz = 400, 800, or 1200 |
| 36 | u32 | epoch | session_epoch (Worker; initial value 1) |
| 40 | u32 | steps | max_catch_up = 8 |
| 44 | u32 | bitmask | runtime_flags: bit0 Ready, bit1 Running, bit2 Fault |
| 48 | u32 | bytes | pilot_offset = 49,216 |
| 52 | u32 | bytes | pilot_bytes = 64 |
| 56..63 | u32[2] | — | reserved_zero |

Initialize the header before attaching readers. Change Hz only while paused
and disarmed, using a new epoch/reset. Diagnostic counters may be read
independently; the header is not a transactional snapshot. Use the epoch
inside a successfully read state for coherent state interpretation.

### State v2 (offsets relative to `64 + slot*192`)

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | publications | sample_id, equal to published after this write |
| 8 | u64 (lo32,hi32) | steps | tick_id, integrations within this epoch |
| 16 | f64 | s | sim_time = tick_id / physics_hz |
| 24 / 32 / 40 | f64 × 3 | m NED | north / east / down |
| 48 / 52 / 56 / 60 | f32 × 4 | unit quaternion | qw / qx / qy / qz |
| 64 / 68 / 72 | f32 × 3 | m/s NED | vn / ve / vd |
| 76 / 80 / 84 | f32 × 3 | m/s² NED | an / ae / ad |
| 88 / 92 / 96 | f32 × 3 | rad/s FRD | p / q / r |
| 100 / 104 / 108 | f32 × 3 | m/s² FRD | ideal_specific_force_x/y/z |
| 112 | f32 | m/s | true_airspeed |
| 116 | f32 | V | battery_voltage |
| 120 | f32 | A | battery_current |
| 124 | f32 | Pa | ambient_pressure |
| 128 | f64 | wall ms | scheduled_wall_time_ms |
| 136 | f32 | m | ground_clearance |
| 140 | f32 | rev/min | reference_rotor_rpm; UI summary, not all rotor states |
| 144 | u32 | bitmask | vehicle_flags |
| 148 | u32 | bitmask | ekf_flags, normalized project flags |
| 152 | u32 | bitmask | ew_flags |
| 156 | u32 | bitmask | sensor_valid_mask |
| 160 | u32 | epoch | session_epoch |
| 164 | u32 | registry key | model_id |
| 168 | u32 | ArduPilot custom_mode | autopilot_mode; 0xffffffff = unknown |
| 172 | u32 | bitmask | autopilot_health |
| 176 | u64 (lo32,hi32) | steps | last_actuator_tick, meaningful when actuator is valid |
| 184 | f32 | wall ms for HITL / sim ms for SITL | autopilot_status_age_ms |
| 188 | u32 | — | reserved_zero |

V2 flags:

| Field | Bits |
| --- | --- |
| vehicle_flags | 0 GroundContact; 1 InputFailsafe; 2 Armed; 3 ActuatorValid; 4 AutopilotStatusValid; 5 ModelOutsideValidity; 6 Paused |
| ekf_flags | 0 AttitudeValid; 1 HorizontalVelocityValid; 2 VerticalVelocityValid; 3 AbsoluteHorizontalPositionValid; 4 AbsoluteVerticalPositionValid |
| ew_flags | 0 GnssJamming; 1 PositionStep; 2 VelocityDrift; 3 MagneticAnomaly; 4 MotorFault |
| sensor_valid_mask | 0 IMU; 1 GNSS; 2 Magnetometer; 3 Barometer; 4 Airspeed; 5 Terrain |
| autopilot_health | 0 HeartbeatFresh; 1 EkfReportFresh; 2 LinkHealthy; 3 CapabilityVerified |

EKF flags must come from actual autopilot diagnostics, with a mapping for
the pinned dialect/firmware. Do not infer them from truth or fabricate FC
responses. `AutopilotStatusValid=0` means unknown even when ekf_flags=0.
`model_id` is local to the session registry; AAR stores full hashes/versions.
Truth must contain no NaN. An invalid observation clears its validity bit
and is never presented as a valid sensor sample. Unassigned bits and reserved
words are zero.

### Pilot mailbox v2 (offsets relative to 49,216)

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | epoch | expected_session_epoch |
| 8 | f64 | wall ms | sampled_wall_time_ms |
| 16 / 20 / 24 | f32 × 3 | [-1,1] | roll / pitch / yaw |
| 28 | f32 | [0,1] | throttle |
| 32 | u32 | bitmask | bit0 Connected, bit1 Armed |
| 36 | u32 | index | calibrated_mode_slot [0,5], 0xffffffff=unavailable |
| 40 | u32 | custom_mode | requested_mode, 0xffffffff=no request |
| 44 | u32 | generation | device_generation, incremented when the device changes |
| 48 | u32 | publications | input_sample_id |
| 52..63 | u32[3] | — | reserved_zero |

A stale epoch, stale input, nonfinite value, unknown flags, or a changed
device_generation disarms the session. New sessions are always disarmed;
rearming is explicit and requires throttle <=5%. Mode slots are not PWM
values or ArduPilot mode numbers: the FC profile defines that mapping.

### Time representation without hot-path BigInt allocations

```ts
export interface TickId { lo: number; hi: number }
export type PhysicsHz = 400 | 800 | 1200;
export type Vec3 = readonly [number, number, number];
export interface FlightStateV2 {
  sampleId: number; tickId: TickId; epoch: number; simTimeS: number;
  northM: number; eastM: number; downM: number;
  qw: number; qx: number; qy: number; qz: number;
  vnMps: number; veMps: number; vdMps: number;
  anMps2: number; aeMps2: number; adMps2: number;
  pRadS: number; qRadS: number; rRadS: number;
  specificForceXBodyMps2: number; specificForceYBodyMps2: number; specificForceZBodyMps2: number;
  trueAirspeedMps: number; batteryVoltage: number; batteryCurrentA: number;
  ambientPressurePa: number; scheduledWallTimeMs: number;
  groundClearanceM: number; referenceRotorRpm: number;
  vehicleFlags: number; ekfFlags: number; ewFlags: number;
  sensorValidMask: number; modelId: number; autopilotMode: number;
  autopilotHealth: number; lastActuatorTick: TickId; autopilotStatusAgeMs: number;
}
export function incrementTickInPlace(t: TickId): void {
  t.lo = (t.lo + 1) >>> 0;
  if (t.lo === 0) t.hi = (t.hi + 1) >>> 0;
}
```

Allocate DTO objects/arrays during initialization and mutate them afterward.
JSON represents u64 as `{lo,hi}`, with both halves uint32. SAB stores lo at
the lower address. Derive `simTimeS` from tick rather than accumulated
addition. Require tick `<2^53` for exact Number representation. Compute
MAVLink microseconds using integer/remainder arithmetic equivalent to
`floor(tick*1_000_000/hz)`: at 1200 Hz intervals are 833/834 microseconds,
not a constant 833 that accumulates error. Published remains u32: create a
new SAB session before wrap, approximately 41 days at 1200 Hz.

## 4. Synchronization: bounded seqlock and overwrite ring

This is a single-writer nonblocking transport. A reader is not guaranteed
to acquire a valid frame if the writer stops at an odd sequence; it returns
a bounded-time miss. The writer never waits for a reader. A delivery queue
uses the distinct ownership rules in the next section.

The following functions use preallocated views/scratch. For v2,
`publishedWord=5`. Only the region owner writes; two writers must never use
the same frame. Scratch is local to its thread.

```ts
export function publishAtomicFrame(
  shared: Int32Array, scratch: Int32Array, baseWord: number, words: number,
): void {
  const seq = Atomics.load(shared, baseWord);
  Atomics.store(shared, baseWord, (seq + 1) | 0); // odd
  for (let i = 1; i < words; i++) {
    Atomics.store(shared, baseWord + i, scratch[i]!);
  }
  Atomics.store(shared, baseWord, (seq + 2) | 0); // even; payload committed
}
export function tryReadAtomicFrame(
  shared: Int32Array, scratch: Int32Array, baseWord: number, words: number,
): boolean {
  const before = Atomics.load(shared, baseWord);
  if (before & 1) return false;
  for (let i = 1; i < words; i++) {
    scratch[i] = Atomics.load(shared, baseWord + i);
  }
  return before === Atomics.load(shared, baseWord);
}
```

State writer: `count=published>>>0`, `slot=count%capacity`,
`scratch[1]=(count+1)>>>0`; publish the frame, then atomically store
published=count+1. Reader: require count>age, compute
slot=(count-1-age)%capacity, read seq/payload/seq into scratch, check
head==count and sample_id==count-age, and **only then** decode output.
Try at most three times; a miss leaves output unchanged. V1 has no sample_id
check. Never write u64 halves independently without the seqlock. Check
endianness during initialization.

Ring history lasts 640/320/213.33 ms at 400/800/1200 Hz. Interpolate only
between adjacent ticks of the same epoch/model. Reset/model replacement
clears render history. Publish the complete seq/head protocol even with
zero render consumers.

## 5. Sensor and actuator SPSC queues

Allocate **separate SABs** for each direction, outside the render ring.
Physics Worker writes sensors; I/O Worker consumes sensors and writes
actuators; Physics consumes actuators. Main is not a second consumer.
For AAR, the producer fans out into a separate recording queue. Web Serial
requestPort remains a Main user gesture. I/O uses Worker APIs/transferable
streams where supported. Never schedule 400 Hz HIL transmission from Main
rAF; any fallback needs its own measured jitter acceptance gate.

Each queue has one producer and one consumer, capacity=1024, stride=128,
and total size `64+1024*128=131136 bytes`. Magic is `0x4d534e53` for
sensors and `0x4d414354` for actuators; version=2. Internal C ABI transport
is not MAVLink wire format: the codec performs scaling, packing, and CRC.

Queue header offsets: 0 magic u32; 4 version u32; 8 stride u32=128;
12 capacity u32=1024; 16 write_counter u32 (producer); 20 read_counter u32
(consumer); 24 full_events u32 (producer); 28 epoch u32 (reset while paused);
32..63 reserved_zero. Reset clears the queue only after both endpoints stop.

Producer computes unsigned `(write-read)>>>0`. If it equals capacity, do
not overwrite unread frames: return `would-block` in SITL or invalidate/fault
the HITL session. Otherwise write the free slot, then atomic store write+1.
Consumer atomically loads write, copies the entire slot to local scratch,
then atomic store read+1. Producer cannot reuse the slot before that store.
All shared payload words also use Atomics. Release the copied slot before
wire decoding or callbacks. Counters use modular arithmetic; capacity<2^31.
Each pump has bounded polling work.

| Slot Offset | Type | Units | Field in both directions |
| ---: | --- | --- | --- |
| 0 | u32 | enum | kind: sensor 1=IMU,2=GNSS,3=MAG,4=BARO,5=AIRSPEED; actuator 1=frame |
| 4 | u32 | epoch | epoch |
| 8 | u64 | steps | tick_id |
| 16 | u64 | us | sample_time_us / actuator_time_us |
| 24 | u32 | bitmask | validity_flags / actuator_flags (bit0 Armed) |
| 28 | u32 | count | sensor value_count / actuator_count<=16 |
| 32..95 | f32[16] | kind-dependent | values / normalized_actuators |
| 96..119 | f64[3] | GNSS: deg,deg,m MSL | geo_lat_lon_alt; zero for other kinds |
| 120 | u32 | index | source_id / motor_map_id |
| 124 | u32 | — | reserved_zero |

Sensor values: IMU count=6: FRD specific force m/s²[0..2], FRD gyro
rad/s[3..5]; GNSS count=8: vN/vE/vD m/s, HDOP, VDOP, fix_type, satellites,
course rad; course validity is a flag. MAG count=3: FRD gauss. BARO count=3:
pressure Pa, pressure_alt m, temperature K. AIRSPEED count=1: differential
pressure Pa. Validate count by kind. Integer sensor quantities stored as
f32 must be exact integer values.

Sensor validity_flags: bit0 PayloadValid, 1 PositionFixValid, 2 CourseValid,
3 TimestampValid, 4 EncodingClipped, 5 SourceStale, 6 HdopValid, 7 VdopValid,
8 VelocityValid, 9 SatellitesValid. Inapplicable bits are zero. GNSS without
a fix may have PayloadValid=1 and PositionFixValid=0 and still transmit a
diagnostic no-fix frame. Unknown DOP uses finite placeholder=0 with its
validity bit clear; the encoder emits 65535. VelocityValid=0 produces
vel=65535, vn/ve/vd=0, and fix_type=0 on MAVLink encoding.

Actuator values lie in [-1,1]; a motor_map profile defines motor/surface
interpretation. Mapped motor duty lies in [0,1]. Do not apply one conversion
to every channel regardless of hardware role.

## 6. Worker Control Protocol v2

Validate low-frequency JSON commands from `unknown` in
`packages/protocol/src/control-v2.ts`. Do not send them every physics tick.
Initialization uses structured clone with SABs and **is not JSON**.
External WS/MAVLink transport has separate schemas and authentication.

```ts
export type EwEffect =
  | { kind: 'gnss-jamming'; severity: number }
  | { kind: 'position-step'; offsetNedM: Vec3 }
  | { kind: 'velocity-drift'; accelerationNedMps2: Vec3; maxSpeedMps: number }
  | { kind: 'magnetic'; rotationRad: Vec3; biasBodyGauss: Vec3 }
  | { kind: 'motor-loss'; motorIndex: number; mode: 'power-cut' | 'instant-thrust-loss'; remainingThrustFraction: number };
export interface EnvelopeV2 {
  protocolVersion: 2; requestId: number; expectedEpoch: number;
}
export type ScheduledCommandV2 = EnvelopeV2 & { atTick: TickId } & (
  | { type: 'weather.set'; windNedMps: Vec3; temperatureK: number;
      pressurePa: number; turbulenceRmsMps: number; seed: number }
  | { type: 'fault.set'; faultId: string; enabled: boolean; effect: EwEffect;
      recovery: 'hold-offset' | 'step-to-truth' }
);
export type LifecycleCommandV2 = EnvelopeV2 & (
  | { type: 'sim.start' | 'sim.pause' | 'worker.dispose' }
  | { type: 'sim.reset'; seed: number }
  | { type: 'sim.configure'; hz: PhysicsHz; clockMode: 'interactive' | 'sitl-lockstep' | 'hitl-realtime' }
  | { type: 'model.load'; modelId: number; manifestSha256: string }
);
export type ControlCommandV2 = ScheduledCommandV2 | LifecycleCommandV2;
export interface WorkerInitV2 {
  type: 'init-v2'; protocolVersion: 2; stateBuffer: SharedArrayBuffer;
  sensorBuffer: SharedArrayBuffer; actuatorBuffer: SharedArrayBuffer;
}
export type CommandResultV2 =
  | { type: 'ready-v2'; protocolVersion: 2; abiVersion: 2; epoch: number; hz: PhysicsHz }
  | { type: 'ack-v2'; requestId: number; status: 'queued' | 'applied';
      epoch: number; appliedTick: TickId }
  | { type: 'reject-v2'; requestId: number; code: 'SCHEMA' | 'STALE_EPOCH' |
      'BAD_STATE' | 'OUT_OF_RANGE' | 'ASSET_MISSING' | 'OVERLOAD'; message: string };
```

Normative runtime validation contract: TASK-010 implements JSON Schema
2020-12, a validator, and equivalence tests against these TS types.

* Every object uses `additionalProperties:false`; every field of the chosen
  branch is required. Discriminators are `type` and nested `effect.kind`.
  Reject NaN, Infinity, undefined, and noninteger integer fields. Payload
  limit is 16 KiB.
* protocolVersion const=2; requestId/expectedEpoch/tick halves/modelId/seed
  are integers [0,4294967295]. Request IDs strictly increase over a Worker's
  lifetime, including epoch changes; start a new Worker before wrap. A
  cache of the last 128 IDs stores original payload and latest result.
  Exact duplicates replay cached ACK/reject without applying twice. The
  same ID with a different payload is rejected. IDs at or below the high
  water mark that have left the cache return BAD_STATE. Deduplicate before
  expectedEpoch validation so a retried reset receives its original result.
* Vec3 is an array of exactly three finite numbers. Wind components are
  [-100,100] m/s; temperature [200,340] K; pressure [30000,110000] Pa;
  turbulenceRms [0,30] m/s. Derive density from atmosphere rather than
  accepting a contradictory second field. These are model envelope limits,
  not limits on Earth's climate.
* faultId matches `[A-Za-z0-9_-]{1,64}`; manifestSha256 has exactly 64 hex
  characters. severity/remainingThrustFraction are [0,1]; motor mode is the
  declared enum; motorIndex is integer [0,31] and <rotorCount. Offset
  components are [-10000,10000] m with norm<=10000 m, the PositionStep
  kernel envelope, so a step admission accepts can always execute; drift
  acceleration components [-0.3,0.3] m/s² with norm<=0.3; maxSpeed (0,20]
  m/s; magnetic rotation components [-pi,pi]; bias components [-2,2] gauss.
  Changing ranges changes spec/tests.
* Scheduled atTick is at least the next unintegrated tick, with a horizon
  <=10 s. Apply **before** integrating that tick. Commands at the same tick
  use recorded receipt order. A past tick never rewrites history. Admission
  and validation allocate outside the hot path; application copies scalars
  from preallocated slots. ACK/events use a bounded outbox and postMessage
  after the compute batch, with no allocations inside step.
* `queued` means accepted, not applied. Its appliedTick is the scheduled
  tick; an `applied` result reports the actual tick. Every queued command
  eventually has final applied/reject; a command that cannot take effect at
  its tick is never reported as `applied`. Limit the queue to 128 commands;
  reject overflow without discarding older commands.
* Pause/dispose execute outside fixed-step processing and do not wait for
  actuators. Reset/configure/model.load require paused+disarmed. They reject
  pending commands with BAD_STATE, reset clocks/history/queues, clear every
  active fault (`sim.configure` keeps the EW seed of the last `sim.reset`),
  and increment epoch. ACK contains the new epoch. Reject commands with stale
  expectedEpoch.
* Model manifests are fetched and hash-verified outside the hot path.
  Prepare the backend while paused; swap only after validation and successful
  initialization. A failure preserves the previous model in paused state,
  without a partial swap.
* Runtime commands do not change terrain licensing, secrets, or network domains.
* Implementation details (TASK-010, `ControlProcessorV2`): a command rejected
  by validation (SCHEMA, or OUT_OF_RANGE found while validating fields) does
  not consume its requestId and is not cached; its reject reports the
  received requestId when that is a uint32, otherwise -1. A lifecycle ACK
  reports the last integrated tick of the epoch in which it applied (0 after
  reset/configure/model swap). `model.load` first returns `queued`, then a
  final `applied` (new epoch), `ASSET_MISSING`, or `BAD_STATE`; while a load
  is in flight every other command except `worker.dispose` is rejected with
  BAD_STATE. Cancelled commands are rejected in due order. JSON Schema cannot
  express the 16 KiB limit, the drift-norm limit or the offset-norm limit;
  the TypeScript validator enforces all three.
* A backend that cannot model a scheduled command rejects it at admission
  with BAD_STATE and its reason (`ControlTargetV2.unsupportedReason`). The
  demo backend has no atmosphere model, so it rejects every `weather.set`; a
  session without the EW port rejects every `fault.set`; and `motor-loss` is
  rejected unless the active dynamics reads a motor-fault table
  (`SessionDynamics.useMotorFaults`), which the demo quad does not. The
  session builds that table with the motor IDs 0..rotorCount-1 of the active
  dynamics and rebuilds it whenever the dynamics is replaced.
* A due scheduled command that cannot take effect at its tick receives a
  final reject (`ControlTargetV2.applyScheduled` returns it): OVERLOAD for a
  full 16-slot fault registry, OUT_OF_RANGE when an effect kernel refuses
  parameters that admission accepted. The session then faults. Every session
  fault (this one, a HITL overrun, a rejected EW step, a dynamics fault)
  stops stepping, blocks arming, sets the header Fault flag and halts the
  processor (`ControlProcessorV2.halt`): no further due command is applied,
  `sim.start` is rejected with BAD_STATE, and the session counts as paused,
  so `sim.reset`, `sim.configure` or a model swap is admitted (the fault
  releases the pilot arm latch; an externally armed autopilot must still
  disarm) and starts a fault-free epoch that cancels the remaining queue with
  BAD_STATE.
* Outside the command/result flow the Worker reports faults as
  `{ type: 'fault-v2', protocolVersion: 2, message }`. Before `ready-v2` (for
  example a failed `init-v2`) the Worker has no session and Main treats the
  fault as fatal. After `ready-v2` it is a session fault: the Worker keeps
  answering commands, Main keeps Reset available without a reload, and Main
  clears the fault notice once the header Fault flag is clear. Main validates
  every Worker message (`parseWorkerEventV2`) and ignores unknown ones; the
  Worker validates `init-v2` by shape and by each buffer layout.

Valid JSON example, scheduled at one second with a 400 Hz physics clock:

```json
{
  "protocolVersion": 2,
  "requestId": 17,
  "expectedEpoch": 1,
  "atTick": { "lo": 400, "hi": 0 },
  "type": "fault.set",
  "faultId": "training-drift",
  "enabled": true,
  "effect": { "kind": "velocity-drift", "accelerationNedMps2": [0.1, 0, 0], "maxSpeedMps": 2 },
  "recovery": "hold-offset"
}
```

## 7. Protocol acceptance

TASK-008/009: exhaustive offset/size/alignment tests; golden byte vectors;
v1 rejection/v2 negotiation; tick carry; epoch/reset/interpolation; Worker
concurrency stress with 1e6 publications and no torn/NaN frames; interrupted
writer returns miss without mutating output; queue full/empty/counter wrap.
TASK-010: positive/negative fixtures for every branch; late/duplicate/out-of-order
ACK; 128+1 queue capacity; stale epoch; failed atomic model swap. TASK-014:
packing/reading steps have no JS/WASM allocations after initialization;
browser timer callback allocations are measured separately. New contract
tests are automated. Report NOT_RUN when a module or required hardware does
not yet exist.


## Separate AAR transport (TASK-076)

The recording transport is a distinct 131,136-byte SAB with a 64-byte header and 256 slots of 512 bytes. Magic/version/write/read/drop counters occupy bytes 0/4/8/12/16; remaining header words are zero. All shared words are atomic int32; float payloads use private codec scratch. Publish the write counter only after copying the record, and release the read counter only after copying out. Modular counters distinguish full/empty; full drops the new recording sample and increments loss without blocking physics. It never attaches a second consumer to the flight sensor/actuator queues. ABI-v2 flight buffers and their ownership remain unchanged. The complete AAR record/archive layout, provenance, CRC/SHA-256 rules, capacity and replay constraints are specified in [Simulation Engines](SPECS_SIMULATION_ENGINES.md). The active demo producer is decimated Main-thread sampling; full-rate production fanout remains separate integration work.

## TASK-043 native admission boundary

Native LiveEkfWarmup consumes actual firmware diagnostics and explicit sensor
clock provenance without adding SAB fields or changing ABI v2 offsets/flags.
Normalized EKF bits retain their existing meanings. The native READY/EW verdict
is scoped to that external-SITL session/epoch; it is not automatically published
to the demo Worker. Browser AutopilotStatusValid stays clear in that
publication. The Main HUD copy may set it from an identity-bound EkfMonitor
snapshot whose epoch matches the displayed flight state. A serial connection
does not publish that flag into the SAB and does not admit browser READY.
Timing and revocation
details are in the engine specification; a version 2 Simulation-on-Hardware board cannot fast-forward.

## Power telemetry v1 (TASK-146)

Per-motor and battery electrical values travel in their own 672-byte
SharedArrayBuffer, created by Main (`createPowerChannelV1`) and handed to
the physics Worker with `{ type: "power.attach", buffer }`. The Worker
answers `power.attached`, or `power.reject` for any other buffer. ABI v2 is
unchanged: `battery_voltage` and `battery_current` keep their meanings, and
no reserved word gains one. The Worker is the only writer and publishes after
every step, after the state ring. While the active dynamics has no electrical
drive (the demo), it publishes a record with `motor_count` 0 and zero values.

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | magic | magic = 0x4d505752 |
| 4 | u32 | version | version = 1 |
| 8 | u32 | bytes | header_bytes = 64 |
| 12 | u32 | bytes | record_bytes = 608 |
| 16 | u32 | rows | motor_capacity = 16 |
| 20 | u32 | publications | published (Worker) |
| 24..63 | u32[10] | — | reserved_zero |

Record (offsets relative to byte 64):

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | publications | sample_id, equal to published after this write |
| 8 | u64 (lo32,hi32) | steps | tick_id |
| 16 | u32 | epoch | session_epoch |
| 20 | u32 | registry key | model_id |
| 24 | u32 | rows | motor_count, 0 without an electrical drive |
| 28 | u32 | bitmask | battery_warning: bit0 UnderVoltage |
| 32 | u32 | bitmask | battery_limited: bit0 PackCurrent, bit1 Charge |
| 36 | u32 | events | dropped_events, limit events the outbox could not hold |
| 40 | f64 | 1 | state_of_charge |
| 48 | f64 | V | bus_voltage |
| 56 | f64 | A | bus_current, negative while regenerating |
| 64 | f64 | W | bus_power = bus_voltage · bus_current |
| 72 | f64 | Ah | remaining_charge |
| 80 | f64 | Ah | capacity |
| 88..95 | u32[2] | — | reserved_zero |
| 96 + 32·i | motor_row | — | motor i: 16 rows; rows at and beyond motor_count are zero |

Motor row (offsets relative to its start):

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | f32 | rev/min | speed, signed |
| 4 | f32 | A | motor_current, negative while braking |
| 8 | f32 | A | bus_current: terminal power over the lagged bus voltage |
| 12 | f32 | W | electrical_power at the motor terminals |
| 16 | f32 | 1 | command: ESC duty in [0, 1] as the ESC received it |
| 20 | u32 | bitmask | warning: bit0 MotorCurrent, bit1 MotorPower, bit2 EscCurrent, bit3 EscVoltage, bit4 Rpm |
| 24 | u32 | bitmask | limited: bit0 CurrentLimit |
| 28 | u32 | — | reserved_zero |

The record uses the seqlock of section 4 with one slot: the writer packs a
private scratch, sets the sequence odd, stores the words, sets it even and
then stores `published`. The reader (`PowerReaderV1.latest`) tries at most
three times and decodes only when the sequence was even and unchanged and
`sample_id` equals `published`; a miss leaves its output unchanged. A
`warning` bit means a component rating is exceeded while physics runs on
unchanged; a `limited` bit means the model clamped the value. The events
behind the masks reach Main as `{ type: "limits.events", events, dropped }`
after each pump, and `{ type: "limits.register", sha256, ratings }` binds limit
ratings v1 to a manifest hash before `model.load` (`limits.registered` or
`limits.reject`). Both are specified in
[Simulation Engines](SPECS_SIMULATION_ENGINES.md), section "Battery and
propulsion limits (TASK-146)".
