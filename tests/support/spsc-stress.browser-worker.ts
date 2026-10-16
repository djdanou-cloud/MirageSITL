import { runSpscProducer } from './spsc-stress.ts';

// Browser module Worker producer for the SPSC stress test.
addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null || !('buffer' in data) || !('control' in data) ||
    !(data.buffer instanceof SharedArrayBuffer) || !(data.control instanceof SharedArrayBuffer)) {
    postMessage('invalid');
    return;
  }
  runSpscProducer(data.buffer, new Int32Array(data.control));
  postMessage('done');
});
