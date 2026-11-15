import test from "node:test";
import assert from "node:assert/strict";
import { createSceneEngine, applyChange, runComparison } from "../src/scenarios.js";

test("initial scene renders with valid dependency graph", () => {
  const engine = createSceneEngine();
  const commands = engine.render();
  const metrics = engine.getMetrics();
  assert.equal(metrics.nodeCount, 40);
  assert.equal(metrics.danglingCount, 0);
  assert.ok(commands.length > 0);
  assert.equal(engine.validateInvariants().length, 0);
});

test("parent resize invalidates its subtree and ancestors, not sibling subtrees", () => {
  const engine = createSceneEngine();
  engine.render();
  const initialHash = engine.visualHash();
  const insightLayoutKey = engine.getNode("insight").cache.layout.key;
  const insightPaintKey = engine.getNode("insight").cache.paint.key;
  const notesLayoutKey = engine.getNode("notes").cache.layout.key;

  engine.updateNode("hero", { width: 420 }, "resize:parent");
  const commands = engine.render();
  const invalidated = new Set(engine.lastInvalidation.ids);

  assert.notEqual(engine.visualHash(commands), initialHash);
  assert.ok(invalidated.has("hero"));
  assert.ok(invalidated.has("heroTitle"));
  assert.ok(!invalidated.has("insight"));
  assert.ok(!invalidated.has("notes"));
  assert.equal(engine.getNode("insight").cache.layout.key, insightLayoutKey);
  assert.equal(engine.getNode("insight").cache.paint.key, insightPaintKey);
  assert.equal(engine.getNode("notes").cache.layout.key, notesLayoutKey);
  assert.ok(engine.lastUpdate.layoutHits > 0);
  assert.ok(engine.lastInvalidation.layoutCandidates < engine.nodes.size);
  assert.equal(engine.validateInvariants().length, 0);
});

test("height-only parent changes also refresh descendant layout", () => {
  const engine = createSceneEngine();
  engine.render();
  const oldArtworkY = engine.getNode("heroFooter").cache.layout.worldY;
  const oldArtworkHeight = engine.getNode("heroArtwork").cache.layout.height;

  engine.updateNode("hero", { height: 520 }, "resize:parent");
  engine.render();

  assert.notEqual(engine.getNode("heroFooter").cache.layout.worldY, oldArtworkY);
  assert.equal(engine.getNode("heroArtwork").cache.layout.height, oldArtworkHeight);
  assert.ok(engine.lastInvalidation.ids.includes("heroFooter"));
  assert.equal(engine.getNode("insight").cache.layoutDirty, false);
  assert.equal(engine.validateInvariants().length, 0);
});

test("inherited font changes invalidate font consumers without touching sibling branches", () => {
  const engine = createSceneEngine();
  engine.render();
  const copyLayoutKey = engine.getNode("heroCopy").cache.layout.key;
  const copyPaintKey = engine.getNode("heroCopy").cache.paint.key;
  const insightPaintKey = engine.getNode("insight").cache.paint.key;
  const oldTitle = engine.getNode("titleA").cache.layout.key;

  engine.setFontSize("heroTitle", 78);
  engine.render();
  const invalidated = new Set(engine.lastInvalidation.ids);

  assert.notEqual(engine.getNode("titleA").cache.layout.key, oldTitle);
  assert.equal(engine.getNode("heroCopy").cache.layout.key, copyLayoutKey);
  assert.equal(engine.getNode("heroCopy").cache.paint.key, copyPaintKey);
  assert.equal(engine.getNode("insight").cache.paint.key, insightPaintKey);
  assert.ok(invalidated.has("heroTitle"));
  assert.ok(!invalidated.has("heroCopy"));
  assert.ok(!invalidated.has("insight"));
  assert.equal(engine.validateInvariants().length, 0);
});

test("font family dependencies cover descendants that override size but inherit family", () => {
  const engine = createSceneEngine();
  engine.render();
  const latinLayoutKey = engine.getNode("titleLatin").cache.layout.key;
  const copyPaintKey = engine.getNode("heroCopy").cache.paint.key;

  engine.updateNode("heroTitle", { fontFamily: "monospace" }, "font:family");
  engine.render();

  assert.notEqual(engine.getNode("titleLatin").cache.layout.key, latinLayoutKey);
  assert.equal(engine.getNode("heroCopy").cache.paint.key, copyPaintKey);
  assert.ok(engine.lastInvalidation.ids.includes("titleLatin"));
  assert.equal(engine.validateInvariants().length, 0);
});

