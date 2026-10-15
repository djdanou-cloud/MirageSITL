import { expect, test } from '@playwright/test';

for (const [property, value, reason] of [
  ['crossOriginIsolated', false, 'cross-origin isolation'],
  ['isSecureContext', false, 'secure HTTPS'],
  ['SharedArrayBuffer', undefined, 'SharedArrayBuffer'],
  ['Worker', undefined, 'Web Workers'],
] as const) {
  test(`missing ${property} never starts a Worker or reports READY`, async ({ page }) => {
    await page.addInitScript(({ property, value }) => {
      Object.defineProperty(window, property, { value });
    }, { property, value });
    await page.goto('/');
    await expect(page.getByTestId('worker-status')).toHaveText('UNAVAILABLE');
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText(reason);
  });
}
test('missing Gamepad and Serial APIs disable the appropriate features', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'getGamepads', { value: undefined });
    Object.defineProperty(navigator, 'serial', { value: undefined });
  });
  await page.goto('/');
  await expect(page.getByTestId('worker-status')).toHaveText('READY');
  await expect(page.getByRole('button', { name: 'USB / EdgeTX', exact: true })).toBeDisabled();
  await expect(page.getByTestId('serial-capability')).toHaveText('Unavailable');
});
test('a rejected WebGPU probe retains the working WebGL2 demo', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: () => Promise.reject(new Error('denied')) } });
  });
  await page.goto('/');
  await expect(page.getByTestId('worker-status')).toHaveText('READY');
  await expect(page.getByTestId('renderer-capability')).toHaveText('WebGL2');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});
test('missing WebGL2 blocks the graphical demo with an explanation', async ({ page }) => {
  await page.addInitScript(() => {
    const original: unknown = Reflect.get(HTMLCanvasElement.prototype, 'getContext');
    function isContextMethod(value: unknown): value is typeof HTMLCanvasElement.prototype.getContext {
      return typeof value === 'function';
    }
    if (!isContextMethod(original)) throw new Error('Missing native canvas method');
    HTMLCanvasElement.prototype.getContext = new Proxy(original, {
      apply(target, receiver: unknown, args: unknown[]): RenderingContext | null {
        if (args[0] === 'webgl2') return null;
        // Proxy arguments come directly from this native method's call sites.
        return Reflect.apply<unknown, Parameters<typeof target>, RenderingContext | null>(target, receiver, args as Parameters<typeof target>);
      },
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('worker-status')).toHaveText('UNAVAILABLE');
  await expect(page.getByRole('alert')).toContainText('WebGL2');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
});
