// Keyboard -> two-player input. Held keys are sampled once per fixed tick.
export class KeyboardInput {
  constructor() {
    this.keys = new Set();
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' '].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  sample() {
    const k = this.keys;
    return {
      winch: (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0),
      leftY: (k.has('a') ? -1 : 0) + (k.has('d') ? 1 : 0),
      steerX: (k.has('arrowright') ? 1 : 0) - (k.has('arrowleft') ? 1 : 0),
      steerY: (k.has('arrowdown') ? 1 : 0) - (k.has('arrowup') ? 1 : 0),
      rightY: (k.has('.') ? 1 : 0) - (k.has(',') ? 1 : 0),
      leftJerk: k.has('q'),
      rightJerk: k.has('/'),
      order: ['left', 'right'],
    };
  }

  // Discrete jerk keys must fire once per press, not every held tick.
  consumePressed(prevSet) {
    const now = this.keys;
    const leftJerk = now.has('q') && !prevSet.has('q');
    const rightJerk = now.has('/') && !prevSet.has('/');
    return { leftJerk, rightJerk, snapshot: new Set(now) };
  }
}
