export const DEFAULT_FIXED_DT = 1 / 120;
export const DEFAULT_MAX_SUBSTEPS = 8;
export const MAX_FRAME_DELTA = 0.25;

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

export class FixedStepClock {
  constructor({
    fixedDt = DEFAULT_FIXED_DT,
    maxSubSteps = DEFAULT_MAX_SUBSTEPS,
    maxFrameDelta = MAX_FRAME_DELTA,
  } = {}) {
    if (!(fixedDt > 0) || !Number.isFinite(fixedDt)) {
      throw new RangeError("fixedDt must be a positive finite number");
    }
    if (!Number.isInteger(maxSubSteps) || maxSubSteps < 1) {
      throw new RangeError("maxSubSteps must be a positive integer");
    }
    this.fixedDt = fixedDt;
    this.maxSubSteps = maxSubSteps;
    this.maxFrameDelta = maxFrameDelta;
    this.reset();
  }

  reset() {
    this.accumulator = 0;
    this.alpha = 0;
    this.paused = false;
    this.totalSteps = 0;
    this.droppedSteps = 0;
    this.droppedSimTime = 0;
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    this.accumulator = 0;
    this.alpha = this.paused ? 1 : 0;
  }

  advance(frameSeconds, { timeScale = 1, onStep } = {}) {
    if (this.paused || typeof onStep !== "function") {
      this.alpha = this.paused ? 1 : this.alpha;
      return { steps: 0, alpha: this.alpha, droppedSteps: 0, clampedFrame: false };
    }

    const finiteFrame = Number.isFinite(frameSeconds) ? Math.max(0, frameSeconds) : 0;
    const finiteScale = Number.isFinite(timeScale) ? Math.max(0, timeScale) : 1;
    const clampedFrame = finiteFrame > this.maxFrameDelta;
    const frame = Math.min(finiteFrame, this.maxFrameDelta);
    this.accumulator += frame * finiteScale;

    let steps = 0;
    while (this.accumulator + Number.EPSILON >= this.fixedDt && steps < this.maxSubSteps) {
      onStep(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps += 1;
      this.totalSteps += 1;
    }

    let droppedSteps = 0;
    if (this.accumulator + Number.EPSILON >= this.fixedDt) {
      droppedSteps = Math.floor((this.accumulator + Number.EPSILON) / this.fixedDt);
      const droppedTime = droppedSteps * this.fixedDt;
      this.accumulator -= droppedTime;
      this.droppedSteps += droppedSteps;
      this.droppedSimTime += droppedTime;
    }

    this.accumulator = clampNumber(this.accumulator, 0, this.fixedDt);
    this.alpha = clampNumber(this.accumulator / this.fixedDt, 0, 1);

    return { steps, alpha: this.alpha, droppedSteps, clampedFrame };
  }
}

export const formatSimTime = (seconds) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalMillis = Math.round(safe * 1000);
  const minutes = Math.floor(totalMillis / 60000);
  const secs = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
};
