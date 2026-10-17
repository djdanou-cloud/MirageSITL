import { parseControlCommandV2, type ControlCommandV2 } from "@mirage/protocol";
export interface ScenarioEvent { readonly tick: number; readonly command: ControlCommandV2 }
export interface Scenario {
  readonly schemaVersion: 1; readonly id: string; readonly hz: 400 | 800 | 1200;
  readonly seed: number; readonly modelSha256: string; readonly firmwareSha256: string;
  readonly durationTicks: number; readonly events: readonly ScenarioEvent[];
  readonly rubric: { readonly holdStartTick: number; readonly holdEndTick: number; readonly targetAltitudeM: number; readonly maxAltitudeErrorM: number; readonly requireHealthyEkf: boolean };
}
function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function keys(v: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k)); }
function integer(v: unknown, max: number): v is number { return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max; }
function hash(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{64}$/.test(v); }
function positive(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10000; }
/** Cold-path admission. Own and freeze all command data before execution. */
export function parseScenario(value: unknown): Scenario {
  const v: unknown = structuredClone(value);
  if (!record(v) || !keys(v, ["schemaVersion", "id", "hz", "seed", "modelSha256", "firmwareSha256", "durationTicks", "events", "rubric"]) ||
    v.schemaVersion !== 1 || typeof v.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(v.id) ||
    (v.hz !== 400 && v.hz !== 800 && v.hz !== 1200) || !integer(v.seed, 0xffffffff) ||
    !hash(v.modelSha256) || !hash(v.firmwareSha256) || !integer(v.durationTicks, 4320000) || v.durationTicks < 1 ||
    !Array.isArray(v.events) || v.events.length > 128 || !record(v.rubric)) throw new Error("Invalid scenario header");
  const r = v.rubric;
  if (!keys(r, ["holdStartTick", "holdEndTick", "targetAltitudeM", "maxAltitudeErrorM", "requireHealthyEkf"]) ||
    !integer(r.holdStartTick, v.durationTicks) || !integer(r.holdEndTick, v.durationTicks) || r.holdEndTick <= r.holdStartTick ||
    !positive(r.targetAltitudeM) || !positive(r.maxAltitudeErrorM) || typeof r.requireHealthyEkf !== "boolean") throw new Error("Invalid scenario rubric");
  const events: ScenarioEvent[] = []; let previous = -1;
  for (const item of v.events as unknown[]) {
    if (!record(item) || !keys(item, ["tick", "command"]) || !integer(item.tick, v.durationTicks) || item.tick < previous) throw new Error("Invalid scenario event ordering");
    const parsed = parseControlCommandV2(item.command);
    if (!parsed.ok || (parsed.command.type !== "fault.set" && parsed.command.type !== "weather.set") ||
      parsed.command.atTick.hi !== 0 || parsed.command.atTick.lo !== item.tick ||
      parsed.command.requestId !== events.length + 1 || parsed.command.expectedEpoch !== 0) throw new Error("Unsupported scenario command template");
    const command = parsed.command;
    if (command.type === "weather.set") Object.freeze(command.windNedMps);
    else {
      const e = command.effect;
      if (e.kind === "position-step") Object.freeze(e.offsetNedM);
      if (e.kind === "velocity-drift") Object.freeze(e.accelerationNedMps2);
      if (e.kind === "magnetic") { Object.freeze(e.rotationRad); Object.freeze(e.biasBodyGauss); }
      Object.freeze(e);
    }
    events.push(Object.freeze({ tick: item.tick, command: Object.freeze(command) }));
    Object.freeze(command.atTick); previous = item.tick;
  }
  return Object.freeze({ schemaVersion: 1, id: v.id, hz: v.hz, seed: v.seed,
    modelSha256: v.modelSha256, firmwareSha256: v.firmwareSha256, durationTicks: v.durationTicks,
    events: Object.freeze(events), rubric: Object.freeze({ holdStartTick: r.holdStartTick, holdEndTick: r.holdEndTick,
      targetAltitudeM: r.targetAltitudeM, maxAltitudeErrorM: r.maxAltitudeErrorM, requireHealthyEkf: r.requireHealthyEkf }) });
}
