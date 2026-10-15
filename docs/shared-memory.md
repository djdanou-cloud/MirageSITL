# SharedArrayBuffer ABI v1

English source. [Russian mirror](ru/shared-memory.md).
Typed source: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts).
Main creates the SAB and passes it through structured clone **without a
transfer list**. A secure context, COOP/COEP, and `crossOriginIsolated=true`
are required. Validate byteLength, magic, version, and sizes. The ABI contains
no JavaScript/WASM references. This guide documents implemented **v1**;
[SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md) separately defines target v2.

## Layout

Indices below are 4-byte words. Total size is
`64 + 256 × 128 + 64 = 32,896 bytes`. Float payloads are packed through a
local little-endian scratch DataView on target platforms. Access shared
memory **only through Atomics on Int32Array**, including both halves of f64.

| Region | Byte offset | Bytes | Writer |
| --- | ---: | ---: | --- |
| Header | 0 | 64 | Main initialization; Worker counters |
| State ring [256] | 64 | 32,768 | Worker |
| Control mailbox | 32,832 | 64 | Main |

### Header

| Word | Type | Meaning |
| --- | --- | --- |
| 0 | u32 | magic `0x4d534954` |
| 1 / 2 / 3 | u32 | version=1 / capacity=256 / stateWords=32 |
| 4 | u32 | Published, total frames; 0=empty |
| 5 | u32 | Overruns, catch-up budget overruns |
| 6 | u32 | DroppedSteps, discarded wall-clock intervals |
| 7–15 | reserved | zero |

Reset clears tick/simTime/diagnostics but not Published. ABI v1 requires a
new session before 32-bit Published/tick wrap, approximately 124 days at 400 Hz.

### State slot — 128 bytes

| Word | Type | Field |
| --- | --- | --- |
| 0 | i32 | seqlock: odd=writing, even=committed |
| 1 | u32 | tick, integrations since reset |
| 2–3 | f64 | simTime, s |
| 4–5 / 6–7 / 8–9 | 3×f64 | north/east/down, m |
| 10–13 | 4×f32 | quaternion w,x,y,z, FRD -> NED |
| 14–16 | 3×f32 | vn/ve/vd, m/s |
| 17–19 | 3×f32 | an/ae/ad, m/s², inertial NED acceleration including gravity |
| 20–22 | 3×f32 | p/q/r body angular rates, rad/s |
| 23 | f32 | spool [0,1], demo collective response |
| 24 | f32 | batteryVoltage, V, demo estimate |
| 25 | u32 | bit0 OnGround, bit1 InputFailsafe, including disarmed |
| 26–27 | f64 | wallTimeMs, timeOrigin + scheduled deadline |
| 28–31 | reserved | zero |

### Control mailbox — 64 bytes

| Word | Type | Field |
| --- | --- | --- |
| 0 | i32 | seqlock |
| 1 | reserved | zero |
| 2–3 | f64 | wallTimeMs, actual Main sample time |
| 4 / 5 / 6 | 3×f32 | roll/pitch/yaw [-1,1] |
| 7 | f32 | throttle [0,1] |
| 8 | u32 | bit0 Connected, bit1 Armed |
| 9–15 | reserved | zero |

The newest value wins; there is no queue of old stick commands. Worker
revalidates finite values, bounds, flags, and age [0,250] ms. On contention
it retains the latest coherent input, which naturally becomes stale.

## Publication

There is one writer per region: Worker does not write controls; Main does
not write state. State writer chooses `slot=Published%256`, stores an odd
sequence, writes payload using atomic stores, commits an even sequence, and
then increments Published. Reader checks even sequence, atomically copies
words into private scratch, and checks sequence/Published again. Only then
does it decode scratch into output. Failed reads never mutate output.
At most three attempts are allowed; otherwise retain the last frame.
The writer never waits for rendering.

`latest(out,age)` supports up to 255 frames of history. Two calls are not one
transaction: rendering checks adjacent ticks or uses the latest snapshot.
Never access shared Float64Array directly: a seqlock alone does not prevent
torn f64 values. Payload words are atomic; full-counter-wrap ABA is outside
the supported session lifetime.

## Lifecycle

```ts
type MainToPhysics =
  | { type: 'init'; version: 1; buffer: SharedArrayBuffer }
  | { type: 'start' | 'pause' | 'reset' | 'dispose'; requestId: number };
type PhysicsToMain =
  | { type: 'ready'; version: 1; hz: 400 }
  | { type: 'ack'; command: 'start' | 'pause' | 'reset' | 'dispose'; requestId: number }
  | { type: 'error'; message: string };
```

Init publishes initial state and ready while keeping the Worker paused.
Start is idempotent and does not reset dynamics. Pause stops integration.
Reset also stops integration and clears model/diagnostics. Dispose
acknowledges and closes the Worker. RequestId associates ACK with the UI
command. Errors stop the loop. Main may terminate immediately on unmount.

This is a trusted in-process API, not a network authorization protocol.
TypeScript does not replace runtime validation of future WS/MAVLink data.
Changes to field order/units/meaning require a new ABI_VERSION; mismatches
block startup rather than being silently converted.
