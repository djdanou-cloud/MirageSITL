// WebGL2 pass for shaders/thermal.glsl (TASK-071): renders a G-buffer
// (temperature, emissivity, distance) into a render target at the
// instrument's native resolution. Scalar uniforms are class instances so
// per-frame updates do not allocate (see ScalarUniform in @mirage/cameras).
// TASK-073 P5 adds the sky temperature and the fixed-pattern-noise textures
// (residual o - bias and drift gain, see fpn.ts).
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
  private readonly u: Record<"uReflectedK" | "uAirK" | "uExtinction" | "uSpanMinK" | "uSpanMaxK" | "uPalette" | "uNetdK" | "uFrameSeed" | "uSkyK" | "uFpn" | "uFpnDriftK", Scalar>;
  private fpnResidual: DataTexture | null = null;
  private fpnGain: DataTexture | null = null;

  /**
   * `supersample` S: the G-buffer is S times the sensor resolution and each sensor pixel averages the
   * radiance of its S x S subsamples (detector-area integration); 1 is a point sample.
   */
  constructor(readonly profile: InstrumentProfile, gBuffer: Texture | null, readonly supersample = 1) {
    validateProfile(profile);
    if (!Number.isInteger(supersample) || supersample < 1 || supersample > 4) throw new Error("Supersample factor must be 1-4");
    const t = radianceTable(profile.spectralBandUm);
    this.table = new DataTexture(t.values, t.values.length, 1, RedFormat, FloatType);
    this.table.minFilter = NearestFilter; this.table.magFilter = NearestFilter; this.table.generateMipmaps = false; this.table.needsUpdate = true;
    const [w, h] = profile.resolution;
    this.target = new WebGLRenderTarget(w, h); // native sensor resolution; display scaling happens later
    this.u = { uReflectedK: new Scalar(250), uAirK: new Scalar(288), uExtinction: new Scalar(0), uSpanMinK: new Scalar(270), uSpanMaxK: new Scalar(320),
      uPalette: new Scalar(0), uNetdK: new Scalar(profile.netdK), uFrameSeed: new Scalar(0), uSkyK: new Scalar(250), uFpn: new Scalar(0), uFpnDriftK: new Scalar(0) };
    this.material = new ShaderMaterial({
      name: "thermal-camera", glslVersion: GLSL3, vertexShader: VERTEX, fragmentShader: thermalFragment, depthTest: false, depthWrite: false,
      defines: { SUPERSAMPLE: supersample },
      uniforms: { ...this.u, uGBuffer: { value: gBuffer }, uTable: { value: this.table }, uTableMinK: { value: t.minK }, uTableCount: { value: t.values.length },
        uFpnResidual: { value: null }, uFpnGain: { value: null } },
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

  /** Binds per-pixel residual (o - bias) and drift gain arrays at the native resolution (configuration path). */
  setFixedPattern(residualK: Float32Array, gainKPerK: Float32Array): void {
    const [w, h] = this.profile.resolution;
    if (residualK.length !== w * h || gainKPerK.length !== w * h) throw new Error("Fixed pattern does not match the sensor resolution");
    this.fpnResidual?.dispose(); this.fpnGain?.dispose();
    this.fpnResidual = sensorTexture(residualK, w, h);
    this.fpnGain = sensorTexture(gainKPerK, w, h);
    const uniforms = this.material.uniforms;
    if (uniforms.uFpnResidual) uniforms.uFpnResidual.value = this.fpnResidual;
    if (uniforms.uFpnGain) uniforms.uFpnGain.value = this.fpnGain;
    this.u.uFpn.value = 1;
  }

  /** Re-uploads the residual after a shutter cycle changed its array in place. */
  residualChanged(): void { if (this.fpnResidual) this.fpnResidual.needsUpdate = true; }

  /** Per sensor frame: focal-plane drift scale s(t), K (allocation-free). */
  setDriftK(driftK: number): void { this.u.uFpnDriftK.value = driftK; }

  /** Sky brightness temperature for G-buffer texels without geometry, K. */
  setSkyK(skyK: number): void { if (skyK > 0) this.u.uSkyK.value = skyK; }

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
    this.fpnResidual?.dispose(); this.fpnGain?.dispose();
  }
}

function sensorTexture(values: Float32Array, width: number, height: number): DataTexture {
  const texture = new DataTexture(values, width, height, RedFormat, FloatType);
  texture.minFilter = NearestFilter; texture.magFilter = NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}
