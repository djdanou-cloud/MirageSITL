import { ShaderMaterial, type Texture } from "three";
import fragment from "./shaders/thermal.glsl?raw";
export interface InstrumentProfile {
  id: string;
  width: number;
  height: number;
  spectralResponse: "uniform-8-14um";
  noiseKelvinRms: number;
  calibrationSource: "synthetic-training";
  coldK: number;
  hotK: number;
  atmosphereK: number;
  extinctionPerM: number;
}
export const TRAINING_PROFILE: Readonly<InstrumentProfile> = Object.freeze({
  id: "synthetic-lwir-640",
  width: 640,
  height: 512,
  spectralResponse: "uniform-8-14um",
  noiseKelvinRms: 0,
  calibrationSource: "synthetic-training",
  coldK: 270,
  hotK: 330,
  atmosphereK: 290,
  extinctionPerM: 0.001,
});
/** SI spectral radiance integrated with 16 midpoint bins from 8 to 14 micrometres.
 * Constants h,c,k are exact SI definitions; result W/(m^2 sr). Flat response is synthetic.
 */
export function bandRadiance(temperatureK: number): number {
  if (
    !Number.isFinite(temperatureK) ||
    temperatureK < 100 ||
    temperatureK > 1000
  )
    throw new RangeError("Temperature outside LWIR envelope");
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const wavelength = 8e-6 + ((i + 0.5) * 6e-6) / 16;
    total +=
      (2 * 6.62607015e-34 * 299792458 ** 2) /
      (wavelength ** 5 *
        Math.expm1(
          (6.62607015e-34 * 299792458) /
            (wavelength * 1.380649e-23 * temperatureK),
        ));
  }
  return (total * 6e-6) / 16;
}
export function validateInstrument(p: InstrumentProfile): void {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(p.id) ||
    !Number.isInteger(p.width) ||
    !Number.isInteger(p.height) ||
    p.width < 1 ||
    p.height < 1 ||
    p.width > 2048 ||
    p.height > 2048 ||
    p.spectralResponse !== "uniform-8-14um" ||
    p.calibrationSource !== "synthetic-training" ||
    p.noiseKelvinRms !== 0 ||
    !Number.isFinite(p.extinctionPerM) ||
    p.extinctionPerM < 0 ||
    p.extinctionPerM > 1 ||
    p.coldK >= p.hotK
  )
    throw new RangeError(
      "Unsupported synthetic thermal profile (noise must be zero)",
    );
  bandRadiance(p.coldK);
  bandRadiance(p.hotK);
  bandRadiance(p.atmosphereK);
}
export function observedRadiance(
  surfaceK: number,
  emissivity: number,
  reflectedK: number,
  distanceM: number,
  p: InstrumentProfile,
): number {
  validateInstrument(p);
  if (
    !Number.isFinite(emissivity) ||
    emissivity < 0 ||
    emissivity > 1 ||
    !Number.isFinite(distanceM) ||
    distanceM < 0 ||
    distanceM > 1e6
  )
    throw new RangeError("Invalid thermal ray");
  const emitted =
    emissivity * bandRadiance(surfaceK) +
    (1 - emissivity) * bandRadiance(reflectedK);
  const transmission = Math.exp(-p.extinctionPerM * distanceM);
  return (
    transmission * emitted + (1 - transmission) * bandRadiance(p.atmosphereK)
  );
}
export function paletteLevel(radiance: number, p: InstrumentProfile): number {
  validateInstrument(p);
  if (!Number.isFinite(radiance)) throw new RangeError("Invalid radiance");
  return Math.min(
    1,
    Math.max(
      0,
      (radiance - bandRadiance(p.coldK)) /
        (bandRadiance(p.hotK) - bandRadiance(p.coldK)),
    ),
  );
}
/** Input RGB32F texture: surface kelvin / emissivity / range metres.
 * Allocate the render target at profile.width x profile.height; no per-frame CPU pixel loop.
 * Texture values are validated by the thermal-state producer, not supplied by arbitrary tiles.
 */
export function createThermalMaterial(
  p: InstrumentProfile,
  stateTexture: Texture,
  reflectedK: number,
): ShaderMaterial {
  validateInstrument(p);
  bandRadiance(reflectedK);
  return new ShaderMaterial({
    name: p.id,
    depthTest: false,
    depthWrite: false,
    vertexShader:
      "varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}",
    fragmentShader: fragment,
    uniforms: {
      uState: { value: stateTexture },
      uReflectedK: { value: reflectedK },
      uAtmosphereK: { value: p.atmosphereK },
      uExtinction: { value: p.extinctionPerM },
      uCold: { value: bandRadiance(p.coldK) },
      uHot: { value: bandRadiance(p.hotK) },
    },
  });
}
