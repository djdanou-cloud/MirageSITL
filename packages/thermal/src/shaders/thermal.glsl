// Thermal camera (TASK-071), GLSL ES 3.00. Mirrors apparentLevel() and
// paletteColor() in packages/thermal/src/thermal-camera.ts.
// G-buffer texel: r = surface temperature K, g = emissivity, b = distance m,
// a = 1 for geometry (a = 0 is open sky, shown at the sky temperature).
// Fixed-pattern noise (TASK-073 P5): residual (o - bias) + gain * drift, in K,
// per sensor pixel; the CPU mirror is ThermalSensorChain / ThermalNuc.output.
precision highp float;
precision highp int;
uniform highp sampler2D uGBuffer;
uniform highp sampler2D uTable;   // in-band radiance per kelvin, width = uTableCount
uniform float uTableMinK;
uniform float uTableCount;
uniform float uReflectedK;
uniform float uAirK;
uniform float uExtinction;
uniform float uSpanMinK;
uniform float uSpanMaxK;
uniform int uPalette;             // 0 white-hot, 1 black-hot, 2 ironbow
uniform float uNetdK;             // per-pixel temperature noise amplitude (uniform, +-NETD)
uniform uint uFrameSeed;
uniform float uSkyK;              // sky brightness temperature, K
uniform int uFpn;                 // 1 when the fixed-pattern textures are bound
uniform highp sampler2D uFpnResidual;
uniform highp sampler2D uFpnGain;
uniform float uFpnDriftK;
varying vec2 vUv;
layout(location = 0) out highp vec4 outColor;

uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float radiance(float tK) {
  float x = clamp(tK - uTableMinK, 0.0, uTableCount - 1.0);
  int i = min(int(floor(x)), int(uTableCount) - 2);
  float f = x - float(i);
  float a = texelFetch(uTable, ivec2(i, 0), 0).r;
  float b = texelFetch(uTable, ivec2(i + 1, 0), 0).r;
  return a * (1.0 - f) + b * f;
}
vec3 ironbow(float x) {
  vec4 p[6] = vec4[6](vec4(0.0, 0.0, 0.0, 0.0), vec4(0.25, 0.35, 0.0, 0.55), vec4(0.5, 0.8, 0.1, 0.25),
                      vec4(0.7, 1.0, 0.5, 0.0), vec4(0.88, 1.0, 0.85, 0.15), vec4(1.0, 1.0, 1.0, 1.0));
  for (int i = 1; i < 6; i++) {
    if (x <= p[i].x) {
      float f = (x - p[i - 1].x) / (p[i].x - p[i - 1].x);
      return mix(p[i - 1].yzw, p[i].yzw, f);
    }
  }
  return vec3(1.0);
}

void main() {
  vec4 g = texture(uGBuffer, vUv);
  bool sky = g.a < 0.5;
  float t = sky ? uSkyK : g.r;
  if (uFpn == 1) {
    ivec2 p = ivec2(gl_FragCoord.xy);
    t += texelFetch(uFpnResidual, p, 0).r + texelFetch(uFpnGain, p, 0).r * uFpnDriftK;
  }
  if (uNetdK > 0.0) {
    uvec2 p = uvec2(gl_FragCoord.xy);
    t += (float(hash(p.x * 0x9e3779b9u ^ hash(p.y ^ uFrameSeed)) >> 8) * (1.0 / 16777216.0) - 0.5) * 2.0 * uNetdK;
  }
  float tau = sky ? 1.0 : exp(-uExtinction * max(0.0, g.b));
  float eps = sky ? 1.0 : g.g;
  float l = tau * (eps * radiance(t) + (1.0 - eps) * radiance(uReflectedK)) + (1.0 - tau) * radiance(uAirK);
  float lo = radiance(uSpanMinK), hi = radiance(uSpanMaxK);
  float level = clamp((l - lo) / (hi - lo), 0.0, 1.0);
  vec3 c = uPalette == 0 ? vec3(level) : uPalette == 1 ? vec3(1.0 - level) : ironbow(level);
  outColor = vec4(c, 1.0);
}
