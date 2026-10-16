// Kannala-Brandt fisheye remap (TASK-067). Mirrors fisheyeSourceUvInto in
// packages/cameras/src/fisheye.ts; keep both in sync.
// Output uv -> distorted normalized radius r_d -> incidence angle theta
// (Newton inverse of theta_d = theta (1 + k1 theta^2 + k2 theta^4 + k3 theta^6
// + k4 theta^8)) -> pinhole source radius tan(theta) -> source uv.
// uModel 0 is the identity (no distortion).
uniform sampler2D uSource;
uniform int uModel;
uniform vec2 uOutCenter;
uniform vec2 uOutFocal;
uniform vec2 uSrcCenter;
uniform vec2 uSrcFocal;
uniform vec4 uK;
uniform float uMaxTheta;
varying vec2 vUv;

float thetaD(float t) {
  float t2 = t * t;
  return t * (1.0 + t2 * (uK.x + t2 * (uK.y + t2 * (uK.z + t2 * uK.w))));
}
float thetaDPrime(float t) {
  float t2 = t * t;
  return 1.0 + t2 * (3.0 * uK.x + t2 * (5.0 * uK.y + t2 * (7.0 * uK.z + t2 * 9.0 * uK.w)));
}

void main() {
  if (uModel == 0) {
    gl_FragColor = texture2D(uSource, vUv);
    return;
  }
  vec2 md = (vUv - uOutCenter) / uOutFocal;
  float rd = length(md);
  float theta = rd;
  for (int i = 0; i < 10; i++) {
    theta = clamp(theta - (thetaD(theta) - rd) / thetaDPrime(theta), 0.0, uMaxTheta);
  }
  if (rd <= 0.0) {
    gl_FragColor = texture2D(uSource, uSrcCenter);
    return;
  }
  if (abs(thetaD(theta) - rd) > 1e-4) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); // outside the lens image circle
    return;
  }
  vec2 mp = md * (tan(theta) / rd);
  vec2 src = uSrcCenter + mp * uSrcFocal;
  if (any(lessThan(src, vec2(0.0))) || any(greaterThan(src, vec2(1.0)))) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  gl_FragColor = texture2D(uSource, src);
}
