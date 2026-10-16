# HITL firmware capability matrix

English source. [Russian mirror](../ru/hitl-matrix.md).

Status: BLOCKED_EXTERNAL. No board profile has been verified on hardware.
`evaluateHitlCapability` (`packages/autopilot/src/hitl-capabilities.ts`) is the
only producer of a READY verdict, and `AutopilotSession.connect("hitl")`
refuses anything else. SITL availability is not evidence of HITL support.

## Gate

HITL becomes READY only when all of the following hold:

1. Source evidence at a pinned commit shows the stack consumes HIL_SENSOR and
   HIL_GPS and emits HIL_ACTUATOR_CONTROLS.
2. A board profile records board, firmware stack/version/git SHA, build flags,
   verification date, operator and the SHA-256 of the evidence bundle.
3. The connected autopilot reports the profile's git SHA (AUTOPILOT_VERSION),
   sets MAV_MODE_FLAG_HIL_ENABLED (32) in HEARTBEAT base_mode, and has sent
   HIL_ACTUATOR_CONTROLS within 100 ms.

Missing evidence yields BLOCKED_EXTERNAL with the exact requirement; a stack
whose source lacks a message path yields UNSUPPORTED.

## Firmware source evidence

| Stack | Pinned commit | HIL_SENSOR in | HIL_GPS in | HIL_ACTUATOR_CONTROLS out | Verdict |
| --- | --- | --- | --- | --- | --- |
| ArduPilot | 8ab6afde107a91df1b5f60ade8f333cb8a61b190 | no | no | no | UNSUPPORTED |
| PX4 | 4d7e4de77742c3ae8187ffc998ed6d04629c611b | only in HIL mode | in HIL mode or with use_hil_gps | yes (stream) | needs a verified board |

ArduPilot: GCS_Common.cpp (sha256 345233ce691a29f21e66d50b81ce75db9672eb29e9d39ac2d0e9e139e92836ec),
the Copter/Plane MAVLink handlers, GCS.h and AP_InertialSensor contain no
handler for these messages; external GNSS uses GPS_INPUT. ArduPilot simulation
uses the JSON SITL backend (TASK-041) instead.

PX4: mavlink_receiver.cpp (sha256 2e22f0d3e22a48f2793202f7e9dba3526afbb5da8221ab3a78d461008364571b)
decodes HIL_SENSOR only while HIL mode is enabled; HIL_ACTUATOR_CONTROLS.hpp
(sha256 1ac5017c301c73801d1e8329024fb5f54183fbe58292e56ef29b2bc6b6b903b7) is a
MAVLink stream. Source support is not board support.

## Verified board profiles

None. To add one, record on real hardware: board and revision, firmware git
SHA and build flags, the HIL mode setting used, a capture showing the HEARTBEAT
HIL flag and HIL_ACTUATOR_CONTROLS with the 30% serial headroom from TASK-049,
then store the evidence bundle's SHA-256 in the profile. Physical acceptance is
TASK-051.
