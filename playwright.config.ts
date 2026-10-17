import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const hardwareGpu = process.env.MIRAGE_BROWSER_GPU === 'hardware';
export default defineConfig({
  testDir: './tests/browser',
  outputDir: 'test-results/browser/artifacts',
  timeout: 30000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ['junit', { outputFile: 'test-results/browser/junit.xml' }],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: process.env.MIRAGE_BROWSER_HEADED !== '1',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      // Software rendering keeps functional tests independent of runner GPUs.
      args: hardwareGpu ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: `"${process.execPath}" "${fileURLToPath(new URL('node_modules/vite/bin/vite.js', import.meta.url))}" apps/web --host 127.0.0.1 --port 5173 --strictPort`,
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
