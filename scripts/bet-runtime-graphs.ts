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
