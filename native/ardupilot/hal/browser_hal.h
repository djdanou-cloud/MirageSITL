#pragma once
#include <cstdint>

// Independent transport ABI. All shared payload words are accessed atomically.
// Header: magic/version/bytes/state/hz/epoch/requestTickLo/Hi/inputSequence/
// outputSequence/fault/channelCount/armed/reserved/timeUsLo/Hi (u32).
// Sensor payload: 40 little-endian f64 at 64. PWM: 32 u32 at 512.
// Diagnostics: 16 f64 at 768. Version 2 (TASK-105): motor speed, 16 f64 rev/min at 896 by
// firmware output channel 0..15, with their channel mask in header word 13 (the reserved
// word of version 1); a channel outside the mask holds 0. Remaining words are reserved zero.
namespace MirageHal {
constexpr uint32_t MAGIC = 0x4d48414c, VERSION = 2, BYTES = 1024;
enum State : uint32_t { Initial = 0, Requested = 1, Supplied = 2, Stop = 3, Stopped = 4, Fault = 5 };
struct Sensor {
    uint64_t timestamp_us;
    double values[40];
    // TASK-105: each output channel's motor speed, rev/min, for ArduPilot's ESC telemetry.
    double rpm[16];
    uint32_t rpm_mask;
};
// Sensor SI fields: lat/lon degrees, MSL metres, velocity NED[3], specific
// force FRD[3], gyro rad/s[3], quaternion body-to-NED wxyz[4], magnetic gauss[3],
// airspeed m/s, battery V/A, height AGL m, RC[12] [0,1], wind NED[3], reserved[2].
bool exchange(const uint16_t pwm[32], bool armed, Sensor &out);
double degrees(double radians);
void diagnostics(const Sensor &s, double out[16]);
}

extern "C" {
uint32_t mirage_hal_version();
uintptr_t mirage_hal_mailbox();
int32_t mirage_hal_configure(uint32_t hz, uint32_t epoch);
void mirage_hal_notify();
void mirage_hal_stop();
}
