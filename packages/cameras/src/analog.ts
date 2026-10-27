// Analog FPV video interference (TASK-068): seeded noise, scanlines, line
// tearing and rolling-shutter "jelly" from frame vibration. Rendering only:
// throttle is read, never written, and nothing here touches truth, sensors or
// physics. All pixel work is in shaders/analog.glsl; this class only updates
// scalar uniforms in place.
//
// * Video frames: index k = floor(t * frameRateHz). Uniforms change only when
//   k changes (throttle-decimated): throttle is sampled once per video frame,
//   so the render rate does not change the image.
// * Visual RNG: frameSeed = lowbias32(seed ^ lowbias32(k)), a stateless hash
//   independent of throttle, call count and every sensor/EW RNG stream.
// * Rolling shutter: line i of frame k is exposed at t_k + i * lineTime and
//   displaced by jellyAmplitude * throttle * sin(2 pi f_vib t + phase), with
//   f_vib = vibFreqMinHz + throttle * (vibFreqMaxHz - vibFreqMinHz).
// update*() are allocation-free.

export interface VideoNoiseConfig {
  /** Visual RNG seed (uint32), separate from sensor seeds. */
  seed: number;
  /** Video frame rate, Hz (e.g. 30 or 25). */
  frameRateHz: number;
  /** Visible lines per frame (scanline count and rolling-shutter rows). */
  lines: number;
  /** Fraction of the frame period spent reading out lines (0..1]. */
  readoutFraction: number;
  /** Additive noise amplitude at zero throttle, fraction of full scale. */
  noiseBase: number;
  /** Extra noise amplitude at full throttle (motor interference). */
  noiseThrottleGain: number;
  /** Scanline darkening depth, 0..1. */
  scanlineIntensity: number;
  /** Horizontal jelly displacement at full throttle, fraction of image width. */
  jellyAmplitudeUv: number;
  vibFreqMinHz: number;
  vibFreqMaxHz: number;
  /** Probability per line of a tearing offset at full noise, and its amplitude (UV). */
  tearProbability: number;
  tearAmplitudeUv: number;
}

/**
 * Default interference. The noise amplitudes were halved on 2026-10-22 (TASK-073, operator review of the
 * G3 screenshots): 0.02 + 0.08 x throttle reached about +-15 grey levels at hover and read as heavy
 * grain; 0.01 + 0.04 x throttle stays visibly analog. Tearing scales with the noise amplitude.
 */
export const DEFAULT_VIDEO_NOISE: Readonly<VideoNoiseConfig> = Object.freeze({
  seed: 1, frameRateHz: 30, lines: 480, readoutFraction: 0.9, noiseBase: 0.01, noiseThrottleGain: 0.04, scanlineIntensity: 0.15,
  jellyAmplitudeUv: 0.004, vibFreqMinHz: 80, vibFreqMaxHz: 300, tearProbability: 0.02, tearAmplitudeUv: 0.01,
});

/**
 * A numeric uniform with its own hidden class. Object literals `{ value }`
 * share one root map across the isolate; once any code stores a non-number
 * there (e.g. a texture uniform) the field becomes tagged and every double
 * store allocates. Class instances keep an unboxed double field.
 */
export class ScalarUniform {
  // Initialized to a double: a bare declaration is defined as undefined first
  // ([[Define]] class fields), which would make the field tagged.
  value = 0.5;
  constructor(value: number) { this.value = value; }
}
type Scalar = ScalarUniform;
export interface AnalogUniforms {
  uFrameSeed: Scalar; uNoise: Scalar; uScanline: Scalar; uLines: Scalar; uJellyAmpUv: Scalar; uVibFreqHz: Scalar;
  uFrameStartS: Scalar; uLineTimeS: Scalar; uTearProb: Scalar; uTearAmpUv: Scalar; uPhase: Scalar;
}
export interface VideoInput { readonly timeS: number; readonly throttle: number }

