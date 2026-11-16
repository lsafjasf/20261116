import { GEOMETRY_KEYS } from "./geometry.js";
import { mat4LookAt, mat4Perspective, mat4Multiply, norm3, sub3, dot3, transformVec4 } from "./math.js";

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic scene. The public node dataset is identical for both render
// paths; only GL resource organization differs.
export function generateScene(params) {
  const rand = mulberry32(params.seed);
  const nodes = [];
  for (let id = 0; id < params.nodeCount; id++) {
    const angle = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * params.spread;
    const geoKey = GEOMETRY_KEYS[Math.floor(rand() * GEOMETRY_KEYS.length)];
    const scale = params.minScale + rand() * (params.maxScale - params.minScale);
    nodes.push({
      id,
      geoKey,
      position: [
        Math.cos(angle) * radius,
        (rand() - 0.5) * params.spread * 0.9,
        Math.sin(angle) * radius,
      ],
      scale,
      colorSeed: rand(),
      // Tessellation creates a cache key: same geo+segments share one mesh.
      tessellation: 2 + Math.floor(rand() * 4),
      layer: Math.floor(rand() * 4),
    });
  }
  return {
    params: { ...params },
    nodes,
    // Public semantic snapshot, asserted equal across render paths.
    publicData: nodes.map((n) => ({
      id: n.id, geoKey: n.geoKey, position: [...n.position],
      scale: n.scale, layer: n.layer, tessellation: n.tessellation,
    })),
  };
}

export class OrbitCamera {
  constructor(canvas) {
    this.target = [0, 0, 0];
    this.distance = 18;
    this.yaw = 0.7;
    this.pitch = 0.35;
    this.fovy = Math.PI / 4;
    this.near = 0.1;
    this.far = 120;
    this.width = canvas.width;
    this.height = canvas.height;
    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.eye = [0, 0, 0];
    this.updateMatrices();
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.updateMatrices();
  }

  orbit(dx, dy) {
    this.yaw -= dx * 0.005;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * 0.005));
    this.updateMatrices();
  }

  zoom(delta) {
    this.distance = Math.max(4, Math.min(60, this.distance * Math.exp(delta * 0.0012)));
    this.updateMatrices();
  }

  getState() {
    return {
      target: [...this.target], distance: this.distance,
      yaw: this.yaw, pitch: this.pitch, fovy: this.fovy,
    };
  }

  updateMatrices() {
    const cp = Math.cos(this.pitch);
    this.eye[0] = this.target[0] + this.distance * cp * Math.sin(this.yaw);
    this.eye[1] = this.target[1] + this.distance * Math.sin(this.pitch);
    this.eye[2] = this.target[2] + this.distance * cp * Math.cos(this.yaw);
    mat4LookAt(this.view, this.eye, this.target, [0, 1, 0]);
    mat4Perspective(this.proj, this.fovy, this.width / this.height, this.near, this.far);
  }

  // Ray in world space from a canvas-space pixel (used by CPU picking).
  pickRay(px, py) {
    const ndcX = (px / this.width) * 2 - 1;
    const ndcY = 1 - (py / this.height) * 2;
    const invProj = invert(this.proj);
    const invView = invert(this.view);
    const nearPoint = transformVec4(invProj, ndcX, ndcY, -1, 1);
    const farPoint = transformVec4(invProj, ndcX, ndcY, 1, 1);
    for (const q of [nearPoint, farPoint]) {
      q[0] /= q[3]; q[1] /= q[3]; q[2] /= q[3]; q[3] = 1;
    }
    let wNear = transformVec4(invView, ...nearPoint);
    let wFar = transformVec4(invView, ...farPoint);
    wNear = wNear.slice(0, 3);
    wFar = wFar.slice(0, 3);
    return { origin: wNear, dir: norm3(sub3(wFar, wNear)) };
  }
}

export function pickNode(ray, nodes) {
  let best = null;
  let bestT = Infinity;
  for (const node of nodes) {
    const t = raySphere(ray, node.position, node.scale * 0.62);
    if (t !== null && t < bestT) {
      bestT = t;
      best = node;
    }
  }
  return best;
}

function raySphere(ray, center, radius) {
  const oc = sub3(ray.origin, center);
  const b = dot3(oc, ray.dir);
  const c = dot3(oc, oc) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

// Conservative view-frustum culling against the six world-space planes.
export function cullNodes(nodes, camera) {
  const vp = new Float32Array(16);
  mat4Multiply(vp, camera.proj, camera.view);
  const planes = extractPlanes(vp);
  const visible = [];
  for (const node of nodes) {
    const r = node.scale * 0.72;
    let inside = true;
    for (const pl of planes) {
      if (pl[0] * node.position[0] + pl[1] * node.position[1] +
          pl[2] * node.position[2] + pl[3] <= -r) { inside = false; break; }
    }
    if (inside) visible.push(node);
  }
  return visible;
}

function extractPlanes(m) {
  return [
    norm4([m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]]),
    norm4([m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]]),
    norm4([m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]]),
    norm4([m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]]),
    norm4([m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]]),
    norm4([m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]]),
  ];
}
function norm4(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return v.map((x) => x / len);
}

function invert(a) {
  const out = new Float32Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return mat4IdentityLocal();
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b03 - a30 * b01 - a32 * b00) * det;
  out[15] = (a20 * b01 - a21 * b03 + a22 * b00) * det;
  return out;
}
function mat4IdentityLocal() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
