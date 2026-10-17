import type { Scenario } from "./schema.ts";
/** Simulation ticks only. Returns immutable event indices; the I/O owner binds epoch/ACKs.
 * Dispatch failures halt the owner; this runner alone cannot certify applied faults.
 */
export class ScenarioRunner {
  private cursor = 0;
  private lastTick = -1;
  readonly scenario: Scenario;
  constructor(scenario: Scenario, modelSha256: string, firmwareSha256: string, seed: number, hz: number) {
    if (modelSha256 !== scenario.modelSha256 || firmwareSha256 !== scenario.firmwareSha256 || seed !== scenario.seed || hz !== scenario.hz) throw new Error("Scenario provenance mismatch");
    this.scenario = scenario;
  }
  nextEventIndex(tick: number, paused: boolean): number {
    if (!Number.isSafeInteger(tick) || tick < this.lastTick || tick > this.scenario.durationTicks) return -2;
    if (paused) return -1;
    this.lastTick = tick;
    const event = this.scenario.events[this.cursor];
    if (!event || event.tick > tick) return -1;
    // Lost simulation ticks are an error; never silently apply faults late.
    if (event.tick < tick) return -2;
    return this.cursor++;
  }
  reset(): void { this.cursor = 0; this.lastTick = -1; }
}
