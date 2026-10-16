/// <reference lib="webworker" />
import { MavParser, definition } from "../../mavlink/src/codec.ts";
/** I/O decoding worker, separate from physics. Permission/stream ownership stays in the controller. */
const worker = self as DedicatedWorkerGlobalScope;
const parser = new MavParser((frame) => {
  // Copy on the I/O thread. Never transfer parser-owned scratch storage.
  const length = definition(frame.id)?.length;
  if (!length) return;
  const payload = frame.payload.slice(0, length);
  worker.postMessage(
    {
      type: "serial.frame",
      id: frame.id,
      systemId: frame.systemId,
      componentId: frame.componentId,
      sequence: frame.sequence,
      payload,
    },
    [payload.buffer],
  );
});
worker.onmessage = (event: MessageEvent<unknown>) => {
  if (event.data instanceof Uint8Array) {
    parser.push(event.data);
    worker.postMessage({ type: "serial.consumed" });
  } else if (event.data === "reset") parser.reset();
};
