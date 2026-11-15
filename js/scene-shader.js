export const vertexShaderSource = `#version 300 es
precision highp float;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const fragmentShaderSource = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uResolution;
uniform float uSplit;

uniform vec3 uEyeA;
uniform vec3 uRightA;
uniform vec3 uUpA;
uniform vec3 uForwardA;
uniform float uTanA;
uniform float uAspectA;

uniform vec3 uEyeB;
uniform vec3 uRightB;
uniform vec3 uUpB;
uniform vec3 uForwardB;
uniform float uTanB;
uniform float uAspectB;

uniform vec3 uGlassCenter[3];
uniform vec3 uGlassHalf[3];
uniform float uGlassRot[3];
uniform vec3 uGlassColor[3];
uniform float uGlassDensity[3];

uniform vec3 uLampPos[2];
uniform vec3 uLampColor[2];
uniform float uLampIntensity[2];
uniform float uFogDensity;
uniform float uFogHeight;

out vec4 outColor;

const float PI = 3.14159265359;
const float FLOOR_Y = -1.3;
const float LAMP_RADIUS = 0.105;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 4; i++) {
    sum += noise2(p) * amp;
    p = p * 2.03 + vec2(7.7, 3.1);
    amp *= 0.49;
  }
  return sum;
}

vec3 rotateY(vec3 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

vec3 inverseRotateY(vec3 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

struct BoxHit {
  bool hit;
  float enter;
  float exit;
  vec3 normal;
};

BoxHit intersectBox(vec3 ro, vec3 rd, int index) {
  BoxHit result;
  result.hit = false;
  result.enter = 0.0;
  result.exit = 0.0;
  result.normal = vec3(0.0, 1.0, 0.0);

  vec3 localOrigin = inverseRotateY(ro - uGlassCenter[index], uGlassRot[index]);
  vec3 localDirection = inverseRotateY(rd, uGlassRot[index]);
  float nearT = -1e20;
  float farT = 1e20;
  vec3 localNormal = vec3(0.0);

  for (int axis = 0; axis < 3; axis++) {
    float o = localOrigin[axis];
    float d = localDirection[axis];
    float halfSize = uGlassHalf[index][axis];
    if (abs(d) < 1e-7) {
      if (o < -halfSize || o > halfSize) return result;
      continue;
    }
    float t0 = (-halfSize - o) / d;
    float t1 = (halfSize - o) / d;
    float side = -1.0;
    if (t0 > t1) {
      float temp = t0;
      t0 = t1;
      t1 = temp;
      side = 1.0;
    }
    if (t0 > nearT) {
      nearT = t0;
      localNormal = vec3(0.0);
      localNormal[axis] = side;
    }
    farT = min(farT, t1);
    if (nearT > farT) return result;
  }

  if (farT <= max(nearT, 0.0)) return result;
  result.hit = true;
  result.enter = max(nearT, 0.0);
  result.exit = farT;
  result.normal = normalize(rotateY(localNormal, uGlassRot[index]));
  return result;
}

vec3 skyColor(vec3 rd) {
  float height = clamp(rd.y * 0.7 + 0.24, 0.0, 1.0);
  vec3 color = mix(vec3(0.008, 0.014, 0.021), vec3(0.012, 0.052, 0.061), height);
  color += vec3(0.035, 0.12, 0.13) * exp(-abs(rd.y) * 13.0) * 0.48;
  float upperGlow = exp(-abs(rd.x + 0.34) * 2.8) * smoothstep(-0.2, 0.6, rd.y);
  color += vec3(0.05, 0.09, 0.12) * upperGlow * 0.28;
  return color;
}

vec3 floorColor(vec3 p) {
  vec2 cell = abs(fract(p.xz * 1.32) - 0.5);
  float grid = smoothstep(0.475, 0.5, max(cell.x, cell.y));
  float fine = smoothstep(0.492, 0.5, max(abs(fract(p.x * 6.6) - 0.5), abs(fract(p.z * 6.6) - 0.5)));
  float radius = length(p.xz);

  vec3 color = vec3(0.012, 0.019, 0.022);
  color += vec3(0.38, 0.75, 0.76) * grid * 0.035;
  color += vec3(0.22, 0.38, 0.39) * fine * 0.017;
  color += vec3(0.01, 0.05, 0.052) * exp(-radius * 0.48) * 0.22;
  color *= 1.0 - smoothstep(3.2, 7.2, radius) * 0.72;

  for (int i = 0; i < 2; i++) {
    vec2 delta = p.xz - uLampPos[i].xz;
    float distanceToLamp = length(delta);
    float pool = exp(-distanceToLamp * distanceToLamp * 0.72) * 0.5;
    pool += exp(-distanceToLamp * distanceToLamp * 0.11) * 0.075;
    float streak = exp(-abs(delta.x) * 7.0) * exp(-abs(delta.y) * 0.72);
    float rings = sin(distanceToLamp * 13.0 - 1.2) * 0.5 + 0.5;
    rings *= exp(-distanceToLamp * 1.55) * 0.045;
    color += uLampColor[i] * uLampIntensity[i] * (pool * 0.26 + streak * 0.09 + rings);
  }

  color += vec3(0.03, 0.065, 0.068) * exp(-abs(p.z + 0.45) * 0.55) * 0.11;
  return color;
}

vec3 sampleBackdrop(vec3 ro, vec3 rd) {
  vec3 color = skyColor(rd);
  if (rd.y < -0.0001) {
    float t = (FLOOR_Y - ro.y) / rd.y;
    if (t > 0.0 && t < 45.0) {
      vec3 p = ro + rd * t;
      float fade = exp(-max(0.0, length(p.xz) - 3.8) * 0.95);
      color = mix(color, floorColor(p), clamp(fade, 0.0, 1.0));
    }
  }
  return color;
}

vec4 sampleFog(vec3 ro, vec3 rd) {
  if (uFogDensity < 0.001) return vec4(0.0);
  float top = FLOOR_Y + uFogHeight * 1.85;
  if (abs(rd.y) < 0.00005) return vec4(0.0);

  float t0 = (FLOOR_Y - ro.y) / rd.y;
  float t1 = (top - ro.y) / rd.y;
  if (t0 > t1) {
    float temp = t0;
    t0 = t1;
    t1 = temp;
  }
  t0 = max(t0, 0.0);
  t1 = min(t1, 28.0);
  if (t1 <= t0) return vec4(0.0);

  vec3 p = ro + rd * (t0 + t1) * 0.5;
  float radial = smoothstep(4.4, 1.1, length(p.xz));
  float wisp = fbm(p.xz * 1.18 + vec2(1.7, 0.4)) * 0.76;
  wisp += noise2(p.xz * 3.4 + p.y * 1.9) * 0.24;
  float alpha = uFogDensity * (0.11 + wisp * 0.72) * min(t1 - t0, 4.2) * 0.285 * radial;
  alpha = clamp(alpha, 0.0, 0.66);

  vec3 color = mix(vec3(0.2, 0.34, 0.37), vec3(0.63, 0.76, 0.76), wisp) * 0.43;
  for (int i = 0; i < 2; i++) {
    float d = length(p - uLampPos[i]);
    float scatter = exp(-d * d * 0.72) * 0.12;
    color += uLampColor[i] * scatter * uLampIntensity[i];
  }
  return vec4(color, alpha);
}

struct GlassEvent {
  vec3 color;
  float alpha;
};

GlassEvent makeGlassEvent(vec3 ro, vec3 rd, int index, vec3 p, vec3 normal, float pathLength) {
  GlassEvent event;
  vec3 local = inverseRotateY(p - uGlassCenter[index], uGlassRot[index]);
  float edgeDistance = min(uGlassHalf[index].x - abs(local.x), uGlassHalf[index].y - abs(local.y));
  float edge = 1.0 - smoothstep(0.012, 0.17, edgeDistance);
  float fresnel = pow(1.0 - clamp(abs(dot(normal, rd)), 0.0, 1.0), 3.1);
  float density = uGlassDensity[index];
  vec3 tint = mix(vec3(1.0), uGlassColor[index] * 1.22, 0.18 + density * 0.43);

  vec3 refractedDirection = normalize(rd + normal * (0.032 + pathLength * 0.045));
  vec3 transmitted = sampleBackdrop(p + normal * 0.045, refractedDirection) * tint;
  float sheen = 0.0;

  for (int i = 0; i < 2; i++) {
    vec3 toLight = normalize(uLampPos[i] - p);
    vec3 halfDir = normalize(toLight - rd);
    float specular = pow(max(dot(normal, halfDir), 0.0), 34.0);
    float reach = exp(-length(uLampPos[i] - p) * 0.11);
    sheen += specular * reach * uLampIntensity[i];
    transmitted += uLampColor[i] * specular * reach * 0.26 * uLampIntensity[i];
  }

  transmitted += uGlassColor[index] * edge * (0.13 + density * 0.35);
  transmitted += vec3(0.7, 0.92, 0.96) * fresnel * 0.16;
  transmitted += uGlassColor[index] * sheen * 0.21;
  event.color = transmitted;
  event.alpha = clamp(0.06 + density * 0.17 + pathLength * 0.4 + fresnel * 0.12 + edge * 0.5, 0.04, 0.82);
  return event;
}

struct LampEvent {
  bool coreHit;
  float coreT;
  vec3 coreColor;
  float halo;
};

LampEvent evaluateLamp(vec3 ro, vec3 rd, int index) {
  LampEvent event;
  event.coreHit = false;
  event.coreT = 0.0;
  event.coreColor = vec3(0.0);
  event.halo = 0.0;

  vec3 oc = ro - uLampPos[index];
  float b = dot(oc, rd);
  float c = dot(oc, oc) - LAMP_RADIUS * LAMP_RADIUS;
  float h = b * b - c;
  if (h > 0.0) {
    float nearT = -b - sqrt(h);
    if (nearT > 0.02) {
      vec3 p = ro + rd * nearT;
      vec3 normal = normalize(p - uLampPos[index]);
      float rim = pow(1.0 - clamp(dot(normal, -rd), 0.0, 1.0), 1.7);
      event.coreHit = true;
      event.coreT = nearT;
      event.coreColor = uLampColor[index] * uLampIntensity[index] * (1.1 + rim * 0.9);
      event.coreColor += vec3(0.9, 1.0, 1.0) * pow(1.0 - rim, 8.0) * 0.26;
    }
  }

  if (!event.coreHit && b > 0.02) {
    vec3 closest = ro + rd * b;
    float d = length(closest - uLampPos[index]);
    float aura = exp(-d * d * 22.0) * 0.9 + exp(-d * d * 3.2) * 0.1;
    if (aura > 0.006) {
      event.coreT = b;
      event.halo = aura * uLampIntensity[index];
    }
  } else if (event.coreHit && b > 0.02) {
    vec3 closest = ro + rd * b;
    float d = length(closest - uLampPos[index]);
    event.halo = exp(-d * d * 32.0) * 1.15 * uLampIntensity[index];
  }
  return event;
}

float fogMidDistance(vec3 ro, vec3 rd) {
  float top = FLOOR_Y + uFogHeight * 1.85;
  if (abs(rd.y) < 0.00005) return -1.0;
  float t0 = (FLOOR_Y - ro.y) / rd.y;
  float t1 = (top - ro.y) / rd.y;
  if (t0 > t1) {
    float temp = t0;
    t0 = t1;
    t1 = temp;
  }
  t0 = max(t0, 0.0);
  t1 = min(t1, 28.0);
  return t1 > t0 ? (t0 + t1) * 0.5 : -1.0;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float splitX = uResolution.x * uSplit;
  bool viewA = frag.x < splitX;

  vec3 eye = viewA ? uEyeA : uEyeB;
  vec3 right = viewA ? uRightA : uRightB;
  vec3 up = viewA ? uUpA : uUpB;
  vec3 forward = viewA ? uForwardA : uForwardB;
  float tanHalf = viewA ? uTanA : uTanB;
  float aspect = viewA ? uAspectA : uAspectB;
  vec2 viewportOrigin = viewA ? vec2(0.0) : vec2(splitX, 0.0);
  vec2 viewportSize = viewA ? vec2(splitX, uResolution.y) : vec2(uResolution.x - splitX, uResolution.y);
  vec2 uv = ((frag - viewportOrigin) / viewportSize) * 2.0 - 1.0;

  vec3 rayOrigin = eye;
  vec3 rayDirection = normalize(forward + right * (uv.x * aspect * tanHalf) + up * (uv.y * tanHalf));
  vec3 color = sampleBackdrop(rayOrigin, rayDirection);

  float eventT[12];
  vec3 eventColor[12];
  float eventAlpha[12];
  int eventType[12];
  int eventCount = 0;

  for (int i = 0; i < 3; i++) {
    BoxHit hit = intersectBox(rayOrigin, rayDirection, i);
    if (!hit.hit) continue;
    vec3 normal = hit.normal;
    if (dot(normal, rayDirection) > 0.0) normal = -normal;
    vec3 p = rayOrigin + rayDirection * hit.enter;
    GlassEvent glass = makeGlassEvent(rayOrigin, rayDirection, i, p, normal, hit.exit - hit.enter);
    eventT[eventCount] = hit.enter;
    eventColor[eventCount] = glass.color;
    eventAlpha[eventCount] = glass.alpha;
    eventType[eventCount] = 0;
    eventCount++;
  }

  for (int i = 0; i < 2; i++) {
    LampEvent lamp = evaluateLamp(rayOrigin, rayDirection, i);
    if (lamp.coreHit) {
      eventT[eventCount] = lamp.coreT;
      eventColor[eventCount] = lamp.coreColor;
      eventAlpha[eventCount] = 1.0;
      eventType[eventCount] = 1;
      eventCount++;
    }
    if (lamp.halo > 0.006) {
      eventT[eventCount] = lamp.coreT;
      eventColor[eventCount] = uLampColor[i] * lamp.halo;
      eventAlpha[eventCount] = 1.0;
      eventType[eventCount] = 2;
      eventCount++;
    }
  }

  vec4 fog = sampleFog(rayOrigin, rayDirection);
  float fogT = fogMidDistance(rayOrigin, rayDirection);
  if (fog.a > 0.004 && fogT > 0.0) {
    eventT[eventCount] = fogT;
    eventColor[eventCount] = fog.rgb;
    eventAlpha[eventCount] = fog.a;
    eventType[eventCount] = 3;
    eventCount++;
  }

  for (int i = 1; i < eventCount; i++) {
    float keyT = eventT[i];
    vec3 keyColor = eventColor[i];
    float keyAlpha = eventAlpha[i];
    int keyType = eventType[i];
    int j = i - 1;
    while (j >= 0 && eventT[j] > keyT) {
      eventT[j + 1] = eventT[j];
      eventColor[j + 1] = eventColor[j];
      eventAlpha[j + 1] = eventAlpha[j];
      eventType[j + 1] = eventType[j];
      j--;
    }
    eventT[j + 1] = keyT;
    eventColor[j + 1] = keyColor;
    eventAlpha[j + 1] = keyAlpha;
    eventType[j + 1] = keyType;
  }

  for (int i = eventCount - 1; i >= 0; i--) {
    if (eventType[i] == 1) {
      color = eventColor[i];
    } else if (eventType[i] == 2) {
      color += eventColor[i];
    } else {
      color = mix(color, eventColor[i], eventAlpha[i]);
    }
  }

  color *= 0.92 + 0.08 * smoothstep(1.2, 0.2, length((frag / uResolution - 0.5) * vec2(1.13, 1.0)));
  color = max(color, vec3(0.0));
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
  color += (hash21(frag) - 0.5) * 0.012;
  outColor = vec4(color, 1.0);
}
`;
