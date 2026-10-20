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
uint32_t bet_bound_version(void);
int32_t bet_bound_init(uint32_t config, uint32_t config_bytes, uint32_t arena, uint32_t arena_bytes);
int32_t bet_bound_step(uint32_t arena, uint32_t input, uint32_t output, double dt);
int32_t bet_bound_reset(uint32_t arena);
void bet_bound_dispose(uint32_t arena);
#endif
