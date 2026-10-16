import { parentPort, workerData } from 'node:worker_threads';
import { runStressWriter } from './atomic-v2-stress.ts';

// Node worker_threads entry for the ABI v2 concurrency stress test. Node loads
// this TypeScript file directly through type stripping.
const data: unknown = workerData;
if (typeof data !== 'object' || data === null || !('buffer' in data) || !('control' in data) ||
  !(data.buffer instanceof SharedArrayBuffer) || !(data.control instanceof SharedArrayBuffer)) {
  throw new Error('Invalid stress worker data');
}
runStressWriter(data.buffer, new Int32Array(data.control));
parentPort?.postMessage('done');
