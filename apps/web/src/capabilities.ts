export type Availability = 'available' | 'unavailable';
export interface CapabilityEnvironment {
  secure: boolean; isolated: boolean; sharedMemory: boolean; worker: boolean;
  gamepad: boolean; serial: boolean;
  webgl2: () => boolean;
  webgpuAdapter: () => Promise<boolean>;
}
export interface CapabilityReport {
  secure: boolean; isolated: boolean; sharedMemory: boolean; worker: boolean;
  webgl2: Availability; webgpu: Availability; gamepad: Availability; serial: Availability;
  demoEligible: boolean; usbEligible: boolean;
  hitlEligible: false; webgpuEligible: false;
  renderer: 'webgl2' | 'unavailable'; blockers: string[];
}
function adapterApi(value: unknown): value is { requestAdapter(): Promise<unknown> } {
  return typeof value === 'object' && value !== null && 'requestAdapter' in value && typeof value.requestAdapter === 'function';
}
function browserEnvironment(): CapabilityEnvironment {
  const gpu: unknown = Reflect.get(navigator, 'gpu');
  const serial: unknown = Reflect.get(navigator, 'serial');
  return {
    secure: isSecureContext, isolated: crossOriginIsolated,
    sharedMemory: typeof SharedArrayBuffer === 'function', worker: typeof Worker === 'function',
    gamepad: typeof navigator.getGamepads === 'function',
    serial: typeof serial === 'object' && serial !== null && 'requestPort' in serial && typeof serial.requestPort === 'function',
    webgl2: () => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    },
    webgpuAdapter: async () => adapterApi(gpu) && (await gpu.requestAdapter()) != null,
  };
}
/** Detect APIs without requesting user permissions or starting any service. */
export async function inspectCapabilities(environment = browserEnvironment(), timeoutMs = 1000): Promise<CapabilityReport> {
  const blockers: string[] = [];
  if (!environment.secure) blockers.push('A secure HTTPS or localhost context is required.');
  if (!environment.isolated) blockers.push('Shared memory requires cross-origin isolation (COOP/COEP).');
  if (!environment.sharedMemory) blockers.push('SharedArrayBuffer is unavailable.');
  if (!environment.worker) blockers.push('Web Workers are unavailable.');
  let webgl2 = false;
  try { webgl2 = environment.webgl2(); } catch { /* Treat blocked context creation as unavailable. */ }
  if (!webgl2) blockers.push('WebGL2 is unavailable; the graphical demo cannot start.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let webgpu = false;
  try {
    webgpu = await Promise.race([
      Promise.resolve().then(() => environment.webgpuAdapter()),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch { /* A GPU failure must preserve the supported WebGL2 renderer. */ }
  finally { clearTimeout(timer); }
  const demoEligible = blockers.length === 0;
  return {
    secure: environment.secure, isolated: environment.isolated, sharedMemory: environment.sharedMemory, worker: environment.worker,
    webgl2: webgl2 ? 'available' : 'unavailable', webgpu: webgpu ? 'available' : 'unavailable',
    gamepad: environment.gamepad ? 'available' : 'unavailable', serial: environment.serial ? 'available' : 'unavailable',
    demoEligible, usbEligible: demoEligible && environment.gamepad,
    hitlEligible: false, webgpuEligible: false, renderer: webgl2 ? 'webgl2' : 'unavailable', blockers,
  };
}
