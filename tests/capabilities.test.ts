import { describe, expect, it } from 'vitest';
import { inspectCapabilities, type CapabilityEnvironment } from '../apps/web/src/capabilities';

const supported = (): CapabilityEnvironment => ({
  secure: true, isolated: true, sharedMemory: true, worker: true,
  gamepad: true, serial: true, webgl2: () => true,
  webgpuAdapter: () => Promise.resolve(true),
});
describe('runtime capability eligibility', () => {
  it('keeps implemented WebGL2 separate from future API availability', async () => {
    const report = await inspectCapabilities(supported());
    expect(report.demoEligible).toBe(true); expect(report.usbEligible).toBe(true);
    expect(report.renderer).toBe('webgl2'); expect(report.serial).toBe('available');
    expect(report.hitlEligible).toBe(false); expect(report.webgpuEligible).toBe(false);
  });
  it.each(['secure', 'isolated', 'sharedMemory', 'worker'] as const)('blocks the Worker without %s', async key => {
    const report = await inspectCapabilities({ ...supported(), [key]: false });
    expect(report.demoEligible).toBe(false); expect(report.usbEligible).toBe(false);
    expect(report.blockers.length).toBeGreaterThan(0);
  });
  it('degrades missing input APIs independently and never fakes WebGL2', async () => {
    const report = await inspectCapabilities({ ...supported(), gamepad: false, serial: false });
    expect(report.demoEligible).toBe(true); expect(report.usbEligible).toBe(false);
    expect(report.serial).toBe('unavailable');
    expect((await inspectCapabilities({ ...supported(), webgl2: () => false })).demoEligible).toBe(false);
  });
  it('retains WebGL2 when GPU probing rejects, returns null, or stalls', async () => {
    for (const probe of [() => Promise.reject(new Error('denied')), () => Promise.resolve(false), () => new Promise<boolean>(() => {})]) {
      const report = await inspectCapabilities({ ...supported(), webgpuAdapter: probe }, 5);
      expect(report.webgpu).toBe('unavailable'); expect(report.demoEligible).toBe(true);
      expect(report.renderer).toBe('webgl2');
    }
  });
});
