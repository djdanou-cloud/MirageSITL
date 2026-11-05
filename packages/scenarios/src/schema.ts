import { CONTROL_PROTOCOL_VERSION_3, parseControlCommand, parseControlCommandV2, parseEffectSet, scheduledEffects, type ControlCommand, type EffectControl, type EffectRecovery } from "@mirage/protocol";
export interface ScenarioEvent { readonly tick: number; readonly command: ControlCommand }
/**
 * Schema 2 (TASK-166) adds `effects`: effect controls with an onset, a duration and a recovery. Each becomes ordinary events, on at
 * its onset and off when its duration ends, so each is acknowledged on its own tick. `events` stays as in schema 1, and may also
 * carry `effect.set`.
 */
export interface ScenarioEffectEntry { readonly control: EffectControl; readonly onsetTick: number; readonly durationTicks: number | null; readonly recovery: EffectRecovery }
export const MAX_SCENARIO_EVENTS = 128;
export interface Scenario {
  readonly schemaVersion: 1 | 2; readonly id: string; readonly hz: 400 | 800 | 1200;
  readonly seed: number; readonly modelSha256: string; readonly firmwareSha256: string;
  readonly durationTicks: number; readonly events: readonly ScenarioEvent[];
  readonly rubric: { readonly holdStartTick: number; readonly holdEndTick: number; readonly targetAltitudeM: number; readonly maxAltitudeErrorM: number; readonly requireHealthyEkf: boolean };
}
function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function keys(v: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k)); }
function integer(v: unknown, max: number): v is number { return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max; }
function hash(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{64}$/.test(v); }
function positive(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10000; }
function freezeCommand(command: ControlCommand): void {
  if (command.type === "weather.set") Object.freeze(command.windNedMps);
  else if (command.type === "fault.set") {
    const e = command.effect;
    if (e.kind === "position-step") Object.freeze(e.offsetNedM);
    if (e.kind === "velocity-drift") Object.freeze(e.accelerationNedMps2);
    if (e.kind === "magnetic") { Object.freeze(e.rotationRad); Object.freeze(e.biasBodyGauss); }
    Object.freeze(e);
  } else if (command.type === "effect.set") {
    for (const value of Object.values(command.control.parameters)) if (Array.isArray(value)) Object.freeze(value);
    Object.freeze(command.control.parameters);
    Object.freeze(command.control);
  }
}
/** The events of one `effects` entry. */
function effectEvents(item: unknown, durationTicks: number): readonly ScenarioEvent[] {
  if (!record(item) || !keys(item, ["control", "onsetTick", "durationTicks", "recovery"]) || !integer(item.onsetTick, durationTicks)) throw new Error("Invalid scenario effect");
  if (item.durationTicks !== null && !(integer(item.durationTicks, durationTicks) && item.durationTicks >= 1 && item.onsetTick + item.durationTicks <= durationTicks)) throw new Error("A scenario effect must end by the end of the scenario");
  // The envelope is checked again when the events are numbered; here the record and its recovery are what is new.
  const parsed = parseEffectSet({ control: item.control, recovery: item.recovery }, { requestId: 0, expectedEpoch: 0, atTick: { lo: item.onsetTick, hi: 0 } });
  return scheduledEffects(parsed.control, { onsetTick: item.onsetTick, durationTicks: item.durationTicks, recovery: parsed.recovery }).map(effect => ({
    tick: effect.tick,
    command: { protocolVersion: CONTROL_PROTOCOL_VERSION_3, requestId: 0, expectedEpoch: 0, atTick: { lo: effect.tick, hi: 0 }, type: "effect.set", control: effect.control, recovery: effect.recovery },
  }));
}
/** Cold-path admission. Own and freeze all command data before execution. */
export function parseScenario(value: unknown): Scenario {
  const v: unknown = structuredClone(value);
  const schema2 = record(v) && v.schemaVersion === 2;
  if (!record(v) || !keys(v, ["schemaVersion", "id", "hz", "seed", "modelSha256", "firmwareSha256", "durationTicks", "events", ...(schema2 ? ["effects"] : []), "rubric"]) ||
    (v.schemaVersion !== 1 && !schema2) || typeof v.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(v.id) ||
    (v.hz !== 400 && v.hz !== 800 && v.hz !== 1200) || !integer(v.seed, 0xffffffff) ||
    !hash(v.modelSha256) || !hash(v.firmwareSha256) || !integer(v.durationTicks, 4320000) || v.durationTicks < 1 ||
    !Array.isArray(v.events) || v.events.length > MAX_SCENARIO_EVENTS || !record(v.rubric) || (schema2 && !Array.isArray(v.effects))) throw new Error("Invalid scenario header");
  const r = v.rubric;
  if (!keys(r, ["holdStartTick", "holdEndTick", "targetAltitudeM", "maxAltitudeErrorM", "requireHealthyEkf"]) ||
    !integer(r.holdStartTick, v.durationTicks) || !integer(r.holdEndTick, v.durationTicks) || r.holdEndTick <= r.holdStartTick ||
    !positive(r.targetAltitudeM) || !positive(r.maxAltitudeErrorM) || typeof r.requireHealthyEkf !== "boolean") throw new Error("Invalid scenario rubric");
  const events: ScenarioEvent[] = []; let previous = -1;
  for (const item of v.events as unknown[]) {
    if (!record(item) || !keys(item, ["tick", "command"]) || !integer(item.tick, v.durationTicks) || item.tick < previous) throw new Error("Invalid scenario event ordering");
    const parsed = schema2 ? parseControlCommand(item.command) : parseControlCommandV2(item.command);
    if (!parsed.ok || (parsed.command.type !== "fault.set" && parsed.command.type !== "weather.set" && parsed.command.type !== "effect.set") ||
      parsed.command.atTick.hi !== 0 || parsed.command.atTick.lo !== item.tick ||
      parsed.command.requestId !== events.length + 1 || parsed.command.expectedEpoch !== 0) throw new Error("Unsupported scenario command template");
    events.push({ tick: item.tick, command: parsed.command });
    previous = item.tick;
  }
  const entries = schema2 ? v.effects as unknown[] : [];
  for (const item of entries) events.push(...effectEvents(item, v.durationTicks));
  if (events.length > MAX_SCENARIO_EVENTS) throw new Error(`A scenario holds at most ${MAX_SCENARIO_EVENTS} events, and an effect with a duration takes two`);
  // In tick order; on one tick, in the order written. Request IDs follow, as schema 1 requires of its events.
  const ordered = events.map((event, order) => ({ event, order })).sort((a, b) => a.event.tick - b.event.tick || a.order - b.order);
  const final = ordered.map(({ event }, index) => {
    const command: ControlCommand = entries.length === 0 ? event.command : { ...event.command, requestId: index + 1 };
    freezeCommand(command);
    if ("atTick" in command) Object.freeze(command.atTick);
    return Object.freeze({ tick: event.tick, command: Object.freeze(command) });
  });
  return Object.freeze({ schemaVersion: schema2 ? 2 : 1, id: v.id, hz: v.hz, seed: v.seed,
    modelSha256: v.modelSha256, firmwareSha256: v.firmwareSha256, durationTicks: v.durationTicks,
    events: Object.freeze(final), rubric: Object.freeze({ holdStartTick: r.holdStartTick, holdEndTick: r.holdEndTick,
      targetAltitudeM: r.targetAltitudeM, maxAltitudeErrorM: r.maxAltitudeErrorM, requireHealthyEkf: r.requireHealthyEkf }) });
}
