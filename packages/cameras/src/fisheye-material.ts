// three.js material for shaders/fisheye.glsl (TASK-067): a full-screen remap
// of the pinhole source render. Uniform objects are created once; update()
// writes new values in place (resize path, not per frame).
import { ShaderMaterial, Vector2, Vector4, type Texture } from "three";
import fisheyeFragment from "./shaders/fisheye.glsl?raw";
import type { FisheyeParams } from "./fisheye.ts";

const VERTEX = "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export function createFisheyeMaterial(params: FisheyeParams, source: Texture | null): ShaderMaterial {
  const material = new ShaderMaterial({
    name: "fpv-fisheye",
    vertexShader: VERTEX,
    fragmentShader: fisheyeFragment,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSource: { value: source }, uModel: { value: 0 }, uOutCenter: { value: new Vector2() }, uOutFocal: { value: new Vector2() },
      uSrcCenter: { value: new Vector2() }, uSrcFocal: { value: new Vector2() }, uK: { value: new Vector4() }, uMaxTheta: { value: 0 },
    },
  });
  updateFisheyeMaterial(material, params);
  return material;
}

export function updateFisheyeMaterial(material: ShaderMaterial, params: FisheyeParams): void {
  const u = material.uniforms;
  const set2 = (name: string, value: readonly [number, number]) => { const v: unknown = u[name]?.value; if (v instanceof Vector2) v.set(value[0], value[1]); };
  if (u.uModel) u.uModel.value = params.model;
  if (u.uMaxTheta) u.uMaxTheta.value = params.maxTheta;
  set2("uOutCenter", params.outCenter); set2("uOutFocal", params.outFocal); set2("uSrcCenter", params.srcCenter); set2("uSrcFocal", params.srcFocal);
  const k: unknown = u.uK?.value;
  if (k instanceof Vector4) k.set(params.k[0], params.k[1], params.k[2], params.k[3]);
}
