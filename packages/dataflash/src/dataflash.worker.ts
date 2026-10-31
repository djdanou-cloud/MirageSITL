import { DataflashReader, type Column, type DataflashLog } from "./reader.ts";

// DataFlash parsing off the main thread (TASK-178). Main sends chunks as
// transferred ArrayBuffers, then "finish"; the Worker answers with progress
// and one result whose numeric columns are transferred, not copied.

export type DataflashRequest =
  | { readonly kind: "chunk"; readonly bytes: ArrayBuffer }
  | { readonly kind: "finish" };
export interface DataflashTableResult {
  readonly name: string;
  readonly columns: Readonly<Record<string, Column>>;
  readonly units: readonly string[] | null;
  readonly timestampS: Float64Array;
  readonly offsets: Float64Array;
}
export type DataflashResponse =
  | { readonly kind: "progress"; readonly bytes: number }
  | { readonly kind: "result"; readonly bytes: number; readonly tables: readonly DataflashTableResult[]; readonly damaged: DataflashLog["damaged"]; readonly gpsTimeBaseS: number | null }
  | { readonly kind: "error"; readonly message: string };

function isRequest(value: unknown): value is DataflashRequest {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  return kind === "finish" || (kind === "chunk" && Reflect.get(value, "bytes") instanceof ArrayBuffer);
}

/** The Worker's message handler, separate from the global so tests can drive it. */
export function createDataflashHandler(post: (response: DataflashResponse, transfer: Transferable[]) => void): (data: unknown) => void {
  let reader = new DataflashReader();
  let received = 0;
  return data => {
    try {
      if (!isRequest(data)) throw new Error("Unknown DataFlash request");
      if (data.kind === "chunk") {
        reader.push(new Uint8Array(data.bytes));
        received += data.bytes.byteLength;
        post({ kind: "progress", bytes: received }, []);
        return;
      }
      const log = reader.finish();
      const transfer: Transferable[] = [];
      const tables = [...log.tables.values()].map(table => {
        for (const column of Object.values(table.columns)) if (column instanceof Float64Array) transfer.push(column.buffer);
        transfer.push(table.timestampS.buffer, table.offsets.buffer);
        return { name: table.name, columns: table.columns, units: table.format.units, timestampS: table.timestampS, offsets: table.offsets };
      });
      post({ kind: "result", bytes: log.bytes, tables, damaged: log.damaged, gpsTimeBaseS: log.gpsTimeBaseS }, transfer);
      reader = new DataflashReader();
      received = 0;
    } catch (error) {
      post({ kind: "error", message: error instanceof Error ? error.message : String(error) }, []);
      reader = new DataflashReader();
      received = 0;
    }
  };
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
function isWorkerScope(value: unknown): value is WorkerScope {
  return typeof value === "object" && value !== null && "postMessage" in value && "onmessage" in value && typeof document === "undefined";
}
if (isWorkerScope(globalThis)) {
  const scope = globalThis;
  const handle = createDataflashHandler((response, transfer) => scope.postMessage(response, transfer));
  scope.onmessage = event => handle(event.data);
}
