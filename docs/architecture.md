# MirageSITL architecture

English source. [Russian mirror](ru/architecture.md).
The detailed task source is [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md).

## Milestone 01: implemented boundaries

The working vertical slice includes React 19/R3F/WebGL, a module Worker,
constant `dt = 1/400 s`, atomic SAB transport, Gamepad calibration, demo
quadrotor dynamics, visualization, and diagnostics. JSBSim/BET, ArduPilot,
EW, and physical HITL are not implemented. Demonstration aerodynamics are
not validated for pilot training.

400–1200 Hz and 60–120 FPS are target budgets. Fixed dt does not guarantee
execution every 2.5 ms: browser timers, GC, the OS, and background-tab
policies provide no hard real-time guarantee. M4/RTX 4050 performance has
not yet been measured.

## Directory structure

```text
apps/web/
  src/App.tsx                 # HUD, controls, calibration
  src/capabilities.ts         # API checks and implemented mode eligibility
  src/runtime.ts              # Gamepad/rAF, lifecycle, SAB reads
  src/FlightScene.tsx         # Position/SLERP in R3F useFrame
  src/coordinates.ts          # NED to Three.js
  src/physics.worker.ts       # Physics owner and fixed-step scheduler
  vite.config.ts              # COOP/COEP for dev and preview
packages/
  protocol/src/index.ts       # ABI v1, types, SAB readers/writers
  physics/src/index.ts        # Demo dynamics and bounded scheduler
  physics/src/model-manifest.ts # Verified configuration registry
  physics/src/model.schema.json # Strict serialized model schema
  test-support/src/           # Fixture verification and seeded streams
  input/src/index.ts          # Gamepad and channel calibration
docs/
  PROJECT_ROADMAP.md          # English task source
  SPECS_SHARED_MEMORY.md      # Implemented v1 and target v2
  SPECS_SIMULATION_ENGINES.md # Target physics and EW contracts
  architecture.md
  shared-memory.md
  ru/                        # Russian documentation mirrors
tests/
  *.test.ts                  # ABI, physics, scheduler, input
  browser/simulation.spec.ts # Real Worker/SAB, UI, mock USB
```

The following components are planned; these directories do not yet exist:

| Directory | Responsibility |
| --- | --- |
| `apps/bridge` | Local WS to ArduPilot JSON/UDP and MAVLink |
| `packages/wasm-jsbsim` | Pinned JSBSim/Emscripten with C ABI |
| `packages/wasm-bet` | Rotor/frame wrapper, native reference and WASM |
| `packages/sensors` | IMU/GNSS/magnetometer, noise, bias, timestamps |
| `packages/autopilot` | Direct/external SITL/WASM SITL/HITL adapters |
| `packages/ew` | Scenario observation faults and hazard volumes |
| `packages/terrain` | Streaming visual LOD and independent collision LOD |
| `packages/aar` | Input/actuator/truth/EKF recording and replay |
| `services/tiles-worker` | Cloudflare proxy, quotas, permitted caching |
| `native` | Source/toolchain pins and WASM reference tests |

## Threads and ownership

```mermaid
flowchart LR
  HID[EdgeTX / OpenTX USB] --> GP[Main: Gamepad + calibration]
  GP --> CMD[SAB control mailbox]
  CMD --> W[Physics Worker: fixed step]
  W --> RING[SAB state ring]
  RING --> R[Main: R3F interpolation + HUD]
  W -. future .-> S[Ideal sensors -> noise -> EW]
  S -.-> AP[Autopilot adapter]
  AP -. actuators .-> W
  AP -.-> WS[Local WS bridge -> SITL]
  AP -.-> SERIAL[Web Serial -> HITL]
  AP -.-> WASM[ArduPilot WASM]
```

Worker owns truth, simulation time, and integration. Main owns DOM/WebGL,
Gamepad, and permissions. Physics never reads the scene graph or waits for
rendering. React receives summaries approximately every 150 ms. R3F reads
the latest two states, SLERPs orientation, and linearly interpolates position.
If concurrent publication/reset yields nonadjacent ticks, use the latest
coherent state instead of interpolation.

