/*
 * mirage-bet C ABI (TASK-018), docs/SPECS_SIMULATION_ENGINES.md section 4.
 *
 * All records are little-endian byte layouts at the offsets below, aligned to
 * BET_RECORD_ALIGN. Pointers are wasm32 linear-memory offsets (uint32_t), must
 * be non-null, aligned, inside memory, at or above the exported __heap_base,
 * and regions passed to one call must not overlap. Never cast an arbitrary
 * object to these records: write each field at its offset. Unused station
 * slots and reserved bytes must be zero. This header is the shared layout
 * source checked by native/bet/tests/abi.rs and tests/wasm-abi.test.ts.
 */
#ifndef MIRAGE_BET_H
#define MIRAGE_BET_H

#include <stdint.h>

#define BET_ABI_VERSION 1
#define BET_MAX_ROTORS 32
#define BET_MAX_STATIONS 64
#define BET_MAX_AZIMUTH_SAMPLES 64
#define BET_MAX_BLADES 16
#define BET_RECORD_ALIGN 8

/* Configuration header (64 bytes), followed by rotor_count rotor configs. */
#define BET_CONFIG_HEADER_BYTES 64
#define BET_CONFIG_ABI_VERSION 0        /* u32 */
#define BET_CONFIG_CONFIG_BYTES 4       /* u32: 64 + rotor_count * 2160 */
#define BET_CONFIG_ROTOR_COUNT 8        /* u32: 1..32 */
#define BET_CONFIG_ROTOR_STRIDE 12      /* u32: BET_ROTOR_BYTES */
#define BET_CONFIG_DT_S 16              /* f64: exactly 1/400, 1/800, or 1/1200 */
#define BET_CONFIG_RESERVED 24          /* 40 bytes, zero */

/* Rotor configuration record (2160 bytes). */
#define BET_ROTOR_BYTES 2160
#define BET_ROTOR_ID 0                  /* u32 */
#define BET_ROTOR_BLADE_COUNT 4         /* u32: 1..16 */
#define BET_ROTOR_SPIN_SIGN 8           /* i32: +1 or -1 */
#define BET_ROTOR_STATION_COUNT 12      /* u32: 1..64 */
#define BET_ROTOR_AZIMUTH_SAMPLES 16    /* u32: 1..64 */
#define BET_ROTOR_POLAR_ID 20           /* u32 */
#define BET_ROTOR_RADIUS_M 24           /* f64 > 0 */
#define BET_ROTOR_ROOT_CUTOUT_M 32      /* f64 in [0, radius) */
#define BET_ROTOR_HUB_POSITION_BODY_M 40 /* f64[3], body FRD */
#define BET_ROTOR_HUB_TO_BODY 64        /* f64[4] w,x,y,z unit quaternion */
#define BET_ROTOR_SHAFT_INERTIA_KG_M2 96 /* f64 > 0 */
#define BET_ROTOR_BEARING_VISCOUS_NM_PER_RAD_S 104 /* f64 >= 0 */
#define BET_ROTOR_RADIAL_STATION_M 112  /* f64[64], strictly increasing */
#define BET_ROTOR_CHORD_M 624           /* f64[64] > 0 */
#define BET_ROTOR_TWIST_RAD 1136        /* f64[64] */
#define BET_ROTOR_QUADRATURE_WIDTH_M 1648 /* f64[64] > 0 */

/* Step input header (64 bytes), followed by rotor_count rotor inputs. */
#define BET_INPUT_HEADER_BYTES 64
#define BET_INPUT_ROTOR_COUNT 0         /* u32: configured count */
#define BET_INPUT_ROTOR_STRIDE 4        /* u32: BET_ROTOR_INPUT_BYTES */
#define BET_INPUT_DENSITY_KG_M3 8       /* f64 > 0 */
#define BET_INPUT_DYNAMIC_VISCOSITY_PA_S 16 /* f64 > 0 */
#define BET_INPUT_SPEED_OF_SOUND_MPS 24 /* f64 > 0 */
#define BET_INPUT_RESERVED 32           /* 32 bytes, zero */

