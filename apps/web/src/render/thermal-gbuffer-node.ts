// WebGPU (TSL node material) port of thermal-gbuffer.ts (TASK-073 P6): the
// same class lookup, orientation weighting and outputs (r = temperature K,
// g = emissivity, b = distance m, a = 1; cleared texels are sky). WebGPU's
// screen y points down, which flips the sign of cross(dFdx, dFdy); the face
// normal is therefore turned towards the camera explicitly, which is the
// visible side on either backend.
import { DataTexture, FloatType, NearestFilter, NoBlending, RedFormat, Vector4 } from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn, cameraPosition, clamp, cross, dFdx, dFdy, dot, float, floor, int, ivec2, length, max, normalize, positionView, positionWorld, select, texture,
  uniform, vec2, vec3, vec4,
} from "three/tsl";
import { ORIENTATIONS, TABLE_WIDTH, type AreaThermal } from "@mirage/thermal/area-thermal";
import type { MaterialDrape } from "./material-drape";

function floatTexture(values: Float32Array, width: number, height: number): DataTexture {
  const t = new DataTexture(values, width, height, RedFormat, FloatType);
  t.minFilter = NearestFilter; t.magFilter = NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

export class ThermalGBufferNode {
  readonly material = new NodeMaterial();
  private readonly temps: DataTexture;
  private readonly emis: DataTexture;
  private readonly placeholderClasses: DataTexture;

  constructor(readonly area: AreaThermal, drape: MaterialDrape | null) {
    if (ORIENTATIONS.length !== 5) throw new Error("The G-buffer shader expects five orientation rows");
    this.temps = floatTexture(area.temperatureK, TABLE_WIDTH, ORIENTATIONS.length);
    this.emis = floatTexture(area.emissivity, TABLE_WIDTH, 1);
    this.placeholderClasses = new DataTexture(new Uint8Array(1), 1, 1, RedFormat);
    this.placeholderClasses.needsUpdate = true;
    const classes = texture(drape?.classTexture ?? this.placeholderClasses);
    const temps = texture(this.temps), emis = texture(this.emis);
    const extent = uniform(drape?.extent ?? new Vector4(0, 0, 1, 1));
    const hasClasses = uniform(drape ? 1 : 0);
    const defaultClass = uniform(Math.max(0, area.materials.indexOf("synthetic-ground")));
    const gbuffer = Fn(() => {
      const w = positionWorld;
      // Render frame: x = east, z = -north. Texture row 0 is the north edge.
      const st = vec2(w.x.sub(extent.x).div(extent.z.sub(extent.x)), extent.w.add(w.z).div(extent.w.sub(extent.y)));
      const inside = hasClasses.greaterThan(0.5).and(st.x.greaterThanEqual(0)).and(st.y.greaterThanEqual(0)).and(st.x.lessThan(1)).and(st.y.lessThan(1));
      const sampled = floor(classes.sample(clamp(st, 0, 1)).x.mul(255).add(0.5));
      const classF = select(inside, sampled, float(defaultClass)).toVar("classF");
      const cls = int(classF).toVar("classIndex");
      const face = normalize(cross(dFdx(w), dFdy(w)));
      const n = select(dot(face, cameraPosition.sub(w)).lessThan(0), face.negate(), face);
      const enu = vec3(n.x, n.z.negate(), n.y);
      const up = max(enu.z, 0), east = max(enu.x, 0), north = max(enu.y, 0), west = max(enu.x.negate(), 0), south = max(enu.y.negate(), 0);
      const wUp = up.mul(up), wE = east.mul(east), wN = north.mul(north), wW = west.mul(west), wS = south.mul(south);
      const sum = wUp.add(wE).add(wN).add(wW).add(wS);
      const downward = sum.lessThan(1e-3);
      const row = (k: number) => temps.load(ivec2(cls, k)).x;
      const weighted = wUp.mul(row(0)).add(wE.mul(row(1))).add(wN.mul(row(2))).add(wW.mul(row(3))).add(wS.mul(row(4))).div(max(sum, 1e-3));
      const walls = row(1).add(row(2)).add(row(3)).add(row(4)).mul(0.25);
      return vec4(select(downward, walls, weighted), emis.load(ivec2(cls, 0)).x, length(positionView), 1);
    });
    this.material.fragmentNode = gbuffer();
    // rgba32float is not blendable.
    this.material.blending = NoBlending;
    this.material.name = "thermal-gbuffer-node";
  }

  temperaturesChanged(): void { this.temps.needsUpdate = true; }

  dispose(): void { this.material.dispose(); this.temps.dispose(); this.emis.dispose(); this.placeholderClasses.dispose(); }
}
