// Procedural geometry. All meshes are centered unit-size (radius ~0.5) so the
// same model matrix works for every shape; only vertex data differs.

const GEOMETRY_BUILDERS = {
  cube: buildCube,
  sphere: buildSphere,
  octa: buildOcta,
  tetra: buildTetra,
};

export const GEOMETRY_KEYS = Object.keys(GEOMETRY_BUILDERS);

export function buildGeometry(key, tessellation) {
  const builder = GEOMETRY_BUILDERS[key];
  if (!builder) throw new Error(`unknown geometry: ${key}`);
  return builder(tessellation);
}

function buildCube() {
  const p = [], uv = [], idx = [];
  const faces = [
    [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
    [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]],
    [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]],
    [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]],
    [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]],
    [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]],
  ];
  const faceUV = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const face of faces) {
    const base = p.length / 3;
    for (let i = 0; i < 4; i++) {
      p.push(...face[i]);
      uv.push(...faceUV[i]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(p), uvs: new Float32Array(uv), indices: new Uint16Array(idx) };
}

function buildOcta() {
  const p = [], uv = [], idx = [];
  const verts = [
    [0, 0.5, 0], [0, -0.5, 0], [0.5, 0, 0],
    [-0.5, 0, 0], [0, 0, 0.5], [0, 0, -0.5],
  ];
  const tris = [
    [0, 4, 2], [0, 2, 5], [0, 5, 3], [0, 3, 4],
    [1, 2, 4], [1, 5, 2], [1, 3, 5], [1, 4, 3],
  ];
  const triUV = [[0.5, 1], [0, 0], [1, 0]];
  for (const tri of tris) {
    const base = p.length / 3;
    for (let i = 0; i < 3; i++) {
      p.push(...verts[tri[i]]);
      uv.push(...triUV[i]);
    }
    idx.push(base, base + 1, base + 2);
  }
  return { positions: new Float32Array(p), uvs: new Float32Array(uv), indices: new Uint16Array(idx) };
}

function buildTetra() {
  const s = 0.55;
  const verts = [
    [s, s, s], [-s, -s, s], [-s, s, -s], [s, -s, -s],
  ];
  const tris = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  const p = [], uv = [], idx = [];
  const triUV = [[0.5, 1], [0, 0], [1, 0]];
  for (const tri of tris) {
    const base = p.length / 3;
    for (let i = 0; i < 3; i++) {
      p.push(...verts[tri[i]]);
      uv.push(...triUV[i]);
    }
    idx.push(base, base + 1, base + 2);
  }
  return { positions: new Float32Array(p), uvs: new Float32Array(uv), indices: new Uint16Array(idx) };
}

function buildSphere(segments) {
  // UV sphere; `segments` is per-quarter resolution so tessellation changes data.
  const lat = segments * 2;
  const lon = segments * 4;
  const p = [], uv = [], idx = [];
  for (let i = 0; i <= lat; i++) {
    const theta = (i / lat) * Math.PI;
    const sinT = Math.sin(theta);
    for (let j = 0; j <= lon; j++) {
      const phi = (j / lon) * Math.PI * 2;
      const x = 0.5 * sinT * Math.cos(phi);
      const y = 0.5 * Math.cos(theta);
      const z = 0.5 * sinT * Math.sin(phi);
      p.push(x, y, z);
      uv.push(j / lon, 1 - i / lat);
    }
  }
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * (lon + 1) + j;
      const b = a + lon + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions: new Float32Array(p), uvs: new Float32Array(uv), indices: new Uint16Array(idx) };
}
