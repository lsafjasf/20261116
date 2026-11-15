// Async tile source with latency, retries, timeout and deterministic content.
import { parseTileId } from './tileGrid.js';

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function tileChecksum(id, layer) {
  return hashString(`${id}|${layer}`).toString(16).padStart(8, '0');
}

export function makeThumbnail(id, layer) {
  return { checksum: tileChecksum(id, layer), width: 16, height: 16 };
}

export function validateThumbnail(tile) {
  return (
    tile.thumbnail != null &&
    tile.thumbnail.checksum === tileChecksum(tile.id, tile.layer)
  );
}

export function generateTile(id, layer, color) {
  const { lod } = parseTileId(id);
  return {
    id,
    layer,
    lod,
    color,
    checksum: tileChecksum(id, layer),
    thumbnail: makeThumbnail(id, layer),
    placeholder: false
  };
}

export function makePlaceholderTile(id, layer) {
  return {
    id,
    layer,
    lod: parseTileId(id).lod,
    color: '#555555',
    checksum: 'placeholder',
    thumbnail: null,
    placeholder: true
  };
}

export class TileLoader {
  constructor(params, { sleep = defaultSleep } = {}) {
    this.params = params;
    this.sleep = sleep;
    this.stats = { requests: 0, failures: 0, retries: 0, timeouts: 0 };
    this.paused = false;
  }

  async _fetch(id, layer) {
    this.stats.requests++;
    await this.sleep(1);
    if (this.params.failTileIds?.includes(id)) {
      this.stats.failures++;
      throw new Error(`fetch failed for tile ${id}`);
    }
    const tile = generateTile(id, layer, this.params.layerColors[layer]);
    if (this.params.corruptThumbnailIds?.includes(id)) {
      tile.thumbnail = { checksum: 'corrupt', width: 16, height: 16 };
    }
    return tile;
  }

  async load(id, layer) {
    if (this.paused) throw new Error('loader paused');
    const maxAttempts = 1 + (this.params.maxRetries ?? 0);
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) this.stats.retries++;
      try {
        return await this._withTimeout(this._fetch(id, layer));
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async _withTimeout(promise) {
    const timeoutMs = this.params.requestTimeoutMs;
    if (!timeoutMs) return promise;
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.stats.timeouts++;
            reject(new Error('request timeout'));
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
