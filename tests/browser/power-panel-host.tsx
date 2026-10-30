/** Mounts the Run-tab power panel on a power channel for tests/browser/power-panel.spec.ts. */
import { createRoot } from 'react-dom/client';
import { PowerReaderV1 } from '../../packages/protocol/src/index.ts';
import type { LimitEvent } from '../../packages/physics/src/limit-monitor.ts';
import { PowerPanel, parseLimitEventsMessage } from '../../apps/web/src/run/PowerPanel.tsx';

export function mountPowerPanel(element: HTMLElement, buffer: SharedArrayBuffer, worker: Worker): void {
  const reader = new PowerReaderV1(buffer);
  let log: readonly LimitEvent[] = [];
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const parsed = parseLimitEventsMessage(event.data);
    if (parsed) log = [...log, ...parsed.events];
  });
  const events = (): readonly LimitEvent[] => log;
  createRoot(element).render(<PowerPanel reader={reader} events={events} refreshMs={100} />);
}
