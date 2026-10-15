import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Cpu, Gamepad2, Pause, Play, Radio, RotateCcw, Shield, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { CHANNELS, defaultCalibration, type GamepadCalibration } from '@mirage/input';
import { StateFlag } from '@mirage/protocol';
import { inspectCapabilities, type CapabilityReport } from './capabilities';
import { FlightScene } from './FlightScene';
import { SimulationRuntime, type ViewStats } from './runtime';

const INITIAL: ViewStats = { ready: false, running: false, armed: false, pending: false,
  tick: 0, simTime: 0, altitude: 0, speed: 0, voltage: 12.6, flags: 3, hz: 0, fps: 0,
  dropped: 0, overruns: 0, input: { roll: 0, pitch: 0, yaw: 0, throttle: 0 }, device: '', inputStatus: 'disconnected', notice: '' };
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="scene-error">WebGL2 is unavailable. Physics and telemetry remain active.</p> : this.props.children; }
}
function Calibration({ value, onChange }: { value: GamepadCalibration; onChange: (value: GamepadCalibration) => void }) {
  return <details className="calibration"><summary><SlidersHorizontal size={14} /> USB channels / calibration</summary>
    <p>Check channel directions while disarmed. Axis indices start at 0.</p>
    <div className="calibration-scroll"><table><thead><tr><th>Channel</th><th>Axis</th><th>Min</th><th>Center</th><th>Max</th><th>↔</th></tr></thead>
      <tbody>{CHANNELS.map(channel => <tr key={channel}><th>{channel}</th>
        {(['axis', 'min', 'center', 'max'] as const).map(field => <td key={field}><input type="number" aria-label={`${channel} ${field}`}
          step={field === 'axis' ? 1 : 0.05} value={value[channel][field]}
          onChange={event => onChange({ ...value, [channel]: { ...value[channel], [field]: Number(event.target.value) } })} /></td>)}
        <td><input type="checkbox" aria-label={`${channel} invert`} checked={value[channel].inverted}
          onChange={event => onChange({ ...value, [channel]: { ...value[channel], inverted: event.target.checked } })} /></td>
      </tr>)}</tbody></table></div>
    <p>Deadzone: 3.5%. Throttle: min → 0%, max → 100%; center is unused. Changing calibration disarms the motors.</p>
  </details>;
}
export default function App() {
  const runtime = useRef<SimulationRuntime | null>(null);
  const [stats, setStats] = useState(INITIAL);
  const [error, setError] = useState('');
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [source, setSource] = useState<'demo' | 'usb'>('demo');
  const [throttle, setThrottle] = useState(0);
  const [calibration, setCalibration] = useState(defaultCalibration);
  const [devices, setDevices] = useState<{ index: number; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        const report = await inspectCapabilities();
        if (cancelled) return;
        setCapabilities(report);
        if (!report.demoEligible) { setError(report.blockers.join(' ')); return; }
        runtime.current = new SimulationRuntime(setStats);
      } catch (cause) { if (!cancelled) setError(String(cause)); }
    };
    void initialize();
    return () => { cancelled = true; runtime.current?.dispose(); runtime.current = null; };
  }, []);
  useEffect(() => {
    const update = () => {
      try { setDevices(Array.from(navigator.getGamepads?.() ?? []).flatMap(p => p?.connected ? [{ index: p.index, name: p.id }] : [])); }
      catch { setDevices([]); }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  const changeSource = (next: 'demo' | 'usb') => { runtime.current?.selectSource(next); setSource(next); };
  const changeCalibration = (next: GamepadCalibration) => { setCalibration(next); runtime.current?.configure(next); };
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-icon"><Radio size={22} /></span><span>MIRAGE<span className="brand-light">SITL</span><small>FLIGHT LABORATORY / 001</small></span></div>
      <div className="top-status"><span className={`status-dot ${stats.running ? 'live' : ''}`} />{stats.running ? 'SIMULATION LIVE' : 'STANDBY'}<span className="divider" /><span className="status-detail">LOCAL PHYSICS</span></div>
      <span className="build-label">PROTOTYPE 0.1 <ArrowUpRight size={14} /></span></header>
    <main className="workspace">
      <section className="flight-panel">
        <div className="panel-heading"><span><span className="tiny-dot" /> FLIGHT FIELD</span><span>01 / EXTERNAL CAMERA</span></div>
        <div className="viewport">
          {capabilities?.demoEligible && <SceneBoundary><FlightScene runtime={runtime} /></SceneBoundary>}
          <div className="viewport-top"><span className="badge">DEMO QUAD / NED</span><span className="coordinates">N {runtime.current?.current.north.toFixed(1) ?? '0.0'} · E {runtime.current?.current.east.toFixed(1) ?? '0.0'}</span></div>
          <div className="reticle"><span /><span /></div>
          <div className="flight-label">MIRAGE TEST RANGE<small>Flat ground · simplified dynamics</small></div>
          <div className="hud-bottom"><div><small>ALTITUDE / AGL</small><strong data-testid="altitude">{stats.altitude.toFixed(1)}<em>m</em></strong></div>
            <div><small>SPEED</small><strong>{stats.speed.toFixed(1)}<em>m/s</em></strong></div>
            <div><small>POWER / MODEL</small><strong>{stats.voltage.toFixed(1)}<em>V</em></strong></div>
            <div className="flight-mode"><small>CONTROL</small><strong>DIRECT RATE</strong><span>ArduPilot disconnected</span></div></div>
        </div>
        <div className="transport"><div className="flex items-center gap-2"><button className="primary" disabled={!stats.ready || stats.pending} onClick={() => runtime.current?.command(stats.running ? 'pause' : 'start')}>
          {stats.running ? <Pause size={15} /> : <Play size={15} />}{stats.running ? 'Pause' : 'Start'}</button>
          <button className="icon-button" aria-label="Reset flight" disabled={!stats.ready || stats.pending} onClick={() => runtime.current?.command('reset')}><RotateCcw size={16} /></button></div>
          <div className="clock"><span>SIM TIME</span><b data-testid="sim-time">{stats.simTime.toFixed(2)} s</b><small data-testid="tick">{stats.tick} ticks</small></div></div>
        <div className="metric-grid"><div><Cpu size={17} /><span>Physics<small>fixed step: 2.5 ms</small></span><b data-testid="physics-hz">{stats.hz.toFixed(0)}<small> / 400 Hz</small></b></div>
          <div><Activity size={17} /><span>Main thread<small>rAF frame rate</small></span><b>{stats.fps.toFixed(0)}<small> FPS</small></b></div>
          <div><Shield size={17} /><span>Scheduler<small>{stats.overruns} budget overruns</small></span><b data-testid="dropped">{stats.dropped}<small> dropped</small></b></div></div>
      </section>
      <aside className="instructor-panel"><div className="panel-heading"><span>PILOT CONSOLE</span><Gamepad2 size={16} /></div>
        <div className="control-section"><div className="eyebrow">01 / INPUT SOURCE</div><h1>Flight controls</h1><p>Check the channels and arm at zero throttle.</p>
          <div className="segmented"><button className={source === 'demo' ? 'selected' : ''} onClick={() => changeSource('demo')}>Demo input</button><button className={source === 'usb' ? 'selected' : ''} disabled={!capabilities?.usbEligible} onClick={() => changeSource('usb')}>USB / EdgeTX</button></div>
          {source === 'usb' ? <div className="device-box"><label htmlFor="device">USB GAMEPAD</label><select id="device" aria-label="USB device" disabled={!devices.length} onChange={event => { runtime.current?.disarm(); if (runtime.current) runtime.current.gamepad.selectedIndex = Number(event.target.value); }}>
            {!devices.length && <option>Connect a transmitter and move a stick</option>}{devices.map(d => <option key={d.index} value={d.index}>{d.index}: {d.name}</option>)}</select>
            <small data-testid="input-status">{stats.inputStatus} {stats.device}</small></div> : <div className="device-box"><span className="status-dot live" /><span>Virtual collective throttle</span><small>Sticks centered. Select the USB tab to use a transmitter.</small></div>}
          <button className={`arm-button ${stats.armed ? 'armed' : ''}`} disabled={!stats.running || stats.pending} onClick={() => runtime.current?.setArmed(!stats.armed)}>{stats.armed ? 'Disarm motors' : 'Arm motors'}<span className="status-dot" /></button>
          <div className="throttle-heading"><span>COLLECTIVE / THROTTLE</span><b>{(stats.input.throttle * 100).toFixed(0)}%</b></div>
          {source === 'demo' && <input aria-label="Demo throttle" className="throttle-slider" type="range" min="0" max="1" step="0.01" value={throttle} onChange={event => { const v = Number(event.target.value); setThrottle(v); if (runtime.current) runtime.current.demoThrottle = v; }} />}
          <div className="channel-bars">{CHANNELS.map(channel => <div key={channel}><span>{channel.toUpperCase()}</span><div className="bar-track"><i style={{ width: `${(channel === 'throttle' ? stats.input[channel] : (stats.input[channel] + 1) / 2) * 100}%` }} /></div><b>{stats.input[channel].toFixed(2)}</b></div>)}</div>
          {source === 'usb' && <Calibration value={calibration} onChange={changeCalibration} />}
        </div>
        <div className="control-section diagnostics"><div className="eyebrow">02 / SYSTEM STATUS</div>
          <div><span>Worker / SAB</span><b data-testid="worker-status">{stats.ready ? 'READY' : error ? 'UNAVAILABLE' : 'INITIALIZING'}</b></div>
          <div><span>Renderer</span><b data-testid="renderer-capability">{capabilities?.renderer === 'webgl2' ? 'WebGL2' : 'Unavailable'}</b></div>
          <div><span>Gamepad API</span><b>{capabilities?.gamepad === 'available' ? 'Available' : 'Unavailable'}</b></div>
          <div><span>Serial API</span><b data-testid="serial-capability">{capabilities?.serial === 'available' ? 'Available' : 'Unavailable'}</b></div>
          <p>Serial API availability does not enable HITL. WebGPU and HITL integrations are planned.</p>
          <div><span>Ground contact</span><b>{stats.flags & StateFlag.OnGround ? 'GROUND' : 'AIRBORNE'}</b></div>
          <div><span>Input protection</span><b className={stats.flags & StateFlag.InputFailsafe ? 'muted' : ''}>{stats.flags & StateFlag.InputFailsafe ? 'DISARMED / STALE' : 'INPUT LIVE'}</b></div>
          {(error || stats.notice) && <p className="alert" role="alert"><TriangleAlert size={16} />{error || stats.notice}</p>}
        </div>
        <div className="scope-note"><span className="eyebrow">DEVELOPMENT MILESTONE 01</span><p>Isolated physics and pilot input. JSBSim, BET, SITL/HITL, and EW are planned in the architecture.</p></div>
      </aside>
    </main>
    <footer><span>SHARED MEMORY TRANSPORT · ABI V1</span><span>Development simulation · not validated for pilot training</span></footer>
  </div>;
}