/** lowbias32 integer hash (Wellons), identical to the shader's hash(). */
export function hash32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function check(c: VideoNoiseConfig): void {
  const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!Number.isInteger(c.seed) || c.seed < 0 || c.seed > 0xffffffff || !inRange(c.frameRateHz, 1, 240) || !Number.isInteger(c.lines) ||
    !inRange(c.lines, 16, 4096) || !(c.readoutFraction > 0 && c.readoutFraction <= 1) || !inRange(c.noiseBase, 0, 1) ||
    !inRange(c.noiseThrottleGain, 0, 1) || !inRange(c.scanlineIntensity, 0, 1) || !inRange(c.jellyAmplitudeUv, 0, 0.1) ||
    !inRange(c.vibFreqMinHz, 0, 2000) || !inRange(c.vibFreqMaxHz, c.vibFreqMinHz, 2000) || !inRange(c.tearProbability, 0, 1) ||
    !inRange(c.tearAmplitudeUv, 0, 0.1)) throw new Error("Invalid video noise configuration");
}

export class AnalogVideo {
  readonly uniforms: AnalogUniforms;
  readonly config: Readonly<VideoNoiseConfig>;
  private frame = -1;
  /** Video frames started since construction or reset. */
  framesStarted = 0;
  private readonly scratch = { timeS: 0, throttle: 0 };
  /** Hash scratch: a uint32 returned from a call would be boxed (above the Smi range). */
  private readonly seedSlot = new Uint32Array(1);

  constructor(config: VideoNoiseConfig = DEFAULT_VIDEO_NOISE) {
    check(config);
    this.config = Object.freeze({ ...config });
    const lineTime = config.readoutFraction / (config.frameRateHz * config.lines);
    // Non-integer initial values give the class a double field representation (no boxing on update).
    const scalar = () => new ScalarUniform(0.5);
    this.uniforms = {
      uFrameSeed: scalar(), uNoise: scalar(), uScanline: scalar(), uLines: scalar(), uJellyAmpUv: scalar(), uVibFreqHz: scalar(),
      uFrameStartS: scalar(), uLineTimeS: scalar(), uTearProb: scalar(), uTearAmpUv: scalar(), uPhase: scalar(),
    };
    this.uniforms.uFrameSeed.value = 0;
    this.uniforms.uScanline.value = config.scanlineIntensity;
    this.uniforms.uLines.value = config.lines;
    this.uniforms.uLineTimeS.value = lineTime;
    this.uniforms.uTearAmpUv.value = config.tearAmplitudeUv;
    this.uniforms.uPhase.value = (hash32(config.seed ^ 0x5bd1e995) / 4294967296) * 2 * Math.PI;
  }

  /** Low-rate convenience (float arguments may be boxed); render loops use updateFrom. */
  update(timeS: number, throttle: number): boolean {
    this.scratch.timeS = timeS; this.scratch.throttle = throttle;
    return this.updateFrom(this.scratch);
  }

  /**
   * Advances to the video frame containing input.timeS. Returns true when a
   * new video frame started (uniforms changed). Throttle outside [0, 1] is
   * clamped; a non-finite time leaves the uniforms unchanged.
   */
  updateFrom(input: VideoInput): boolean {
    const t = input.timeS;
    if (!Number.isFinite(t) || t < 0) return false;
    const c = this.config;
    const k = Math.floor(t * c.frameRateHz);
    if (k === this.frame) return false;
    this.frame = k;
    this.framesStarted++;
    const raw = input.throttle;
    const throttle = raw > 1 ? 1 : raw > 0 ? raw : 0; // NaN -> 0
    const u = this.uniforms;
    this.frameSeedInto(k);
    u.uFrameSeed.value = this.seedSlot[0]!; // length 1
    u.uFrameStartS.value = k / c.frameRateHz;
    const noise = c.noiseBase + c.noiseThrottleGain * throttle;
    u.uNoise.value = noise > 1 ? 1 : noise;
    u.uJellyAmpUv.value = c.jellyAmplitudeUv * throttle;
    u.uVibFreqHz.value = c.vibFreqMinHz + throttle * (c.vibFreqMaxHz - c.vibFreqMinHz);
    u.uTearProb.value = c.tearProbability * (noise > 1 ? 1 : noise);
    return true;
  }

  /** seedSlot[0] = hash32(seed ^ hash32(k)), the same lowbias32 as hash32() and the shader. */
  private frameSeedInto(k: number): void {
    const slot = this.seedSlot;
    slot[0] = k;
    for (let round = 0; round < 2; round++) {
      let h: number = slot[0]; // length 1
      h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
      h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
      h ^= h >>> 16;
      slot[0] = round === 0 ? h ^ this.config.seed : h;
    }
  }

  /** Video frame index of the current uniforms (-1 before the first update). */
  get videoFrame(): number { return this.frame; }

  reset(): void { this.frame = -1; this.framesStarted = 0; }
}
