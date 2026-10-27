// Thermal G-buffer (TASK-073 P5): each fragment's material class (from the P4
// raster, else the synthetic ground) and its surface orientation select a
// temperature from the AreaThermal table; emissivity comes from the class.
// Output texel: r = temperature K, g = emissivity, b = distance m, a = 1.
// Cleared texels keep a = 0 and are shown as sky by shaders/thermal.glsl.
//
// The surface normal is the flat face normal from screen-space derivatives
// of the world position, so it works for meshes without a normal attribute
// (the pg2b3dm buildings). Orientation weights are the squared positive ENU
// components over the five table rows (up, east, north, west, south);
// downward faces fall back to the mean of the walls.
import { DataTexture, FloatType, GLSL3, NearestFilter, RedFormat, ShaderMaterial, Vector4 } from "three";
import { ORIENTATIONS, TABLE_WIDTH, type AreaThermal } from "@mirage/thermal/area-thermal";
import type { MaterialDrape } from "./material-drape";

const VERTEX = `varying vec3 vView;
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 view = viewMatrix * world;
  vView = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

const FRAGMENT = `precision highp float;
varying vec3 vView;
varying vec3 vWorld;
uniform highp sampler2D uClasses;
uniform vec4 uExtent;          // west, south, east, north (render metres, north positive)
uniform int uHasClasses;
uniform float uDefaultClass;
uniform highp sampler2D uTemps; // 256 x 5, R = K
uniform highp sampler2D uEmis;  // 256 x 1, R = emissivity
layout(location = 0) out highp vec4 outGBuffer;
void main() {
  float cls = uDefaultClass;
  if (uHasClasses == 1) {
    // Render frame: x = east, z = -north. Texture row 0 is the north edge.
    vec2 uv = vec2((vWorld.x - uExtent.x) / (uExtent.z - uExtent.x), (uExtent.w + vWorld.z) / (uExtent.w - uExtent.y));
    if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) cls = floor(texture(uClasses, uv).r * 255.0 + 0.5);
  }
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 enu = vec3(n.x, -n.z, n.y);
  float wUp = max(enu.z, 0.0), wE = max(enu.x, 0.0), wN = max(enu.y, 0.0), wW = max(-enu.x, 0.0), wS = max(-enu.y, 0.0);
  wUp *= wUp; wE *= wE; wN *= wN; wW *= wW; wS *= wS;
  float sum = wUp + wE + wN + wW + wS;
  if (sum < 1e-3) { wE = 0.25; wN = 0.25; wW = 0.25; wS = 0.25; sum = 1.0; }
  int c = int(cls);
  float t = wUp * texelFetch(uTemps, ivec2(c, 0), 0).r + wE * texelFetch(uTemps, ivec2(c, 1), 0).r + wN * texelFetch(uTemps, ivec2(c, 2), 0).r +
            wW * texelFetch(uTemps, ivec2(c, 3), 0).r + wS * texelFetch(uTemps, ivec2(c, 4), 0).r;
  outGBuffer = vec4(t / sum, texelFetch(uEmis, ivec2(c, 0), 0).r, length(vView), 1.0);
}
`;

function floatTexture(values: Float32Array, width: number, height: number): DataTexture {
  const texture = new DataTexture(values, width, height, RedFormat, FloatType);
  texture.minFilter = NearestFilter; texture.magFilter = NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}

export class ThermalGBuffer {
  readonly material: ShaderMaterial;
  private readonly temps: DataTexture;
  private readonly emis: DataTexture;

  constructor(readonly area: AreaThermal, drape: MaterialDrape | null) {
    if (ORIENTATIONS.length !== 5) throw new Error("The G-buffer shader expects five orientation rows");
    this.temps = floatTexture(area.temperatureK, TABLE_WIDTH, ORIENTATIONS.length);
    this.emis = floatTexture(area.emissivity, TABLE_WIDTH, 1);
    const defaultClass = Math.max(0, area.materials.indexOf("synthetic-ground"));
    this.material = new ShaderMaterial({
      name: "thermal-gbuffer", glslVersion: GLSL3, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      uniforms: {
        uClasses: { value: drape?.classTexture ?? null }, uExtent: { value: drape?.extent ?? new Vector4(0, 0, 1, 1) },
        uHasClasses: { value: drape ? 1 : 0 }, uDefaultClass: { value: defaultClass }, uTemps: { value: this.temps }, uEmis: { value: this.emis },
      },
    });
  }

  /** Re-uploads the temperature table after AreaThermal.advanceTo(). */
  temperaturesChanged(): void { this.temps.needsUpdate = true; }

  dispose(): void {
    this.material.dispose(); this.temps.dispose(); this.emis.dispose();
  }
}
