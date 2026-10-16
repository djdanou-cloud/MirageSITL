// WebGL2 pass for shaders/thermal.glsl (TASK-071): renders a G-buffer
// (temperature, emissivity, distance) into a render target at the
// instrument's native resolution. Scalar uniforms are class instances so
// per-frame updates do not allocate (see ScalarUniform in @mirage/cameras).
import {
  DataTexture, FloatType, GLSL3, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RedFormat, Scene, ShaderMaterial,
  WebGLRenderTarget, type Texture, type WebGLRenderer,
} from "three";
import thermalFragment from "./shaders/thermal.glsl?raw";
import { paletteIndex, radianceTable, validateProfile, type InstrumentProfile, type ThermalPalette, type ThermalScene } from "./thermal-camera.ts";

class Scalar { value = 0.5; constructor(v: number) { this.value = v; } }
const VERTEX = "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export class ThermalCameraPass {
  readonly target: WebGLRenderTarget;
  readonly material: ShaderMaterial;
  private readonly table: DataTexture;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: Mesh;
  private readonly u: Record<"uReflectedK" | "uAirK" | "uExtinction" | "uSpanMinK" | "uSpanMaxK" | "uPalette" | "uNetdK" | "uFrameSeed", Scalar>;

  constructor(readonly profile: InstrumentProfile, gBuffer: Texture | null) {
    validateProfile(profile);
    const t = radianceTable(profile.spectralBandUm);
    this.table = new DataTexture(t.values, t.values.length, 1, RedFormat, FloatType);
    this.table.minFilter = NearestFilter; this.table.magFilter = NearestFilter; this.table.generateMipmaps = false; this.table.needsUpdate = true;
    const [w, h] = profile.resolution;
    this.target = new WebGLRenderTarget(w, h); // native sensor resolution; display scaling happens later
    this.u = { uReflectedK: new Scalar(250), uAirK: new Scalar(288), uExtinction: new Scalar(0), uSpanMinK: new Scalar(270), uSpanMaxK: new Scalar(320),
      uPalette: new Scalar(0), uNetdK: new Scalar(profile.netdK), uFrameSeed: new Scalar(0) };
    this.material = new ShaderMaterial({
      name: "thermal-camera", glslVersion: GLSL3, vertexShader: VERTEX, fragmentShader: thermalFragment, depthTest: false, depthWrite: false,
      uniforms: { ...this.u, uGBuffer: { value: gBuffer }, uTable: { value: this.table }, uTableMinK: { value: t.minK }, uTableCount: { value: t.values.length } },
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Scene/display settings (configuration path). */
  configure(scene: ThermalScene, palette: ThermalPalette, noise: boolean): void {
    if (!(scene.spanMaxK > scene.spanMinK && scene.extinctionPerM >= 0 && scene.airK > 150 && scene.reflectedK > 0)) throw new Error("Invalid thermal scene");
    this.u.uReflectedK.value = scene.reflectedK; this.u.uAirK.value = scene.airK; this.u.uExtinction.value = scene.extinctionPerM;
    this.u.uSpanMinK.value = scene.spanMinK; this.u.uSpanMaxK.value = scene.spanMaxK;
    this.u.uPalette.value = paletteIndex(palette);
    this.u.uNetdK.value = noise ? this.profile.netdK : 0;
  }

  /** Per sensor frame: noise seed only (allocation-free). */
  setFrameSeed(seed: number): void { this.u.uFrameSeed.value = seed >>> 0; }

  render(renderer: WebGLRenderer): void {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
  }

  dispose(): void {
    this.material.dispose(); this.quad.geometry.dispose(); this.table.dispose(); this.target.dispose();
  }
}
