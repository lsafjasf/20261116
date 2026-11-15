import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_MESSAGES,
  VersionedResourceCache,
  createThumbnailFallback,
  promiseWithTimeout,
} from "../src/core/fallback.js";
import { createSpriteFrame } from "../src/core/sprite.js";

test("invalid cache is evicted instead of serving stale content", async () => {
  const cache = new VersionedResourceCache({ ttlMs: 1000, now: () => 0 });
  const first = await cache.getOrLoad("preview", {
    version: 1,
    loader: async () => "old-pixels",
    fallback: async () => "unused",
  });
  assert.equal(first.value, "old-pixels");
  cache.bumpVersion("preview");
  const result = await cache.getOrLoad("preview", {
    version: 3,
    loader: async () => {
      throw new Error("offline");
    },
    fallback: async ({ message }) => `rebuilt:${message}`,
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.stale, false);
  assert.equal(result.value.includes("old-pixels"), false);
  assert.equal(result.message, FALLBACK_MESSAGES.VERSION);
  assert.equal(cache.entries.has("preview"), false);
});

test("expired cache and forced invalid cache cannot leak old pixels", async () => {
  let clock = 0;
  const cache = new VersionedResourceCache({ ttlMs: 10, now: () => clock });
  await cache.getOrLoad("thumb", {
    loader: async () => "old-thumb",
    fallback: async () => "unused",
  });
  clock = 20;
  const expired = await cache.getOrLoad("thumb", {
    loader: async () => {
      throw new Error("decode failed");
    },
    fallback: async () => "fresh-thumb",
  });
  assert.equal(expired.value, "fresh-thumb");
  assert.equal(expired.message, FALLBACK_MESSAGES.EXPIRED);

  const forced = await cache.getOrLoad("thumb", {
    forceInvalid: true,
    loader: async () => {
      throw new Error("decode failed");
    },
    fallback: async () => "source-rebuild",
  });
  assert.equal(forced.value, "source-rebuild");
  assert.notEqual(forced.value, "old-thumb");
});

test("async timeout falls back without returning a blank value", async () => {
  const cache = new VersionedResourceCache();
  const result = await cache.getOrLoad("slow", {
    timeoutMs: 5,
    loader: () => new Promise(() => {}),
    fallback: async ({ message }) => ({ message, render: "color-placeholder" }),
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.value.render, "color-placeholder");
  assert.equal(result.message, FALLBACK_MESSAGES.TIMEOUT);
  await assert.rejects(promiseWithTimeout(new Promise(() => {}), 5), /timed out/);
});

test("thumbnail decode failure yields a labeled color placeholder", () => {
  const fallback = createThumbnailFallback(createSpriteFrame("thumb-004", 4));
  assert.equal(fallback.kind, "placeholder");
  assert.equal(fallback.id, "thumb-004");
  assert.equal(fallback.label, "004");
  assert.match(fallback.color, /^#[\da-f]{6}$/);
  assert.equal(fallback.message, FALLBACK_MESSAGES.THUMBNAIL);
});
