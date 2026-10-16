// three.js material for shaders/analog.glsl (TASK-068). The material shares
// AnalogVideo's uniform objects, so AnalogVideo.updateFrom() is the only
// per-frame work and nothing is allocated per frame.
import { GLSL3, ShaderMaterial, type Texture } from "three";
import analogFragment from "./shaders/analog.glsl?raw";
import type { AnalogVideo } from "./analog.ts";

const VERTEX = "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export function createAnalogMaterial(video: AnalogVideo, source: Texture | null): ShaderMaterial {
  return new ShaderMaterial({
    name: "fpv-analog",
    glslVersion: GLSL3,
    vertexShader: VERTEX,
    fragmentShader: analogFragment,
    depthTest: false,
    depthWrite: false,
    uniforms: { ...video.uniforms, uSource: { value: source } },
  });
}
