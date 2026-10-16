import { parentPort, workerData } from 'node:worker_threads';
import { runSpscProducer } from './spsc-stress.ts';

// Node worker_threads producer for the SPSC stress test (loaded via type stripping).
const data: unknown = workerData;
if (typeof data !== 'object' || data === null || !('buffer' in data) || !('control' in data) ||
  !(data.buffer instanceof SharedArrayBuffer) || !(data.control instanceof SharedArrayBuffer)) {
  throw new Error('Invalid SPSC stress worker data');
}
runSpscProducer(data.buffer, new Int32Array(data.control));
parentPort?.postMessage('done');
