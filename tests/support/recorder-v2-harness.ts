// TASK-162 browser harness: recorder v2 with the application's physics Worker,
// the recorder Worker and the persistent IndexedDB database. The spec loads
// this module on the application page (cross-origin isolated, so
// SharedArrayBuffer exists) and calls these functions; a browser restart
// separates writing a record from reopening it. Results are plain JSON.
import { RecorderV2Host, listRecordings, reopenRecording } from "../../packages/aar/src/recorder-v2-host";
import { RecordingProducerV2 } from "../../packages/aar/src/recorder-v2";
import { planRates } from "../../packages/aar/src/signal-catalog";
import { createSharedMemoryV2, createSpscQueue, newActuatorFrameV2, newFlightStateV2, newSensorFrameV2, newHeaderSnapshotV2, StateReaderV2 } from "../../packages/protocol/src/index";

const IDENTITY = { experimentId: "task-162-browser", modelSha256: null, firmware: null };

function waitFor(worker: Worker, predicate: (data: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 30000);
    const listener = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (typeof data === "object" && data !== null && predicate(data as Record<string, unknown>)) {
        clearTimeout(timer);
        worker.removeEventListener("message", listener);
        resolve(data as Record<string, unknown>);
      }
    };
    worker.addEventListener("message", listener);
  });
}

/**
 * Runs the demo session in the physics Worker for `seconds` of wall time with
 * recorder v2 armed: truth.position at 400 Hz, motors requested at 2 kHz
 * (capped at 400), everything else at the 50 Hz default. The demo has no
 * electrical drive, so motor and battery samples are absent, never zero.
 */
export async function recordPhysics(workerUrl: string, seconds: number) {
  const plan = planRates({ signals: { "truth.position": 400 }, groups: { motors: 2000 } }, { physicsHz: 400, telemetryHz: 10 });
  const host = new RecorderV2Host(plan, IDENTITY);
  await host.started();
  const stateBuffer = createSharedMemoryV2(), worker = new Worker(workerUrl, { type: "module" });
  const ready = waitFor(worker, d => d.type === "ready-v2", "ready-v2");
  worker.postMessage({ type: "init-v2", protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue("sensor"), actuatorBuffer: createSpscQueue("actuator") });
  await ready;
  const armed = waitFor(worker, d => d.type === "recording-v2.armed" || d.type === "recording-v2.reject", "the recording arm");
  worker.postMessage(host.armMessage());
  const arm = await armed;
  if (arm.type !== "recording-v2.armed") throw new Error(String(arm.message));
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2();
  reader.readHeader(header);
  const started = waitFor(worker, d => d.requestId === 1 && (d.type === "reject-v2" || (d.type === "ack-v2" && d.status === "applied")), "sim.start");
  worker.postMessage({ protocolVersion: 2, requestId: 1, expectedEpoch: header.sessionEpoch, type: "sim.start" });
  await started;
  host.event("pause", [0], { tick: 0, simTimeS: 0, epoch: header.sessionEpoch });
  host.parameterSnapshot([{ name: "ATC_RAT_RLL_I", value: Math.fround(0.00017) }, { name: "FRAME_CLASS", value: 1 }], { tick: 0, simTimeS: 0, epoch: header.sessionEpoch });
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  worker.postMessage({ type: "recording-v2.stop" });
  // Let the Worker finish its current batch before the record closes.
  await new Promise(resolve => setTimeout(resolve, 100));
  const entry = await host.close();
  worker.terminate();
  return { recordId: host.recordId, entry, motors: plan.signals.find(s => s.name === "motors.speed") ?? null };
}

/**
 * Starts a record fed by a producer on this page and leaves it open after at
 * least two sealed chunks, as a page that is closed mid-recording.
 */
export async function recordUnfinished() {
  const plan = planRates({ signals: { "truth.position": 400 } }, { physicsHz: 400, telemetryHz: 10 });
  const host = new RecorderV2Host(plan, IDENTITY);
  await host.started();
  const producer = new RecordingProducerV2(host.queue, host.producer);
  const state = newFlightStateV2(), sample = { state, pilot: new Float64Array(4), actuator: newActuatorFrameV2(), sensor: newSensorFrameV2(), power: null };
  sample.sensor.kind = 0;
  state.epoch = 1;
  // 2.5 s of wall time at 400 ticks per 100 ms: the Worker seals a chunk every wall second.
  for (let batch = 0; batch < 25; batch++) {
    for (let i = 0; i < 400; i++) {
      state.tickId.lo++;
      state.simTimeS = state.tickId.lo / 400;
      state.northM = Math.sin(state.simTimeS);
      producer.record(sample);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { recordId: host.recordId, ticks: state.tickId.lo };
}

/** Lists the stored records (marking cut-off ones interrupted) and reopens one. */
export async function reopen(recordId: string) {
  const entries = await listRecordings();
  const listed = entries.find(entry => entry.recordId === recordId) ?? null;
  const opened = await reopenRecording(recordId);
  const rows = Object.fromEntries([...opened.rows].map(([name, list]) => [name, list.length]));
  const position = opened.rows.get("truth.position") ?? [];
  let increasing = true;
  for (let i = 1; i < position.length; i++) if ((position[i]?.tick ?? 0) <= (position[i - 1]?.tick ?? 0)) increasing = false;
  const parameter = opened.rows.get("events.parameter")?.map(row => row.parameter) ?? [];
  return { status: listed?.status ?? null, entry: opened.entry, rows, missing: opened.missingChunks, corrupt: opened.corruptChunks.length, gaps: opened.gaps.length,
    increasing, firstTick: position[0]?.tick ?? null, lastTick: position.at(-1)?.tick ?? null, parameter, header: opened.header };
}