High-rate data uses SAB; postMessage carries init/lifecycle/error events.
Extensions require separate typed sensor/actuator buffers. The current
physics hot path reuses input/state/scratch with no explicit per-step
allocations. A Worker has its own JS heap, but cannot promise absolute
isolation from GC/OS latency. Preallocate WASM memory and exclude growth,
terrain loading, network I/O, and decoding from fixed-step computation.

## Clocks, overload, and input safety

FixedStepClock tracks performance.now deadlines while passing constant dt
to integration. At most eight steps run per callback before yielding to
lifecycle messages. Nested setTimeout may be clamped to roughly 4 ms;
one callback may therefore perform multiple physical steps.

When catch-up exceeds its budget, whole wall-clock intervals are discarded
and DroppedSteps/Overruns increase. Simulation time increases only for
executed steps. Never substitute a large variable dt. Pause/resume resets
deadlines; reset stops and clears dynamics. Hiding the tab disarms and
pauses. Worker independently rejects input older than 250 ms, nonfinite
values, and disconnected/disarmed controls. Target thrust becomes zero;
modeled rotor response decays with spool lag.

SITL needs a separate sensor/actuator lockstep policy with simulation
timestamps. HITL uses physical time: overload invalidates/stops the session;
fast-forward is not valid for a real FC.

Gamepad API belongs to Window, not a normal Worker. rAF polling incurs
USB/HID/browser/display delay. Measure p50/p95/p99 input age and end-to-end
latency; zero input lag is unattainable. Initial axes
`roll=0,pitch=1,yaw=3,throttle=2` are assumptions, not an EdgeTX standard.
UI configures indices/endpoints/center/inversion with 3.5% deadzone on
centered channels. Calibration currently lasts one session. Source/device/
calibration changes disarm. Disconnect never silently selects another
transmitter. Arming requires throttle <=5%.

## Coordinates and physics backends

Use SI and right-handed NED. Body axes are FRD. Quaternion `(w,x,y,z)`
rotates FRD to NED, and p/q/r are right-hand body rates in rad/s.
Three.js uses `(x,y,z)=(east,-down,-north)`, a rotation without reflection.
Future WGS84/ECEF and origin shifts retain float64 geodesy while GPU
coordinates stay local float32.

The demo is a rate-controlled toy quad with collective thrust, first-order
spool lag, quaternion, gravity, and linear drag. Translation uses
semi-implicit Euler; `down<=0` constrains a flat ground plane. Voltage is
an illustrative throttle-dependent indicator, not electrochemistry. There
are no individual motors, landing-gear contacts, rotor BET, or autorotation.

The target DynamicsBackend provides reset(config),
step(dt, actuatorFrame, atmosphere, contactInput), and
readTruth(preallocatedOutput), refined into the typed stepInto facade in
the engine specification. Autopilot supplies actuators; physics produces
forces and moments.

* JSBSim retains its own equations of motion. Convert ft/slugs and frame
  conventions explicitly at the C ABI boundary.
* BET computes element-relative flow, angle of attack, Re/Mach polar lookup,
  and integrated forces/moments. Autorotation requires aerodynamic torque,
  inertia, flapping, and induced-flow dynamics rather than prescribed RPM.
* Arbitrary frames use `F=sum R_i*F_i` and
  `M=sum(r_i cross R_i*F_i + R_i*M_i)` in body coordinates. ESC, voltage,
  rotor inertia, and coaxial interactions have separate states.
* Rapier/Jolt integration has one rigid-body owner. BET may supply solver
  forces; JSBSim needs consistent contact impulse coupling. Two independent
  integrators for one body are forbidden.

## ArduPilot integration boundaries

Modes are mutually exclusive. Lifecycle:
`disconnected -> initializing -> warming -> ready -> running -> fault`.

1. **External SITL is the first target backend.** Development bridge:
   `ws://localhost:9002`. HTTPS deployment must check mixed-content/Private
   Network Access and use trusted local WSS where necessary. Bind loopback,
   validate Origin/session, and bound message size/rate. JSON/UDP physics
   provides truth/sensor lockstep; MAVLink provides RC/commands/diagnostics.
   RC_CHANNELS_OVERRIDE alone does not integrate external physics.
