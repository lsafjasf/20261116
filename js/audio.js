/*
 * Web Audio engine for the lighthouse game.
 * Motor hum tracks lamp rotation speed, a filtered sweep tracks beam
 * direction/power, and an alarm fires on overheat / failure events.
 * Everything can be torn down and reset so replays start silent.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.LighthouseAudio = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.nodes = {};
      this.running = false;
      this.lastEventSeen = 0;
    }

    // Lazily created inside a user gesture (browser autoplay policy).
    ensureContext() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      }
      const Ctx = (typeof window !== 'undefined') &&
        (window.AudioContext || window.webkitAudioContext);
      if (!Ctx) return null;
      this.ctx = new Ctx();
      this._buildGraph();
      return this.ctx;
    }

    _buildGraph() {
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.0;
      this.master.connect(ctx.destination);

      // Rotation motor: low oscillator whose frequency follows turn rate.
      const motor = ctx.createOscillator();
      motor.type = 'sawtooth';
      motor.frequency.value = 55;
      const motorGain = ctx.createGain();
      motorGain.gain.value = 0.12;
      const motorFilter = ctx.createBiquadFilter();
      motorFilter.type = 'lowpass';
      motorFilter.frequency.value = 240;
      motor.connect(motorFilter).connect(motorGain).connect(this.master);
      motor.start();

      // Beam tone: sine whose pan + pitch reflect beam heading and power.
      const beam = ctx.createOscillator();
      beam.type = 'sine';
      beam.frequency.value = 220;
      const beamGain = ctx.createGain();
      beamGain.gain.value = 0.0;
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      beam.connect(beamGain);
      if (panner) beamGain.connect(panner).connect(this.master);
      else beamGain.connect(this.master);
      beam.start();

      this.nodes = {
        motor, motorGain, motorFilter, beam, beamGain, panner
      };
      this.running = true;
    }

    setEnabled(on) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.linearRampToValueAtTime(on ? 0.9 : 0.0, t + 0.15);
    }

    // Called every render frame with the latest simulation snapshot.
    update(snapshot, rotationInput) {
      if (!this.ctx || !this.running) return;
      const t = this.ctx.currentTime;
      const { motor, motorFilter, beam, beamGain, panner } = this.nodes;
      const rotMag = Math.abs(rotationInput || 0);

      motor.frequency.setTargetAtTime(48 + rotMag * 130, t, 0.05);
      motorFilter.frequency.setTargetAtTime(180 + rotMag * 520, t, 0.05);

      if (snapshot.lampOn && (snapshot.mode === 'running' ||
          snapshot.mode === 'overheat')) {
        const headingPan = Math.sin(snapshot.angle);
        if (panner) panner.pan.setTargetAtTime(headingPan, t, 0.08);
        beam.frequency.setTargetAtTime(
          180 + snapshot.power * 320 + (snapshot.mode === 'overheat' ? 90 : 0),
          t, 0.08);
        beamGain.gain.setTargetAtTime(
          snapshot.mode === 'overheat' ? 0.16 : 0.07 + snapshot.power * 0.08,
          t, 0.1);
      } else {
        beamGain.gain.setTargetAtTime(0.0, t, 0.12);
      }

      // Event-driven one-shots: overheat, dock, failure, success.
      for (const ev of snapshot._events || []) {
        if (ev.step <= this.lastEventSeen) continue;
        this._oneShot(ev);
      }
      this.lastEventSeen = (snapshot._events || []).reduce(
        (m, e) => Math.max(m, e.step), this.lastEventSeen);
    }

    _oneShot(ev) {
      const ctx = this.ctx;
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain).connect(this.master);
      const t = ctx.currentTime;
      if (ev.type === 'overheat' || ev.type === 'fail') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(ev.type === 'fail' ? 140 : 320, t);
        osc.frequency.exponentialRampToValueAtTime(70, t + 0.5);
      } else if (ev.type === 'dock' || ev.type === 'success') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.exponentialRampToValueAtTime(880, t + 0.35);
      } else {
        return;
      }
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      osc.start(t);
      osc.stop(t + 0.65);
    }

    reset() {
      this.lastEventSeen = 0;
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(0.0, t);
      if (this.nodes.beamGain) {
        this.nodes.beamGain.gain.setValueAtTime(0.0, t);
      }
      if (this.nodes.motor) this.nodes.motor.frequency.setValueAtTime(55, t);
    }

    dispose() {
      this.running = false;
      if (this.ctx) {
        this.ctx.close().catch(() => {});
        this.ctx = null;
        this.nodes = {};
      }
    }
  }

  return { AudioEngine };
});
