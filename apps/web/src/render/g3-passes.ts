// TASK-073 production passes. They run only for `?g3=1` and only on WebGL2:
// a mounted FPV camera, fisheye remap, analog video, and an LWIR camera
// (approximated FLIR Boson 640, 50 deg lens, TASK-073 P5) fed by a G-buffer
// rasterized from the same scene (including tiles): per-fragment material
// class and orientation select a TASK-070 heat-balance temperature, and the
// sensor chain adds generated fixed-pattern noise corrected by the TASK-072
// shutter/NUC. The display holds its last image while the shutter is closed.
// Residency is the tileset cache estimate, charged to both budgets the way
// TASK-062 charges it. WebGPU has no fisheye or thermal pass, so those flags
// stay false there. Nothing here writes physics, AAR, or React state.
import { useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  FloatType, Mesh, NearestFilter, OrthographicCamera, PerspectiveCamera, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, Vector2,
  WebGLRenderTarget, WebGLRenderer, type Camera, type Texture,
} from "three";
import { AnalogVideo, DEFAULT_VIDEO_NOISE, type VideoInput } from "@mirage/cameras/analog";
import { createAnalogMaterial } from "@mirage/cameras/analog-material";
import { FpvCamera, type CameraConfig } from "@mirage/cameras/fpv-camera";
import { createFisheyeMaterial, updateFisheyeMaterial } from "@mirage/cameras/fisheye-material";
import { interpolationAlpha, interpolatePoseInto, newRenderPoseV2, wallNow } from "@mirage/protocol";
import type { TilesScene } from "@mirage/terrain/tiles-scene";
import { AreaThermal } from "@mirage/thermal/area-thermal";
import { BOSON_FPN_ASSUMED, BOSON_SHUTTER_ASSUMED, BOSON_WARMUP_ASSUMED, ThermalSensorChain, generateFixedPattern } from "@mirage/thermal/fpn";
import type { ThermalWeather } from "@mirage/thermal/heat-balance";
import { BOSON_640_50DEG, verticalFovRad, type ThermalScene } from "@mirage/thermal/thermal-camera";
import { ThermalCameraPass } from "@mirage/thermal/thermal-material";
import type { ShutterState } from "@mirage/thermal/thermal-status";
import type { SimulationRuntime } from "../runtime";
import { g3ThermalUtcFromSearch, g3ViewFromSearch, type G3View } from "./g3-mode";
import type { MaterialDrape } from "./material-drape";
import { ThermalGBuffer } from "./thermal-gbuffer";
import { BODY_NOSE_FORWARD_M, MODEL_HEIGHT_OFFSET_M } from "../vehicle-geometry";

