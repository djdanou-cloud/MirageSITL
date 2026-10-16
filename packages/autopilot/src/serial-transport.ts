/** Structural Web Serial contracts keep permission ownership explicit and testable. */
export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
export interface SerialApi {
  requestPort(): Promise<unknown>;
}
function isSerialApi(value: unknown): value is SerialApi {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestPort" in value &&
    typeof value.requestPort === "function"
  );
}
export function serialApi(value: unknown): SerialApi | null {
  return isSerialApi(value) ? value : null;
}
export function isSerialPort(value: unknown): value is SerialPortLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof value.open === "function" &&
    "close" in value &&
    typeof value.close === "function" &&
    "readable" in value &&
    (value.readable === null || value.readable instanceof ReadableStream) &&
    "writable" in value &&
    (value.writable === null || value.writable instanceof WritableStream)
  );
}
const leased = new WeakSet<SerialPortLike>();
export class SerialTransport {
  status: "closed" | "opening" | "open" | "closing" | "fault" = "closed";
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reading: Promise<void> | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private writing = false;
  constructor(
    private readonly receive: (bytes: Uint8Array) => void | Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}
  async open(port: SerialPortLike, baudRate = 921600): Promise<void> {
    if (
      this.status !== "closed" ||
      leased.has(port) ||
      !Number.isInteger(baudRate) ||
      baudRate < 9600 ||
      baudRate > 3000000
    )
      throw new Error("Serial port busy or invalid baud");
    this.port = port;
    leased.add(port);
    this.status = "opening";
    this.opening = this.start(port, baudRate);
    try {
      await this.opening;
    } catch (error) {
      if (this.reader) {
        this.reader.releaseLock();
        this.reader = null;
      }
      if (this.writer) {
        this.writer.releaseLock();
        this.writer = null;
      }
      try {
        await port.close();
      } catch {
        /* Failed open may not have acquired a device. */
      }
      leased.delete(port);
      this.port = null;
      this.status = "closed";
      throw error;
    } finally {
      this.opening = null;
    }
  }
  private async start(port: SerialPortLike, baudRate: number): Promise<void> {
    await port.open({ baudRate });
    if (this.status === "closing") return;
    if (!port.readable || !port.writable)
      throw new Error("Serial streams unavailable");
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.status = "open";
    this.reading = this.read();
  }
  private async read(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    try {
      while (this.status === "open") {
        const result = await reader.read();
        if (result.done) break;
        if (this.status === "open") {
          if (result.value.length > 4096)
            throw new Error("Serial chunk exceeds budget");
          await this.receive(result.value);
        }
      }
    } catch (error) {
      if (this.status === "open") {
        this.status = "fault";
        this.onError(error);
      }
    } finally {
      reader.releaseLock();
      this.reader = null;
      if (this.status === "open") this.status = "fault";
      if (this.status === "fault")
        queueMicrotask(() => {
          void this.close().catch(this.onError);
        });
    }
  }
  /** Caller retains an immutable buffer until completion. Backpressure rejects another write. */
  async write(bytes: Uint8Array): Promise<boolean> {
    if (
      this.status !== "open" ||
      !this.writer ||
      this.writing ||
      bytes.length > 4096
    )
      return false;
    this.writing = true;
    try {
      await this.writer.write(bytes);
      return true;
    } catch (error) {
      this.status = "fault";
      this.onError(error);
      void this.close().catch(this.onError);
      return false;
    } finally {
      this.writing = false;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.status === "closed") return Promise.resolve();
    this.status = "closing";
    this.closing = this.finish().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }
  private async finish(): Promise<void> {
    try {
      await this.opening;
    } catch {
      /* Failed open already releases ownership. */
    }
    let streamError: unknown;
    try {
      await this.reader?.cancel();
    } catch (error) {
      streamError = error;
    }
    await this.reading;
    if (this.writer) {
      try {
        await this.writer.abort();
      } catch (error) {
        streamError = error;
      } finally {
        this.writer.releaseLock();
        this.writer = null;
      }
    }
    try {
      if (this.port) {
        await this.port.close();
        leased.delete(this.port);
      }
      this.port = null;
      this.reading = null;
      this.status = "closed";
    } catch (error) {
      this.status = "fault";
      throw error;
    }
    if (streamError) this.onError(streamError);
  }
}
