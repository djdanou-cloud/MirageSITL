import { useEffect, useRef, useState } from "react";
import {
  serialApi,
  isSerialPort,
  SerialTransport,
} from "@mirage/autopilot/serial-transport";
/** Transport diagnostic only. A serial permission grant never claims HITL readiness. */
export function SerialConnect() {
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
      let frames = 0;
      let consumed: (() => void) | null = null;
      worker.onerror = () => {
        clearDisplay();
        worker.terminate();
        void active.current?.close().catch(() => undefined);
        if (mounted.current) setStatus("Serial decoder failed");
      };
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
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
      }, 150);
      active.current = transport;
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
        onClick={() => {
          void (active.current ? disconnect() : connect());
        }}
      >
        {active.current ? "Disconnect serial" : "Connect serial"}
      </button>
      <small role="status" data-testid="serial-status">
        {status}
      </small>
    </div>
  );
}
