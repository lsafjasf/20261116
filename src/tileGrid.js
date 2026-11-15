// Tile math for a quadtree-style LOD pyramid.
// lod 0 covers the whole world with worldSize pixels; each finer lod doubles
// the resolution. Tile id format: "lod/x/y".
export function lodScale(params, lod) {
  return 2 ** lod;
}

export function tilesPerAxis(params, lod) {
  const scale = lodScale(params, lod);
  return {
    cols: Math.ceil((params.worldSize.width * scale) / params.tileSize),
    rows: Math.ceil((params.worldSize.height * scale) / params.tileSize)
  };
}

export function parseTileId(id) {
  const [lod, x, y] = id.split('/').map(Number);
  return { lod, x, y };
}

export function makeTileId(lod, x, y) {
  return `${lod}/${x}/${y}`;
}

// World-space rect (lod-0 pixel coordinates) covered by a tile.
export function tileWorldRect(params, id) {
  const { lod, x, y } = parseTileId(id);
  const scale = lodScale(params, lod);
  const size = params.tileSize / scale;
  return { x: x * size, y: y * size, width: size, height: size };
}

// Pick the lod whose pixel resolution best matches the camera zoom.
// zoom = screen pixels per world(lod-0) pixel.
export function lodForZoom(params, zoom) {
  const target = Math.round(Math.log2(Math.max(zoom, 1e-9)));
  return Math.max(0, Math.min(params.maxLod, target));
}

// All tile ids of a given lod intersecting a world-space viewport rect.
export function visibleTiles(params, lod, view) {
  const { cols, rows } = tilesPerAxis(params, lod);
  const size = params.tileSize / lodScale(params, lod);
  const x0 = Math.max(0, Math.floor(view.x / size));
  const y0 = Math.max(0, Math.floor(view.y / size));
  const x1 = Math.min(cols - 1, Math.floor((view.x + view.width - 1e-9) / size));
  const y1 = Math.min(rows - 1, Math.floor((view.y + view.height - 1e-9) / size));
  const ids = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      ids.push(makeTileId(lod, x, y));
    }
  }
  return ids;
}

// Coarser parent tile id, or null at lod 0.
export function parentTileId(id) {
  const { lod, x, y } = parseTileId(id);
  if (lod === 0) return null;
  return makeTileId(lod - 1, Math.floor(x / 2), Math.floor(y / 2));
}
