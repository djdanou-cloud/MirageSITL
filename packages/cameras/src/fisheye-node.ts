// WebGPU (TSL node material) port of shaders/fisheye.glsl (TASK-073 P6).
// Same Kannala-Brandt remap as the GLSL and as fisheyeSourceUvInto in
// fisheye.ts: output uv -> distorted radius r_d -> Newton inverse for the
// incidence angle theta -> pinhole radius tan(theta) -> source uv. Pixels
// outside the lens image circle or the source frame are black. Uniforms are
// node uniforms updated in place by update() (resize path, not per frame).
import { Vector2, Vector4, type Texture } from "three";
import { NodeMaterial } from "three/webgpu";
import { Fn, Loop, abs, clamp, float, length, select, tan, texture, uniform, uv, vec4 } from "three/tsl";
import type { FisheyeParams } from "./fisheye.ts";

export class FisheyeNodeMaterial {
  readonly material = new NodeMaterial();
  private readonly model = uniform(0);
  private readonly outCenter = uniform(new Vector2());
  private readonly outFocal = uniform(new Vector2());
  private readonly srcCenter = uniform(new Vector2());
  private readonly srcFocal = uniform(new Vector2());
  private readonly k = uniform(new Vector4());
  private readonly maxTheta = uniform(0);
  private readonly source;

  constructor(params: FisheyeParams, source: Texture) {
    this.source = texture(source);
    const k = this.k;
    const thetaD = (t: ReturnType<typeof float>) => {
      const t2 = t.mul(t);
      return t.mul(float(1).add(t2.mul(k.x.add(t2.mul(k.y.add(t2.mul(k.z.add(t2.mul(k.w)))))))));
    };
    const thetaDPrime = (t: ReturnType<typeof float>) => {
      const t2 = t.mul(t);
      return float(1).add(t2.mul(k.x.mul(3).add(t2.mul(k.y.mul(5).add(t2.mul(k.z.mul(7).add(t2.mul(k.w.mul(9)))))))));
    };
    const remap = Fn(() => {
      const st = uv();
      const md = st.sub(this.outCenter).div(this.outFocal);
      const rd = length(md);
      const theta = float(rd).toVar();
      Loop(10, () => {
        theta.assign(clamp(theta.sub(thetaD(theta).sub(rd).div(thetaDPrime(theta))), 0, this.maxTheta));
      });
      const src = this.srcCenter.add(md.mul(tan(theta).div(rd.max(1e-12))).mul(this.srcFocal));
      const inCircle = abs(thetaD(theta).sub(rd)).lessThanEqual(1e-4);
      const inFrame = src.x.greaterThanEqual(0).and(src.y.greaterThanEqual(0)).and(src.x.lessThanEqual(1)).and(src.y.lessThanEqual(1));
      // All samples are taken unconditionally: WGSL needs uniform control flow around implicit-derivative sampling.
      const identity = this.source.sample(st);
      const centre = this.source.sample(this.srcCenter);
      const remapped = this.source.sample(src);
      const black = vec4(0, 0, 0, 1);
      return select(this.model.lessThan(0.5), identity,
        select(rd.lessThanEqual(0), centre, select(inCircle.and(inFrame), remapped, black)));
    });
    this.material.fragmentNode = remap();
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.name = "fpv-fisheye-node";
    this.update(params);
  }

  setSource(source: Texture): void { this.source.value = source; }

  update(params: FisheyeParams): void {
    this.model.value = params.model;
    this.maxTheta.value = params.maxTheta;
    this.outCenter.value.set(params.outCenter[0], params.outCenter[1]);
    this.outFocal.value.set(params.outFocal[0], params.outFocal[1]);
    this.srcCenter.value.set(params.srcCenter[0], params.srcCenter[1]);
    this.srcFocal.value.set(params.srcFocal[0], params.srcFocal[1]);
    this.k.value.set(params.k[0], params.k[1], params.k[2], params.k[3]);
  }

  dispose(): void { this.material.dispose(); }
}
