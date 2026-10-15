import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Cpu, Gamepad2, Pause, Play, Radio, RotateCcw, Shield, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { CHANNELS, defaultCalibration, type GamepadCalibration } from '@mirage/input';
import { StateFlag } from '@mirage/protocol';
import { FlightScene } from './FlightScene';
import { SimulationRuntime, type ViewStats } from './runtime';

const INITIAL: ViewStats = { ready: false, running: false, armed: false, pending: false,
  tick: 0, simTime: 0, altitude: 0, speed: 0, voltage: 12.6, flags: 3, hz: 0, fps: 0,
  dropped: 0, overruns: 0, input: { roll: 0, pitch: 0, yaw: 0, throttle: 0 }, device: '', inputStatus: 'disconnected', notice: '' };
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="scene-error">WebGL2 недоступен. Физика и телеметрия продолжают работать.</p> : this.props.children; }
}
function Calibration({ value, onChange }: { value: GamepadCalibration; onChange: (value: GamepadCalibration) => void }) {
  return <details className="calibration"><summary><SlidersHorizontal size={14} /> Каналы USB / калибровка</summary>
    <p>Проверьте направления при выключенных двигателях. Индексы осей начинаются с 0.</p>
    <div className="calibration-scroll"><table><thead><tr><th>Канал</th><th>Ось</th><th>Min</th><th>Центр</th><th>Max</th><th>↔</th></tr></thead>
      <tbody>{CHANNELS.map(channel => <tr key={channel}><th>{channel}</th>
        {(['axis', 'min', 'center', 'max'] as const).map(field => <td key={field}><input type="number" aria-label={`${channel} ${field}`}
          step={field === 'axis' ? 1 : 0.05} value={value[channel][field]}
          onChange={event => onChange({ ...value, [channel]: { ...value[channel], [field]: Number(event.target.value) } })} /></td>)}
        <td><input type="checkbox" aria-label={`${channel} invert`} checked={value[channel].inverted}
          onChange={event => onChange({ ...value, [channel]: { ...value[channel], inverted: event.target.checked } })} /></td>
      </tr>)}</tbody></table></div>
    <p>Deadzone 3,5%. Газ: min → 0%, max → 100%; центр для газа не используется. Изменение калибровки отключает двигатели.</p>
  </details>;
}
export default function App() {
  const runtime = useRef<SimulationRuntime | null>(null);
  const [stats, setStats] = useState(INITIAL);
  const [error, setError] = useState('');
  const [source, setSource] = useState<'demo' | 'usb'>('demo');
  const [throttle, setThrottle] = useState(0);
  const [calibration, setCalibration] = useState(defaultCalibration);
  const [devices, setDevices] = useState<{ index: number; name: string }[]>([]);
  useEffect(() => {
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      setError('Для общей памяти нужны HTTPS (или localhost), COOP: same-origin и COEP: require-corp.'); return;
    }
    try { runtime.current = new SimulationRuntime(setStats); }
    catch (e) { setError(String(e)); }
    return () => { runtime.current?.dispose(); runtime.current = null; };
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
        <div className="panel-heading"><span><span className="tiny-dot" /> ПОЛЁТНОЕ ПОЛЕ</span><span>01 / EXTERNAL CAMERA</span></div>
        <div className="viewport">
          <SceneBoundary><FlightScene runtime={runtime} /></SceneBoundary>
          <div className="viewport-top"><span className="badge">DEMO QUAD / NED</span><span className="coordinates">N {runtime.current?.current.north.toFixed(1) ?? '0.0'} · E {runtime.current?.current.east.toFixed(1) ?? '0.0'}</span></div>
          <div className="reticle"><span /><span /></div>
          <div className="flight-label">MIRAGE TEST RANGE<small>Плоская поверхность · упрощённая динамика</small></div>
          <div className="hud-bottom"><div><small>ВЫСОТА / AGL</small><strong data-testid="altitude">{stats.altitude.toFixed(1)}<em>м</em></strong></div>
            <div><small>СКОРОСТЬ</small><strong>{stats.speed.toFixed(1)}<em>м/с</em></strong></div>
            <div><small>ПИТАНИЕ / МОДЕЛЬ</small><strong>{stats.voltage.toFixed(1)}<em>V</em></strong></div>
            <div className="flight-mode"><small>УПРАВЛЕНИЕ</small><strong>DIRECT RATE</strong><span>ArduPilot не подключён</span></div></div>
        </div>
        <div className="transport"><div className="flex items-center gap-2"><button className="primary" disabled={!stats.ready || stats.pending} onClick={() => runtime.current?.command(stats.running ? 'pause' : 'start')}>
          {stats.running ? <Pause size={15} /> : <Play size={15} />}{stats.running ? 'Пауза' : 'Запустить'}</button>
          <button className="icon-button" aria-label="Сбросить полёт" disabled={!stats.ready || stats.pending} onClick={() => runtime.current?.command('reset')}><RotateCcw size={16} /></button></div>
          <div className="clock"><span>SIM TIME</span><b data-testid="sim-time">{stats.simTime.toFixed(2)} s</b><small data-testid="tick">{stats.tick} ticks</small></div></div>
        <div className="metric-grid"><div><Cpu size={17} /><span>Физика<small>фиксированный шаг 2,5 мс</small></span><b data-testid="physics-hz">{stats.hz.toFixed(0)}<small> / 400 Hz</small></b></div>
          <div><Activity size={17} /><span>Main thread<small>частота кадров rAF</small></span><b>{stats.fps.toFixed(0)}<small> FPS</small></b></div>
          <div><Shield size={17} /><span>Планировщик<small>{stats.overruns} превышений бюджета</small></span><b data-testid="dropped">{stats.dropped}<small> пропусков</small></b></div></div>
      </section>
      <aside className="instructor-panel"><div className="panel-heading"><span>КОНСОЛЬ ПИЛОТА</span><Gamepad2 size={16} /></div>
        <div className="control-section"><div className="eyebrow">01 / ИСТОЧНИК КОМАНД</div><h1>Управление полётом</h1><p>Проверьте каналы и включите двигатели при нулевом газе.</p>
          <div className="segmented"><button className={source === 'demo' ? 'selected' : ''} onClick={() => changeSource('demo')}>Демо-ввод</button><button className={source === 'usb' ? 'selected' : ''} onClick={() => changeSource('usb')}>USB / EdgeTX</button></div>
          {source === 'usb' ? <div className="device-box"><label htmlFor="device">USB GAMEPAD</label><select id="device" aria-label="USB устройство" disabled={!devices.length} onChange={event => { runtime.current?.disarm(); if (runtime.current) runtime.current.gamepad.selectedIndex = Number(event.target.value); }}>
            {!devices.length && <option>Подключите пульт и сдвиньте стик</option>}{devices.map(d => <option key={d.index} value={d.index}>{d.index}: {d.name}</option>)}</select>
            <small data-testid="input-status">{stats.inputStatus} {stats.device}</small></div> : <div className="device-box"><span className="status-dot live" /><span>Виртуальный коллективный газ</span><small>Стики по центру. Для USB выберите соседнюю вкладку.</small></div>}
          <button className={`arm-button ${stats.armed ? 'armed' : ''}`} disabled={!stats.running || stats.pending} onClick={() => runtime.current?.setArmed(!stats.armed)}>{stats.armed ? 'Отключить двигатели' : 'Включить двигатели'}<span className="status-dot" /></button>
          <div className="throttle-heading"><span>COLLECTIVE / ГАЗ</span><b>{(stats.input.throttle * 100).toFixed(0)}%</b></div>
          {source === 'demo' && <input aria-label="Демо-газ" className="throttle-slider" type="range" min="0" max="1" step="0.01" value={throttle} onChange={event => { const v = Number(event.target.value); setThrottle(v); if (runtime.current) runtime.current.demoThrottle = v; }} />}
          <div className="channel-bars">{CHANNELS.map(channel => <div key={channel}><span>{channel.toUpperCase()}</span><div className="bar-track"><i style={{ width: `${(channel === 'throttle' ? stats.input[channel] : (stats.input[channel] + 1) / 2) * 100}%` }} /></div><b>{stats.input[channel].toFixed(2)}</b></div>)}</div>
          {source === 'usb' && <Calibration value={calibration} onChange={changeCalibration} />}
        </div>
        <div className="control-section diagnostics"><div className="eyebrow">02 / СОСТОЯНИЕ СИСТЕМЫ</div>
          <div><span>Worker / SAB</span><b data-testid="worker-status">{stats.ready ? 'READY' : 'INITIALIZING'}</b></div>
          <div><span>Контакт с землёй</span><b>{stats.flags & StateFlag.OnGround ? 'GROUND' : 'AIRBORNE'}</b></div>
          <div><span>Защита ввода</span><b className={stats.flags & StateFlag.InputFailsafe ? 'muted' : ''}>{stats.flags & StateFlag.InputFailsafe ? 'DISARMED / STALE' : 'INPUT LIVE'}</b></div>
          {(error || stats.notice) && <p className="alert" role="alert"><TriangleAlert size={16} />{error || stats.notice}</p>}
        </div>
        <div className="scope-note"><span className="eyebrow">DEVELOPMENT MILESTONE 01</span><p>Изолированный контур физики и ввод пилота. JSBSim, BET, SITL/HITL и РЭБ запланированы в архитектуре.</p></div>
      </aside>
    </main>
    <footer><span>SHARED MEMORY TRANSPORT · ABI V1</span><span>Симуляция для разработки · не валидирована для подготовки пилотов</span></footer>
  </div>;
}
