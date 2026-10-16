import { runStressWriter } from './atomic-v2-stress.ts';

// Browser module Worker entry for the ABI v2 concurrency stress test.
addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null || !('buffer' in data) || !('control' in data) ||
    !(data.buffer instanceof SharedArrayBuffer) || !(data.control instanceof SharedArrayBuffer)) {
    postMessage('invalid');
    return;
  }
  runStressWriter(data.buffer, new Int32Array(data.control));
  postMessage('done');
});
