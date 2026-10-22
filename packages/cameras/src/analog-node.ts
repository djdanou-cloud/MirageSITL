// WebGPU (TSL node material) port of shaders/analog.glsl (TASK-073 P6):
// per-pixel noise, scanlines, line tearing and rolling-shutter jelly with the
// same lowbias32 integer hash. The image for a seed and video frame is fixed
// on a backend; the per-pixel noise is keyed to the pixel position, whose
// origin differs between backends (WebGPU counts rows from the top), so only
// noise statistics, not noise bytes, are comparable with WebGL2. updateFrom()
// copies AnalogVideo's uniforms once per video frame.
import type { Texture } from "three";
import { NodeMaterial } from "three/webgpu";
import { Fn, clamp, cos, float, floor, min, screenCoordinate, select, sin, texture, uint, uniform, uv, vec2, vec4 } from "three/tsl";
import type { AnalogVideo } from "./analog.ts";

type UintNode = ReturnType<typeof uint>;

/** lowbias32 (Wellons), identical to hash() in analog.glsl and hash32() in analog.ts. */
function hash(x: UintNode): UintNode {
  const a = x.bitXor(x.shiftRight(16)).mul(uint(0x7feb352d));
  const b = a.bitXor(a.shiftRight(15)).mul(uint(0x846ca68b));
  return b.bitXor(b.shiftRight(16));
}
const unit = (h: UintNode) => float(h.shiftRight(8)).mul(1 / 16777216);
const TWO_PI = 6.28318530718;

export class AnalogNodeMaterial {
  readonly material = new NodeMaterial();
  private readonly source;
  private readonly u = {
    seed: uniform(0, "uint"), noise: uniform(0), scanline: uniform(0), lines: uniform(480), jellyAmpUv: uniform(0), vibFreqHz: uniform(0),
    frameStartS: uniform(0), lineTimeS: uniform(0), tearProb: uniform(0), tearAmpUv: uniform(0), phase: uniform(0),
  };

  constructor(video: AnalogVideo, source: Texture) {
    this.source = texture(source);
    const u = this.u;
    const shade = Fn(() => {
      const st = uv();
      // Lines are read out top to bottom; each line is exposed lineTimeS later.
      const line = min(floor(float(1).sub(st.y).mul(u.lines)), u.lines.sub(1));
      const t = u.frameStartS.add(line.mul(u.lineTimeS));
      const jelly = u.jellyAmpUv.mul(sin(u.vibFreqHz.mul(TWO_PI).mul(t).add(u.phase)));
      const seed = uint(u.seed);
      const lineHash = hash(uint(line).bitXor(hash(seed)));
      const tear = select(unit(lineHash).lessThan(u.tearProb), unit(hash(lineHash)).sub(0.5).mul(2).mul(u.tearAmpUv), float(0));
      const c = this.source.sample(vec2(st.x.add(jelly).add(tear), st.y));
      const px = uint(screenCoordinate.x), py = uint(screenCoordinate.y);
      const n = unit(hash(px.mul(uint(0x9e3779b9)).bitXor(hash(py.bitXor(seed))))).sub(0.5).mul(2).mul(u.noise);
      const scan = float(1).sub(u.scanline.mul(float(0.5).add(cos(st.y.mul(u.lines).mul(TWO_PI)).mul(0.5))));
      return vec4(clamp(c.rgb.mul(scan).add(n), 0, 1), c.a);
    });
    this.material.fragmentNode = shade();
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.name = "fpv-analog-node";
    this.updateFrom(video);
  }

  setSource(source: Texture): void { this.source.value = source; }

  /** Copies the current video-frame uniforms (call after AnalogVideo.updateFrom returned true). */
  updateFrom(video: AnalogVideo): void {
    const s = video.uniforms, u = this.u;
    u.seed.value = s.uFrameSeed.value; u.noise.value = s.uNoise.value; u.scanline.value = s.uScanline.value; u.lines.value = s.uLines.value;
    u.jellyAmpUv.value = s.uJellyAmpUv.value; u.vibFreqHz.value = s.uVibFreqHz.value; u.frameStartS.value = s.uFrameStartS.value;
    u.lineTimeS.value = s.uLineTimeS.value; u.tearProb.value = s.uTearProb.value; u.tearAmpUv.value = s.uTearAmpUv.value; u.phase.value = s.uPhase.value;
  }

  dispose(): void { this.material.dispose(); }
}
