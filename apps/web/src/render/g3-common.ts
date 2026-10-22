// Backend-independent parts of the TASK-073 G3 passes: the published probe,
// the FPV lens, the Boson 640 thermal camera and its scene state (sensor
// frame clock, fixed pattern and NUC, per-class heat balance, display span).
// g3-passes.ts (WebGL2) and g3-passes-webgpu.ts (WebGPU) render with it.
import { PerspectiveCamera, type Camera, type Scene } from "three";
import type { VideoInput } from "@mirage/cameras/analog";
import type { CameraConfig, FpvCamera } from "@mirage/cameras/fpv-camera";
import { wallNow } from "@mirage/protocol";
import type { TilesScene } from "@mirage/terrain/tiles-scene";
import { AreaThermal } from "@mirage/thermal/area-thermal";
import { BOSON_FPN_ASSUMED, BOSON_SHUTTER_ASSUMED, BOSON_WARMUP_ASSUMED, ThermalSensorChain, generateFixedPattern } from "@mirage/thermal/fpn";
import type { ThermalWeather } from "@mirage/thermal/heat-balance";
import { BOSON_640_50DEG, verticalFovRad, type ThermalPalette, type ThermalScene } from "@mirage/thermal/thermal-camera";
import type { ShutterState } from "@mirage/thermal/thermal-status";
import { g3ThermalUtcFromSearch, type G3View } from "./g3-mode";
import type { MaterialDrape } from "./material-drape";
import { BODY_NOSE_FORWARD_M, MODEL_HEIGHT_OFFSET_M } from "../vehicle-geometry";

export const PROBE = "__mirageG3";
export const PROFILE = BOSON_640_50DEG;
/** Assumed weather for the thermal scene (no measured weather): summer air 30 C, 60% humidity, light wind, nearly clear sky. */
export const WEATHER: ThermalWeather = { airTemperatureK: 303.15, windSpeedMps: 3, cloudFraction: 0.1, deepTemperatureK: 298.15, relativeHumidity: 0.6, pressurePa: 101325 };
/**
 * Thermal G-buffer subsamples per sensor pixel and axis: each Boson pixel averages the radiance of
 * 3 x 3 subsamples (detector-area integration) instead of point-sampling the scene, which aliased
 * (staircase edges, thin roads breaking into crawling dashes).
 */
export const THERMAL_SUPERSAMPLE = 3;
/** Fixed-pattern seed (the pattern is generated; any fixed value reproduces it). */
const FPN_SEED = 0x7a5c0640;
/** Display span margin around the scene's surface temperatures (a simple AGC), K. */
const SPAN_MARGIN_K = 2;
export const LENS: CameraConfig = {
  lens: { fovHorizontalRad: (120 * Math.PI) / 180, distortion: { model: "kannala-brandt", k: [-0.02, 0.01, -0.004, 0.001] } },
  // On the nose of the drawn body (2 cm ahead of its front face, level with its centre);
  // FRD z is down, so the mesh height offset is negative here.
  mount: { offsetFrdM: [BODY_NOSE_FORWARD_M + 0.02, 0, -MODEL_HEIGHT_OFFSET_M], uptiltRad: 0.15 },
};

export interface G3Probe {
  terrain: boolean;
  fpv: boolean;
  thermal: boolean;
  gpuBytes: number;
  cpuBytes: number;
  dpr: number;
  width: number;
  height: number;
  backend: string;
  frames: number;
  reason: string;
  /** Which image is presented full-screen; FPV and thermal render every frame either way. */
  view: G3View;
  /** Thermal instrument profile id and shutter/NUC state from the sensor frame clock. */
  thermalProfile: string;
  shutter: ShutterState;
  nucCycles: number;
  /** Sensor frames skipped because rendering fell behind the 60 Hz sensor clock. */
  thermalSkippedFrames: number;
}

export interface ThermalLocation { latDeg: number; lonDeg: number }

/** What a backend's G3 passes expose to the React component. */
export interface G3PassSet {
  readonly probe: G3Probe;
  setDrape(drape: MaterialDrape | null): void;
  render(scene: Scene, chase: Camera, view: G3View, pose: Parameters<FpvCamera["update"]>[0], tiles: readonly TilesScene[], video: VideoInput): void;
  dispose(): void;
}

export function newProbe(backend: string, view: G3View, reason = ""): G3Probe {
  return {
    terrain: false, fpv: false, thermal: false, gpuBytes: 0, cpuBytes: 0, dpr: 0, width: 0, height: 0, backend, frames: 0, reason, view,
    thermalProfile: PROFILE.id, shutter: "idle", nucCycles: 0, thermalSkippedFrames: 0,
  };
}

export function publish(canvas: HTMLCanvasElement, probe: G3Probe): void {
  Reflect.set(canvas, PROBE, probe);
}

/** The thermal camera pass operations the scene state drives (implemented by both backends' passes). */
export interface ThermalCameraTarget {
  configure(scene: ThermalScene, palette: ThermalPalette, noise: boolean): void;
  setFixedPattern(residualK: Float32Array, gainKPerK: Float32Array): void;
  residualChanged(): void;
  setDriftK(driftK: number): void;
  setSkyK(skyK: number): void;
}
export interface ThermalGBufferTarget { temperaturesChanged(): void; dispose(): void }

