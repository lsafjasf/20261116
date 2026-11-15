import test from "node:test";
import assert from "node:assert/strict";
import { LayoutCache, LayoutService } from "../src/cache.js";
import { LayoutEngine } from "../src/engine.js";
import { createApproxMeasurer } from "../src/measure.js";
import { layoutString } from "../src/layout.js";

const style = {
  fontFamily: "sans-serif",
  fontWeight: 600,
  fontSize: 32,
  width: 500,
  align: "center",
  lineHeight: 1.5
};

test("identical text and style hit; candidates drop to zero", () => {
  const cache = new LayoutCache();
  const service = new LayoutService({
    engine: new LayoutEngine(createApproxMeasurer()),
    cache
  });
  const text = "重复测量的同一段字幕应该命中缓存。";
  const first = service.resolve(text, style);
  const second = service.resolve(text, style);
  assert.equal(first.cacheHit, false);
  assert.ok(first.candidates > 0);
  assert.equal(second.cacheHit, true);
  assert.equal(second.candidates, 0);
  assert.equal(layoutString(first.layout), layoutString(second.layout));
  assert.equal(cache.hits, 1);
  assert.equal(cache.misses, 1);
});

test("each style dimension invalidates the cache", () => {
  const cache = new LayoutCache();
  const service = new LayoutService({
    engine: new LayoutEngine(createApproxMeasurer()),
    cache
  });
  const text = "Style changes must never reuse a stale layout.";
  service.resolve(text, style);
  const changes = [
    { fontFamily: "Georgia, serif" },
    { fontWeight: 400 },
    { fontSize: 40 },
    { width: 420 },
    { align: "right" },
    { lineHeight: 1.2 }
  ];
  for (const change of changes) {
    const result = service.resolve(text, { ...style, ...change });
    assert.equal(result.cacheHit, false, JSON.stringify(change));
    assert.ok(result.candidates > 0);
  }
  assert.equal(cache.hits, 0);
  assert.equal(cache.misses, changes.length + 1);
});

test("LRU evicts the oldest entry and keeps recent layouts", () => {
  const cache = new LayoutCache(2);
  const engine = new LayoutEngine(createApproxMeasurer());
  const service = new LayoutService({ engine, cache });
  service.resolve("one", style);
  service.resolve("two", style);
  service.resolve("three", style);
  assert.equal(cache.size, 2);
  assert.equal(cache.evictions, 1);
  const recent = service.resolve("three", style);
  assert.equal(recent.cacheHit, true);
});

test("cache key ignores transforms but keeps content semantics", () => {
  const cache = new LayoutCache();
  const service = new LayoutService({
    engine: new LayoutEngine(createApproxMeasurer()),
    cache
  });
  const text = "Scroll and zoom do not change line geometry.";
  const first = service.resolve(text, style);
  const second = service.resolve(text, { ...style });
  assert.equal(second.cacheHit, true);
  assert.equal(layoutString(first.layout), layoutString(second.layout));
});
