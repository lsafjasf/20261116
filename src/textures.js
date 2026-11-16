// Deterministic procedural RGBA textures. Four layers packed into one
// TEXTURE_2D_ARRAY so both render paths sample identical texels.

export const TEXTURE_SIZE = 64;
export const TEXTURE_LAYERS = 4;

const LAYER_COLORS = [
  [232, 96, 96],
  [96, 178, 232],
  [168, 220, 120],
  [232, 196, 96],
];

export function buildTextureLayers() {
  const size = TEXTURE_SIZE;
  const data = new Uint8Array(size * size * TEXTURE_LAYERS * 4);
  for (let layer = 0; layer < TEXTURE_LAYERS; layer++) {
    const base = LAYER_COLORS[layer];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2;
        const stripe = Math.floor((x + y) / 16) % 2;
        const shade = 0.62 + checker * 0.26 + stripe * 0.12;
        const idx = ((layer * size + y) * size + x) * 4;
        data[idx] = clampByte(base[0] * shade);
        data[idx + 1] = clampByte(base[1] * shade);
        data[idx + 2] = clampByte(base[2] * shade);
        data[idx + 3] = 255;
      }
    }
  }
  return data;
}

export function uploadTextureArray(gl) {
  const size = TEXTURE_SIZE;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(
    gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, size, size, TEXTURE_LAYERS
  );
  gl.texSubImage3D(
    gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, size, size, TEXTURE_LAYERS,
    gl.RGBA, gl.UNSIGNED_BYTE, buildTextureLayers()
  );
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return tex;
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}
