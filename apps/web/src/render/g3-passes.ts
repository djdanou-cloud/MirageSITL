// TASK-073 production passes. They run only for `?g3=1` and only on WebGL2:
// a mounted FPV camera, fisheye remap, analog video, and a synthetic LWIR
// camera fed by a G-buffer rasterized from the same scene (including tiles).
// Residency is the tileset cache estimate, charged to both budgets the way
// TASK-062 charges it. WebGPU has no fisheye or thermal pass, so those flags
// stay false there. Nothing here writes physics, AAR, or React state.
import { useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  FloatType, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, Vector2,
  WebGLRenderTarget, WebGLRenderer, type Camera, type Texture,
} from "three";
import { AnalogVideo, DEFAULT_VIDEO_NOISE, type VideoInput } from "@mirage/cameras/analog";
import { createAnalogMaterial } from "@mirage/cameras/analog-material";
import { FpvCamera, type CameraConfig } from "@mirage/cameras/fpv-camera";
import { createFisheyeMaterial, updateFisheyeMaterial } from "@mirage/cameras/fisheye-material";
import { interpolationAlpha, interpolatePoseInto, newRenderPoseV2, wallNow } from "@mirage/protocol";
import type { TilesScene } from "@mirage/terrain/tiles-scene";
import { SYNTHETIC_LWIR_640, type ThermalScene } from "@mirage/thermal/thermal-camera";
import { ThermalCameraPass } from "@mirage/thermal/thermal-material";
import type { SimulationRuntime } from "../runtime";
import { g3ViewFromSearch, type G3View } from "./g3-mode";
import { BODY_NOSE_FORWARD_M, MODEL_HEIGHT_OFFSET_M } from "../vehicle-geometry";

const PROBE = "__mirageG3";
const GBUFFER_VERTEX = "varying vec3 vView;\nvoid main() {\n  vec4 view = modelViewMatrix * vec4(position, 1.0);\n  vView = view.xyz;\n  gl_Position = projectionMatrix * view;\n}\n";
const GBUFFER_FRAGMENT = "varying vec3 vView;\nvoid main() {\n  float distanceM = length(vView);\n  float temperatureK = 290.0 + 18.0 * clamp(1.0 - distanceM / 80.0, 0.0, 1.0);\n  gl_FragColor = vec4(temperatureK, 0.92, distanceM, 1.0);\n}\n";
const THERMAL_SCENE: ThermalScene = { reflectedK: 250, airK: 288, extinctionPerM: 0.0002, spanMinK: 270, spanMaxK: 320 };
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
}

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
  };
  private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fpv: FpvCamera;
  private readonly video: AnalogVideo;
  private readonly gbufferMaterial = new ShaderMaterial({ vertexShader: GBUFFER_VERTEX, fragmentShader: GBUFFER_FRAGMENT });
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

  constructor(private readonly renderer: WebGLRenderer) {
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
    this.thermal = new ThermalCameraPass(SYNTHETIC_LWIR_640, null);
    this.thermal.configure(THERMAL_SCENE, "white-hot", true);
    this.previousShaderError = renderer.debug.onShaderError;
    renderer.debug.onShaderError = () => { this.shaderErrors += 1; };
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
    this.gbuffer = floatTarget(SYNTHETIC_LWIR_640.resolution[0], SYNTHETIC_LWIR_640.resolution[1]);
    this.fpv.resize(width, height);
    updateFisheyeMaterial(this.fisheyeMaterial, this.fpv.params);
    bindSource(this.fisheyeMaterial, this.color.texture);
    bindSource(this.analogMaterial, this.fisheye.texture);
    const gbufferUniform = this.thermal.material.uniforms.uGBuffer;
    if (gbufferUniform) gbufferUniform.value = this.gbuffer.texture;
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
    const errorsBefore = this.shaderErrors;
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
      // Chase view: the FPV chain still runs to its own target, then the whole drone is presented.
      this.renderer.setRenderTarget(this.analog);
      this.renderer.render(this.analogScene, this.ortho);
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, chase);
    }
    const previousOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.gbufferMaterial;
    this.renderer.setRenderTarget(gbuffer);
    this.renderer.render(scene, this.fpv.camera);
    scene.overrideMaterial = previousOverride;
    this.frame = (this.frame + 1) >>> 0;
    this.thermal.setFrameSeed(this.frame);
    this.thermal.render(this.renderer);
    let bytes = 0;
    for (const source of tiles) if (source.modelCount > 0) bytes += source.cachedBytes;
    const probe = this.probe;
    probe.gpuBytes = bytes;
    probe.cpuBytes = bytes;
    probe.terrain = bytes >= 1;
    probe.fpv = this.shaderErrors === errorsBefore;
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
  };
  publish(canvas, probe);
  return probe;
}

const VIEW: G3View = g3ViewFromSearch(globalThis.location?.search ?? "");

export function G3Passes({ runtime, tiles }: { runtime: RefObject<SimulationRuntime | null>; tiles: RefObject<TilesScene[]> }) {
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
    const created = new ProductionPasses(gl);
    passes.current = created;
    return () => {
      created.dispose();
      passes.current = null;
      delete canvas.dataset.g3;
    };
  }, [gl]);
  useFrame(({ camera }) => {
    const pass = passes.current;
    const sim = runtime.current;
    if (!pass || !sim) return;
    const alpha = interpolationAlpha(wallNow(), sim.current, sim.header.physicsHz, sim.running);
    interpolatePoseInto(sim.previous, sim.current, sim.history, alpha, pose.current);
    video.current.timeS = wallNow() / 1000;
    pass.render(scene, camera, VIEW, pose.current, tiles.current, video.current);
  }, 1);
  return null;
}
