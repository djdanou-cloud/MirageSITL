// TASK-073 production passes for `?g3=1`: a mounted FPV camera, fisheye
// remap, analog video, and an LWIR camera (approximated FLIR Boson 640, 50 deg
// lens, TASK-073 P5) fed by a G-buffer rasterized from the same scene
// (including tiles): per-fragment material class and orientation select a
// TASK-070 heat-balance temperature, and the sensor chain adds generated
// fixed-pattern noise corrected by the TASK-072 shutter/NUC. The display holds
// its last image while the shutter is closed. This module is the WebGL2
// implementation; WebGPU uses the TSL ports in g3-passes-webgpu.ts (TASK-073
// P6), loaded only for that backend. Residency is the tileset cache estimate,
// charged to both budgets the way TASK-062 charges it. Nothing here writes
// physics, AAR, or React state.
import { useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  FloatType, LinearFilter, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, Vector2,
  WebGLRenderTarget, WebGLRenderer, type Camera, type Texture,
} from "three";
import { AnalogVideo, DEFAULT_VIDEO_NOISE, type VideoInput } from "@mirage/cameras/analog";
import { createAnalogMaterial } from "@mirage/cameras/analog-material";
import { FpvCamera } from "@mirage/cameras/fpv-camera";
import { createFisheyeMaterial, updateFisheyeMaterial } from "@mirage/cameras/fisheye-material";
import { interpolationAlpha, interpolatePoseInto, newRenderPoseV2, wallNow } from "@mirage/protocol";
import type { TilesScene } from "@mirage/terrain/tiles-scene";
import { ThermalCameraPass } from "@mirage/thermal/thermal-material";
import type { SimulationRuntime } from "../runtime";
import { LENS, PROFILE, THERMAL_SUPERSAMPLE, ThermalSceneState, newProbe, publish, residentBytes, sensorPillarbox, type G3PassSet, type ThermalLocation } from "./g3-common";
import { g3ViewFromSearch, type G3View } from "./g3-mode";
import type { MaterialDrape } from "./material-drape";
import { ThermalGBuffer } from "./thermal-gbuffer";
import { GpuPassTimer, type G3Pass } from "./gpu-pass-timer";

/** `?g3profile=1`: per-pass GPU timing published as probe.passMs (diagnostics only). */
const PROFILE_PASSES = new URLSearchParams(globalThis.location?.search ?? "").get("g3profile") === "1";

export type { G3Probe, ThermalLocation } from "./g3-common";

const PRESENT_VERTEX = "varying vec2 vUv;\nuniform vec2 uScale;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy * uScale, 0.0, 1.0); }\n";
const PRESENT_FRAGMENT = "varying vec2 vUv;\nuniform sampler2D uSource;\nvoid main() { gl_FragColor = texture2D(uSource, vUv); }\n";

/**
 * FPV chain targets: bilinear, so the fisheye remap and the analog line shifts interpolate; the
 * scene render is 4x multisampled (TASK-073: the point-sampled chain aliased).
 */
