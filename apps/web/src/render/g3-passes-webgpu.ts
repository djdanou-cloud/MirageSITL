// WebGPU implementation of the TASK-073 G3 passes (P6), loaded only when the
// app runs on WebGPURenderer. Same chain and probe as g3-passes.ts with the
// TSL node materials: FisheyeNodeMaterial, AnalogNodeMaterial,
// ThermalGBufferNode and ThermalCameraNodePass, drawn with QuadMesh into
// RenderTargets. WebGPU reports shader and validation failures
// asynchronously on the device, so the probe counts uncaptured device errors
// instead of a compile hook.
import { FloatType, LinearFilter, NearestFilter, RenderTarget, Vector2, type Camera, type Scene, type WebGLRenderer } from "three";
import { NodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";
import { Fn, select, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { AnalogNodeMaterial } from "@mirage/cameras/analog-node";
import { AnalogVideo, DEFAULT_VIDEO_NOISE, type VideoInput } from "@mirage/cameras/analog";
import { FisheyeNodeMaterial } from "@mirage/cameras/fisheye-node";
import { FpvCamera } from "@mirage/cameras/fpv-camera";
import type { TilesScene } from "@mirage/terrain/tiles-scene";
import { ThermalCameraNodePass } from "@mirage/thermal/thermal-node";
import { LENS, PROFILE, THERMAL_SUPERSAMPLE, ThermalSceneState, newProbe, publish, residentBytes, sensorPillarbox, type G3PassSet, type ThermalLocation } from "./g3-common";
import { g3ProfileFromSearch, g3SkipFromSearch, type G3View } from "./g3-mode";
import type { G3Pass } from "./gpu-pass-timer";
import { WebGpuPassTimer } from "./gpu-pass-timer-webgpu";
import type { MaterialDrape } from "./material-drape";
import { ThermalGBufferNode } from "./thermal-gbuffer-node";
import { rendererDevice } from "./webgpu";

/** `?g3profile=1` and `?g3skip=fpv,thermal`, as on WebGL2 (diagnostics only). */
const PROFILE_PASSES = g3ProfileFromSearch(globalThis.location?.search ?? "");
const { fpv: SKIP_FPV, thermal: SKIP_THERMAL } = g3SkipFromSearch(globalThis.location?.search ?? "");
const SKIPPED = [SKIP_FPV ? "fpv" : "", SKIP_THERMAL ? "thermal" : ""].filter(Boolean).join(",");

/** G-buffer: float, nearest. FPV chain: bilinear; the scene render (samples 4) is multisampled. */
function target(width: number, height: number, float = false, samples = 0): RenderTarget {
  const t = new RenderTarget(width, height, float ? { type: FloatType, depthBuffer: true } : { depthBuffer: true, samples });
  t.texture.minFilter = float ? NearestFilter : LinearFilter;
  t.texture.magFilter = float ? NearestFilter : LinearFilter;
  t.texture.generateMipmaps = false;
  return t;
}

class WebGpuPasses implements G3PassSet {
  readonly probe = newProbe("webgpu", "chase");
  private readonly fpv = new FpvCamera(LENS, 16, 9);
  private readonly video = new AnalogVideo(DEFAULT_VIDEO_NOISE);
  private color = target(16, 9);
  private fisheye = target(16, 9);
  private analog = target(16, 9);
  private readonly gbuffer = target(PROFILE.resolution[0] * THERMAL_SUPERSAMPLE, PROFILE.resolution[1] * THERMAL_SUPERSAMPLE, true);
  private readonly fisheyeNode: FisheyeNodeMaterial;
  private readonly analogNode: AnalogNodeMaterial;
  private readonly thermal: ThermalCameraNodePass;
  private readonly thermalState: ThermalSceneState<ThermalGBufferNode>;
  private readonly fisheyeQuad: QuadMesh;
  private readonly analogQuad: QuadMesh;
  private readonly presentQuad: QuadMesh;
  private readonly presentMaterial = new NodeMaterial();
  private readonly presentScale = uniform(1);
  private readonly bufferSize = new Vector2();
  private width = 0;
  private height = 0;
  private frame = 0;
  private deviceErrors = 0;
  private disposed = false;
  private readonly timer: WebGpuPassTimer | null;
  private readonly onDeviceError = (event: Event) => {
    this.deviceErrors += 1;
    if (this.deviceErrors === 1) console.error("G3 WebGPU device error", event instanceof GPUUncapturedErrorEvent ? event.error.message : event.type);
  };

  constructor(private readonly renderer: WebGPURenderer, location: ThermalLocation) {
    this.fisheyeNode = new FisheyeNodeMaterial(this.fpv.params, this.color.texture);
    this.analogNode = new AnalogNodeMaterial(this.video, this.fisheye.texture);
    this.fisheyeQuad = new QuadMesh(this.fisheyeNode.material);
    this.analogQuad = new QuadMesh(this.analogNode.material);
    this.thermal = new ThermalCameraNodePass(PROFILE, this.gbuffer.texture, THERMAL_SUPERSAMPLE);
    this.thermalState = new ThermalSceneState(location, this.thermal, (area, drape) => new ThermalGBufferNode(area, drape), this.probe);
    // Pillarboxed thermal image: x is rescaled about the centre; outside the sensor image is black.
    const thermalImage = texture(this.thermal.target.texture);
    const scale = this.presentScale;
    this.presentMaterial.fragmentNode = Fn(() => {
      const st = uv();
      const x = st.x.sub(0.5).div(scale).add(0.5);
      const inside = x.greaterThanEqual(0).and(x.lessThanEqual(1));
      return select(inside, thermalImage.sample(vec2(x.clamp(0, 1), st.y)), vec4(0, 0, 0, 1));
    })();
    this.presentQuad = new QuadMesh(this.presentMaterial);
    const device = rendererDevice(renderer);
    device?.addEventListener("uncapturederror", this.onDeviceError);
    this.timer = PROFILE_PASSES && device ? WebGpuPassTimer.create(device, renderer.backend) : null;
    if (this.timer) {
      Reflect.set(this.probe, "passMs", this.timer.meanMs);
      Reflect.set(this.probe, "passLog", this.timer.log);
    }
    publish(renderer.domElement, this.probe);
  }

  private ensureSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    // New targets rather than setSize(): resizing recreates the GPU texture under bind groups that
    // still reference the old one (invalid command buffers after the capture goes fullscreen).
    const old = [this.color, this.fisheye, this.analog];
    this.color = target(width, height, false, 4);
    this.fisheye = target(width, height);
    this.analog = target(width, height);
    this.fisheyeNode.setSource(this.color.texture);
    this.analogNode.setSource(this.fisheye.texture);
    for (const t of old) t.dispose();
    this.presentScale.value = sensorPillarbox(width, height);
    this.fpv.resize(width, height);
    this.fisheyeNode.update(this.fpv.params);
  }

  setDrape(drape: MaterialDrape | null): void {
    if (!this.disposed) this.thermalState.setDrape(drape);
  }

  render(scene: Scene, chase: Camera, view: G3View, pose: Parameters<FpvCamera["update"]>[0], tiles: readonly TilesScene[], video: VideoInput): void {
    if (this.disposed) return;
    const r = this.renderer;
    r.setPixelRatio(1);
    r.getDrawingBufferSize(this.bufferSize);
    const width = this.bufferSize.x, height = this.bufferSize.y;
    if (width < 2 || height < 2) return;
    this.ensureSize(width, height);
    this.fpv.update(pose);
    for (const source of tiles) {
      source.tiles.setCamera(this.fpv.camera);
      source.tiles.setResolution(this.fpv.camera, this.bufferSize);
      source.update();
    }
    const timer = this.timer;
    const begin = (pass: G3Pass) => timer?.begin(pass);
    const end = () => timer?.end();
    if (!SKIP_FPV) {
      r.setRenderTarget(this.color);
      begin("fpvScene"); void r.render(scene, this.fpv.camera); end();
      r.setRenderTarget(this.fisheye);
      begin("fisheye"); this.fisheyeQuad.render(r); end();
      if (this.video.updateFrom(video)) this.analogNode.updateFrom(this.video);
      r.setRenderTarget(view === "fpv" ? null : this.analog);
      begin("analog"); this.analogQuad.render(r); end();
    }
    if (view === "chase") {
      r.setRenderTarget(null);
      begin("chaseScene"); void r.render(scene, chase); end();
    }
    const state = this.thermalState;
    if (!SKIP_THERMAL && state.step()) {
      state.aimFrom(this.fpv.camera);
      const previousOverride = scene.overrideMaterial, previousBackground = scene.background, previousAlpha = r.getClearAlpha();
      scene.overrideMaterial = state.gbuffer.material;
      scene.background = null; // cleared texels (alpha 0) are sky
      r.setClearAlpha(0);
      r.setRenderTarget(this.gbuffer);
      begin("gbuffer"); void r.render(scene, state.camera); end();
      r.setClearAlpha(previousAlpha);
      scene.background = previousBackground;
      scene.overrideMaterial = previousOverride;
      this.frame = (this.frame + 1) >>> 0;
      this.thermal.setFrameSeed(this.frame);
      begin("thermal"); this.thermal.render(r); end();
    }
    if (view === "thermal") {
      r.setRenderTarget(null);
      begin("present"); this.presentQuad.render(r); end();
    }
    timer?.endFrame();
    const bytes = residentBytes(tiles);
    const probe = this.probe;
    probe.gpuBytes = bytes;
    probe.cpuBytes = bytes;
    probe.terrain = bytes >= 1;
    probe.fpv = this.deviceErrors === 0 && !SKIP_FPV;
    probe.thermal = this.deviceErrors === 0 && !SKIP_THERMAL; // rgba32float is renderable in core WebGPU
    probe.dpr = r.getPixelRatio();
    probe.width = width;
    probe.height = height;
    probe.view = view;
    probe.frames += 1;
    probe.reason = SKIPPED ? `Passes skipped by ?g3skip (diagnostics): ${SKIPPED}`
      : this.deviceErrors !== 0 ? "WebGPU device reported an error" : probe.terrain ? "" : "Terrain tiles are not resident";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    rendererDevice(this.renderer)?.removeEventListener("uncapturederror", this.onDeviceError);
    this.timer?.dispose();
    this.color.dispose(); this.fisheye.dispose(); this.analog.dispose(); this.gbuffer.dispose();
    this.fisheyeNode.dispose(); this.analogNode.dispose(); this.thermal.dispose(); this.thermalState.gbuffer.dispose(); this.presentMaterial.dispose();
    this.probe.fpv = false;
    this.probe.thermal = false;
    this.probe.reason = "disposed";
  }
}

/** The WebGPU pass set, or null when `gl` is not an initialized WebGPURenderer. */
export function createWebGpuPasses(gl: WebGLRenderer | WebGPURenderer, location: ThermalLocation): G3PassSet | null {
  return gl instanceof WebGPURenderer ? new WebGpuPasses(gl, location) : null;
}
