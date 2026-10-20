import type { CommandResultV2, ControlCommandV2 } from "@mirage/protocol";
import { ScenarioRunner } from "./runner.ts";
import type { Scenario } from "./schema.ts";

export type ScenarioEventState = "idle" | "pending" | "queued" | "applied" | "rejected";

/**
 * Binds scenario templates to the live session epoch and request ids.
 * A fault is applied only after an applied ACK. Queued is not applied.
 */
export class ScenarioBinder {
  private readonly runner: ScenarioRunner;
  private readonly states: ScenarioEventState[];
  private readonly requestIds: number[];
  private haltedFlag = false;
  private boundEpoch = 0;
  constructor(
    scenario: Scenario,
    private readonly allocateRequestId: () => number,
  ) {
    this.runner = new ScenarioRunner(scenario, scenario.modelSha256, scenario.firmwareSha256, scenario.seed, scenario.hz);
    this.states = scenario.events.map(() => "idle");
    this.requestIds = scenario.events.map(() => -1);
  }
  get halted(): boolean { return this.haltedFlag; }
  get epoch(): number { return this.boundEpoch; }
  state(index: number): ScenarioEventState {
    return this.states[index] ?? "idle";
  }
  /** True only after the Worker ACK says applied. */
  claimsApplied(index: number): boolean { return this.state(index) === "applied"; }
  rewind(epoch: number): void {
    this.runner.reset();
    this.states.fill("idle");
    this.requestIds.fill(-1);
    this.haltedFlag = false;
    this.boundEpoch = epoch >>> 0;
  }
  /** Returns the live command for this simulation tick, or null when none is due. */
  poll(tick: number, paused: boolean, epoch: number): ControlCommandV2 | null {
    if (this.haltedFlag) return null;
    if ((epoch >>> 0) !== epoch) return null;
    if (this.boundEpoch !== epoch) this.rewind(epoch);
    const index = this.runner.nextEventIndex(tick, paused);
    if (index === -2) { this.haltedFlag = true; return null; }
    if (index < 0) return null;
    const template = this.runner.scenario.events[index]?.command;
    if (!template) { this.haltedFlag = true; return null; }
    const requestId = this.allocateRequestId();
    if ((requestId >>> 0) !== requestId) { this.haltedFlag = true; return null; }
    this.states[index] = "pending";
    this.requestIds[index] = requestId;
    return { ...template, requestId, expectedEpoch: epoch };
  }
  observe(event: CommandResultV2): void {
    if (event.type === "ready-v2") return;
    const index = this.requestIds.indexOf(event.requestId);
    if (index < 0) return;
    if (event.type === "reject-v2") { this.states[index] = "rejected"; return; }
    this.states[index] = event.status === "applied" ? "applied" : "queued";
  }
}
