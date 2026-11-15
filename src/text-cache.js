export class TextCommandCache {
  constructor(capacity = 512) {
    this.capacity = Math.max(1, capacity);
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  _key(text) {
    return `${text.label}|${text.font}|${text.color}|${text.background}`;
  }

  prepare(text, ctx) {
    const key = this._key(text);
    const cached = this.entries.get(key);
    if (cached) {
      this.hits += 1;
      this.entries.delete(key);
      this.entries.set(key, cached);
      text.width = cached.width;
      text.height = cached.height;
      return cached;
    }

    this.misses += 1;
    ctx.save();
    ctx.font = text.font;
    const metrics = ctx.measureText(text.label);
    ctx.restore();
    const command = {
      key,
      label: text.label,
      font: text.font,
      color: text.color,
      background: text.background,
      width: Math.ceil(metrics.width),
      height: text.fontSize + 2,
    };
    text.width = command.width;
    text.height = command.height;
    this.entries.set(key, command);
    if (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
    return command;
  }

  get hitRate() {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  resetStats() {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}