const PROBE = "__mirageG3";
const PROFILE = BOSON_640_50DEG;
/** Assumed weather for the thermal scene (no measured weather): summer air 30 C, 60% humidity, light wind, nearly clear sky. */
const WEATHER: ThermalWeather = { airTemperatureK: 303.15, windSpeedMps: 3, cloudFraction: 0.1, deepTemperatureK: 298.15, relativeHumidity: 0.6, pressurePa: 101325 };
/** Fixed-pattern seed (the pattern is generated; any fixed value reproduces it). */
const FPN_SEED = 0x7a5c0640;
/** Display span margin around the scene's surface temperatures (a simple AGC), K. */
const SPAN_MARGIN_K = 2;
const PRESENT_VERTEX = "varying vec2 vUv;\nuniform vec2 uScale;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy * uScale, 0.0, 1.0); }\n";
const PRESENT_FRAGMENT = "varying vec2 vUv;\nuniform sampler2D uSource;\nvoid main() { gl_FragColor = texture2D(uSource, vUv); }\n";
const LENS: CameraConfig = {
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

function publish(canvas: HTMLCanvasElement, probe: G3Probe): void {
  Reflect.set(canvas, PROBE, probe);
}

function colorTarget(width: number, height: number): WebGLRenderTarget {
  const target = new WebGLRenderTarget(width, height, { depthBuffer: true });
  target.texture.minFilter = NearestFilter;
  target.texture.magFilter = NearestFilter;
  target.texture.generateMipmaps = false;
  return target;
}

function floatTarget(width: number, height: number): WebGLRenderTarget {
  const target = new WebGLRenderTarget(width, height, { type: FloatType, format: RGBAFormat, depthBuffer: true });
  target.texture.minFilter = NearestFilter;
  target.texture.magFilter = NearestFilter;
  target.texture.generateMipmaps = false;
  return target;
}

function bindSource(material: ShaderMaterial, texture: Texture): void {
  const uniform = material.uniforms.uSource;
  if (uniform) uniform.value = texture;
}

class ProductionPasses {
  readonly probe: G3Probe = {
    terrain: false, fpv: false, thermal: false, gpuBytes: 0, cpuBytes: 0, dpr: 1, width: 0, height: 0, backend: "webgl2", frames: 0, reason: "", view: "chase",
    thermalProfile: PROFILE.id, shutter: "idle", nucCycles: 0, thermalSkippedFrames: 0,
  };
  private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fpv: FpvCamera;
  private readonly video: AnalogVideo;
  private readonly thermalCamera: PerspectiveCamera;
  private readonly sensor: ThermalSensorChain;
  private readonly thermalScene: ThermalScene = { reflectedK: 250, airK: WEATHER.airTemperatureK, extinctionPerM: 0.0002, spanMinK: 270, spanMaxK: 320 };
  private readonly startUtcMs = g3ThermalUtcFromSearch(globalThis.location?.search ?? "");
  private area: AreaThermal;
  private gbufferMaterial: ThermalGBuffer;
  private drape: MaterialDrape | null = null;
  private sensorStartMs = -1;
  private residualVersion = -1;
  private thermalSecond = 0;
  private readonly presentMaterial = new ShaderMaterial({ vertexShader: PRESENT_VERTEX, fragmentShader: PRESENT_FRAGMENT,
    uniforms: { uSource: { value: null }, uScale: { value: new Vector2(1, 1) } }, depthTest: false, depthWrite: false });
  private readonly presentScene = new Scene();
  private readonly presentQuad: Mesh;
  private readonly fisheyeMaterial: ShaderMaterial;
  private readonly analogMaterial: ShaderMaterial;
  private readonly fisheyeScene = new Scene();
  private readonly analogScene = new Scene();
  private readonly fisheyeQuad: Mesh;
  private readonly analogQuad: Mesh;
  private readonly thermal: ThermalCameraPass;
  private color: WebGLRenderTarget | null = null;
  private fisheye: WebGLRenderTarget | null = null;
  /** Analog FPV output when the chase view is presented. */
  private analog: WebGLRenderTarget | null = null;
  private gbuffer: WebGLRenderTarget | null = null;
  private width = 0;
  private height = 0;
  private frame = 0;
  private shaderErrors = 0;
  private floatColor = false;
  private readonly bufferSize = new Vector2();
  private previousShaderError: WebGLRenderer["debug"]["onShaderError"] = null;
  private disposed = false;

  constructor(private readonly renderer: WebGLRenderer, private readonly location: ThermalLocation) {
    // A square placeholder puts the 120 deg corners past the 80 deg pinhole limit. 16:9 stays inside it; the real buffer size is applied in ensureSize.
    this.fpv = new FpvCamera(LENS, 16, 9);
    this.video = new AnalogVideo(DEFAULT_VIDEO_NOISE);
    this.fisheyeMaterial = createFisheyeMaterial(this.fpv.params, null);
    this.analogMaterial = createAnalogMaterial(this.video, null);
    this.fisheyeQuad = new Mesh(new PlaneGeometry(2, 2), this.fisheyeMaterial);
    this.analogQuad = new Mesh(new PlaneGeometry(2, 2), this.analogMaterial);
    this.fisheyeQuad.frustumCulled = false;
    this.analogQuad.frustumCulled = false;
    this.fisheyeScene.add(this.fisheyeQuad);
    this.analogScene.add(this.analogQuad);
    const [sensorW, sensorH] = PROFILE.resolution;
    this.thermalCamera = new PerspectiveCamera((verticalFovRad(PROFILE) * 180) / Math.PI, sensorW / sensorH, 0.1, 30000);
    this.thermal = new ThermalCameraPass(PROFILE, null);
    this.sensor = new ThermalSensorChain(generateFixedPattern({ width: sensorW, height: sensorH, seed: FPN_SEED, ...BOSON_FPN_ASSUMED }),
      { ambientK: WEATHER.airTemperatureK, ...BOSON_WARMUP_ASSUMED }, PROFILE.frameHz ?? 60, BOSON_SHUTTER_ASSUMED);
    this.thermal.setFixedPattern(this.sensor.residualK, this.sensor.pattern.driftGainKPerK);
    this.area = this.createArea(null);
    this.gbufferMaterial = new ThermalGBuffer(this.area, null);
    this.configureThermal();
    this.presentQuad = new Mesh(new PlaneGeometry(2, 2), this.presentMaterial);
    this.presentQuad.frustumCulled = false;
    this.presentScene.add(this.presentQuad);
    const presentSource = this.presentMaterial.uniforms.uSource;
    if (presentSource) presentSource.value = this.thermal.target.texture;
    this.previousShaderError = renderer.debug.onShaderError;
    renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      this.shaderErrors += 1;
      // Replacing the hook silences three's own log; keep the first failure diagnosable.
      if (this.shaderErrors === 1) {
        console.error("G3 shader program failed", gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertexShader), gl.getShaderInfoLog(fragmentShader));
      }
    };
    this.floatColor = renderer.getContext().getExtension("EXT_color_buffer_float") !== null;
    publish(renderer.domElement, this.probe);
  }

  private ensureSize(width: number, height: number): void {
    if (width === this.width && height === this.height && this.color && this.fisheye && this.analog && this.gbuffer) return;
    this.color?.dispose();
    this.fisheye?.dispose();
    this.analog?.dispose();
    this.gbuffer?.dispose();
    this.width = width;
    this.height = height;
    this.color = colorTarget(width, height);
    this.analog = colorTarget(width, height);
    this.fisheye = colorTarget(width, height);
    this.gbuffer = floatTarget(PROFILE.resolution[0], PROFILE.resolution[1]);
    // Pillarbox the 5:4 sensor image on the display.
    const scale: unknown = this.presentMaterial.uniforms.uScale?.value;
    if (scale instanceof Vector2) scale.set(Math.min(1, PROFILE.resolution[0] / PROFILE.resolution[1] / (width / height)), 1);
    this.fpv.resize(width, height);
    updateFisheyeMaterial(this.fisheyeMaterial, this.fpv.params);
    bindSource(this.fisheyeMaterial, this.color.texture);
    bindSource(this.analogMaterial, this.fisheye.texture);
    const gbufferUniform = this.thermal.material.uniforms.uGBuffer;
    if (gbufferUniform) gbufferUniform.value = this.gbuffer.texture;
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
    if (drape === this.drape || this.disposed) return;
    this.drape = drape;
    this.area = this.createArea(drape);
    this.gbufferMaterial.dispose();
    this.gbufferMaterial = new ThermalGBuffer(this.area, drape);
    this.configureThermal();
  }

  /** Reflected sky and display span from the current surface temperatures (allocation-free). */
  private configureThermal(): void {
    const t = this.area.temperatureK, n = this.area.materials.length;
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < n; c++) {
        const v = t[r * 256 + c]!; // r < 5 rows, c < n <= 256 columns
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const scene = this.thermalScene;
    scene.reflectedK = this.area.skyTemperatureK();
    scene.spanMinK = lo - SPAN_MARGIN_K;
    scene.spanMaxK = hi + SPAN_MARGIN_K;
    this.thermal.configure(scene, "white-hot", true);
    this.thermal.setSkyK(scene.reflectedK);
  }

  /** Sensor frame clock (wall time at the profile rate), NUC and the 1 Hz heat-balance update. Returns whether a live frame is shown. */
  private stepSensor(): boolean {
    const now = wallNow();
    if (this.sensorStartMs < 0) this.sensorStartMs = now;
    const sensorTimeS = (now - this.sensorStartMs) / 1000;
    this.sensor.advanceTo(sensorTimeS);
    if (this.sensor.residualVersion !== this.residualVersion) {
      this.residualVersion = this.sensor.residualVersion;
      this.thermal.residualChanged();
    }
    this.thermal.setDriftK(this.sensor.driftK);
    const second = Math.floor(sensorTimeS);
    if (second !== this.thermalSecond) {
      this.thermalSecond = second;
      this.area.advanceTo(this.startUtcMs + second * 1000);
      this.gbufferMaterial.temperaturesChanged();
      this.configureThermal();
    }
    const status = this.sensor.status;
    this.probe.shutter = status.state;
    this.probe.nucCycles = status.cycles;
    this.probe.thermalSkippedFrames = this.sensor.skippedFrames;
    return status.visible;
  }

  render(scene: Scene, chase: Camera, view: G3View, pose: Parameters<FpvCamera["update"]>[0], tiles: readonly TilesScene[], video: VideoInput): void {
    if (this.disposed) return;
    this.renderer.setPixelRatio(1);
    this.renderer.getDrawingBufferSize(this.bufferSize);
    const width = this.bufferSize.x;
    const height = this.bufferSize.y;
    if (width < 2 || height < 2) return;
    this.ensureSize(width, height);
    const color = this.color;
    const fisheye = this.fisheye;
    const gbuffer = this.gbuffer;
    if (!color || !fisheye || !gbuffer) return;
    this.fpv.update(pose);
    for (const source of tiles) {
      source.tiles.setCamera(this.fpv.camera);
      source.tiles.setResolutionFromRenderer(this.fpv.camera, this.renderer);
      source.update();
    }
    this.renderer.setRenderTarget(color);
    this.renderer.render(scene, this.fpv.camera);
    this.renderer.setRenderTarget(fisheye);
    this.renderer.render(this.fisheyeScene, this.ortho);
    this.video.updateFrom(video);
    if (view === "fpv") {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.analogScene, this.ortho);
    } else {
      // Chase and thermal views: the FPV chain still runs to its own target.
      this.renderer.setRenderTarget(this.analog);
      this.renderer.render(this.analogScene, this.ortho);
      if (view === "chase") {
        this.renderer.setRenderTarget(null);
        this.renderer.render(scene, chase);
      }
    }
    // The thermal camera is boresighted with the FPV mount; while the shutter is closed the last image is held.
    if (this.stepSensor()) {
      this.thermalCamera.position.copy(this.fpv.camera.position);
      this.thermalCamera.quaternion.copy(this.fpv.camera.quaternion);
      this.thermalCamera.updateMatrixWorld();
      const previousOverride = scene.overrideMaterial, previousBackground = scene.background, previousAlpha = this.renderer.getClearAlpha();
      scene.overrideMaterial = this.gbufferMaterial.material;
      scene.background = null; // cleared texels (alpha 0) are sky
      this.renderer.setClearAlpha(0);
      this.renderer.setRenderTarget(gbuffer);
      this.renderer.render(scene, this.thermalCamera);
      this.renderer.setClearAlpha(previousAlpha);
      scene.background = previousBackground;
      scene.overrideMaterial = previousOverride;
      this.frame = (this.frame + 1) >>> 0;
      this.thermal.setFrameSeed(this.frame);
      this.thermal.render(this.renderer);
    }
    if (view === "thermal") {
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      this.renderer.render(this.presentScene, this.ortho);
    }
    let bytes = 0;
    for (const source of tiles) if (source.modelCount > 0) bytes += source.cachedBytes;
    const probe = this.probe;
    probe.gpuBytes = bytes;
    probe.cpuBytes = bytes;
    probe.terrain = bytes >= 1;
    // A program fails once, at compile, and stays invalid: any failure so far marks the passes broken.
    probe.fpv = this.shaderErrors === 0;
    probe.thermal = probe.fpv && this.floatColor;
    probe.dpr = this.renderer.getPixelRatio();
    probe.width = width;
    probe.height = height;
    probe.backend = "webgl2";
    probe.view = view;
    probe.frames += 1;
    probe.reason = !probe.fpv ? "FPV or thermal shader failed" : this.floatColor ? (probe.terrain ? "" : "Terrain tiles are not resident") : "EXT_color_buffer_float is unavailable";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.debug.onShaderError = this.previousShaderError;
    this.color?.dispose();
    this.fisheye?.dispose();
    this.analog?.dispose();
    this.gbuffer?.dispose();
    this.gbufferMaterial.dispose();
    this.presentMaterial.dispose();
    this.presentQuad.geometry.dispose();
    this.fisheyeMaterial.dispose();
    this.analogMaterial.dispose();
    this.fisheyeQuad.geometry.dispose();
    this.analogQuad.geometry.dispose();
    this.thermal.dispose();
    this.probe.fpv = false;
    this.probe.thermal = false;
    this.probe.reason = "disposed";
  }
}

