export class ThumbnailScheduler {
  #cache;
  #loadFrame;
  #concurrency;
  #onSlotState;
  #onStats;
  #slots = new Map();
  #queue = new Map();
  #active = 0;
  #generation = 0;
  #requestCounter = 0;
  #staleDrops = 0;
  #disposed = false;

  constructor({
    cache,
    loadFrame,
    concurrency = 3,
    onSlotState = () => {},
    onStats = () => {},
  }) {
    if (!cache || typeof loadFrame !== "function") {
      throw new TypeError("cache and loadFrame are required");
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    this.#cache = cache;
    this.#loadFrame = loadFrame;
    this.#concurrency = concurrency;
    this.#onSlotState = onSlotState;
    this.#onStats = onStats;
  }

  get queueLength() {
    return this.#queue.size + this.#active;
  }

  get pendingLength() {
    return this.#queue.size;
  }

  get activeLength() {
    return this.#active;
  }

  update(slots) {
    if (this.#disposed) return;
    const incoming = new Map(slots.map((slot) => [slot.slotId, slot]));
    for (const slotId of this.#slots.keys()) {
      if (!incoming.has(slotId)) {
        this.#slots.delete(slotId);
        this.#queue.delete(slotId);
      }
    }

    for (const slot of slots) {
      const previous = this.#slots.get(slot.slotId);
      const sameRequest =
        previous &&
        previous.key === slot.key &&
        previous.generation === this.#generation &&
        previous.state !== "error";

      if (sameRequest) {
        previous.timeMs = slot.timeMs;
        previous.priority = slot.priority;
        continue;
      }

      const requestId = ++this.#requestCounter;
      const next = {
        ...slot,
        requestId,
        generation: this.#generation,
        state: "loading",
      };
      this.#slots.set(slot.slotId, next);
      this.#onSlotState({
        ...next,
        state: "loading",
        message: "正在解码缩略帧",
      });
      this.#queue.delete(slot.slotId);
      this.#queue.set(slot.slotId, next);
    }

    this.#emit();
    this.#pump();
  }

  invalidate(reason = "cache invalidated") {
    this.#generation += 1;
    this.#cache.clear(reason);
    const slots = [...this.#slots.values()];
    this.#queue.clear();
    for (const slot of slots) {
      const next = {
        ...slot,
        requestId: ++this.#requestCounter,
        generation: this.#generation,
        state: "loading",
      };
      this.#slots.set(slot.slotId, next);
      this.#onSlotState({
        ...next,
        state: "fallback",
        message: "缓存已失效，正在自动重建",
      });
      this.#queue.set(slot.slotId, next);
    }
    this.#emit();
    this.#pump();
  }

  retryFailed() {
    for (const slot of this.#slots.values()) {
      if (slot.state !== "error") continue;
      const next = {
        ...slot,
        requestId: ++this.#requestCounter,
        state: "loading",
      };
      this.#slots.set(slot.slotId, next);
      this.#onSlotState({ ...next, state: "fallback", message: "正在重试失效缩略帧" });
      this.#queue.set(slot.slotId, next);
    }
    this.#emit();
    this.#pump();
  }

  async whenIdle() {
    while (this.queueLength > 0) {
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
  }

  metrics() {
    return {
      queueLength: this.queueLength,
      pending: this.pendingLength,
      active: this.activeLength,
      staleDrops: this.#staleDrops,
      slots: this.#slots.size,
      cache: this.#cache.metrics(),
    };
  }

  dispose() {
    this.#disposed = true;
    this.#queue.clear();
    this.#slots.clear();
    this.#cache.clear("scheduler disposed");
  }

  #pump() {
    if (this.#disposed) return;
    while (this.#active < this.#concurrency && this.#queue.size > 0) {
      const first = this.#queue.entries().next().value;
      const [slotId, slot] = first;
      this.#queue.delete(slotId);
      this.#active += 1;
      this.#loadSlot(slotId, slot);
    }
    this.#emit();
  }

  async #loadSlot(slotId, request) {
    try {
      const lookup = this.#cache.getOrLoad(
        request.key,
        (signal) =>
          this.#loadFrame({
            ...request,
            signal,
          }),
        {
          validate: (frame) => this.#validateFrame(frame, request),
        },
      );
      const frame = lookup.status === "hit" ? lookup.value : await lookup.promise;
      const current = this.#slots.get(slotId);
      if (!this.#isCurrent(current, request)) {
        this.#staleDrops += 1;
        return;
      }
      this.#validateFrame(frame, request);
      current.state = "ready";
      current.frame = frame;
      this.#onSlotState({
        ...current,
        state: "ready",
        frame,
        message: "缩略帧已锁定",
      });
    } catch (error) {
      const current = this.#slots.get(slotId);
      if (!this.#isCurrent(current, request)) {
        this.#staleDrops += 1;
        return;
      }
      current.state = "error";
      current.error = error;
      this.#onSlotState({
        ...current,
        state: "error",
        error,
        message: "缩略帧失效，已回退到安全占位",
      });
    } finally {
      this.#active -= 1;
      this.#emit();
      this.#pump();
    }
  }

  #isCurrent(current, request) {
    return Boolean(
      current &&
        current.requestId === request.requestId &&
        current.key === request.key &&
        current.generation === request.generation &&
        current.generation === this.#generation,
    );
  }

  #validateFrame(frame, request) {
    if (!frame || typeof frame !== "object") {
      throw new TypeError("frame result is missing");
    }
    if (!frame.canvas || frame.canvas.width !== request.width || frame.canvas.height !== request.height) {
      throw new RangeError("frame resolution does not match the request");
    }
    if (Math.round(frame.timeMs) !== Math.round(request.timeMs)) {
      throw new RangeError("frame timestamp does not match the request");
    }
    if (frame.key !== request.key || frame.revision !== request.revision) {
      throw new Error("frame identity does not match the request");
    }
  }

  #emit() {
    this.#onStats(this.metrics());
  }
}
