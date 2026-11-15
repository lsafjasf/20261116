// 资源服务：缓存 -> 后端请求 -> 过期缓存 -> 内置占位 的多级回退。
// 任何失效都会在 notices 中给出明确原因，绝不静默展示旧内容或空白。

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }
}

function hashKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h;
}

export class ResourceService {
  constructor({ backend, thumbnailer, faults = {} } = {}) {
    if (typeof backend !== 'function') {
      throw new TypeError('backend 必须是 async (key) => {version, payload} 函数');
    }
    this.backend = backend;
    this.thumbnailer = thumbnailer;
    this.faults = new Map(Object.entries(faults));
    this.cache = new Map(); // key -> { version, payload, thumbnail, stale }
    this.noticeLog = [];
  }

  // 标记缓存失效：下次 get 必须重新向后端验证
  invalidate(key) {
    const entry = this.cache.get(key);
    if (entry) entry.stale = true;
  }

  invalidateAll() {
    this.cache.forEach((entry) => {
      entry.stale = true;
    });
  }

  setFault(key, code) {
    this.faults.set(key, code);
  }

  clearFault(key) {
    this.faults.delete(key);
  }

  placeholder(key) {
    const h = hashKey(key);
    const r = h & 0xff;
    const g = (h >> 8) & 0xff;
    const b = (h >> 16) & 0xff;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    return { kind: 'placeholder', color: hex, label: key };
  }

  async requestBackend(key) {
    const fault = this.faults.get(key);
    if (fault === 'network') throw new FetchError('NETWORK', `网络请求失败: ${key}`);
    if (fault === 'timeout') throw new FetchError('TIMEOUT', `请求超时: ${key}`);
    if (fault === 'corrupt') {
      return { version: -1, payload: null, corrupt: true };
    }
    return this.backend(key);
  }

  async getResource(key) {
    const notices = [];
    const cached = this.cache.get(key);
    let response;
    try {
      response = await this.requestBackend(key);
      if (!response || response.corrupt || response.payload == null) {
        throw new FetchError('CORRUPT', `响应数据损坏或为空: ${key}`);
      }
      const entry = {
        version: response.version,
        payload: response.payload,
        thumbnail: cached && cached.version === response.version ? cached.thumbnail : null,
        stale: false,
      };
      this.cache.set(key, entry);
      return {
        status: 'ok',
        source: cached && !cached.stale && cached.version === response.version
          ? 'cache-verified'
          : 'network',
        value: response.payload,
        version: response.version,
        notices,
      };
    } catch (err) {
      if (cached) {
        cached.stale = true;
        notices.push({
          level: 'warning',
          code: err.code ?? 'FETCH_FAILED',
          message: `后端请求失败（${err.message}），已回退到最近缓存；该缓存已标记为过期`,
        });
        this.noticeLog.push({ key, ...notices[0] });
        return {
          status: 'fallback',
          source: 'stale-cache',
          value: cached.payload,
          version: cached.version,
          notices,
        };
      }
      notices.push({
        level: 'error',
        code: err.code ?? 'FETCH_FAILED',
        message: `资源不可用（${err.message}），且无缓存，已回退到内置占位图`,
      });
      this.noticeLog.push({ key, ...notices[0] });
      return {
        status: 'fallback',
        source: 'placeholder',
        value: this.placeholder(key),
        version: 0,
        notices,
      };
    }
  }

  async getThumbnail(key) {
    const result = await this.getResource(key);
    const entry = this.cache.get(key);
    if (result.source !== 'placeholder' && entry && this.thumbnailer) {
      if (!entry.thumbnail) {
        try {
          entry.thumbnail = await this.thumbnailer(entry.payload);
        } catch (err) {
          result.notices.push({
            level: 'warning',
            code: 'THUMBNAIL_FAILED',
            message: `缩略图生成失败（${err.message}），已回退到占位缩略图`,
          });
          entry.thumbnail = this.placeholder(key);
        }
      }
      return { ...result, thumbnail: entry.thumbnail };
    }
    const placeholder = this.placeholder(key);
    if (!result.notices.some((n) => n.code === 'THUMBNAIL_FAILED')) {
      result.notices.push({
        level: 'warning',
        code: 'THUMBNAIL_PLACEHOLDER',
        message: '无可用资源，缩略图回退为占位图',
      });
    }
    return { ...result, thumbnail: placeholder };
  }
}
