import { Export } from "./aar/Export";
import { PilotHud } from "./hud/PilotHud";
import { hudTelemetry } from "./hud/telemetry";
import { Console } from "./instructor/Console";
import { AppShell } from "./shell/AppShell";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Cpu,
  Gamepad2,
  Pause,
  Play,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import {
  CHANNELS,
  defaultCalibration,
  type GamepadCalibration,
} from "@mirage/input";
import { VehicleFlagV2 } from "@mirage/protocol";
import { inspectCapabilities, type CapabilityReport } from "./capabilities";
import { FlightScene } from "./FlightScene";
import { PowerPanel } from "./run/PowerPanel";
import type { LimitEvent } from "@mirage/physics/limit-monitor";

import { terrainConfigFrom } from "./terrain-config";
import type { TileFailure } from "@mirage/terrain/tiles-provider";

/** No limit events before the runtime exists (TASK-146). */
const NO_LIMIT_EVENTS = (): readonly LimitEvent[] => [];

// Build-time terrain settings (TASK-061); absent by default, so no terrain is loaded.
const TERRAIN = terrainConfigFrom(
  import.meta.env.VITE_MIRAGE_TILESET_URL,
  import.meta.env.VITE_MIRAGE_TILES_ORIGIN,
  import.meta.env.VITE_MIRAGE_TILES_ATTRIBUTION,
  import.meta.env.VITE_MIRAGE_TERRAIN_URL,
  import.meta.env.VITE_MIRAGE_MATERIALS_URL,
);
import { SerialConnect } from "./SerialConnect";
import {
  loadCalibration,
  saveCalibration,
} from "@mirage/input/calibration-store";
import {
  defaultModeCalibration,
  type ModeCalibration,
} from "@mirage/input/mode-channel";
import { SimulationRuntime, type ViewStats } from "./runtime";
import { flightPlanFromSearch } from "./flight-plan";

// TASK-073: `?flight=circuit` flies the scripted circuit inside the configured area.
const FLIGHT_PLAN = flightPlanFromSearch(globalThis.location?.search ?? "", import.meta.env.VITE_MIRAGE_AREA_RADIUS_M);

