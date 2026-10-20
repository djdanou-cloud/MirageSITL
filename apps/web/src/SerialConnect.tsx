import { useEffect, useRef, useState } from "react";
import { withFocusReturn } from "./ui/focus";
import { StatusMessage } from "./ui/StatusMessage";
import {
  serialApi,
  isSerialPort,
  SerialTransport,
} from "@mirage/autopilot/serial-transport";
/** Read-only MAVLink2 COMMAND_LONG (76): MAV_CMD_REQUEST_MESSAGE 512 for EKF_STATUS_REPORT 193. 33-byte payload plus the 12-byte v2 header and CRC. */
const REQUEST_EKF_STATUS_REPORT = new Uint8Array([
  253, 33, 0, 0, 1, 255, 190, 76, 0, 0,
  0, 64, 193, 67, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
  1, 1, 0, 152, 183,
]);
/** Transport diagnostic only. A serial permission grant never claims HITL readiness. */
export function SerialConnect({
  onFrame,
  onDisconnect,
}: {
  onFrame?: (frame: unknown) => void;
  onDisconnect?: () => void;
} = {}) {
  const [status, setStatus] = useState("Disconnected"),
    [busy, setBusy] = useState(false);
  const active = useRef<SerialTransport | null>(null),
    decoder = useRef<Worker | null>(null);
  const mounted = useRef(true);
  const displayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  function clearDisplay() {
    if (displayTimer.current !== null) {
      clearInterval(displayTimer.current);
      displayTimer.current = null;
    }
  }
  const api = serialApi(Reflect.get(navigator, "serial") as unknown);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearDisplay();
      void active.current?.close().catch(() => undefined);
      decoder.current?.terminate();
    };
  }, []);
  async function connect() {
    if (!api || busy || active.current) return;
    setBusy(true);
    try {
      // requestPort is invoked synchronously inside the click handler, before any await.
      const port = await api.requestPort();
      if (!mounted.current) return;
      if (!isSerialPort(port)) throw new Error("Invalid serial port");
      const worker = new Worker(
        new URL(
          "../../../packages/autopilot/src/serial-io.worker.ts",
          import.meta.url,
        ),
        { type: "module", name: "mirage-serial-io" },
      );
      decoder.current = worker;
      let markReady: (() => void) | null = null;
      let failReady: ((error: Error) => void) | null = null;
      let startupTimer: ReturnType<typeof setTimeout>;
      const ready = new Promise<void>((resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error("Serial decoder startup timeout")), 5000);
        markReady = () => { clearTimeout(startupTimer); resolve(); };
        failReady = error => { clearTimeout(startupTimer); reject(error); };
      });
      let frames = 0;
      let seenHeartbeat = false;
      let lastEkfRequestMs = -Infinity;
      let consumed: (() => void) | null = null;
      worker.onerror = () => {
        failReady?.(new Error("Serial decoder failed"));
        clearDisplay();
        worker.terminate();
        void active.current?.close().catch(() => undefined);
        if (mounted.current) setStatus("Serial decoder failed");
      };
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (typeof data === "object" && data !== null && "type" in data && data.type === "serial.ready") {
          markReady?.();
          markReady = null;
          return;
        }
        if (
          typeof data === "object" &&
          data !== null &&
          "type" in data &&
          data.type === "serial.consumed"
        ) {
          consumed?.();
          consumed = null;
          return;
        }
        if (
          mounted.current &&
          typeof data === "object" &&
          data !== null &&
          "type" in data &&
          data.type === "serial.frame"
        ) {
          frames++;
          onFrame?.(data);
          if ("id" in data && data.id === 0) seenHeartbeat = true;
        }
      };
      const transport = new SerialTransport(
        (bytes) =>
          new Promise<void>((done, reject) => {
            const timer = setTimeout(() => {
              consumed = null;
              reject(new Error("Serial decoder backpressure timeout"));
            }, 500);
            consumed = () => {
              clearTimeout(timer);
              done();
            };
            worker.postMessage(bytes);
          }),
        () => {
          clearDisplay();
          worker.terminate();
          if (mounted.current) setStatus("Serial link failed");
        },
      );
      displayTimer.current = setInterval(() => {
        if (mounted.current && transport.status === "open" && frames > 0)
          setStatus(
            `Transport connected; received ${frames} MAVLink frames; HITL unavailable`,
          );
        if (transport.status === "open" && seenHeartbeat) {
          const now = performance.now();
          if (now - lastEkfRequestMs >= 250) {
            lastEkfRequestMs = now;
            void transport.write(REQUEST_EKF_STATUS_REPORT).catch(() => undefined);
          }
        }
      }, 150);
      active.current = transport;
      // Cold module loading is separate from the per-chunk backpressure deadline.
      await ready;
      failReady = null;
      if (!mounted.current) return;
      await transport.open(port);
      if (!mounted.current) {
        await transport.close();
        return;
      }
      if (transport.status !== "open") throw new Error("Serial link closed");
      setStatus("Transport connected; HITL unavailable");
    } catch (cause) {
      await active.current?.close().catch(() => undefined);
      clearDisplay();
      active.current = null;
      decoder.current?.terminate();
      decoder.current = null;
      if (mounted.current)
        setStatus(
          cause instanceof Error ? cause.message : "Serial permission denied",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try {
      await active.current?.close();
      clearDisplay();
      active.current = null;
      decoder.current?.terminate();
      decoder.current = null;
      onDisconnect?.();
      setStatus("Disconnected");
    } catch {
      setStatus("Serial disconnect failed");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div>
      <button
        disabled={!api || busy}
        onClick={(event) => {
          void withFocusReturn(event.currentTarget, () => active.current ? disconnect() : connect());
        }}
        aria-busy={busy}
      >
        {active.current ? "Disconnect serial" : "Connect serial"}
      </button>
      <small data-testid="serial-status">
        <StatusMessage error={/failed|denied|cancelled/i.test(status)}>{status}</StatusMessage>
      </small>
    </div>
  );
}
