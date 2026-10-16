varying vec2 vUv;
uniform sampler2D uState;
uniform float uReflectedK, uAtmosphereK, uExtinction, uCold, uHot;
float radiance(float t) {
  float sum = 0.0;
  // Wavelength in micrometres keeps the coefficients within float32 range.
  for (int i=0; i<16; i++) {
    float l=8.0+(float(i)+0.5)*6.0/16.0;
    sum += 1.1910429723971884e8/(pow(l,5.0)*(exp(14387.768775039337/(l*t))-1.0));
  }
  return sum*6.0/16.0;
}
void main() {
  vec3 state=texture2D(uState,vUv).rgb;
  float emitted=state.g*radiance(state.r)+(1.0-state.g)*radiance(uReflectedK);
  float transmission=exp(-uExtinction*state.b);
  float observed=transmission*emitted+(1.0-transmission)*radiance(uAtmosphereK);
  float level=clamp((observed-uCold)/(uHot-uCold),0.0,1.0);
  gl_FragColor=vec4(vec3(level),1.0);
}
