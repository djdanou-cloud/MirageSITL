// The graphs of `scripts/check-bet-runtime.mjs --allocation`: a report holds
// exactly one sample of each graph and WASM variant, and
// scripts/validate-models.mjs admits only that set.
export type AllocationVariant = "scalar" | "simd128";

export const ALLOCATION_GRAPHS: readonly (readonly [graph: string, variant: AllocationVariant])[] = [
  ["active-neuralfoil-rotor", "scalar"], ["active-neuralfoil-rotor", "simd128"],
  // TASK-088 step interfaces v2.
  ["active-neuralfoil-rotor-v2", "scalar"], ["active-neuralfoil-rotor-v2", "simd128"],
  ["stationary-zero-gravity-body-v2", "scalar"], ["stationary-zero-gravity-body-v2", "simd128"],
  ["stationary-zero-gravity-four-rotor-flight", "scalar"], ["synthetic-pad-four-rotor-flight", "scalar"],
  // TASK-092 ESC drive and shared bus.
  ["esc-drive-bus-synthetic-pad-four-rotor", "scalar"],
  // TASK-093 weather: the seeded gust and the per-step air on the rotors, and the real session applying scheduled weather.set.
  ["weather-synthetic-pad-four-rotor", "scalar"], ["weather-session-synthetic-pad", "scalar"],
  // TASK-096 airframe drag in a gusty wind, its validity flag switching on and off.
  ["airframe-drag-weather-pad-four-rotor", "scalar"],
  // TASK-097 a full-range table: four Mach nodes, and rotational augmentation on every strip.
  ["extended-polar-synthetic-pad-four-rotor", "scalar"], ["extended-polar-synthetic-pad-four-rotor", "simd128"],
  // TASK-098 dynamic inflow with its annular solve.
  ["dynamic-inflow-synthetic-pad-four-rotor", "scalar"], ["dynamic-inflow-synthetic-pad-four-rotor", "simd128"],
  // TASK-100 the rotor ground effect, on every rotor at every step.
  ["ground-effect-esc-drive-pad-four-rotor", "scalar"],
  // TASK-101 the rotor wakes, every ordered pair checked and one reaching a rotor at every step, with a download.
  ["rotor-wake-esc-drive-pad-four-rotor", "scalar"],
  // TASK-145 calibrated rotors on the ESC drive, checked against their bench envelope every step, its flag switching with the air's density.
  ["calibrated-esc-weather-pad-four-rotor", "scalar"],
  // TASK-103 a table rotor on every arm on the ESC drive, its loads read off the nodes at every step.
  ["rotor-map-esc-drive-weather-pad-four-rotor", "scalar"], ["rotor-map-esc-drive-weather-pad-four-rotor", "simd128"],
];

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** True when `samples` holds exactly one sample of every graph and variant and nothing else. */
export function completeAllocationSamples(samples: unknown): boolean {
  return Array.isArray(samples) && samples.length === ALLOCATION_GRAPHS.length &&
    ALLOCATION_GRAPHS.every(([graph, variant]) =>
      samples.filter((sample: unknown) => field(sample, "graph") === graph && field(sample, "variant") === variant).length === 1);
}
