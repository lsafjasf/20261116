export const STATES = Object.freeze({
  CALM: 'calm',
  CHASE: 'chase',
  DANGER: 'danger',
});

export const STATE_ORDER = [STATES.CALM, STATES.CHASE, STATES.DANGER];

// Three-band classification with hysteresis so values near a threshold do not
// cause rapid flapping.
export class StateMachine {
  constructor(params, initial = STATES.CALM) {
    this.params = params;
    this.state = initial;
    this.lastChangeTime = 0;
  }

 update(params) {
    this.params = params;
  }

  // Returns the new state (possibly unchanged) for a given intensity at time t.
  evaluate(intensity, time) {
    const { thresholdCalmChase, thresholdChaseDanger, hysteresis } = this.params;
    const h = hysteresis ?? 0.02;
    let next = this.state;

    if (intensity >= thresholdChaseDanger) {
      next = STATES.DANGER;
    } else if (intensity >= thresholdCalmChase) {
      next = STATES.CHASE;
    } else {
      next = STATES.CALM;
    }

    // Only leave the current band after crossing by the hysteresis margin.
    if (next !== this.state) {
      const level = STATE_ORDER.indexOf(next);
      const current = STATE_ORDER.indexOf(this.state);
      if (level > current) {
        const upLimit = level === 2 ? thresholdChaseDanger : thresholdCalmChase;
        if (intensity < upLimit + h) next = this.state;
      } else {
        const downLimit = current === 2 ? thresholdChaseDanger : thresholdCalmChase;
        if (intensity > downLimit - h) next = this.state;
      }
    }

    if (next !== this.state) {
      this.state = next;
      this.lastChangeTime = time;
    }
    return this.state;
  }
}
