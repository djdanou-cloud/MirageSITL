/// <reference lib="webworker" />
import { AarRecord } from '@mirage/aar/record';
import { RecordingHandoff } from '@mirage/aar/handoff';
import { EwEngine, type EwContext } from '@mirage/ew/engine';
import { isWorkerInitV2, tickToNumber, type CommandResultV2, type ControlCommandV2, type WorkerFaultV2 } from '@mirage/protocol';
import { PhysicsSessionV2, type SessionClock, type SessionFaultPort } from '@mirage/physics';
import { MotorFaults } from '@mirage/physics/motor-fault';
import { ScenarioBinder } from '@mirage/scenarios/bind';
import { parseScenario } from '@mirage/scenarios/schema';

// Thin message adapter around PhysicsSessionV2 (ABI v2, Control Protocol v2).
// Messages are validated at runtime: init-v2 by shape and buffer layouts,
// commands by the Control Protocol v2 validator inside the session.

const clock: SessionClock = {
  monotonicMs: () => performance.now(),
  wallMs: () => performance.timeOrigin + performance.now(),
};
let session: PhysicsSessionV2 | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let binder: ScenarioBinder | null = null;
let haltPosted = false;
let recorder: { handoff: RecordingHandoff; record: AarRecord } | null = null;
type WorkerNotice = CommandResultV2 | WorkerFaultV2
  | { type: "scenario.submit"; command: ControlCommandV2 }
  | { type: "scenario.reject"; message: string };

function createFaultPort(): SessionFaultPort {
  const motors = new MotorFaults([0, 1, 2, 3]);
  const engine = new EwEngine(motors);
  const scratch: EwContext = { dtS: 0, simTimeS: 0, truthNorthM: 0, truthEastM: 0, truthDownM: 0 };
  return {
    apply: (command, tick) => engine.apply(command, tick),
    reset: (seed) => engine.reset(seed),
    advanceInto(context) {
      scratch.dtS = context.dtS;
      scratch.simTimeS = context.simTimeS;
      scratch.truthNorthM = context.northM;
      scratch.truthEastM = context.eastM;
      scratch.truthDownM = context.downM;
      return engine.advanceInto(scratch);
    },
    get flags() { return engine.flags; },
    get validityFlags() { return motors.vehicleFlags; },
  };
}
function createdRequestId(): number {
  return session?.allocateRequestId() ?? 1;
}
function post(event: WorkerNotice): void { postMessage(event); }
function flush(): void {
  session?.drain((event) => {
    binder?.observe(event);
    post(event);
  });
}
function armScenario(value: unknown): void {
  try {
    const scenario = parseScenario(value);
    haltPosted = false;
    binder = new ScenarioBinder(scenario, () => createdRequestId());
  } catch (error) {
    binder = null;
    post({ type: "scenario.reject", message: error instanceof Error ? error.message : "Invalid scenario" });
  }
}
function isRecordingArm(data: unknown): data is { type: "recording.arm"; queue: SharedArrayBuffer } {
  return typeof data === "object" && data !== null && "type" in data && data.type === "recording.arm" && "queue" in data && data.queue instanceof SharedArrayBuffer;
}
function isRecordingStop(data: unknown): boolean {
  return typeof data === "object" && data !== null && "type" in data && data.type === "recording.stop";
}
function armRecording(queue: SharedArrayBuffer): void {
  if (!session) return;
  const handoff = new RecordingHandoff(queue);
  const record = new AarRecord();
  const pilot = new Float64Array(4);
  let notedLost = 0;
  recorder = { handoff, record };
  session.setRecorder((sample) => {
    const active = recorder;
    if (!active) return;
    for (let i = 0; i < 4; i++) pilot[i] = sample.pilot[i] ?? 0;
    const lost = (active.handoff.lost - notedLost) >>> 0;
    if (!active.record.encode(sample.state, pilot, sample.sensor, sample.actuator, 0, lost, false)) return;
    if (active.handoff.push(active.record.words)) notedLost = active.handoff.lost;
  });
}
function isScenarioArm(data: unknown): data is { type: "scenario.arm"; scenario: unknown } {
  return typeof data === "object" && data !== null && "type" in data && data.type === "scenario.arm" && "scenario" in data;
}

/** Steps the session, then sends results after the compute batch, never inside a step. */
function pump(): void {
  timer = undefined;
  if (!session) return;
  const delay = session.pump();
  flush();
  if (session.fault) post({ type: 'fault-v2', protocolVersion: 2, message: session.fault });
  else if (delay >= 0) timer = setTimeout(pump, delay);
}
function schedule(): void {
  if (session?.running && timer === undefined && !session.fault) timer = setTimeout(pump, 0);
  if (!session?.running && timer !== undefined) { clearTimeout(timer); timer = undefined; }
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!session) {
    if (!isWorkerInitV2(data)) { post({ type: 'fault-v2', protocolVersion: 2, message: 'Expected init-v2' }); return; }
    try {
      session = new PhysicsSessionV2(data, clock, undefined, createFaultPort());
      const created = session;
      created.setBeforeTick((tick) => {
        if (!binder) return;
        for (;;) {
          const command = binder.poll(tickToNumber(tick), false, created.currentEpoch);
          if (binder.halted && !haltPosted) {
            haltPosted = true;
            post({ type: "scenario.reject", message: "Scenario missed a simulation tick" });
            return;
          }
          if (!command) return;
          post({ type: "scenario.submit", command });
          created.handle(command);
        }
      });
      post(session.readyEvent());
    } catch (error) {
      post({ type: 'fault-v2', protocolVersion: 2, message: error instanceof Error ? error.message : 'Initialization failed' });
    }
    return;
  }
  const current = session;
  if (isScenarioArm(data)) {
    armScenario(data.scenario);
    return;
  }
  if (isRecordingArm(data)) {
    armRecording(data.queue);
    return;
  }
  if (isRecordingStop(data)) {
    recorder = null;
    current.setRecorder(null);
    return;
  }
  current.handle(data);
  flush();
  // A model load completes asynchronously; deliver its final result when it settles.
  void current.settled().then(() => { flush(); schedule(); });
  schedule();
  if (current.disposed) { clearTimeout(timer); close(); }
});
