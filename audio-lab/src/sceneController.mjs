import { resolveConfig } from './sceneConfig.mjs';

// Owns scene graph construction/teardown. The graph topology is identical
// regardless of which resource manager is injected, which keeps the rendered
// audio output semantics stable across baseline and optimized builds.
export class SceneController {
  constructor(context, manager, cache, { onError = null } = {}) {
    this.context = context;
    this.manager = manager;
    this.cache = cache;
    this.onError = onError;
    this.currentScope = null;
    this.currentConfig = null;
    this.lastManifest = null;
    this._handlerFired = 0;
    this._frameSamples = [];
  }

  get frameStats() {
    const samples = this._frameSamples;
    if (samples.length === 0) return { last: 0, avg: 0, max: 0, samples: 0 };
    const sum = samples.reduce((a, b) => a + b, 0);
    return {
      last: samples[samples.length - 1],
      avg: sum / samples.length,
      max: Math.max(...samples),
      samples: samples.length,
    };
  }

  enterScene(rawConfig) {
    const started = now();
    const { value: config } = this.cache.get(rawConfig.id, () => resolveConfig(rawConfig));
    this.currentConfig = config;
    const scope = `scene:${config.id}:${this._frameSamples.length}`;
    this.currentScope = scope;
    this.manager.beginScope(scope);

    const manifest = { id: config.id, voices: [] };
    const master = this.manager.track(this.context.createGain(), 'masterGain');
    master.gain.setValueAtTime(config.gain, this.context.currentTime);
    this.manager.connect(master, this.context.destination);

    for (let voice = 0; voice < config.voices; voice += 1) {
      try {
        const osc = this.manager.track(
          this.context.createOscillator(), 'oscillator');
        const voiceGain = this.manager.track(this.context.createGain(), 'voiceGain');
        const delay = this.manager.track(
          this.context.createDelay(1), 'delay');

        osc.type = config.oscType;
        const freq = config.freq * (1 + voice * 0.25);
        osc.frequency.setValueAtTime(freq, this.context.currentTime);
        voiceGain.gain.setValueAtTime(config.gain / Math.max(1, config.voices),
          this.context.currentTime);
        delay.delayTime.setValueAtTime(config.delay, this.context.currentTime);

        this.manager.connect(osc, voiceGain);
        this.manager.connect(voiceGain, delay);
        this.manager.connect(delay, master);

        this.manager.on(osc, 'ended', () => {
          this._handlerFired += 1;
        });
        osc.start(this.context.currentTime);

        manifest.voices.push({
          oscType: config.oscType, freq,
          gain: config.gain / Math.max(1, config.voices),
          delay: config.delay,
        });
      } catch (error) {
        this.onError?.({ where: 'enterScene', config: config.id, error });
      }
    }

    this.lastManifest = manifest;
    this._frameSamples.push(now() - started);
    return manifest;
  }

  exitScene() {
    if (!this.currentScope) return 0;
    const started = now();
    const released = this.manager.endScope(this.currentScope);
    this.currentScope = null;
    this.currentConfig = null;
    this._frameSamples.push(now() - started);
    return released;
  }

  async switchTo(rawConfig) {
    this.exitScene();
    const manifest = this.enterScene(rawConfig);
    return manifest;
  }

  get handlerFired() {
    return this._handlerFired;
  }
}

function now() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  const hr = process.hrtime.bigint();
  return Number(hr) / 1e6;
}