/**
 * Sensor clock, NUC, heat balance and display span for one thermal camera.
 * The G-buffer material is created by the backend through `makeGBuffer` and
 * rebuilt when the material raster arrives.
 */
export class ThermalSceneState<G extends ThermalGBufferTarget> {
  readonly camera: PerspectiveCamera;
  gbuffer: G;
  private readonly sensor: ThermalSensorChain;
  private readonly scene: ThermalScene = { reflectedK: 250, airK: WEATHER.airTemperatureK, extinctionPerM: 0.0002, spanMinK: 270, spanMaxK: 320 };
  private readonly startUtcMs = g3ThermalUtcFromSearch(globalThis.location?.search ?? "");
  private area: AreaThermal;
  private drape: MaterialDrape | null = null;
  private sensorStartMs = -1;
  private residualVersion = -1;
  private thermalSecond = 0;

  constructor(private readonly location: ThermalLocation, private readonly pass: ThermalCameraTarget,
    private readonly makeGBuffer: (area: AreaThermal, drape: MaterialDrape | null) => G, private readonly probe: G3Probe) {
    const [w, h] = PROFILE.resolution;
    this.camera = new PerspectiveCamera((verticalFovRad(PROFILE) * 180) / Math.PI, w / h, 0.1, 30000);
    this.sensor = new ThermalSensorChain(generateFixedPattern({ width: w, height: h, seed: FPN_SEED, ...BOSON_FPN_ASSUMED }),
      { ambientK: WEATHER.airTemperatureK, ...BOSON_WARMUP_ASSUMED }, PROFILE.frameHz ?? 60, BOSON_SHUTTER_ASSUMED);
    pass.setFixedPattern(this.sensor.residualK, this.sensor.pattern.driftGainKPerK);
    this.area = this.createArea(null);
    this.gbuffer = makeGBuffer(this.area, null);
    this.configure();
  }

  /** Cold path: (re)builds the per-class heat balance for the drape's classes and integrates the previous day. */
  private createArea(drape: MaterialDrape | null): AreaThermal {
    const area = new AreaThermal(drape?.raster.materials ?? ["synthetic-ground"], {
      latDeg: this.location.latDeg, lonDeg: this.location.lonDeg, startUtcMs: this.startUtcMs, weather: WEATHER,
    });
    area.spinUp();
    if (this.thermalSecond > 0) area.advanceTo(this.startUtcMs + this.thermalSecond * 1000);
    return area;
  }

  /** Uses the P4 material raster once it has loaded (TerrainTiles loads it asynchronously). */
  setDrape(drape: MaterialDrape | null): void {
    if (drape === this.drape) return;
    this.drape = drape;
    this.area = this.createArea(drape);
    this.gbuffer.dispose();
    this.gbuffer = this.makeGBuffer(this.area, drape);
    this.configure();
  }

  /** Reflected sky and display span from the current surface temperatures (allocation-free). */
  private configure(): void {
    const t = this.area.temperatureK, n = this.area.materials.length;
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < n; c++) {
        const v = t[r * 256 + c]!; // r < 5 rows, c < n <= 256 columns
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const scene = this.scene;
    scene.reflectedK = this.area.skyTemperatureK();
    scene.spanMinK = lo - SPAN_MARGIN_K;
    scene.spanMaxK = hi + SPAN_MARGIN_K;
    this.pass.configure(scene, "white-hot", true);
    this.pass.setSkyK(scene.reflectedK);
  }

  /** Sensor frame clock (wall time at the profile rate), NUC and the 1 Hz heat-balance update. Returns whether a live frame is shown. */
  step(): boolean {
    const now = wallNow();
    if (this.sensorStartMs < 0) this.sensorStartMs = now;
    const sensorTimeS = (now - this.sensorStartMs) / 1000;
    this.sensor.advanceTo(sensorTimeS);
    if (this.sensor.residualVersion !== this.residualVersion) {
      this.residualVersion = this.sensor.residualVersion;
      this.pass.residualChanged();
    }
    this.pass.setDriftK(this.sensor.driftK);
    const second = Math.floor(sensorTimeS);
    if (second !== this.thermalSecond) {
      this.thermalSecond = second;
      this.area.advanceTo(this.startUtcMs + second * 1000);
      this.gbuffer.temperaturesChanged();
      this.configure();
    }
    const status = this.sensor.status;
    this.probe.shutter = status.state;
    this.probe.nucCycles = status.cycles;
    this.probe.thermalSkippedFrames = this.sensor.skippedFrames;
    return status.visible;
  }

  /** Boresights the thermal camera with the FPV mount. */
  aimFrom(fpv: Camera): void {
    this.camera.position.copy(fpv.position);
    this.camera.quaternion.copy(fpv.quaternion);
    this.camera.updateMatrixWorld();
  }
}

/** Pillarbox scale for the 5:4 sensor image on a display of this size. */
export function sensorPillarbox(width: number, height: number): number {
  return Math.min(1, PROFILE.resolution[0] / PROFILE.resolution[1] / (width / height));
}

/** Tile residency charged to both budgets the way TASK-062 charges it. */
export function residentBytes(tiles: readonly TilesScene[]): number {
  let bytes = 0;
  for (const source of tiles) if (source.modelCount > 0) bytes += source.cachedBytes;
  return bytes;
}
