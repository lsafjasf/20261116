// Render engine: viewport -> visible tiles -> cache/loader -> draw list.
// Guarantees:
//  - low-detail (coarser lod) tiles appear first and are smoothly replaced
//  - a missing hi-detail tile never leaves a blank: parent chain, then a
//    marked placeholder, always with an explicit notice
//  - failed cache entries / thumbnails / requests fall back automatically
import { TileCache } from './cache.js';
import { TileLoader, validateThumbnail, makePlaceholderTile, makeThumbnail } from './loader.js';
import {
  lodForZoom,
  visibleTiles,
  parentTileId,
  tileWorldRect,
  lodScale
} from './tileGrid.js';

export class Engine {
  constructor(params, layers, { now = Date.now, sleep } = {}) {
    this.params = params;
    this.layers = layers;
    this.now = now;
    this.cache = new TileCache({
      budgetBytes: params.cacheBudgetBytes,
      ttlMs: params.invalidateCacheAfterMs ?? null
    });
    this.loader = new TileLoader(params, sleep ? { sleep } : {});
    this.displayed = new Map(layers.order().map((l) => [l, new Map()]));
    this.pending = new Map();
    this.notices = [];
    this.paused = false;
  }

  notice(type, message, extra = {}) {
    this.notices.push({ type, message, at: this.now(), ...extra });
  }

  setPaused(paused) {
    this.paused = paused;
    this.loader.paused = paused;
  }

  viewRect(camera) {
    const { width, height } = this.params.viewport;
    const w = width / camera.zoom;
    const h = height / camera.zoom;
    return { x: camera.x - w / 2, y: camera.y - h / 2, width: w, height: h };
  }

  _cacheKey(layer, id) {
    return `${layer}|${id}`;
  }

  // Best immediately-available stand-in: nearest cached ancestor, else a
  // locally generated placeholder (never blank, never stale).
  _fallbackTile(layer, id) {
    let cursor = parentTileId(id);
    while (cursor) {
      const cached = this.cache.peek(this._cacheKey(layer, cursor), this.now());
      if (cached) return { tile: cached, source: 'parent', covers: cursor };
      cursor = parentTileId(cursor);
    }
    return { tile: makePlaceholderTile(id, layer), source: 'placeholder' };
  }

  async _request(layer, id) {
    const key = this._cacheKey(layer, id);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = (async () => {
      try {
        let tile = await this.loader.load(id, layer);
        if (!validateThumbnail(tile)) {
          this.notice(
            'thumbnail',
            `thumbnail invalid for ${layer}:${id}; regenerated locally`,
            { tileId: id, layer }
          );
          tile = { ...tile, thumbnail: makeThumbnail(id, layer) };
        }
        this.cache.set(key, tile, this.params.tileBytes, this.now());
        this._swapIn(layer, id, tile);
      } catch (err) {
        this.notice(
          'load-failed',
          `tile ${layer}:${id} failed (${err.message}); using fallback`,
          { tileId: id, layer }
        );
        const fallback = this._fallbackTile(layer, id);
        this._swapIn(layer, id, fallback.tile);
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, promise);
    return promise;
  }

  _swapIn(layer, id, tile) {
    const slot = this.displayed.get(layer);
    const existing = slot.get(id);
    slot.set(id, { tile, alpha: existing ? existing.alpha : 0, fadingOut: false });
  }

  // One frame: evaluate the viewport, kick off loads, advance crossfades.
  // Returns the ordered draw list (bottom layer first).
  update(camera, dtMs = 16) {
    if (this.paused) return this.render(camera);
    const lod = lodForZoom(this.params, camera.zoom);
    const view = this.viewRect(camera);
    const wanted = visibleTiles(this.params, lod, view);
    const wantedKeys = new Set(wanted);

    for (const layer of this.layers.order()) {
      const slot = this.displayed.get(layer);
      // release tiles that left the viewport (fade out, then drop)
      for (const [id, entry] of slot) {
        if (!wantedKeys.has(id)) entry.fadingOut = true;
      }
      for (const id of wanted) {
        const key = this._cacheKey(layer, id);
        const cached = this.cache.get(key, this.now());
        if (cached) {
          if (!slot.has(id) || slot.get(id).tile !== cached) {
            this._swapIn(layer, id, cached);
          }
          continue;
        }
        if (!slot.has(id)) {
          const fallback = this._fallbackTile(layer, id);
          if (fallback.source === 'placeholder') {
            this.notice(
              'placeholder',
              `no cached data for ${layer}:${id}; showing placeholder`,
              { tileId: id, layer }
            );
          }
          slot.set(id, { tile: fallback.tile, alpha: 1, fadingOut: false });
        }
        this._request(layer, id);
      }
    }
    this._advanceFades(dtMs);
    return this.render(camera);
  }

  _advanceFades(dtMs) {
    const step = this.params.crossfadeMs > 0 ? dtMs / this.params.crossfadeMs : 1;
    for (const slot of this.displayed.values()) {
      for (const [id, entry] of slot) {
        if (entry.fadingOut) {
          entry.alpha -= step;
          if (entry.alpha <= 0) slot.delete(id);
        } else if (entry.alpha < 1) {
          entry.alpha = Math.min(1, entry.alpha + step);
        }
      }
    }
  }

  // Ordered, self-contained draw list: what the screen shows right now.
  render(camera) {
    const view = this.viewRect(camera);
    const ops = [];
    for (const layer of this.layers.order()) {
      for (const [id, entry] of this.displayed.get(layer)) {
        const rect = tileWorldRect(this.params, id);
        ops.push({
          layer,
          tileId: id,
          lod: entry.tile.lod,
          screen: {
            x: (rect.x - view.x) * camera.zoom,
            y: (rect.y - view.y) * camera.zoom,
            width: rect.width * camera.zoom,
            height: rect.height * camera.zoom
          },
          color: entry.tile.color,
          alpha: Number(entry.alpha.toFixed(4)),
          placeholder: entry.tile.placeholder,
          checksum: entry.tile.checksum
        });
      }
    }
    return ops;
  }

  async settle() {
    await Promise.all([...this.pending.values()]);
  }

  getStats() {
    return {
      cache: this.cache.snapshot(),
      loader: { ...this.loaderStats(), paused: this.loader.paused },
      pending: this.pending.size,
      notices: this.notices.length
    };
  }

  loaderStats() {
    return this.loader.stats;
  }
}