function inactive(canvas: HTMLCanvasElement, reason: string): G3Probe {
  const probe: G3Probe = {
    terrain: false, fpv: false, thermal: false, gpuBytes: 0, cpuBytes: 0, dpr: 0, width: 0, height: 0, backend: "", frames: 0, reason, view: VIEW,
    thermalProfile: PROFILE.id, shutter: "idle", nucCycles: 0, thermalSkippedFrames: 0,
  };
  publish(canvas, probe);
  return probe;
}

const VIEW: G3View = g3ViewFromSearch(globalThis.location?.search ?? "");

export function G3Passes({ runtime, tiles, drape, location }: { runtime: RefObject<SimulationRuntime | null>; tiles: RefObject<TilesScene[]>;
  drape: RefObject<MaterialDrape | null>; location: ThermalLocation }) {
  const { gl, scene } = useThree();
  const passes = useRef<ProductionPasses | null>(null);
  const pose = useRef(newRenderPoseV2());
  const video = useRef({ timeS: 0, throttle: 0.35 });
  useEffect(() => {
    const canvas = gl.domElement;
    canvas.dataset.g3 = "1";
    if (!(gl instanceof WebGLRenderer)) {
      inactive(canvas, "WebGPU fisheye and thermal passes are not implemented");
      return () => { delete canvas.dataset.g3; };
    }
    const created = new ProductionPasses(gl, location);
    passes.current = created;
    return () => {
      created.dispose();
      passes.current = null;
      delete canvas.dataset.g3;
    };
  }, [gl, location]);
  useFrame(({ camera }) => {
    const pass = passes.current;
    const sim = runtime.current;
    if (!pass || !sim) return;
    const alpha = interpolationAlpha(wallNow(), sim.current, sim.header.physicsHz, sim.running);
    interpolatePoseInto(sim.previous, sim.current, sim.history, alpha, pose.current);
    video.current.timeS = wallNow() / 1000;
    pass.setDrape(drape.current);
    pass.render(scene, camera, VIEW, pose.current, tiles.current, video.current);
  }, 1);
  return null;
}
