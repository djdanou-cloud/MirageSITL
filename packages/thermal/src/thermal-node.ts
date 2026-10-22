// WebGPU (TSL node material) port of the thermal camera pass (TASK-073 P6):
// the same chain as shaders/thermal.glsl and apparentLevel() in
// thermal-camera.ts, with the TASK-073 P5 sky and fixed-pattern-noise terms.
// G-buffer texel: r = temperature K, g = emissivity, b = distance m, a = 1
// for geometry (a = 0 is open sky). Float textures are read with textureLoad
// (sampling float32 needs an optional WebGPU feature); the G-buffer and the
// output share the sensor resolution, so texel = output pixel. WebGPU counts
// pixel rows from the top: the fixed pattern is mirrored vertically relative
// to the WebGL2 pass, which does not matter for a generated pattern.
import { DataTexture, FloatType, NearestFilter, RedFormat, RenderTarget, type Texture } from "three";
import { NodeMaterial, QuadMesh, type WebGPURenderer } from "three/webgpu";
import { Fn, clamp, exp, float, floor, ivec2, max, min, mix, screenCoordinate, select, texture, uint, uniform, vec3, vec4 } from "three/tsl";
import { paletteIndex, radianceTable, validateProfile, type InstrumentProfile, type ThermalPalette, type ThermalScene } from "./thermal-camera.ts";

type UintNode = ReturnType<typeof uint>;
type FloatNode = ReturnType<typeof float>;
function hash(x: UintNode): UintNode {
  const a = x.bitXor(x.shiftRight(16)).mul(uint(0x7feb352d));
  const b = a.bitXor(a.shiftRight(15)).mul(uint(0x846ca68b));
  return b.bitXor(b.shiftRight(16));
}