/* Rotor step input record (96 bytes). */
#define BET_ROTOR_INPUT_BYTES 96
#define BET_ROTOR_INPUT_AIR_VELOCITY_AT_HUB_HUB_MPS 0 /* f64[3] */
#define BET_ROTOR_INPUT_BODY_ANGULAR_VELOCITY_HUB_RAD_S 24 /* f64[3] */
#define BET_ROTOR_INPUT_COLLECTIVE_PITCH_RAD 48 /* f64 */
#define BET_ROTOR_INPUT_CYCLIC_COS_RAD 56 /* f64 */
#define BET_ROTOR_INPUT_CYCLIC_SIN_RAD 64 /* f64 */
#define BET_ROTOR_INPUT_MOTOR_TORQUE_MAGNITUDE_NM 72 /* f64 >= 0 */
#define BET_ROTOR_INPUT_FLAGS 80        /* u32, zero */
#define BET_ROTOR_INPUT_RESERVED 84     /* 12 bytes, zero */

/* Rotor output record (128 bytes). */
#define BET_OUTPUT_BYTES 128
#define BET_OUTPUT_FORCE_HUB_N 0        /* f64[3] */
#define BET_OUTPUT_AIR_MOMENT_HUB_NM 24 /* f64[3] */
#define BET_OUTPUT_TRANSMITTED_MOMENT_HUB_NM 48 /* f64[3] */
#define BET_OUTPUT_OMEGA_RAD_S 72       /* f64 */
#define BET_OUTPUT_AERO_SHAFT_TORQUE_NM 80 /* f64 */
#define BET_OUTPUT_SHAFT_POWER_W 88     /* f64 */
#define BET_OUTPUT_INDUCED_AXIAL_VELOCITY_MPS 96 /* f64 */
#define BET_OUTPUT_CONE_RAD 104         /* f64 */
#define BET_OUTPUT_FLAGS 112            /* u32 */
#define BET_OUTPUT_RESERVED 116         /* u32, zero */
#define BET_OUTPUT_ANGULAR_MOMENTUM_NMS 120 /* f64 */

/* Engine arena: 64-byte header + configuration copy + 64 bytes per rotor state. */
#define BET_ARENA_HEADER_BYTES 64
#define BET_ARENA_ROTOR_STATE_BYTES 64

/* Status codes (int32_t). Outputs are written only for status >= 0. */
#define BET_STATUS_OK 0
#define BET_STATUS_AERODYNAMICS_UNAVAILABLE 1
#define BET_STATUS_BAD_HANDLE -1
#define BET_STATUS_BAD_POINTER -2
#define BET_STATUS_BAD_INPUT -3
#define BET_STATUS_BAD_DT -4
#define BET_STATUS_MEMORY_GROWN -5
#define BET_STATUS_ARENA_TOO_SMALL -6
#define BET_STATUS_ABI_MISMATCH -7

/* Output validity flags (u32). */
#define BET_FLAG_AERODYNAMICS_UNAVAILABLE 1
#define BET_FLAG_OUTSIDE_POLAR_VALIDITY 2

uint32_t bet_abi_version(void);
/* Arena bytes for a valid configuration, or 0 (reason: bet_last_error). */
uint32_t bet_required_bytes(uint32_t config_ptr, uint32_t len);
/* Copies the configuration into the arena; returns a nonzero handle or 0. */
uint32_t bet_init(uint32_t config_ptr, uint32_t len, uint32_t arena_ptr, uint32_t arena_bytes);
/* Status of the last failed bet_required_bytes/bet_init call. */
int32_t bet_last_error(void);
int32_t bet_step(uint32_t handle, uint32_t input_ptr, uint32_t out_ptr, double dt_s);
int32_t bet_reset(uint32_t handle, uint32_t seed);
void bet_dispose(uint32_t handle);

#endif /* MIRAGE_BET_H */