function colorTarget(width: number, height: number, samples = 0): WebGLRenderTarget {
  // Only colour is read downstream: resolving the multisampled depth/stencil too cost about 6 ms per
  // frame on an Intel iGPU (ANGLE/D3D11 resolves depth with a shader), for no visible change.
  const target = new WebGLRenderTarget(width, height, { depthBuffer: true, samples, resolveDepthBuffer: false, resolveStencilBuffer: false });
  target.texture.minFilter = LinearFilter;
  target.texture.magFilter = LinearFilter;
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

class ProductionPasses implements G3PassSet {
  readonly probe = newProbe("webgl2", "chase");
  private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fpv: FpvCamera;
  private readonly video: AnalogVideo;
  private readonly thermalState: ThermalSceneState<ThermalGBuffer>;
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
  private readonly timer: GpuPassTimer | null;

  constructor(private readonly renderer: WebGLRenderer, location: ThermalLocation) {
    const context = renderer.getContext();
    this.timer = PROFILE_PASSES && context instanceof WebGL2RenderingContext ? GpuPassTimer.create(context) : null;
    if (this.timer) Reflect.set(this.probe, "passMs", this.timer.meanMs);
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
    this.thermal = new ThermalCameraPass(PROFILE, null, THERMAL_SUPERSAMPLE);
    this.thermalState = new ThermalSceneState(location, this.thermal, (area, drape) => new ThermalGBuffer(area, drape), this.probe);
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
    this.color = colorTarget(width, height, 4);
    this.analog = colorTarget(width, height);
    this.fisheye = colorTarget(width, height);
    this.gbuffer = floatTarget(PROFILE.resolution[0] * THERMAL_SUPERSAMPLE, PROFILE.resolution[1] * THERMAL_SUPERSAMPLE);
    const scale: unknown = this.presentMaterial.uniforms.uScale?.value;
    if (scale instanceof Vector2) scale.set(sensorPillarbox(width, height), 1);
    this.fpv.resize(width, height);
    updateFisheyeMaterial(this.fisheyeMaterial, this.fpv.params);
    bindSource(this.fisheyeMaterial, this.color.texture);
    bindSource(this.analogMaterial, this.fisheye.texture);
    const gbufferUniform = this.thermal.material.uniforms.uGBuffer;
    if (gbufferUniform) gbufferUniform.value = this.gbuffer.texture;
  }

  setDrape(drape: MaterialDrape | null): void {
    if (!this.disposed) this.thermalState.setDrape(drape);
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
    // The scene is rendered up to three times per frame (FPV, chase, thermal G-buffer) and nothing moves in
    // between, so the shadow map is rendered once, by the first pass, instead of on every render() call.
    const shadowMap = this.renderer.shadowMap, shadowAuto = shadowMap.autoUpdate;
    shadowMap.autoUpdate = false;
    shadowMap.needsUpdate = shadowAuto;
    const timer = this.timer;
    const begin = (pass: G3Pass) => timer?.begin(pass);
    const end = () => timer?.end();
    this.renderer.setRenderTarget(color);
    begin("fpvScene"); this.renderer.render(scene, this.fpv.camera); end();
    this.renderer.setRenderTarget(fisheye);
    begin("fisheye"); this.renderer.render(this.fisheyeScene, this.ortho); end();
    this.video.updateFrom(video);
    if (view === "fpv") {
      this.renderer.setRenderTarget(null);
      begin("analog"); this.renderer.render(this.analogScene, this.ortho); end();
    } else {
      // Chase and thermal views: the FPV chain still runs to its own target.
      this.renderer.setRenderTarget(this.analog);
      begin("analog"); this.renderer.render(this.analogScene, this.ortho); end();
      if (view === "chase") {
        this.renderer.setRenderTarget(null);
        begin("chaseScene"); this.renderer.render(scene, chase); end();
      }
    }
    // The thermal camera is boresighted with the FPV mount; while the shutter is closed the last image is held.
    const state = this.thermalState;
    if (state.step()) {
      state.aimFrom(this.fpv.camera);
      const previousOverride = scene.overrideMaterial, previousBackground = scene.background, previousAlpha = this.renderer.getClearAlpha();
      scene.overrideMaterial = state.gbuffer.material;
      scene.background = null; // cleared texels (alpha 0) are sky
      this.renderer.setClearAlpha(0);
      this.renderer.setRenderTarget(gbuffer);
      begin("gbuffer"); this.renderer.render(scene, state.camera); end();
      this.renderer.setClearAlpha(previousAlpha);
      scene.background = previousBackground;
      scene.overrideMaterial = previousOverride;
      this.frame = (this.frame + 1) >>> 0;
      this.thermal.setFrameSeed(this.frame);
      begin("thermal"); this.thermal.render(this.renderer); end();
    }
    if (view === "thermal") {
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      begin("present"); this.renderer.render(this.presentScene, this.ortho); end();
    }
    shadowMap.autoUpdate = shadowAuto;
    timer?.poll();
    const bytes = residentBytes(tiles);
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
    probe.view = view;
    probe.frames += 1;
    probe.reason = !probe.fpv ? "FPV or thermal shader failed" : this.floatColor ? (probe.terrain ? "" : "Terrain tiles are not resident") : "EXT_color_buffer_float is unavailable";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.debug.onShaderError = this.previousShaderError;
    this.timer?.dispose();
    this.color?.dispose();
    this.fisheye?.dispose();
    this.analog?.dispose();
    this.gbuffer?.dispose();
    this.thermalState.gbuffer.dispose();
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

const VIEW: G3View = g3ViewFromSearch(globalThis.location?.search ?? "");

export function G3Passes({ runtime, tiles, drape, location }: { runtime: RefObject<SimulationRuntime | null>; tiles: RefObject<TilesScene[]>;
  drape: RefObject<MaterialDrape | null>; location: ThermalLocation }) {
  const { gl, scene } = useThree();
  const passes = useRef<G3PassSet | null>(null);
  const pose = useRef(newRenderPoseV2());
  const video = useRef({ timeS: 0, throttle: 0.35 });
  useEffect(() => {
    const canvas = gl.domElement;
    canvas.dataset.g3 = "1";
    let created: G3PassSet | null = null, cancelled = false;
    if (gl instanceof WebGLRenderer) {
      created = new ProductionPasses(gl, location);
      passes.current = created;
    } else {
      // WebGPU (TASK-073 P6): the TSL passes load only for this backend.
      publish(canvas, newProbe("webgpu", VIEW, "WebGPU passes are loading"));
      void import("./g3-passes-webgpu").then(({ createWebGpuPasses }) => {
        if (cancelled) return;
        created = createWebGpuPasses(gl, location);
        if (created) passes.current = created;
        else publish(canvas, newProbe("", VIEW, "Renderer is neither WebGL2 nor WebGPU"));
      });
    }
    return () => {
      cancelled = true;
      created?.dispose();
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