2. **WASM ArduPilot is a feasibility project.** HAL, scheduler, storage,
   sockets, licenses, clocks, and native parity all need verification.
   Compiling a binary to WASM alone does not establish a working port.
3. **HITL targets Chromium on macOS/Windows.** Require a secure context
   and a user gesture for requestPort. Safari/Firefox are not target HITL
   browsers. MAVLink2 parsing checks CRC/dialect/seq/sysid/compid and signing
   when required. HIL_SENSOR runs at 200–400 Hz; HIL_GPS at 5–10 Hz;
   HIL_ACTUATOR_CONTROLS uses consistent timestamps. Verify message/build/HIL
   support on the exact ArduPilot firmware/board. SITL support does not
   establish hardware HIL capability.

At 8N1, the serial ceiling is baud/10 bytes/s including framing and all
traffic. 115200 may be insufficient; measure headroom and use supported FC
baud rates. Selecting a port does not validate a closed loop.

Warmup means 30 seconds of simulation time in SITL lockstep, without EW,
with coherent IMU/GNSS/mag timestamps. Readiness depends on EKF health,
status, and innovations, not merely a timer. HITL cannot fast-forward
physical FC filters. Neither warmup nor MAVLink is implemented yet.

## EW, terrain, cameras, and AAR

Keep truth unchanged: truth -> ideal sensors -> noise/bias -> EW -> adapter.
Each sensor defines rates, latency, axes, units, and seeded RNG. ABI inertial
acceleration includes gravity; HIL accelerometers need specific force after
subtracting gravity and rotating into body axes.

Bound inverse-square exposure with positive r_min and saturation; cones
include direction/aperture. A receiver model is required: power is not
satellite count. GNSS loss/spoofing changes observations. Coherent drift
integrates position/velocity consistently rather than teleporting truth.
Magnetic errors use sensor axes. Motor faults act on a selected actuator
before force aggregation. EKF/mode behavior depends on firmware, parameters,
and other sensors; do not promise gate bypass or a particular failsafe
without pinned scenario regression evidence.

WebGL2 is the baseline. WebGPU is a separate capability-detected backend
with visual parity tests; the browser chooses Metal/DX12. Bound DPR,
textures, and tile LOD. RTX 4050 has 6 GB shared with browser/framebuffer
needs; M4 uses shared RAM. Terrain decoding must not run in Physics Worker.

Google Photorealistic Tiles requires billing, keys, attribution, and Map
Tiles API compliance. **Persistent Google tile copying into R2 and prefetching
a 10–15 km region are not assumed authorized.** Check licensing/caching
rules first. Cache only permitted content/TTLs or use owned/licensed offline
tiles. Cloudflare proxy hides keys, enforces origin/session/quota, and
respects provider TTLs. COEP requires CORS/CORP for external tiles/WASM.

Analog FPV is postprocessing independent of truth. WorldCover/OSM gives
surface classes, not temperature. Thermal modeling needs emissivity,
weather, solar heating, inertia, attenuation, and calibration data. AO
does not calculate heat. Start with controlled synthetic materials and
a defined GPU budget.

The state ring holds only about 0.64 s for rendering. AAR needs a separate
bounded recorder Worker/IndexedDB with inputs, actuators, truth, sensors,
EKF, seed/config/version/events, and explicit losses. State replay differs
from resimulation; compare native/WASM within declared numerical tolerances.

## Implementation milestones and acceptance

| Milestone | Result | Verification |
| --- | --- | --- |
| 01 — current | Worker/SAB/Gamepad/demo | Unit tests; real-browser Worker, flight/pause/reset, mock USB |
| 02 | WASM physics facade and sensors | Forces/moments, specific force, contact/energy, 400/800/1200 convergence |
| 03 | External SITL lockstep | Arm/takeoff/land, EKF readiness, RC, link loss, pinned ArduPilot |
| 04 | BET/frames/autorotation | Thrust curves, torque balance, energy, spool/battery, measured references |
| 05 | EW and AAR | Seeded replay, truth/observation separation, EKF/mode response |
| 06 | HITL | Physical board/firmware, sustained throughput, jitter/loss/failsafe |
| 07 | Terrain/FPV/thermal/WebGPU | Licensing/attribution, VRAM/LOD, M4/RTX 4050 evidence |
| Feasibility | ArduPilot WASM | External/native SITL parity before enabling the mode |

