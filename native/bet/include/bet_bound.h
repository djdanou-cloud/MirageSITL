#ifndef MIRAGE_BET_BOUND_H
#define MIRAGE_BET_BOUND_H
#include <stdint.h>
/* Additive bound rotor ABI v1. All offsets are bytes; all arrays are f64 LE.
 * Caller-owned regions must be >= __heap_base, aligned to 8 and disjoint.
 * Config = 128-byte header, radius/chord/twist/width arrays, alpha/Re/Mach axes,
 * CL/CD/confidence tables in (Mach,Re,alpha) order. Arena = 64 + config bytes.
 * Configuration bytes are immutable after init; no growth after initialization.
 * Every negative status leaves the step output and state unchanged.
 */
#define BET_BOUND_VERSION 1
#define BET_BOUND_CONFIG_HEADER 128
#define BET_BOUND_ARENA_HEADER 64
#define BET_BOUND_INPUT_BYTES 128
#define BET_BOUND_OUTPUT_BYTES 128
#define BET_BOUND_LOW_CONFIDENCE 4
#define BET_BOUND_OUTSIDE_INFLOW 8
#define BET_BOUND_REVERSE_LIMIT 16
/* Configuration version 2 (TASK-091): version 1 plus a u32 kernel options word
 * at config byte 36 (reserved zero in version 1). Option 1: the half-step
 * prediction uses azimuth samples 0 and N/2. Option 2: near hover the midpoint
 * uses every other azimuth sample; its state (f64 0 or 1) sits in arena header
 * bytes 56..63, which stay zero without it. Output flags 64 and 128 report the
 * steps that used them and are not validity breaches. Option 4 (TASK-091
 * increment 3) runs the exact kernel, bitwise equal to the reference, instead
 * of the default kernel, which agrees with it within T1 (1e-12 relative);
 * it cannot combine with options 1 and 2.
 * Configuration version 3 (TASK-097): version 2 plus option 8, rotational lift
 * augmentation, with the f64 lift slope (1/rad) at config byte 112 and the f64
 * zero-lift angle (rad) at byte 120. Bytes 112..127 stay reserved zero otherwise.
 * Configuration version 4 (TASK-098): version 3 plus option 16, Pitt-Peters dynamic
 * inflow with annular tip and hub losses. The configuration then ends with (3 + nStations)
 * f64, zero at init and reset and written by the step inside the arena: harmonics on
 * cos and sin (m/s), the loss minus 1, and each strip's shape minus 1. An inflow tau of 0
 * asks for the derived time constant. */
#define BET_BOUND_CONFIG_VERSION_OPTIONS 2
#define BET_BOUND_OPTION_REDUCED_PREDICTOR 1
#define BET_BOUND_OPTION_HOVER_SAMPLING 2
#define BET_BOUND_OPTION_EXACT_KERNEL 4
#define BET_BOUND_HOVER_SAMPLING 64
#define BET_BOUND_REDUCED_PREDICTOR 128
uint32_t bet_bound_version(void);
int32_t bet_bound_init(uint32_t config, uint32_t config_bytes, uint32_t arena, uint32_t arena_bytes);
int32_t bet_bound_step(uint32_t arena, uint32_t input, uint32_t output, double dt);
int32_t bet_bound_reset(uint32_t arena);
void bet_bound_dispose(uint32_t arena);

/* Step interfaces v2 (TASK-088). Bound-rotor input/output records are 256 bytes
 * on unchanged v1 arenas; the body input is 448 bytes with a 256-byte output.
 * Fields owned by later tasks must hold neutral values, otherwise the step
 * returns BET_V2_UNSUPPORTED and changes nothing. Outputs carry validity bits.
 */
#define BET_BOUND_V2_VERSION 2
#define BET_BOUND_V2_INPUT_BYTES 256
#define BET_BOUND_V2_OUTPUT_BYTES 256
#define BET_BOUND_V2_GROUND_PLANE 1
#define BET_BOUND_V2_DRIVE_TORQUE 0
#define BET_BOUND_V2_DRIVE_ESC_DUTY 1
#define BET_BOUND_V2_VALID_ELECTRICAL 1
#define BET_BOUND_V2_VALID_INFLOW_HARMONICS 2
#define BET_BOUND_V2_VALID_GROUND_EFFECT 4
#define BET_BOUND_V2_VALID_EXTERNAL_WAKE 8
/* Drive mode 1 (TASK-092): drive parameters at input bytes 192..247, drive
 * flags at 248; ESC state in arena header bytes 32..55. */
#define BET_BOUND_V2_DRIVE_POWER_CUT 1
#define BET_BOUND_V2_FLAG_CURRENT_LIMITED 32
#define BET_BODY_V2_VERSION 2
#define BET_BODY_V2_INPUT_BYTES 448
#define BET_BODY_V2_OUTPUT_BYTES 256
#define BET_BODY_V2_GRAVITY_CONSTANT_DOWN 0
#define BET_BODY_V2_GRAVITY_NED_VECTOR 1
#define BET_BODY_V2_GRAVITY_WGS84 2
#define BET_BODY_V2_MASS_RATES 1
#define BET_BODY_V2_VALID_SPECIFIC_FORCE 1
#define BET_BODY_V2_VALID_ANGULAR_ACCELERATION 2
#define BET_BODY_V2_VALID_REFERENCE_POSITION 4
#define BET_V2_UNSUPPORTED (-8)
uint32_t bet_bound_v2_version(void);
int32_t bet_bound_step_v2(uint32_t arena, uint32_t input, uint32_t output, double dt);
uint32_t bet_body_v2_version(void);
int32_t bet_body_step_v2(uint32_t input, uint32_t output, double dt);
/* Shared battery bus (TASK-092): 128-byte input and output records. */
#define BET_BUS_VERSION 1
#define BET_BUS_INPUT_BYTES 128
#define BET_BUS_OUTPUT_BYTES 128
#define BET_BUS_FLAG_POWER_LIMITED 1
#define BET_BUS_FLAG_CHARGE_LIMITED 2
uint32_t bet_bus_version(void);
int32_t bet_bus_step(uint32_t input, uint32_t output, double dt);
/* TASK-197: the bus and ESC rotors solved together for one step. table: count pairs of u32 (arena, v2 input record). */
#define BET_BUS_SOLUTION_VERSION 1
#define BET_BUS_SOLUTION_BYTES 64
uint32_t bet_bus_solve_version(void);
int32_t bet_bound_bus_solve_v2(uint32_t table, uint32_t count, uint32_t bus, uint32_t output, double dt);
#endif
