// Analog FPV video interference (TASK-068), GLSL ES 3.00. Per-pixel noise,
// scanlines, line tearing and rolling-shutter "jelly". Uniforms change only
// at video-frame boundaries (packages/cameras/src/analog.ts), so the image
// for a given seed and video frame is independent of the render rate.
// Integer hashing (lowbias32) keeps the noise pattern identical for equal
// inputs on a backend; float rounding may still differ between GPUs.
precision highp float;
precision highp int;
uniform sampler2D uSource;
uniform uint uFrameSeed;
uniform float uNoise;
uniform float uScanline;
uniform float uLines;
uniform float uJellyAmpUv;
uniform float uVibFreqHz;
uniform float uFrameStartS;
uniform float uLineTimeS;
uniform float uTearProb;
uniform float uTearAmpUv;
uniform float uPhase;
varying vec2 vUv;
layout(location = 0) out highp vec4 outColor;

uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float unit(uint h) { return float(h >> 8) * (1.0 / 16777216.0); }

void main() {
  // Lines are read out top to bottom; each line is exposed uLineTimeS later.
  float line = min(floor((1.0 - vUv.y) * uLines), uLines - 1.0);
  float t = uFrameStartS + line * uLineTimeS;
  float dx = uJellyAmpUv * sin(6.28318530718 * uVibFreqHz * t + uPhase);
  uint lineHash = hash(uint(line) ^ hash(uFrameSeed));
  if (unit(lineHash) < uTearProb) dx += (unit(hash(lineHash)) - 0.5) * 2.0 * uTearAmpUv;
  vec4 c = texture(uSource, vec2(vUv.x + dx, vUv.y));
  uvec2 p = uvec2(gl_FragCoord.xy);
  float n = (unit(hash(p.x * 0x9e3779b9u ^ hash(p.y ^ uFrameSeed))) - 0.5) * 2.0 * uNoise;
  float scan = 1.0 - uScanline * (0.5 + 0.5 * cos(6.28318530718 * vUv.y * uLines));
  outColor = vec4(clamp(c.rgb * scan + n, 0.0, 1.0), c.a);
}