test("visibility toggles paint only and can restore the exact prior output", () => {
  const engine = createSceneEngine();
  const initialCommands = engine.render();
  const initialHash = engine.visualHash(initialCommands);
  const artworkLayoutKey = engine.getNode("heroArtwork").cache.layout.key;
  const artworkPaintKey = engine.getNode("heroArtwork").cache.paint.key;

  engine.setVisible("heroArtwork", false);
  const hiddenCommands = engine.render();
  const hiddenHash = engine.visualHash(hiddenCommands);

  assert.notEqual(hiddenHash, initialHash);
  assert.equal(engine.lastInvalidation.layoutCandidates, 0);
  assert.ok(engine.lastInvalidation.paintCandidates > 0);
  assert.equal(engine.getNode("heroArtwork").cache.layout.key, artworkLayoutKey);
  assert.notEqual(engine.getNode("heroArtwork").cache.paint.key, artworkPaintKey);

  engine.setVisible("heroArtwork", true);
  const restoredCommands = engine.render();
  assert.equal(engine.visualHash(restoredCommands), initialHash);
  assert.equal(engine.validateInvariants().length, 0);
});

test("explicit cache keys recover from a missed invalidation instead of showing stale output", () => {
  const engine = createSceneEngine();
  const initial = engine.render();
  const initialHeroWidth = engine.getNode("hero").cache.layout.width;

  engine.getNode("hero").width = 390;
  const recovered = engine.render();

  assert.notEqual(engine.getNode("hero").cache.layout.width, initialHeroWidth);
  assert.equal(engine.getNode("hero").cache.layout.width, 390);
  assert.notEqual(engine.visualHash(recovered), engine.visualHash(initial));
  assert.ok(engine.lastUpdate.keyRecoveries > 0);
  assert.equal(engine.validateInvariants().length, 0);
});

test("deleting a subtree clears nodes and caches without dangling references", () => {
  const engine = createSceneEngine();
  engine.render();
  const beforeNodes = engine.nodes.size;
  const beforeEntries = engine.getCacheEntries();

  const result = engine.deleteNode("heroArtwork");
  engine.render();

  assert.equal(result.deletedCount, 5);
  assert.equal(engine.nodes.size, beforeNodes - 5);
  assert.equal(engine.getNode("artSun"), null);
  assert.equal(engine.getNode("hero").children.includes("heroArtwork"), false);
  assert.equal(engine.getCacheEntries(), beforeEntries - 10);
  assert.equal(result.danglingCount, 0);
  assert.equal(engine.validateInvariants().length, 0);
  assert.equal(engine.lastInvalidation.ids.includes("heroArtwork"), false);
});

test("fixed before/after/boundary scenarios preserve visual and public semantics", () => {
  const result = runComparison();
  assert.equal(result.checks.visualEqual, true);
  assert.equal(result.checks.documentEqual, true);
  assert.equal(result.checks.interactionEqual, true);
  assert.equal(result.checks.boundaryVisualEqual, true);
  assert.equal(result.checks.boundaryDocumentEqual, true);
  assert.equal(result.checks.boundaryInteractionEqual, true);
  assert.equal(result.checks.noExceptions, true);
  assert.equal(result.checks.noDanglingReferences, true);
  assert.ok(result.after.totalRecomputes < result.before.totalRecomputes);
  assert.ok(result.after.hitRate > result.before.hitRate);
  assert.equal(result.summary.pass, true);
});

test("boundary parameters render deterministically", () => {
  const first = createSceneEngine();
  applyChange(first, "resize", { boundary: true });
  applyChange(first, "font", { boundary: true });
  applyChange(first, "visibility", { boundary: true });
  const firstHash = first.visualHash(first.render());

  const second = createSceneEngine();
  applyChange(second, "resize", { boundary: true });
  applyChange(second, "font", { boundary: true });
  applyChange(second, "visibility", { boundary: true });
  const secondHash = second.visualHash(second.render());

  assert.equal(firstHash, secondHash);
  assert.equal(first.validateInvariants().length, 0);
  assert.equal(second.validateInvariants().length, 0);
});
