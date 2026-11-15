// Canvas preview renderers. All three views sample the SAME composite tile;
// only the affected canvas is redrawn on a change, and no scene is rebuilt.
import { TILE_SIZE } from "../core/params.js";

export function drawFlat(canvas, composite) {
  const ctx = canvas.getContext("2d");
  const img = new ImageData(
    new Uint8ClampedArray(composite.buffer, composite.byteOffset, composite.length),
    TILE_SIZE,
    TILE_SIZE
  );
  const off = document.createElement("canvas");
  off.width = TILE_SIZE;
  off.height = TILE_SIZE;
  off.getContext("2d").putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

export function drawTiled(canvas, composite, repeat = 3) {
  const ctx = canvas.getContext("2d");
  const img = new ImageData(
    new Uint8ClampedArray(composite.buffer, composite.byteOffset, composite.length),
    TILE_SIZE,
    TILE_SIZE
  );
  const off = document.createElement("canvas");
  off.width = TILE_SIZE;
  off.height = TILE_SIZE;
  off.getContext("2d").putImageData(img, 0, 0);
  const cell = canvas.width / repeat;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < repeat; y++) {
    for (let x = 0; x < repeat; x++) {
      ctx.drawImage(off, x * cell, y * cell, cell, cell);
    }
  }
}

// Curved preview: wrap the tile around a horizontal cylinder. The mapping uses
// u = theta/2pi so the left and right edges meet on the back of the cylinder;
// a seamless tile shows no vertical seam and no obvious repeat.
export function drawCurved(canvas, composite) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const src = document.createElement("canvas");
  src.width = TILE_SIZE;
  src.height = TILE_SIZE;
  src.getContext("2d").putImageData(
    new ImageData(
      new Uint8ClampedArray(composite.buffer, composite.byteOffset, composite.length),
      TILE_SIZE,
      TILE_SIZE
    ),
    0,
    0
  );
  ctx.clearRect(0, 0, W, H);
  const radius = H * 0.42;
  const centerY = H / 2;
  const span = radius * 2;
  // One output column per angular sample; each is a thin strip from the tile.
  for (let sx = 0; sx < W; sx++) {
    const nx = (sx / W) * 2 - 1; // -1..1 across the cylinder
    if (nx * nx > 1) continue;
    const cosT = nx; // projected x = r*cos(theta)
    const theta = Math.acos(cosT); // 0..pi (front hemisphere)
    const u = theta / Math.PI; // 0..1 across the tile
    const srcX = Math.min(TILE_SIZE - 1, Math.floor(u * TILE_SIZE));
    const shade = 0.35 + 0.65 * Math.sin(theta); // limb darkening
    const stripW = Math.ceil(W / TILE_SIZE) + 1;
    ctx.drawImage(src, srcX, 0, 1, TILE_SIZE, sx, centerY - span / 2, stripW, span);
    ctx.fillStyle = `rgba(0,0,0,${(1 - shade) * 0.55})`;
    ctx.fillRect(sx, centerY - span / 2, stripW, span);
  }
}