function floatTexture(values: Float32Array, width: number, height: number): DataTexture {
  const t = new DataTexture(values, width, height, RedFormat, FloatType);
  t.minFilter = NearestFilter; t.magFilter = NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

export class ThermalCameraNodePass {
  readonly target: RenderTarget;
  readonly material = new NodeMaterial();
  private readonly quad: QuadMesh;
  private readonly table: DataTexture;
  private readonly gBuffer;
  private fpnResidual: DataTexture;
  private fpnGain: DataTexture;
  private readonly residualNode;
  private readonly gainNode;
  private readonly u = {
    reflectedK: uniform(250), airK: uniform(288), extinction: uniform(0), spanMinK: uniform(270), spanMaxK: uniform(320), palette: uniform(0),
    netdK: uniform(0.05), frameSeed: uniform(0, "uint"), skyK: uniform(250), fpn: uniform(0), fpnDriftK: uniform(0),
  };

  /** `supersample` S as in ThermalCameraPass: S x S G-buffer subsamples averaged in radiance per sensor pixel. */
  constructor(readonly profile: InstrumentProfile, gBuffer: Texture, readonly supersample = 1) {
    validateProfile(profile);
    if (!Number.isInteger(supersample) || supersample < 1 || supersample > 4) throw new Error("Supersample factor must be 1-4");
    const t = radianceTable(profile.spectralBandUm);
    this.table = floatTexture(t.values, t.values.length, 1);
    const [w, h] = profile.resolution;
    this.target = new RenderTarget(w, h, { depthBuffer: false });
    this.u.netdK.value = profile.netdK;
    // Placeholders until setFixedPattern(): zero residual and gain (uFpn = 0 also disables the term).
    this.fpnResidual = floatTexture(new Float32Array(w * h), w, h);
    this.fpnGain = floatTexture(new Float32Array(w * h), w, h);
    this.gBuffer = texture(gBuffer);
    this.residualNode = texture(this.fpnResidual);
    this.gainNode = texture(this.fpnGain);
    const tableNode = texture(this.table);
    const u = this.u, tableMinK = t.minK, tableCount = t.values.length;
    const radiance = (tK: FloatNode) => {
      const x = clamp(tK.sub(tableMinK), 0, tableCount - 1);
      const i = min(floor(x), tableCount - 2);
      const f = x.sub(i);
      const a = tableNode.load(ivec2(i, 0)).x, b = tableNode.load(ivec2(i.add(1), 0)).x;
      return a.mul(float(1).sub(f)).add(b.mul(f));
    };
    const ironbow = (x: FloatNode) => {
      // Control points as in IRONBOW (thermal-camera.ts): black -> purple -> red -> orange -> yellow -> white.
      const seg = (x0: number, x1: number, c0: [number, number, number], c1: [number, number, number]) =>
        mix(vec3(...c0), vec3(...c1), clamp(x.sub(x0).div(x1 - x0), 0, 1));
      return select(x.lessThanEqual(0.25), seg(0, 0.25, [0, 0, 0], [0.35, 0, 0.55]),
        select(x.lessThanEqual(0.5), seg(0.25, 0.5, [0.35, 0, 0.55], [0.8, 0.1, 0.25]),
          select(x.lessThanEqual(0.7), seg(0.5, 0.7, [0.8, 0.1, 0.25], [1, 0.5, 0]),
            select(x.lessThanEqual(0.88), seg(0.7, 0.88, [1, 0.5, 0], [1, 0.85, 0.15]), seg(0.88, 1, [1, 0.85, 0.15], [1, 1, 1])))));
    };
    const shade = Fn(() => {
      const p = ivec2(screenCoordinate.xy);
      // Per-detector offset (fixed pattern + NETD), K, applied to every subsample.
      const dt = select(u.fpn.greaterThan(0.5), this.residualNode.load(p).x.add(this.gainNode.load(p).x.mul(u.fpnDriftK)), float(0)).toVar();
      const px = uint(screenCoordinate.x), py = uint(screenCoordinate.y), seed = uint(u.frameSeed);
      dt.addAssign(float(hash(px.mul(uint(0x9e3779b9)).bitXor(hash(py.bitXor(seed)))).shiftRight(8)).mul(1 / 16777216).sub(0.5).mul(2).mul(u.netdK));
      const reflected = radiance(float(u.reflectedK)), air = radiance(float(u.airK));
      const S = this.supersample;
      const sum = float(0).toVar();
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          const g = this.gBuffer.load(p.mul(S).add(ivec2(i, j)));
          const sky = g.w.lessThan(0.5);
          const t = select(sky, u.skyK, g.x).add(dt);
          const tau = select(sky, float(1), exp(u.extinction.negate().mul(max(g.z, 0))));
          const eps = select(sky, float(1), g.y);
          sum.addAssign(tau.mul(eps.mul(radiance(t)).add(float(1).sub(eps).mul(reflected))).add(float(1).sub(tau).mul(air)));
        }
      }
      const l = sum.div(S * S);
      const lo = radiance(float(u.spanMinK)), hi = radiance(float(u.spanMaxK));
      const level = clamp(l.sub(lo).div(hi.sub(lo)), 0, 1);
      const grey = vec3(level, level, level), inverted = vec3(float(1).sub(level), float(1).sub(level), float(1).sub(level));
      const colour = select(u.palette.lessThan(0.5), grey, select(u.palette.lessThan(1.5), inverted, ironbow(level)));
      return vec4(colour, 1);
    });
    this.material.fragmentNode = shade();
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.name = "thermal-camera-node";
    this.quad = new QuadMesh(this.material);
  }

  configure(scene: ThermalScene, palette: ThermalPalette, noise: boolean): void {
    if (!(scene.spanMaxK > scene.spanMinK && scene.extinctionPerM >= 0 && scene.airK > 150 && scene.reflectedK > 0)) throw new Error("Invalid thermal scene");
    const u = this.u;
    u.reflectedK.value = scene.reflectedK; u.airK.value = scene.airK; u.extinction.value = scene.extinctionPerM;
    u.spanMinK.value = scene.spanMinK; u.spanMaxK.value = scene.spanMaxK;
    u.palette.value = paletteIndex(palette);
    u.netdK.value = noise ? this.profile.netdK : 0;
  }

  setGBuffer(gBuffer: Texture): void { this.gBuffer.value = gBuffer; }

  setFixedPattern(residualK: Float32Array, gainKPerK: Float32Array): void {
    const [w, h] = this.profile.resolution;
    if (residualK.length !== w * h || gainKPerK.length !== w * h) throw new Error("Fixed pattern does not match the sensor resolution");
    this.fpnResidual.dispose(); this.fpnGain.dispose();
    this.fpnResidual = floatTexture(residualK, w, h);
    this.fpnGain = floatTexture(gainKPerK, w, h);
    this.residualNode.value = this.fpnResidual;
    this.gainNode.value = this.fpnGain;
    this.u.fpn.value = 1;
  }

  residualChanged(): void { this.fpnResidual.needsUpdate = true; }
  setDriftK(driftK: number): void { this.u.fpnDriftK.value = driftK; }
  setSkyK(skyK: number): void { if (skyK > 0) this.u.skyK.value = skyK; }
  setFrameSeed(seed: number): void { this.u.frameSeed.value = seed >>> 0; }

  render(renderer: WebGPURenderer): void {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(previous);
  }

  dispose(): void {
    this.material.dispose(); this.table.dispose(); this.target.dispose(); this.fpnResidual.dispose(); this.fpnGain.dispose();
  }
}
