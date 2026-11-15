import { SCENE_VERT, buildSceneFragment } from '../shaders/scene.glsl.js';

const QUALITY = Object.freeze({
  low:  { fogSteps: 24, fogOctaves: 2, internalScale: 0.6, label: 'low' },
  high: { fogSteps: 96, fogOctaves: 4, internalScale: 1.0, label: 'high' },
});

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + log);
  }
  return sh;
}

export class FogEngine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.objectCount = 0;
    this.quality = null;
    this.lastRegions = [];
    this._initCounters();
    this._wrapContextLoss();
  }

  _initCounters() {
    const gl = this.gl;
    this.created = { shader: 0, program: 0, buffer: 0, texture: 0, fbo: 0, rbo: 0 };
    const self = this;
    const createMap = {
      createShader: 'shader', createProgram: 'program', createBuffer: 'buffer',
      createTexture: 'texture', createFramebuffer: 'fbo',
      createRenderbuffer: 'rbo',
    };
    for (const [name, key] of Object.entries(createMap)) {
      const orig = gl[name].bind(gl);
      gl[name] = (...args) => {
        const obj = orig(...args);
        if (obj) {
          self.created[key] += 1;
          self.objectCount += 1;
        }
        return obj;
      };
    }
    const deleteMap = {
      deleteShader: 'shader', deleteProgram: 'program', deleteBuffer: 'buffer',
      deleteTexture: 'texture', deleteFramebuffer: 'fbo',
      deleteRenderbuffer: 'rbo',
    };
    for (const [name, key] of Object.entries(deleteMap)) {
      const orig = gl[name].bind(gl);
      gl[name] = (obj) => {
        if (obj) self.objectCount -= 1;
        if (obj && self.created[key] > 0) self.created[key] -= 1;
        return orig(obj);
      };
    }
    const origDelVAO = gl.deleteVertexArray.bind(gl);
    gl.deleteVertexArray = (obj) => {
      if (obj) self.objectCount -= 1;
      return origDelVAO(obj);
    };
  }

  _wrapContextLoss() {
    this.lost = false;
    this.lostHandlers = [];
    this.gl.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.objectCount = 0; // 上下文丢失会隐式回收全部 GL 对象
      this.program = this.vao = this.fbo = this.tex = null;
      this.lostHandlers.forEach((fn) => fn());
    });
  }

  onContextLost(fn) { this.lostHandlers.push(fn); }

  // 仅在质量档变化时重建 program 与离屏缓冲 —— 普通参数变化不会走到这里。
  buildQuality(quality, width, height) {
    const gl = this.gl;
    this._disposeResources();
    const cfg = QUALITY[quality];
    if (!cfg) throw new Error('unknown quality: ' + quality);
    this.quality = quality;
    this.cfg = cfg;
    const vs = compile(gl, gl.VERTEX_SHADER, SCENE_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, buildSceneFragment());
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('program link failed: ' + gl.getProgramInfoLog(this.program));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.vao = gl.createVertexArray();
    this.target = { width: 0, height: 0 };
    this._resizeFbo(width, height);
    this.u = {};
    const n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(this.program, i);
      this.u[info.name.replace('[0]', '')] =
        gl.getUniformLocation(this.program, info.name);
    }
    return { rebuilt: true, objects: this.objectCount };
  }

  _resizeFbo(width, height) {
    const gl = this.gl;
    const scale = this.cfg.internalScale;
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    if (this.target.width === w && this.target.height === h) return false;
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      gl.deleteTexture(this.tex);
    }
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA,
      gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this.tex, 0);
    this.target = { width: w, height: h };
    return true;
  }

  _disposeResources() {
    const gl = this.gl;
    if (this.lost) {
      this.program = this.vao = this.fbo = this.tex = null;
      return;
    }
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.tex) gl.deleteTexture(this.tex);
    this.program = this.vao = this.fbo = this.tex = null;
  }
  _sunVector(az, el) {
    const a = az * Math.PI / 180;
    const e = el * Math.PI / 180;
    return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
  }

  // 按受影响区域上传 uniform；区域集合为空时直接跳过 GL 调用。
  applyState(state, changedRegions) {
    if (this.lost) return { skipped: 'context-lost' };
    const gl = this.gl;
    const regions = changedRegions || [];
    const uploads = [];
    gl.useProgram(this.program);

    const need = new Set(regions);
    need.add('time'); // 每帧时间由 RAF 单独驱动
    if (need.size === 0) return { uploads };

    if (need.has('viewport')) this._resizeFbo(state.width, state.height);

    const set1f = (loc, v) => gl.uniform1f(loc, v);
    if (need.has('camera') || need.has('viewport')) {
      set1f(this.u.uCamAz, state.camAzimuth);
      set1f(this.u.uCamEl, state.camElevation);
      gl.uniform2f(this.u.uResolution, this.target.width, this.target.height);
      gl.uniform3f(this.u.uCamPos, 0, 22, 58);
      uploads.push('camera', 'resolution');
    }
    if (need.has('time') || need.has('wind') || need.has('weather')) {
      gl.uniform1f(this.u.uTime, state.simTime);
      const wa = state.windDir * Math.PI / 180;
      gl.uniform2f(this.u.uWind,
        Math.sin(wa) * state.windSpeed, Math.cos(wa) * state.windSpeed);
      uploads.push('time', 'wind');
    }
    if (need.has('humidity') || need.has('weather')) {
      gl.uniform1f(this.u.uHumidity, state.humidity);
      uploads.push('humidity');
    }
    if (need.has('sun') || need.has('weather')) {
      gl.uniform3fv(this.u.uSunDir, this._sunVector(state.sunAzimuth, state.sunElevation));
      const overcast = state.humidity;
      gl.uniform3f(this.u.uSunColor,
        1.0 - overcast * 0.45, 0.95 - overcast * 0.35, 0.85 - overcast * 0.2);
      gl.uniform3f(this.u.uSkyZenith,
        0.12 + overcast * 0.28, 0.22 + overcast * 0.26, 0.42 - overcast * 0.1);
      gl.uniform3f(this.u.uSkyHorizon,
        0.55 + overcast * 0.18, 0.58 + overcast * 0.15, 0.6 - overcast * 0.08);
      uploads.push('sun');
    }
    gl.uniform1f(this.u.uFarPlane, 180);
    gl.uniform1f(this.u.uFogStep, 180 / this.cfg.fogSteps);
    gl.uniform1f(this.u.uFogOctaves, this.cfg.fogOctaves);
    this.lastRegions = regions;
    this.lastUploads = uploads;
    return { uploads };
  }

  render(debugMask = 0) {
    if (this.lost) return false;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.target.width, this.target.height);
    gl.useProgram(this.program);
    gl.uniform1i(this.u.uDebugMask, debugMask);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 低质量档以线性放大回全分辨率 —— 与高质量档共享同一轮廓。
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.blitFramebuffer(
      0, 0, this.target.width, this.target.height,
      0, 0, this.canvas.width, this.canvas.height,
      gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  // 默认从默认 framebuffer（blit 后的全分辨率画布）读，
  // 保证高/低质量档的哈希与掩码在同一尺寸下逐像素可比。
  readPixels(target = 'color', source = 'canvas') {
    const gl = this.gl;
    const useInternal = source === 'internal';
    const w = useInternal ? this.target.width : this.canvas.width;
    const h = useInternal ? this.target.height : this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, useInternal ? this.fbo : null);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: w, height: h, pixels: px, debug: target === 'mask' };
  }

  forceContextLoss() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (!ext) throw new Error('WEBGL_lose_context unavailable');
    ext.loseContext();
    return ext;
  }

  restoreContext(ext) {
    return new Promise((resolve) => {
      this.gl.canvas.addEventListener('webglcontextrestored', () => {
        this.lost = false;
        this.buildQuality(this.quality, this.canvas.width, this.canvas.height);
        resolve();
      }, { once: true });
      ext.restoreContext();
    });
  }
}

export { QUALITY };
