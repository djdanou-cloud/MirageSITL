// WebGPU twin of MaterialDrape.apply (TASK-073 P6): WebGPURenderer ignores
// onBeforeCompile, but converts a classic material by copying its own
// properties into the node material, so a `colorNode` set here replaces the
// diffuse colour with the same filtered, mipmapped colour-texture lookup
// (render x = east, z = -north, texture row 0 = north edge). Outside the
// raster, or for a class without a display colour, the material's own colour
// stays. Loaded only on the WebGPU backend.
import type { MeshStandardMaterial } from "three";
import { Fn, materialColor, mix, positionWorld, select, texture, uniform, vec2, vec4 } from "three/tsl";
import type { MaterialDrape } from "./material-drape";

export function drapeNodeHook(drape: MaterialDrape): (material: MeshStandardMaterial) => void {
  const colour = texture(drape.colourTexture), extent = uniform(drape.extent);
  const colorNode = Fn(() => {
    const w = positionWorld;
    const st = vec2(w.x.sub(extent.x).div(extent.z.sub(extent.x)), extent.w.add(w.z).div(extent.w.sub(extent.y)));
    const inside = st.x.greaterThanEqual(0).and(st.y.greaterThanEqual(0)).and(st.x.lessThan(1)).and(st.y.lessThan(1));
    const c = colour.sample(st);
    return select(inside, vec4(mix(materialColor.rgb, c.rgb, c.a), 1), vec4(materialColor.rgb, 1));
  })();
  return material => {
    Reflect.set(material, "colorNode", colorNode);
    material.needsUpdate = true;
  };
}
