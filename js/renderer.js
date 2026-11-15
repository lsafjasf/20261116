import { fragmentShaderSource, vertexShaderSource } from "./scene-shader.js";
import { GLASS_DEFS, TILE_COLS, TILE_ROWS } from "./state.js";
import { cameraBasis, glassBox, lampPosition, viewportRects } from "./geometry.js";

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader 编译失败: ${log}`);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program 链接失败: ${log}`);
  }
  return program;
}

function uniformMap(gl, program) {
  const result = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i += 1) {
    const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, "");
    result[name] = gl.getUniformLocation(program, name);
  }
  return result;
}

function flattenVectors(vectors) {
  return new Float32Array(vectors.flat());
}

function hashBytes(bytes) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!this.gl) throw new Error("当前浏览器不支持 WebGL2");
    this.program = createProgram(this.gl);
    this.uniforms = uniformMap(this.gl, this.program);
    this.emptyVao = this.gl.createVertexArray();
    this.width = 0;
    this.height = 0;
    this.pixelRatio = 1;
    this.state = null;
    this.lastStats = { pixels: 0, tiles: 0, totalTiles: TILE_COLS * TILE_ROWS, duration: 0, mode: "init" };
    this.gl.disable(this.gl.DEPTH_TEST);
    this.gl.disable(this.gl.BLEND);
    this.gl.disable(this.gl.CULL_FACE);
  }

  resize(state, dpr = window.devicePixelRatio || 1) {
    this.state = state;
    const rect = this.canvas.getBoundingClientRect();
    this.pixelRatio = Math.min(Math.max(dpr, 1), 1.35);
    this.width = Math.max(640, Math.round(rect.width * this.pixelRatio));
    this.height = Math.max(420, Math.round(rect.height * this.pixelRatio));
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      return true;
    }
    return false;
  }

  setState(state) {
    this.state = state;
  }

  updateUniforms(state) {
    const gl = this.gl;
    const u = this.uniforms;
    const splitX = Math.max(1, Math.round(this.width * state.split));
    const viewAspect = splitX / this.height;
    const viewBAspect = Math.max(1, this.width - splitX) / this.height;
    const cameraA = cameraBasis(state.viewA);
    const cameraB = cameraBasis(state.viewB);

    gl.useProgram(this.program);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1f(u.uSplit, state.split);
    gl.uniform3fv(u.uEyeA, cameraA.eye);
    gl.uniform3fv(u.uRightA, cameraA.right);
    gl.uniform3fv(u.uUpA, cameraA.up);
    gl.uniform3fv(u.uForwardA, cameraA.forward);
    gl.uniform1f(u.uTanA, cameraA.tanHalfFov);
    gl.uniform1f(u.uAspectA, viewAspect);
    gl.uniform3fv(u.uEyeB, cameraB.eye);
    gl.uniform3fv(u.uRightB, cameraB.right);
    gl.uniform3fv(u.uUpB, cameraB.up);
    gl.uniform3fv(u.uForwardB, cameraB.forward);
    gl.uniform1f(u.uTanB, cameraB.tanHalfFov);
    gl.uniform1f(u.uAspectB, viewBAspect);

    const centers = [];
    const halves = [];
    const rotations = [];
    const colors = [];
    const densities = [];
    for (let i = 0; i < 3; i += 1) {
      const box = glassBox(i, state);
      centers.push(box.center);
      halves.push(box.half);
      rotations.push(box.rot);
      colors.push(GLASS_DEFS[i].color);
      densities.push(0.12 + (state.glasses[i].thickness / 30) * 0.68);
    }
    gl.uniform3fv(u.uGlassCenter, flattenVectors(centers));
    gl.uniform3fv(u.uGlassHalf, flattenVectors(halves));
    gl.uniform1fv(u.uGlassRot, new Float32Array(rotations));
    gl.uniform3fv(u.uGlassColor, flattenVectors(colors));
    gl.uniform1fv(u.uGlassDensity, new Float32Array(densities));

    const lampPositions = state.lamps.map((lamp, index) => lampPosition(lamp, index));
    const lampColors = state.lamps.map((_, index) => {
      const def = index === 0 ? [0.15, 0.94, 1.0] : [1.0, 0.3, 0.24];
      return def;
    });
    gl.uniform3fv(u.uLampPos, flattenVectors(lampPositions));
    gl.uniform3fv(u.uLampColor, flattenVectors(lampColors));
    gl.uniform1fv(u.uLampIntensity, new Float32Array(state.lamps.map((lamp) => lamp.intensity)));
    gl.uniform1f(u.uFogDensity, state.fog.density);
    gl.uniform1f(u.uFogHeight, state.fog.height);
  }

  render(state, options = {}) {
    const gl = this.gl;
    if (state) this.state = state;
    if (!this.state) return this.lastStats;
    const start = performance.now();
    this.updateUniforms(this.state);
    gl.bindVertexArray(this.emptyVao);

    const full = options.mode === "full" || !options.tiles?.length;
    if (full) {
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0.01, 0.015, 0.02, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.enable(gl.SCISSOR_TEST);
      for (const tile of options.tiles) {
        const x = Math.max(0, tile.x);
        const y = Math.max(0, tile.y);
        const w = Math.min(tile.w, this.width - x);
        const h = Math.min(tile.h, this.height - y);
        if (w <= 0 || h <= 0) continue;
        gl.scissor(x, this.height - (y + h), w, h);
        gl.viewport(x, this.height - (y + h), w, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, this.width, this.height);
    }

    gl.finish();
    const duration = performance.now() - start;
    const tiles = full ? TILE_COLS * TILE_ROWS : options.tiles.length;
    const pixels = full ? this.width * this.height : options.tiles.reduce((sum, tile) => sum + Math.min(tile.w, this.width - tile.x) * Math.min(tile.h, this.height - tile.y), 0);
    this.lastStats = { pixels, tiles, totalTiles: TILE_COLS * TILE_ROWS, duration, mode: full ? "full" : "dirty" };
    return this.lastStats;
  }

  readPixels() {
    const pixels = new Uint8Array(this.width * this.height * 4);
    this.gl.readPixels(0, 0, this.width, this.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  readPixelsTopDown() {
    const pixels = this.readPixels();
    const rowSize = this.width * 4;
    const flipped = new Uint8ClampedArray(pixels.length);
    for (let row = 0; row < this.height; row += 1) {
      const source = (this.height - row - 1) * rowSize;
      flipped.set(pixels.subarray(source, source + rowSize), row * rowSize);
    }
    return flipped;
  }

  hash() {
    return this.imageHash(this.readPixelsTopDown());
  }

  imageHash(pixels) {
    return hashBytes(pixels);
  }

  captureDataUrl(type = "image/png") {
    return this.canvas.toDataURL(type);
  }

  captureThumbnail(width = 360, height = 225) {
    const thumb = document.createElement("canvas");
    thumb.width = width;
    thumb.height = height;
    const context = thumb.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.drawImage(this.canvas, 0, 0, width, height);
    return thumb.toDataURL("image/jpeg", 0.77);
  }

  samplePixel(x, y) {
    const px = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    const pyFromTop = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    const glY = this.height - pyFromTop - 1;
    const pixel = new Uint8Array(4);
    this.gl.readPixels(px, glY, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
    return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
  }

  comparePixels(before, after) {
    let changed = 0;
    let totalDelta = 0;
    let minX = this.width;
    let minY = this.height;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < before.length; i += 4) {
      const delta = Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]);
      if (delta > 2) {
        changed += 1;
        totalDelta += delta;
        const index = i / 4;
        const x = index % this.width;
        const y = Math.floor(index / this.width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const total = this.width * this.height;
    return {
      changed,
      ratio: changed / total,
      meanDelta: changed ? totalDelta / changed : 0,
      bounds: changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    };
  }

  projectedLampPoints(state) {
    const viewports = viewportRects(state, this.width, this.height);
    return state.lamps.map((lamp, index) => {
      const position = lampPosition(lamp, index);
      return viewports.map((viewport) => {
        const camera = viewport.camera;
        const relative = [
          position[0] - camera.eye[0],
          position[1] - camera.eye[1],
          position[2] - camera.eye[2],
        ];
        const depth = relative[0] * camera.forward[0] + relative[1] * camera.forward[1] + relative[2] * camera.forward[2];
        if (depth <= 0) return null;
        const x = relative[0] * camera.right[0] + relative[1] * camera.right[1] + relative[2] * camera.right[2];
        const y = relative[0] * camera.up[0] + relative[1] * camera.up[1] + relative[2] * camera.up[2];
        const ndcX = x / (depth * camera.tanHalfFov * viewport.aspect);
        const ndcY = y / (depth * camera.tanHalfFov);
        return {
          x: viewport.x + (ndcX * 0.5 + 0.5) * viewport.w,
          y: (1 - (ndcY * 0.5 + 0.5)) * viewport.h,
        };
      });
    });
  }
}