These capability milestones are not the detailed Phase 0–6 sprint schedule;
the roadmap defines dependencies and execution order.

Measure production on M4 and RTX 4050 with a visible tab after warmup:
frame-time p50/p95/p99, Worker compute/deadline lateness, executed steps/s,
dropped wall time, input age, sensor jitter, GPU memory, and end-to-end
latency. 120 FPS allows 8.33 ms/frame; 60 FPS allows 16.67 ms. A 1200 Hz
physics step has 0.833 ms and needs headroom. Headless cloud smoke does
not establish these performance budgets.

## Phase 0 contracts: fixtures, capabilities, and models

TASK-004–006 introduce configuration-time boundaries; they do not add a new
physics backend. TASK-007 retains the running ABI v1. The v1 tests pin 32896
bytes, a 64-byte header, 256 states of 128 bytes, and the pilot mailbox at byte
32832. `tests/protocol-golden.test.ts` adds an independent oracle: the
registered, hand-authored fixture `tests/fixtures/abi/v1-layout.json` must
match the header, state, and pilot mailbox v1 byte tables in
SPECS_SHARED_MEMORY.md field by field, and every byte of the 32896-byte buffer
written by StateWriter and ControlWriter (header, two ring slots, untouched
slots, reserved words, and mailbox) must equal an image packed by a local
DataView. The v1 readers are not used, so a symmetric encoder/decoder offset
error cannot pass. TASK-008 adds the v2 layout constants, state and pilot
codecs, header initialization, validation, and v1/v2 negotiation to
packages/protocol. They are verified against `tests/fixtures/protocol/state-v2.hex`,
golden records packed with Python struct from the specification tables
independently of the TypeScript encoder. TASK-009 adds the section 4 bounded
seqlock transport: StateWriterV2/StateReaderV2 with sample_id and head checks
and at most three read attempts, PilotWriterV2/PilotReaderV2, header
diagnostics, and epoch-safe render history (latestPair never pairs frames
across an epoch, model, or tick gap). A real-thread stress test publishes
1e6 frames in Node worker_threads and in a browser module Worker while the
reader checks every field; removing the seqlock re-check makes it report torn
frames. TASK-010 adds Control Protocol v2: `parseControlCommandV2` validates
untrusted commands into normalized copies, `control-v2.schema.json` is the
equivalent JSON Schema 2020-12 contract (an Ajv equivalence test covers more
than 50 cases), and `ControlProcessorV2` implements deduplication, epochs, the
128-command schedule applied before integrating each tick, lifecycle state
rules, and atomic model swaps behind a `ControlTargetV2` interface with a
preallocated outbox. The running application remains on v1 until TASK-085.

### Verified fixture manifests and deterministic streams

`packages/test-support` exports `./fixtures` and `./prng`. The registry at
`tests/fixtures/registry.json` records paths relative to `tests/fixtures/`.
Its three reference payloads are explicitly synthetic: analytical NED
ballistic samples under constant gravity, a demonstration quad configuration,
and the hand-authored ABI v1 byte layout. They provide reproducible software
oracles, not experimental aerodynamic evidence.

`verifyFixture(metadata, bytes)` snapshots both inputs before awaiting SHA-256,
validates strict formatVersion 1 metadata, compares the lowercase 64-character
hash with the exact payload bytes, and returns a deeply frozen manifest.
Whitespace changes require a new hash. Payloads are limited to 16 MiB.
Each quantity has a recognized SI/unit token and matching finite closed bounds;
absolute and relative tolerances must be finite and nonnegative. The unit
vocabulary is `1`, `s`, `us`, `m`, `m/s`, `m/s^2`, `rad`, `rad/s`, `N`, `N*m`,
`kg`, `kg*m^2`, `Pa`, `K`, `V`, `A`, `rev/min`, and `gauss`.

Provenance is a strict discriminated union. Synthetic data requires a derivation;
measured data requires datasetId, license, parseable acquiredAt, and an HTTPS
reference. Relabeling synthetic metadata while retaining derivation is rejected.
Metadata cannot prove a measurement occurred: review its external source before
using it to satisfy a physics validation gate. A digest checks integrity against
a trusted registry entry; it is not authentication of an arbitrary supplied hash.

