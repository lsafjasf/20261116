import test from "node:test";
import assert from "node:assert/strict";
import { FrameCache, makeFrameKey } from "../../src/core/frame-cache.js";
import { ThumbnailScheduler } from "../../src/core/thumbnail-scheduler.js";

function key(timeMs = 1000, width = 192, height = 108, cropAspect = "16:9", revision = 1) {
  return makeFrameKey({ sourceId: "unit", revision, timeMs, width, height, cropAspect });
}

function fakeFrame(request) {
  return {
    canvas: { width: request.width, height: request.height },
    key: request.key,
    revision: request.revision,
    timeMs: request.timeMs,
    width: request.width,
    height: request.height,
  };
}

test("默认参数：时间或分辨率不同会产生不同缓存键并命中 LRU", async () => {
  const cache = new FrameCache({ capacity: 2 });
  const first = key(1000, 192, 108);
  const second = key(2000, 192, 108);
  const third = key(1000, 108, 192);
  assert.notEqual(first, second);
  assert.notEqual(first, third);
  assert.notEqual(first, key(1000, 192, 108, "9:16"));

  let loads = 0;
  const load = async () => {
    loads += 1;
    return `frame-${loads}`;
  };
  const miss = cache.getOrLoad(first, load);
  assert.equal(miss.status, "miss");
  assert.equal(await miss.promise, "frame-1");
  const hit = cache.getOrLoad(first, load);
  assert.equal(hit.status, "hit");
  assert.equal(hit.value, "frame-1");
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 1);
  assert.equal(cache.hitRate, 0.5);

  await cache.getOrLoad(second, load).promise;
  assert.equal(cache.get(first), "frame-1");
  await cache.getOrLoad(third, load).promise;
  assert.equal(cache.peek(second), undefined, "least recently used frame is evicted");
  assert.equal(cache.peek(first), "frame-1");
  assert.equal(cache.peek(third), "frame-3");
  assert.equal(cache.stats.evictions, 1);
});

test("边界参数：容量为 1、并发为 1 且末尾时间仍可被调度", async () => {
  const cache = new FrameCache({ capacity: 1 });
  await cache.getOrLoad(key(0), async () => "zero").promise;
  await cache.getOrLoad(key(120000), async () => "end").promise;
  assert.equal(cache.size, 1);
  assert.equal(cache.peek(key(0)), undefined);
  assert.equal(cache.peek(key(120000)), "end");

  assert.throws(() => new FrameCache({ capacity: 0 }), RangeError);
  assert.throws(() => key(-1), RangeError);
  assert.throws(() => key(0, 0, 108), RangeError);
  assert.throws(() => key(0, 192, -1), RangeError);

  const scheduler = new ThumbnailScheduler({
    cache: new FrameCache({ capacity: 8 }),
    concurrency: 1,
    loadFrame: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 6));
      return fakeFrame(request);
    },
  });
  scheduler.update(
    Array.from({ length: 6 }, (_, index) => ({
      slotId: `slot-${index}`,
      timeMs: index === 5 ? 120000 : index * 1000,
      key: key(index === 5 ? 120000 : index * 1000),
      revision: 1,
      width: 192,
      height: 108,
      cropAspect: "16:9",
      priority: index,
    })),
  );
  await scheduler.whenIdle();
  assert.equal(scheduler.metrics().queueLength, 0);
  assert.equal(scheduler.metrics().cache.inflight, 0);
  assert.equal(scheduler.metrics().staleDrops, 0);
});

test("异常参数：失败结果不缓存，清空后旧异步结果不能回填", async () => {
  const cache = new FrameCache({ capacity: 4 });
  const failedKey = key(500);
  const failed = cache.getOrLoad(failedKey, async () => {
    throw new Error("decode failed");
  });
  await assert.rejects(failed.promise, /decode failed/);
  assert.equal(cache.peek(failedKey), undefined);
  assert.equal(cache.stats.failures, 1);

  let release;
  const slowKey = key(600);
  const slow = cache.getOrLoad(
    slowKey,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  cache.clear("test invalidation");
  release("stale-frame");
  assert.equal(await slow.promise, "stale-frame");
  assert.equal(cache.peek(slowKey), undefined);
  assert.equal(cache.generation, 1);
});

test("异常参数：帧身份校验失败时不写入缓存", async () => {
  const cache = new FrameCache({ capacity: 4 });
  const request = key(700);
  const result = cache.getOrLoad(
    request,
    async () => ({ timeMs: 701, key: request, revision: 1 }),
    {
      validate: (frame) => {
        if (Math.round(frame.timeMs) !== 700) throw new RangeError("timestamp mismatch");
      },
    },
  );
  await assert.rejects(result.promise, /timestamp mismatch/);
  assert.equal(cache.peek(request), undefined);
});

test("异常参数：较旧请求晚到时不覆盖较新请求", async () => {
  const pending = new Map();
  const ready = [];
  const cache = new FrameCache({ capacity: 8 });
  const scheduler = new ThumbnailScheduler({
    cache,
    concurrency: 2,
    onSlotState: (state) => {
      if (state.state === "ready") ready.push(state);
    },
    loadFrame: (request) =>
      new Promise((resolve) => {
        pending.set(request.key, () => resolve(fakeFrame(request)));
      }),
  });
  const oldRequest = {
    slotId: "same-slot",
    timeMs: 1000,
    key: key(1000),
    revision: 1,
    width: 192,
    height: 108,
    cropAspect: "16:9",
  };
  const newRequest = {
    ...oldRequest,
    timeMs: 3000,
    key: key(3000),
  };
  scheduler.update([oldRequest]);
  scheduler.update([newRequest]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.size, 2, "both requests were started");

  pending.get(newRequest.key)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending.get(oldRequest.key)();
  await scheduler.whenIdle();

  assert.equal(ready.length, 1);
  assert.equal(ready[0].timeMs, newRequest.timeMs);
  assert.equal(ready[0].frame.key, newRequest.key);
  assert.equal(scheduler.metrics().staleDrops, 1);
});
