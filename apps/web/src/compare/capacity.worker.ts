/// <reference lib="webworker" />
import { buildProfileDynamics } from "@mirage/physics/profile-dynamics";
import { thrustCapacity } from "@mirage/physics/thrust-capacity";
import { validateVehicleManifest } from "@mirage/physics/vehicle-manifest";

// The thrust at full command of one aircraft (TASK-177), in a Worker of its own: a calculation of
// some seconds of simulated rotors should not hold up the page. It takes a derived manifest and
// the BET module's bytes, both from this page, and answers once per request.

const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);
let compiled: Promise<WebAssembly.Module> | null = null;

addEventListener("message", (event: MessageEvent<unknown>) => {
  const { data } = event, id = field(data, "id"), bytes = field(data, "moduleBytes"), stateOfCharge = field(data, "stateOfCharge");
  void (async () => {
    try {
      if (!(bytes instanceof Uint8Array) || typeof stateOfCharge !== "number") throw new Error("A thrust request needs the BET module and a state of charge");
      compiled ??= WebAssembly.compile(new Uint8Array(bytes));
      const module = await compiled;
      const build = buildProfileDynamics(validateVehicleManifest(field(data, "manifest")), { initialStateOfCharge: stateOfCharge, syntheticPad: true });
      postMessage({ id, capacity: thrustCapacity(module, build.configuration) });
    } catch (error) {
      postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
