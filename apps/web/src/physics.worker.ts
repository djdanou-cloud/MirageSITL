/// <reference lib="webworker" />
import { ABI_VERSION, ControlReader, Header, PHYSICS_HZ, StateWriter, newInput, wallNow,
  type MainToPhysics, type PhysicsToMain } from '@mirage/protocol';
import { DemoDynamics, FixedStepClock } from '@mirage/physics';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const dynamics = new DemoDynamics();
const clock = new FixedStepClock(8);
const input = newInput();
let writer: StateWriter | undefined;
let reader: ControlReader | undefined;
let words: Int32Array | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
const send = (event: PhysicsToMain) => scope.postMessage(event);
// This callback and all state/scratch buffers are allocated once, off the hot path.
const step = () => {
  reader!.latest(input);
  dynamics.step(input, wallNow());
  // Presentation timestamp is the scheduled wall deadline; several catch-up
  // steps may execute together. Freshness validation above uses actual time.
  dynamics.state.wallTimeMs = performance.timeOrigin + clock.nextMs;
  writer!.publish(dynamics.state);
};
function pump(): void {
  if (!running) return;
  clock.advance(performance.now(), step);
  Atomics.store(words!, Header.Overruns, clock.overruns);
  Atomics.store(words!, Header.DroppedSteps, clock.droppedSteps);
  // Yield so lifecycle postMessages can run. Timers are wakeups, not dt values.
  timer = setTimeout(pump, Math.max(0, clock.nextMs - performance.now()));
}
scope.onmessage = ({ data }: MessageEvent<MainToPhysics>) => {
  try {
    if (data.type === 'init') {
      if (writer || data.version !== ABI_VERSION) throw new Error('Invalid worker initialization');
      writer = new StateWriter(data.buffer); reader = new ControlReader(data.buffer);
      words = new Int32Array(data.buffer);
      dynamics.state.wallTimeMs = wallNow();
      writer.publish(dynamics.state);
      send({ type: 'ready', version: ABI_VERSION, hz: PHYSICS_HZ });
      return;
    }
    if (!writer) throw new Error('Worker is not initialized');
    switch (data.type) {
      case 'start':
        if (!running) { running = true; clock.reset(performance.now()); pump(); }
        break;
      case 'pause':
        running = false; clearTimeout(timer);
        break;
      case 'reset':
        running = false; clearTimeout(timer); dynamics.reset();
        clock.overruns = 0; clock.droppedSteps = 0;
        Atomics.store(words!, Header.Overruns, 0); Atomics.store(words!, Header.DroppedSteps, 0);
        dynamics.state.wallTimeMs = wallNow(); writer.publish(dynamics.state);
        break;
      case 'dispose': running = false; clearTimeout(timer); break;
      default: throw new Error('Unknown worker command');
    }
    send({ type: 'ack', command: data.type, requestId: data.requestId });
    if (data.type === 'dispose') scope.close();
  } catch (error) {
    running = false; clearTimeout(timer);
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
