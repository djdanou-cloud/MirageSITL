/// <reference lib="webworker" />
/**
 * DataFlash parsing Worker (TASK-178).
 *
 * Request:  { type: 'parse', id, source: Blob | ArrayBuffer | Uint8Array, chunkBytes? }
 * Replies:  { type: 'progress', id, bytes, total } after each chunk,
 *           { type: 'result', id, log } with the log's buffers transferred,
 *           { type: 'error', id, message } for a rejected request or a failed read.
 * Any other message is rejected with id -1.
 */
import { parseSource, transferables } from './reader.ts';

const DEFAULT_CHUNK_BYTES = 1 << 20;
const MAX_CHUNK_BYTES = 64 << 20;
const scope = self as DedicatedWorkerGlobalScope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

scope.onmessage = ({ data }: MessageEvent<unknown>) => {
  void handle(data);
};

async function handle(data: unknown): Promise<void> {
  const id = isRecord(data) && Number.isSafeInteger(data.id) && typeof data.id === 'number' ? data.id : -1;
  try {
    if (!isRecord(data) || data.type !== 'parse' || id < 0) throw new Error('Expected { type: "parse", id, source }');
    const source = data.source;
    if (!(source instanceof Blob) && !(source instanceof ArrayBuffer) && !(source instanceof Uint8Array)) {
      throw new Error('source must be a Blob, ArrayBuffer or Uint8Array');
    }
    const chunkBytes = data.chunkBytes === undefined ? DEFAULT_CHUNK_BYTES : data.chunkBytes;
    if (typeof chunkBytes !== 'number' || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
      throw new Error(`chunkBytes must be an integer from 1 to ${MAX_CHUNK_BYTES}`);
    }
    const log = await parseSource(source, chunkBytes, (bytes, total) => scope.postMessage({ type: 'progress', id, bytes, total }));
    scope.postMessage({ type: 'result', id, log }, transferables(log));
  } catch (error) {
    scope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
}
