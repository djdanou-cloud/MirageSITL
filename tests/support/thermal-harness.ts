import {
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import {
  createThermalMaterial,
  TRAINING_PROFILE,
  observedRadiance,
  paletteLevel,
} from "../../packages/thermal/src/thermal-camera";
export function thermalPixels() {
  const width = 6,
    height = 2;
  const rays = [
    [270, 1, 280, 0],
    [330, 1, 280, 0],
    [310, 0.3, 280, 0],
    [320, 1, 280, 1000],
    [320, 1, 280, 10000],
    [300, 1, 280, 0],
  ];
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const r = rays[i % width]!;
    data.set([r[0]!, r[1]!, r[3]!, 1], i * 4);
  }
  const p = { ...TRAINING_PROFILE, width, height };
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  const material = createThermalMaterial(p, texture, 280),
    geometry = new PlaneGeometry(2, 2),
    scene = new Scene();
  scene.add(new Mesh(geometry, material));
  const renderer = new WebGLRenderer();
  let errors = 0;
  renderer.debug.onShaderError = () => {
    errors++;
  };
  const target = new WebGLRenderTarget(width, height);
  renderer.setRenderTarget(target);
  renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  const expected = rays.map((r) =>
    Math.round(
      255 * paletteLevel(observedRadiance(r[0]!, r[1]!, r[2]!, r[3]!, p), p),
    ),
  );
  material.dispose();
  geometry.dispose();
  texture.dispose();
  target.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return {
    red: Array.from(pixels.filter((_, i) => i % 4 === 0)),
    expected,
    width,
    height,
    errors,
  };
}