const INITIAL: ViewStats = {
  ready: false,
  faulted: false,
  running: false,
  armed: false,
  pending: false,
  tick: 0,
  simTime: 0,
  altitude: 0,
  speed: 0,
  voltage: 12.6,
  flags:
    VehicleFlagV2.GroundContact |
    VehicleFlagV2.InputFailsafe |
    VehicleFlagV2.Paused,
  hz: 0,
  targetHz: 400,
  epoch: 1,
  fps: 0,
  dropped: 0,
  overruns: 0,
  input: { roll: 0, pitch: 0, yaw: 0, throttle: 0 },
  device: "",
  inputStatus: "disconnected",
  selectedDevice: null,
  notice: "",
};
class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="scene-error">
        WebGL2 is unavailable. Physics and telemetry remain active.
      </p>
    ) : (
      this.props.children
    );
  }
}
function Calibration({
  value,
  onChange,
}: {
  value: GamepadCalibration;
  onChange: (value: GamepadCalibration) => void;
}) {
  return (
    <details className="calibration">
      <summary>
        <SlidersHorizontal size={14} /> USB channels / calibration
      </summary>
      <p>Check channel directions while disarmed. Axis indices start at 0.</p>
      <div className="calibration-scroll">
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Axis</th>
              <th>Min</th>
              <th>Center</th>
              <th>Max</th>
              <th>↔</th>
            </tr>
          </thead>
          <tbody>
            {CHANNELS.map((channel) => (
              <tr key={channel}>
                <th>{channel}</th>
                {(["axis", "min", "center", "max"] as const).map((field) => (
                  <td key={field}>
                    <input
                      type="number"
                      aria-label={`${channel} ${field}`}
                      step={field === "axis" ? 1 : 0.05}
                      value={value[channel][field]}
                      onChange={(event) =>
                        onChange({
                          ...value,
                          [channel]: {
                            ...value[channel],
                            [field]: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </td>
                ))}
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${channel} invert`}
                    checked={value[channel].inverted}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        [channel]: {
                          ...value[channel],
                          inverted: event.target.checked,
                        },
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Deadzone: 3.5%. Throttle: min → 0%, max → 100%; center is unused.
        Changing calibration disarms the motors.
      </p>
    </details>
  );
}
/**
 * The synthetic demo flight that the Run tab holds (formerly the whole page).
 * While another tab is open the simulation keeps running and only the 3D view pauses.
 */
function DemoFlight({ visible }: { visible: boolean }) {
  const runtime = useRef<SimulationRuntime | null>(null);
  const [stats, setStats] = useState(INITIAL);
  const [error, setError] = useState("");
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(
    null,
  );
  const [source, setSource] = useState<"demo" | "usb">("demo");
  const [materialsStatus, setMaterialsStatus] = useState("");
  const [terrainFailures, setTerrainFailures] = useState<
    readonly TileFailure[]
  >([]);
  const [throttle, setThrottle] = useState(0);
  const [calibration, setCalibration] = useState(defaultCalibration);
  const [modeCalibration, setModeCalibration] = useState<ModeCalibration>(
    defaultModeCalibration,
  );
  const [devices, setDevices] = useState<{ index: number; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        const report = await inspectCapabilities();
        if (cancelled) return;
        setCapabilities(report);
        if (!report.demoEligible) {
          setError(report.blockers.join(" "));
          return;
        }
        runtime.current = new SimulationRuntime(setStats);
        if (FLIGHT_PLAN) runtime.current.useScriptedFlight(FLIGHT_PLAN);
        const profile = loadCalibration(localStorage);
        if (profile) {
          setCalibration(profile.axes);
          setModeCalibration(profile.mode);
          runtime.current.configure(profile.axes);
          runtime.current.gamepad.modeCalibration = profile.mode;
        }
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    };
    void initialize();
    return () => {
      cancelled = true;
      runtime.current?.dispose();
      runtime.current = null;
    };
  }, []);
  useEffect(() => {
    const update = () => {
      try {
        setDevices(
          Array.from(navigator.getGamepads?.() ?? []).flatMap((p) =>
            p?.connected ? [{ index: p.index, name: p.id }] : [],
          ),
        );
      } catch {
        setDevices([]);
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  const changeSource = (next: "demo" | "usb") => {
    runtime.current?.selectSource(next);
    setSource(next);
  };
  const changeCalibration = (next: GamepadCalibration) => {
    setCalibration(next);
    runtime.current?.configure(next);
    if (!saveCalibration(localStorage, next, modeCalibration))
      setError("Calibration is invalid or storage is unavailable.");
    else setError("");
  };
  const changeModeCalibration = (next: ModeCalibration) => {
    runtime.current?.disarm();
    if (runtime.current) runtime.current.gamepad.modeCalibration = next;
    setModeCalibration(next);
    if (!saveCalibration(localStorage, calibration, next))
      setError("Mode calibration is invalid or storage is unavailable.");
    else setError("");
  };
  const hud = runtime.current
    ? hudTelemetry(runtime.current.current)
    : null;
  return (
    <>
      <div className="top-status demo-status">
        <span className={`status-dot ${stats.running ? "live" : ""}`} />
        {stats.running ? "SIMULATION LIVE" : "STANDBY"}
        <span className="divider" />
        <span className="status-detail">LOCAL PHYSICS · SHARED MEMORY ABI V2</span>
      </div>
      <div className="workspace">
        <section className="flight-panel">
          <div className="panel-heading">
            <span>
              <span className="tiny-dot" /> FLIGHT FIELD
            </span>
            <span>01 / EXTERNAL CAMERA</span>
          </div>
          <div className="viewport">
            {capabilities?.demoEligible && (
              <SceneBoundary>
                <FlightScene
                  runtime={runtime}
                  active={visible}
                  terrain={TERRAIN.status === "ready" ? TERRAIN.config : null}
                  onTerrainFailures={setTerrainFailures}
                  onMaterials={setMaterialsStatus}
                />
              </SceneBoundary>
            )}
            <div className="viewport-top">
              <span className="badge">DEMO QUAD / NED</span>
              <span className="coordinates">
                N {runtime.current?.current.northM.toFixed(1) ?? "0.0"} · E{" "}
                {runtime.current?.current.eastM.toFixed(1) ?? "0.0"}
              </span>
            </div>
            {TERRAIN.status !== "off" && (
              <div className="terrain-status" data-testid="terrain-status">
                {TERRAIN.status === "ready"
                  ? `Terrain: ${TERRAIN.config.attribution}`
                  : `Terrain blocked: ${TERRAIN.reason}`}
                {materialsStatus && ` · ${materialsStatus}`}
                {terrainFailures.length > 0 &&
                  ` · ${terrainFailures.length} tile request(s) failed (${terrainFailures[0]!.kind}: ${terrainFailures[0]!.message})`}
              </div>
            )}
            <PilotHud state={runtime.current?.current ?? null} />
            <div className="reticle">
              <span />
              <span />
            </div>
            <div className="flight-label">
              MIRAGE TEST RANGE<small>Flat ground · simplified dynamics</small>
            </div>
            <div className="hud-bottom">
              <div>
                <small>ALTITUDE / AGL</small>
                <strong data-testid="altitude">
                  {stats.altitude.toFixed(1)}
                  <em>m</em>
                </strong>
              </div>
              <div>
                <small>SPEED</small>
                <strong>
                  {stats.speed.toFixed(1)}
                  <em>m/s</em>
                </strong>
              </div>
              <div>
                <small>POWER / MODEL</small>
                <strong>
                  {stats.voltage.toFixed(1)}
                  <em>V</em>
                </strong>
              </div>
              <div className="flight-mode">
                <small>CONTROL</small>
                <strong>
                  {hud?.source === "autopilot" ? hud.mode : "DIRECT RATE"}
                </strong>
                <span>
                  {hud?.source === "autopilot"
                    ? hud.status === "fresh"
                      ? "Autopilot telemetry live"
                      : "Autopilot telemetry stale"
                    : "ArduPilot disconnected"}
                </span>
              </div>
            </div>
          </div>
          <div className="transport">
            <div className="flex items-center gap-2">
              <button
                className="primary"
                disabled={!stats.ready || stats.pending || stats.faulted}
                onClick={() =>
                  runtime.current?.command(stats.running ? "pause" : "start")
                }
              >
                {stats.running ? <Pause size={15} /> : <Play size={15} />}
                {stats.running ? "Pause" : "Start"}
              </button>
              <button
                className="icon-button"
                aria-label="Reset flight"
                disabled={!stats.ready || stats.pending}
                onClick={() => runtime.current?.command("reset")}
              >
                <RotateCcw size={16} />
              </button>
            </div>
            <div className="clock">
              <span>SIM TIME</span>
              <b data-testid="sim-time">{stats.simTime.toFixed(2)} s</b>
              <small data-testid="tick">{stats.tick} ticks</small>
            </div>
          </div>
          <div className="metric-grid">
            <div>
              <Cpu size={17} />
              <span>
                Physics
                <small>
                  fixed step: {(1000 / stats.targetHz).toFixed(3)} ms
                </small>
              </span>
              <b data-testid="physics-hz">
                {stats.hz.toFixed(0)}
                <small data-testid="target-hz"> / {stats.targetHz} Hz</small>
              </b>
            </div>
            <div>
              <Activity size={17} />
              <span>
                Main thread<small>rAF frame rate</small>
              </span>
              <b>
                {stats.fps.toFixed(0)}
                <small> FPS</small>
              </b>
            </div>
            <div>
              <Shield size={17} />
              <span>
                Scheduler<small>{stats.overruns} budget overruns</small>
              </span>
              <b data-testid="dropped">
                {stats.dropped}
                <small> dropped</small>
              </b>
            </div>
          </div>
        </section>
        <aside className="instructor-panel">
          <div className="panel-heading">
            <span>PILOT CONSOLE</span>
            <Gamepad2 size={16} />
          </div>
          <div className="control-section">
            <div className="eyebrow">01 / INPUT SOURCE</div>
            <h2 className="console-title">Flight controls</h2>
            <p>Check the channels and arm at zero throttle.</p>
            {FLIGHT_PLAN && (
              <p className="notice" data-testid="scripted-flight">
                Scripted flight: {FLIGHT_PLAN.circuitRadiusM} m circuit at{" "}
                {FLIGHT_PLAN.altitudeM} m, {FLIGHT_PLAN.speedMps} m/s
              </p>
            )}
            <div className="segmented">
              <button
                className={source === "demo" ? "selected" : ""}
                onClick={() => changeSource("demo")}
              >
                Demo input
              </button>
              <button
                className={source === "usb" ? "selected" : ""}
                disabled={!capabilities?.usbEligible}
                onClick={() => changeSource("usb")}
              >
                USB / EdgeTX
              </button>
            </div>
            {source === "usb" ? (
              <div className="device-box">
                <label htmlFor="device">USB GAMEPAD</label>
                <select
                  id="device"
                  aria-label="USB device"
                  disabled={!devices.length}
                  value={stats.selectedDevice ?? ""}
                  onChange={(event) =>
                    runtime.current?.selectDevice(
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                    )
                  }
                >
                  {!devices.length ? (
                    <option value="">
                      Connect a transmitter and move a stick
                    </option>
                  ) : (
                    <option value="">Automatic (first connected)</option>
                  )}
                  {devices.map((d) => (
                    <option key={d.index} value={d.index}>
                      {d.index}: {d.name}
                    </option>
                  ))}
                </select>
                <small data-testid="input-status">
                  {stats.inputStatus} {stats.device}
                </small>
              </div>
            ) : (
              <div className="device-box">
                <span className="status-dot live" />
                <span>Virtual collective throttle</span>
                <small>
                  Sticks centered. Select the USB tab to use a transmitter.
                </small>
              </div>
            )}
            <button
              className={`arm-button ${stats.armed ? "armed" : ""}`}
              disabled={!stats.running || stats.pending}
              onClick={() => runtime.current?.setArmed(!stats.armed)}
            >
              {stats.armed ? "Disarm motors" : "Arm motors"}
              <span className="status-dot" />
            </button>
            <div className="throttle-heading">
              <span>COLLECTIVE / THROTTLE</span>
              <b>{(stats.input.throttle * 100).toFixed(0)}%</b>
            </div>
            {source === "demo" && (
              <input
                aria-label="Demo throttle"
                className="throttle-slider"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={throttle}
                onChange={(event) => {
                  const v = Number(event.target.value);
                  setThrottle(v);
                  if (runtime.current) runtime.current.demoThrottle = v;
                }}
              />
            )}
            <div className="channel-bars">
              {CHANNELS.map((channel) => (
                <div key={channel}>
                  <span>{channel.toUpperCase()}</span>
                  <div className="bar-track">
                    <i
                      style={{
                        width: `${(channel === "throttle" ? stats.input[channel] : (stats.input[channel] + 1) / 2) * 100}%`,
                      }}
                    />
                  </div>
                  <b>{stats.input[channel].toFixed(2)}</b>
                </div>
              ))}
            </div>
            {source === "usb" && (
              <>
                <Calibration value={calibration} onChange={changeCalibration} />
                <label>
                  <input
                    aria-label="Enable mode channel"
                    type="checkbox"
                    checked={modeCalibration.enabled}
                    onChange={(event) =>
                      changeModeCalibration({
                        ...modeCalibration,
                        enabled: event.target.checked,
                      })
                    }
                  />{" "}
                  Enable mode channel (six slots)
                </label>
                {modeCalibration.enabled && (
                  <details className="calibration">
                    <summary>Mode channel calibration</summary>
                    <div className="calibration-scroll">
                      {(
                        ["axis", "min", "center", "max", "deadzone"] as const
                      ).map((field) => (
                        <label key={field}>
                          Mode {field}
                          <input
                            type="number"
                            aria-label={`mode ${field}`}
                            value={modeCalibration.axis[field]}
                            step={field === "axis" ? 1 : 0.05}
                            onChange={(event) =>
                              changeModeCalibration({
                                ...modeCalibration,
                                axis: {
                                  ...modeCalibration.axis,
                                  [field]: Number(event.target.value),
                                },
                              })
                            }
                          />
                        </label>
                      ))}
                      <label>
                        <input
                          type="checkbox"
                          aria-label="mode invert"
                          checked={modeCalibration.axis.inverted}
                          onChange={(event) =>
                            changeModeCalibration({
                              ...modeCalibration,
                              axis: {
                                ...modeCalibration.axis,
                                inverted: event.target.checked,
                              },
                            })
                          }
                        />{" "}
                        Invert mode axis
                      </label>
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
          <div className="control-section diagnostics">
            <div className="eyebrow">02 / SYSTEM STATUS</div>
            <div>
              <span>Worker / SAB</span>
              <b data-testid="worker-status">
                {stats.ready
                  ? stats.faulted
                    ? "FAULT"
                    : "READY"
                  : error
                    ? "UNAVAILABLE"
                    : "INITIALIZING"}
              </b>
            </div>
            <div>
              <span>Renderer</span>
              <b data-testid="renderer-capability">
                {capabilities?.renderer === "webgl2" ? "WebGL2" : "Unavailable"}
              </b>
            </div>
            <div>
              <span>Gamepad API</span>
              <b>
                {capabilities?.gamepad === "available"
                  ? "Available"
                  : "Unavailable"}
              </b>
            </div>
            <div>
              <span>Serial API</span>
              <b data-testid="serial-capability">
                {capabilities?.serial === "available"
                  ? "Available"
                  : "Unavailable"}
              </b>
            </div>
            <SerialConnect
              onFrame={(frame) => {
                runtime.current?.ingestSerialFrame(frame);
              }}
              onDisconnect={() => runtime.current?.clearAutopilotStatus()}
            />
            <p>
              Serial API availability does not enable HITL. A verified
              flight-controller profile is required.
            </p>
            <div>
              <span>Ground contact</span>
              <b>
                {stats.flags & VehicleFlagV2.GroundContact
                  ? "GROUND"
                  : "AIRBORNE"}
              </b>
            </div>
            <div>
              <span>Input protection</span>
              <b
                data-testid="input-protection"
                className={
                  stats.flags & VehicleFlagV2.InputFailsafe ? "muted" : ""
                }
              >
                {stats.flags & VehicleFlagV2.InputFailsafe
                  ? "DISARMED / STALE"
                  : "INPUT LIVE"}
              </b>
            </div>
            {(error || stats.notice) && (
              <p className="alert" role="alert">
                <TriangleAlert size={16} />
                {error || stats.notice}
              </p>
            )}
          </div>
          <PowerPanel reader={runtime.current?.power ?? null} events={runtime.current?.limitEvents ?? NO_LIMIT_EVENTS} />
          <Console runtime={runtime.current} />
          <Export runtime={runtime.current} />
          <div className="scope-note">
            <span className="eyebrow">DEVELOPMENT MILESTONE 01</span>
            <p>
              Demo flight backend. Autopilot disconnected; instructor effects
              require a supporting backend.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

/**
 * The Run tab (TASK-137). The synthetic demo is the only flight backend until
 * the integrated ArduPilot session (TASK-153, TASK-154); it is selected here
 * and labeled synthetic.
 */
function RunTab({ visible }: { visible: boolean }) {
  return (
    <div className="run-tab">
      <div className="run-heading">
        <h2>Run</h2>
        <fieldset className="run-mode">
          <legend>Flight backend</legend>
          <label>
            <input type="radio" name="flight-backend" value="demo" defaultChecked /> Synthetic demo
          </label>
          <label>
            <input type="radio" name="flight-backend" value="ardupilot" disabled /> ArduPilot SITL (not available yet)
          </label>
        </fieldset>
      </div>
      <p className="synthetic-note">
        Synthetic demo: a simplified collective-thrust quadcopter. It does not use project data and is not
        validated for tuning, pilot training or real-flight settings.
      </p>
      <DemoFlight visible={visible} />
    </div>
  );
}

export default function App() {
  return <AppShell run={visible => <RunTab visible={visible} />} />;
}