`SeededRandom(seed, streamId)` accepts uint32 values, including zero. Its version
is `mulberry32-mix32-v1`; reset reproduces the sequence. Initial state is
`mix32(seed ^ mix32(streamId ^ 0x9e3779b9))`, with uint32 arithmetic. mix32 applies
xor shifts 16/15/15 and multiplication constants 0x21f0aaad and 0x735a2d97.
Mulberry32 advances by 0x6d2b79f5. `nextUint32()` returns [0, 2^32−1];
`nextFloat()` divides by 2^32 to produce [0,1). Seed 123 / stream 7 has the frozen
uint32 sequence 1915834569, 2163859737, 2018986825, 2541224312, 3937151044.
Separate instances have independent mutable state; this is neither cryptographic
randomness nor a proof of statistically independent or nonoverlapping streams.
Construction/reset validate outside the step; drawing numbers allocates no
objects. Sensor stream assignment is part of the future sensor/EW contract.

### Browser eligibility before Worker startup

`apps/web/src/capabilities.ts` exposes `CapabilityReport` and injectable
`inspectCapabilities(environment?, timeoutMs?)`. Secure context, cross-origin
isolation, SharedArrayBuffer, Worker, and successful WebGL2 context creation
are all required for the current graphical demo. Missing prerequisites keep
Start disabled, suppress Worker/scene construction, and display an explanation.
READY still requires the actual Worker's initialization acknowledgement.
USB additionally requires Gamepad API availability. Transmitter presence,
channel calibration, and connected status remain separate input checks.

WebGPU adapter probing handles rejection, null, and a one-second timeout while
preserving WebGL2. The temporary WebGL2 probe releases its context. Serial is
probed without requesting permission. API availability is distinct from mode
eligibility: `hitlEligible` and `webgpuEligible` remain false because those
integrations do not exist yet. Chromium browser tests override API availability
and exercise the real supported Worker/renderer; they do not validate hardware.

### Model admission and immutable session IDs

`@mirage/physics/model-manifest` is a separate package export. Its AJV 8.20.0
schema and asynchronous loader stay outside the existing demo Worker import
graph. Serialized `ModelDescriptor`/`RotorGeometry` use readonly JSON arrays;
they are configuration representations of the target engine geometry, not the
future typed-array WASM ABI in SPECS_SIMULATION_ENGINES. `VerifiedModel` holds
`{sha256, manifest}` separately so the manifest never hashes itself.

`model.schema.json` uses JSON Schema draft-07, forbids unknown properties, and
requires schemaVersion 1, units SI, world NED, body FRD, quaternion order wxyz,
positive finite mass, a nine-entry row-major inertia, modelId in [1,2^32−1],
kind demo/bet/jsbsim, rotorCapacity 32, and matching rotorCount/rotors in [0,32].
Inertia must be exactly symmetric and Cholesky positive definite; validation
never repairs a tensor. Rotor IDs and motor channels are unique integers [0,31].
Blades are [1,16], azimuth samples [1,64], and polar IDs uint32.

Rotor validation requires positive radius/chords/shaft inertia/quadrature widths,
nonnegative cutout and bearing friction, spin sign ±1, finite geometry, and a
unit hub-to-body wxyz quaternion within 1e-6 in norm. Radial station, chord,
twist, and width arrays have the same length [1,64]. Stations strictly increase
inside (cutout,radius); widths sum to radius−cutout within 1e-9 m. This checks
structural admissibility, not polar availability or aerodynamic validity.

`ModelRegistry.register(bytes, expectedSha256)` snapshots at most 1 MiB, verifies
raw bytes against a trusted SHA-256, decodes strict UTF-8 JSON, validates and
freezes a snapshot, then admits it to the session registry. An identical ID/hash
returns the same record; a different hash for an existing ID is a collision.
Hash/schema/physics failures leave registry contents unchanged, including when
the caller mutates its original bytes during hashing. `get(modelId)` returns
the verified immutable record. Runtime model switching is introduced in
TASK-010; the current demo is not switched by this registry. Configuration
validation may allocate; none of this work belongs inside the physics step.
