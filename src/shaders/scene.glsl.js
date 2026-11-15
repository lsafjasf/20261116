import { NOISE_GLSL } from './noise.glsl.js';

export const SCENE_VERT = /* glsl */ `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0)
);
void main() {
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
}
`;

const SCENE_BODY = /* glsl */ `
uniform vec2  uResolution;
uniform float uCamAz, uCamEl;
uniform float uTime;
uniform vec3  uCamPos;
uniform vec2  uWind;       // 风速矢量（米/秒，已按风向旋转）
uniform float uHumidity;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyZenith, uSkyHorizon;
uniform float uFogOctaves;
uniform float uFogStep;    // 雾积分采样步长
uniform int   uDebugMask;  // 0=最终画面 1=地形遮挡掩码
uniform float uFarPlane;

const float FOG_FLOOR = -4.0;
const float FOG_CEIL  = 26.0;

float terrainHeight(vec2 p) {
  // 固定 5 octave，与质量档无关 —— 轮廓由这里决定。
  float base = fbm2(p * 0.028, 5);
  float ridges = 1.0 - abs(2.0 * fbm2(p * 0.06 + 11.7, 5) - 1.0);
  float valley = -6.0 * exp(-dot(p, p) * 0.00035);
  return (base - 0.5) * 14.0 + ridges * 7.0 + valley - 3.0;
}

float fogDensity(vec3 p) {
  float h = clamp((p.y - FOG_FLOOR) / (FOG_CEIL - FOG_FLOOR), 0.0, 1.0);
  // 雾主要沉积在谷底，向上逐渐稀薄，避免整屏洗白。
  float layer = pow(1.0 - h, 1.6) * (0.35 + 0.65 * sin(h * 3.14159));
  vec3 q = p * 0.075;
  q.xz += uWind * uTime * 0.05;
  int oct = int(uFogOctaves + 0.5);
  float n = fbm3(q, oct);
  float density = layer * (0.04 + 0.96 * n);
  return max(density, 0.0) * (0.0035 + uHumidity * 0.03);
}

vec3 terrainNormal(vec2 p) {
  float e = 0.6;
  float hL = terrainHeight(p - vec2(e, 0.0));
  float hR = terrainHeight(p + vec2(e, 0.0));
  float hD = terrainHeight(p - vec2(0.0, e));
  float hU = terrainHeight(p + vec2(0.0, e));
  return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
}

vec3 skyColor(vec3 rd) {
  float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(t, 1.4));
  float disc = smoothstep(0.9986, 0.9994, dot(rd, uSunDir));
  float glow = pow(max(dot(rd, uSunDir), 0.0), 8.0);
  return col + uSunColor * (disc * 2.2 + glow * 0.25);
}

out vec4 fragColor;

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  float ca = radians(uCamAz);
  float ce = radians(uCamEl);
  vec3 fwd = normalize(vec3(sin(ca) * cos(ce), sin(ce), cos(ca) * cos(ce)));
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  vec3 rd = normalize(fwd + uv.x * right * 0.9 + uv.y * up * 0.9);
  vec3 ro = uCamPos;

  // ---- 第一阶段：固定 96 步地形 raymarch（两质量档完全相同）----
  const int TERRAIN_STEPS = 96;
  float marchLen = uFarPlane / float(TERRAIN_STEPS);
  float hitT = -1.0;
  vec3  hitPos = vec3(0.0);
  float t = 0.5;
  for (int i = 0; i < TERRAIN_STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = p.y - terrainHeight(p.xz);
    if (d < 0.35) { hitT = t; hitPos = p; break; }
    t += marchLen;
  }
  float sceneEnd = hitT > 0.0 ? hitT : uFarPlane;

  if (uDebugMask == 1) {
    fragColor = vec4(vec3(hitT > 0.0 ? 1.0 : 0.0), 1.0);
    return;
  }

  // ---- 第二阶段：体积雾积分（步数/噪声 octave 随质量档变化）----
  vec3 sunScatter = mix(vec3(0.55, 0.62, 0.75), uSunColor, 0.65);
  float mu = dot(rd, uSunDir);
  float phase = 0.55 + 0.9 * pow(max(mu, 0.0), 16.0);
  float trans = 1.0;
  vec3  fogAccum = vec3(0.0);
  float ft = uFogStep * 0.5;
  while (ft < sceneEnd) {
    vec3 p = ro + rd * ft;
    if (p.y > FOG_FLOOR && p.y < FOG_CEIL) {
      float dens = fogDensity(p) * uFogStep;
      float atten = exp(-dens * 1.15);
      vec3 inscatter = sunScatter * phase * (1.0 - atten) * 0.85;
      fogAccum += trans * inscatter;
      trans *= atten;
    }
    ft += uFogStep;
  }

  vec3 background;
  if (hitT > 0.0) {
    vec3 n = terrainNormal(hitPos.xz);
    float lambert = max(dot(n, uSunDir), 0.0);
    vec3 grass = mix(vec3(0.16, 0.20, 0.12), vec3(0.34, 0.29, 0.22),
                     clamp(hitPos.y * 0.05 + 0.5, 0.0, 1.0));
    vec3 rock = vec3(0.32, 0.29, 0.26) * (0.35 + 0.65 * n.y);
    vec3 surface = mix(grass, rock, smoothstep(0.55, 0.95, 1.0 - n.y));
    float shadow = 0.28 + 0.72 * lambert;
    vec3 lit = surface * shadow * uSunColor * 1.25;
    float aerial = clamp(hitT / uFarPlane, 0.0, 1.0);
    background = mix(lit, uSkyHorizon, aerial * 0.4);
  } else {
    background = skyColor(rd);
  }

  vec3 color = background * trans + fogAccum;
  color = color / (color + vec3(1.15));           // 简单 tonemap，压高光防洗白
  // 轻微饱和度提升，抵消体积雾的灰蒙感。
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(luma), color, 1.18);
  color = pow(color, vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`;

export function buildSceneFragment(defines = {}) {
  const header = Object.entries(defines)
    .map(([k, v]) => `#define ${k} ${v}`)
    .join('\n');
  return `#version 300 es\nprecision highp float;\n${header}\n${NOISE_GLSL}\n${SCENE_BODY}`;
}
