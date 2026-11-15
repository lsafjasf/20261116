// 共享噪声库：地形与体积雾使用同一组函数，保证遮挡关系一致。
export const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float vnoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec3 of = vec3(0.0, 1.0, 0.0);
  float n000 = hash31(i);
  float n100 = hash31(i + of.yxx);
  float n010 = hash31(i + of.xyx);
  float n110 = hash31(i + of.yyx);
  float n001 = hash31(i + of.xxy);
  float n101 = hash31(i + of.yxy);
  float n011 = hash31(i + of.xyy);
  float n111 = hash31(i + of.yyy);
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float fbm2(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int k = 0; k < 8; k++) {
    if (k >= octaves) break;
    sum += amp * vnoise2(p);
    p = rot * p * 2.03;
    amp *= 0.5;
  }
  return sum;
}

float fbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int k = 0; k < 6; k++) {
    if (k >= octaves) break;
    sum += amp * vnoise3(p);
    p = p * 2.07 + vec3(1.7, 9.2, 3.3);
    amp *= 0.5;
  }
  return sum;
}
`;
