// GLGuard wraps a WebGL2 context so that:
//  1. every GL call is blocked while the context is lost (no stale handles);
//  2. blocked calls and GL errors are counted as observable metrics;
//  3. GPU-side buffer/texture memory is estimated from actual uploads.

const SIZE_TABLE = {
  // WebGL2 constants -> bytes per component.
  0x1400: 1, 0x1401: 1, // BYTE, UNSIGNED_BYTE
  0x1402: 2, 0x1403: 2, // SHORT, UNSIGNED_SHORT
  0x1404: 4, 0x1405: 4, // INT, UNSIGNED_INT
  0x1406: 4,            // FLOAT
  0x8dd1: 2, 0x8dd2: 3, 0x8dd3: 4, // HALF_FLOAT, RGB32F-ish int24/10_10_10
};

const UPLOAD_TARGETS = new Set([
  0x8892, // ARRAY_BUFFER
  0x8893, // ELEMENT_ARRAY_BUFFER
  0x8a11, // UNIFORM_BUFFER
]);

export class GLGuard {
  constructor(gl) {
    this.realGL = gl;
    this.alive = true;
    this.blockedCalls = 0;
    this.glErrors = 0;
    this.gpuBytes = 0;
    this._boundBufferTarget = 0;
    this._bufferSizes = new Map();
    this._textureSizes = new Map();
    this._activeTextureUnit = 0;
    this._boundBuffers = new Map();

    const guard = this;
    this.api = new Proxy(gl, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        // On a dead context, hand back callable no-ops (and undefined for
        // constants) without ever touching the underlying driver. The actual
        // count happens when the no-op is invoked (see _invoke).
        if (!guard.alive) {
          return typeof value === "function"
            ? (...args) => guard._invoke(prop, value, target, args)
            : undefined;
        }
        if (typeof value !== "function") return value;
        return (...args) => guard._invoke(prop, value, target, args);
      },
      set(target, prop, value) {
        if (!guard.alive) {
          guard.blockedCalls++;
          return true;
        }
        return Reflect.set(target, prop, value);
      },
    });
  }

  markLost() { this.alive = false; }
  markRestored() {
    this.alive = true;
    this._boundBufferTarget = 0;
    this._bufferSizes.clear();
    this._textureSizes.clear();
  }

  _invoke(name, fn, target, args) {
    if (!this.alive) {
      this.blockedCalls++;
      return name.startsWith("get") ? null : undefined;
    }
    this._trackBefore(name, args);
    const result = fn.apply(target, args);
    this._trackAfter(name, args);
    if (name === "getError") {
      const err = result;
      if (err !== 0) this.glErrors++;
    }
    return result;
  }

  _trackBefore(name, args) {
    if (name === "bindBuffer") {
      this._boundBufferTarget = args[0];
      // null unbinds; remember the most recent handle per target.
      this._boundBuffers.set(args[0], args[1] ?? null);
    }
    if (name === "activeTexture") this._activeTextureUnit = args[0] - 0x84c0;
    if (name === "bufferData") {
      this._pendingBufferHandle = this._boundBuffers.get(args[0]) ?? null;
    }
  }

  _trackAfter(name, args) {
    if (name === "bufferData" && UPLOAD_TARGETS.has(args[0])) {
      const src = args[1];
      const bytes = src && src.byteLength ? src.byteLength : (args[2] ?? 0);
      this._accountBuffer(this._pendingBufferHandle, bytes);
    } else if (name === "texImage2D" && args.length >= 9) {
      this._accountTexture2D(args);
    } else if (name === "texImage3D" && args.length >= 10) {
      this._accountTexture3D(args);
    } else if (name === "texStorage3D" && args.length >= 7) {
      // (target, levels, internalformat, width, height, depth)
      const [target, , internalformat, width, height, depth] = args;
      const key = `tex3d:${target}:${this._activeTextureUnit}`;
      const bytes = textureByteSize(internalformat, width, height, depth, null);
      const prev = this._textureSizes.get(key) ?? 0;
      this.gpuBytes += bytes - prev;
      this._textureSizes.set(key, bytes);
    } else if (name === "deleteBuffer" && args[0]) {
      const size = this._bufferSizes.get(args[0]) ?? 0;
      this.gpuBytes -= size;
      this._bufferSizes.delete(args[0]);
    } else if (name === "deleteTexture" && args[0]) {
      const size = this._textureSizes.get(args[0]) ?? 0;
      this.gpuBytes -= size;
      this._textureSizes.delete(args[0]);
    }
  }

  _accountBuffer(key, bytes) {
    // Track by the buffer handle captured at bind time; re-upload replaces it.
    if (!key) return;
    const prev = this._bufferSizes.get(key) ?? 0;
    this.gpuBytes += bytes - prev;
    this._bufferSizes.set(key, bytes);
  }

  _accountTexture2D(args) {
    const [target, level, internalformat, width, height, , format, type, pixels] = args;
    const key = `tex2d:${target}:${this._activeTextureUnit}`;
    const bytes = textureByteSize(internalformat, width, height, 1, pixels);
    const prev = this._textureSizes.get(key) ?? 0;
    this.gpuBytes += bytes - prev;
    this._textureSizes.set(key, bytes);
  }

  _accountTexture3D(args) {
    const [target, level, internalformat, width, height, depth, , format, type, pixels] = args;
    const key = `tex3d:${target}:${this._activeTextureUnit}`;
    const bytes = textureByteSize(internalformat, width, height, depth, pixels);
    const prev = this._textureSizes.get(key) ?? 0;
    this.gpuBytes += bytes - prev;
    this._textureSizes.set(key, bytes);
  }
}

function textureByteSize(internalformat, w, h, d, pixels) {
  if (pixels && pixels.byteLength) return pixels.byteLength;
  const components = {
    0x1907: 3, 0x1908: 4, 0x1906: 1, // RGB, RGBA, ALPHA
    0x8814: 4, 0x8815: 3, 0x8229: 1, // RGBA32F, RGB32F, R32F
    0x8051: 1, 0x8227: 1, 0x8228: 4, // R8, RGB8, RGBA8
  }[internalformat] ?? 4;
  return w * h * d * components;
}

export function componentBytes(type) {
  return SIZE_TABLE[type] ?? 4;
}
