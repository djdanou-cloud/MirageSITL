import { ABI_VERSION, ControlFlag, ControlWriter, Header, StateReader,
  createSharedMemory, newInput, newState, wallNow,
  type FlightState, type MainToPhysics, type PhysicsCommand, type PhysicsToMain } from '@mirage/protocol';
import { GamepadAdapter, type GamepadCalibration } from '@mirage/input';

export interface ViewStats {
  ready: boolean; running: boolean; armed: boolean; pending: boolean;
  tick: number; simTime: number; altitude: number; speed: number; voltage: number;
  flags: number; hz: number; fps: number; dropped: number; overruns: number;
  input: { roll: number; pitch: number; yaw: number; throttle: number };
  device: string; inputStatus: string; notice: string;
}
export class SimulationRuntime {
  readonly buffer = createSharedMemory();
  readonly words = new Int32Array(this.buffer);
  readonly reader = new StateReader(this.buffer);
  readonly controls = new ControlWriter(this.buffer);
  readonly gamepad = new GamepadAdapter();
  readonly current: FlightState = newState();
  readonly previous: FlightState = newState();
  readonly input = newInput();
  readonly worker = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module', name: 'mirage-physics' });
  source: 'demo' | 'usb' = 'demo';
  demoThrottle = 0;
  ready = false;
  running = false;
  armed = false;
  pending = false;
  notice = '';
  private requestId = 0;
  private pendingId = 0;
  private raf = 0;
  private lastReport = performance.now();
  private lastTick = 0;
  private frames = 0;
  private disposed = false;

  constructor(private readonly report: (stats: ViewStats) => void) {
    this.worker.onmessage = ({ data }: MessageEvent<PhysicsToMain>) => {
      if (data.type === 'ready') this.ready = true;
      if (data.type === 'error') this.fail(data.message);
      if (data.type === 'ack' && data.requestId === this.pendingId) {
        this.pending = false;
        this.running = data.command === 'start';
      }
    };
    this.worker.onerror = event => this.fail(event.message || 'Physics worker failed');
    this.send({ type: 'init', version: ABI_VERSION, buffer: this.buffer });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.raf = requestAnimationFrame(this.frame);
  }
  private send(message: MainToPhysics) { this.worker.postMessage(message); }
  private fail(message: string) {
    this.notice = message; this.ready = this.running = this.armed = this.pending = false;
  }
  command(command: PhysicsCommand): void {
    if (!this.ready || this.pending) return;
    this.disarm();
    this.pending = true; this.pendingId = ++this.requestId;
    this.send({ type: command, requestId: this.pendingId });
  }
  setArmed(value: boolean): void {
    if (!value) { this.disarm(); return; }
    if (!this.running || this.pending) return;
    if (this.input.throttle > 0.05) { this.notice = 'Lower throttle to 0% before arming.'; return; }
    if (this.source === 'usb' && this.gamepad.status !== 'connected') {
      this.notice = 'Connect a USB transmitter and check its axes.'; return;
    }
    this.notice = ''; this.armed = true;
  }
  disarm(): void {
    this.armed = false;
    this.input.flags &= ~ControlFlag.Armed;
    this.input.wallTimeMs = wallNow();
    this.controls.publish(this.input);
  }
  selectSource(source: 'demo' | 'usb') { this.disarm(); this.source = source; }
  configure(calibration: GamepadCalibration) { this.disarm(); this.gamepad.calibration = calibration; }
  private onVisibility = () => {
    if (document.hidden) {
      this.disarm();
      // A pending start ACK can arrive after visibilitychange. Queue pause last.
      if (this.ready) {
        this.pending = true; this.pendingId = ++this.requestId;
        this.send({ type: 'pause', requestId: this.pendingId });
      }
    }
  };
  private frame = (now: number) => {
    if (this.disposed) return;
    if (this.source === 'usb') {
      this.gamepad.poll(this.input, wallNow(), this.armed);
      if (this.gamepad.status !== 'connected') this.armed = false;
    } else {
      this.input.roll = this.input.pitch = this.input.yaw = 0;
      this.input.throttle = this.demoThrottle;
      this.input.flags = ControlFlag.Connected | (this.armed ? ControlFlag.Armed : 0);
      this.input.wallTimeMs = wallNow();
    }
    this.controls.publish(this.input);
    if (this.reader.latest(this.current)) {
      if (!this.reader.latest(this.previous, 1) || this.previous.tick + 1 !== this.current.tick)
        Object.assign(this.previous, this.current);
    }
    this.frames++;
    const elapsed = now - this.lastReport;
    if (elapsed >= 150) {
      const s = this.current;
      this.report({ ready: this.ready, running: this.running, armed: this.armed, pending: this.pending,
        tick: s.tick, simTime: s.simTime, altitude: -s.down, speed: Math.hypot(s.vn, s.ve, s.vd),
        voltage: s.batteryVoltage, flags: s.flags,
        hz: s.tick >= this.lastTick ? (s.tick - this.lastTick) * 1000 / elapsed : 0,
        fps: this.frames * 1000 / elapsed,
        dropped: Atomics.load(this.words, Header.DroppedSteps) >>> 0,
        overruns: Atomics.load(this.words, Header.Overruns) >>> 0,
        input: { roll: this.input.roll, pitch: this.input.pitch, yaw: this.input.yaw, throttle: this.input.throttle },
        device: this.gamepad.deviceName, inputStatus: this.gamepad.status, notice: this.notice });
      this.lastTick = s.tick; this.lastReport = now; this.frames = 0;
    }
    this.raf = requestAnimationFrame(this.frame);
  };
  dispose(): void {
    this.disposed = true; this.disarm(); cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.worker.terminate();
  }
}
