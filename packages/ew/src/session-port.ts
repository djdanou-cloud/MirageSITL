// Production SessionFaultPort (TASK-075, TASK-124): the physics Worker and
// its tests drive PhysicsSessionV2 through this one adapter around an
// EwEngine, so the port under test is the port the application runs. The
// port owns no motor table: the session binds the table of its active
// dynamics. advanceInto copies the session context into preallocated scratch
// and allocates nothing.
import type { SessionFaultPort } from "@mirage/physics";
import { EwEngine, type EwContext } from "./engine.ts";

export function createSessionFaultPort(): SessionFaultPort {
  let engine = new EwEngine();
  const scratch: EwContext = { dtS: 0, simTimeS: 0, truthNorthM: 0, truthEastM: 0, truthDownM: 0 };
  return {
    apply: (command, tick) => engine.apply(command, tick),
    reset: (seed) => engine.reset(seed),
    // EwEngine fixes its motor table at construction, so a new table means a new
    // engine. The session binds only when it adopts a dynamics (construction,
    // sim.configure), which starts a fault-free epoch; the seed carries over.
    bindMotors(motors) {
      const seed = engine.seed;
      engine = new EwEngine(motors);
      engine.reset(seed);
    },
    advanceInto(context) {
      scratch.dtS = context.dtS;
      scratch.simTimeS = context.simTimeS;
      scratch.truthNorthM = context.northM;
      scratch.truthEastM = context.eastM;
      scratch.truthDownM = context.downM;
      return engine.advanceInto(scratch);
    },
    get flags() { return engine.flags; },
  };
}
