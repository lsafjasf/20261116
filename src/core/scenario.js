import { projectFingerprint } from "./project.js";
import { pixelsEqual, renderAtlas, restoreOriginalFrame } from "./render.js";
import {
  buildAtlasPackage,
  createSnapshotPackage,
  packageFingerprint,
  packerFromPackage,
  validateAtlasPackage,
} from "./schema.js";
import { createDemoFrames, createSpriteFrame, hashPixels } from "./sprite.js";
import { StableAtlasPacker } from "./packer.js";

export const DEMO_ROUND_SPECS = Object.freeze([
  {
    label: "第 1 轮：新增 2 / 删除 1",
    add: [
      { id: "spr-100", index: 100 },
      { id: "spr-101", index: 101 },
    ],
    remove: ["spr-011"],
    modify: [],
  },
  {
    label: "第 2 轮：新增 1 / 删除 2 / 修改 2",
    add: [{ id: "spr-102", index: 102 }],
    remove: ["spr-042", "spr-077"],
    modify: [
      { id: "spr-007", index: 7, variant: 1 },
      { id: "spr-031", index: 31, variant: 1 },
    ],
  },
  {
    label: "第 3 轮：新增 2 / 删除 1 / 修改 3",
    add: [
      { id: "spr-103", index: 103 },
      { id: "spr-104", index: 104 },
    ],
    remove: ["spr-003"],
    modify: [
      { id: "spr-005", index: 5, variant: 2 },
      { id: "spr-017", index: 17, variant: 2 },
      { id: "spr-066", index: 66, variant: 2 },
    ],
  },
]);

export function roundChanges(roundIndex, seed = 628) {
  const spec = DEMO_ROUND_SPECS[roundIndex];
  if (!spec) throw new RangeError("Unknown demo round");
  const upserts = [
    ...spec.add.map((entry) => createSpriteFrame(entry.id, entry.index, { seed })),
    ...spec.modify.map((entry) =>
      createSpriteFrame(entry.id, entry.index, { seed, variant: entry.variant ?? 1 }),
    ),
  ];
  return {
    label: spec.label,
    upserts,
    deletes: [...spec.remove],
  };
}

function updateProjectFrames(project, addedIds, deletedIds) {
  const deleted = new Set(deletedIds);
  project.frameOrder = project.frameOrder.filter((id) => !deleted.has(id));
  for (const id of addedIds) {
    if (!project.frameOrder.includes(id)) project.frameOrder.push(id);
  }
  for (const keyframe of project.keyframes) {
    if (deleted.has(keyframe.frameId)) keyframe.frameId = project.frameOrder[0];
  }
  if (deleted.has(project.selectedFrameId) || !project.frameOrder.includes(project.selectedFrameId)) {
    project.selectedFrameId = project.frameOrder[0];
  }
  project.revision += 1;
}

function unaffectedMovement(before, after, affectedIds) {
  let moved = 0;
  let maxDelta = 0;
  let compared = 0;
  for (const [id, old] of before) {
    if (affectedIds.has(id) || !after.has(id)) continue;
    const next = after.get(id);
    compared += 1;
    const delta = Math.abs(old.x - next.x) + Math.abs(old.y - next.y);
    maxDelta = Math.max(maxDelta, delta);
    if (delta > 0 || old.rotated !== next.rotated) moved += 1;
  }
  return { compared, moved, maxDelta };
}

function restoreCheck(packageJson, atlas, frames) {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  let checked = 0;
  let failed = 0;
  for (const slice of packageJson.frames) {
    const original = byId.get(slice.id);
    if (!original) continue;
    checked += 1;
    const restored = restoreOriginalFrame(slice, atlas);
    if (!pixelsEqual(restored, original)) failed += 1;
  }
  return { checked, failed, exact: failed === 0 && checked === packageJson.frames.length };
}

export function runThreeRoundScenario({
  seed = 628,
  count = 100,
  options = {},
  includeAtlasPixels = false,
} = {}) {
  const frames = createDemoFrames(count, { seed });
  const project = createProjectForFrames(frames);
  const packer = new StableAtlasPacker(options);
  const baselineSummary = packer.packAll(frames);
  const frameById = new Map(frames.map((frame) => [frame.id, frame]));
  const rounds = [];
  let previousPlacements = new Map(packer.placements);
  let previousUtilization = baselineSummary.metrics.utilization;

  for (let roundIndex = 0; roundIndex < DEMO_ROUND_SPECS.length; roundIndex += 1) {
    const changes = roundChanges(roundIndex, seed);
    const affectedIds = new Set([
      ...changes.upserts.map((frame) => frame.id),
      ...changes.deletes,
    ]);
    const changeResult = packer.applyChanges(changes);
    const addedIds = changes.upserts.filter((frame) => !frameById.has(frame.id)).map((frame) => frame.id);
    for (const frame of changes.upserts) frameById.set(frame.id, frame);
    for (const id of changes.deletes) frameById.delete(id);
    updateProjectFrames(project, addedIds, changes.deletes);
    const currentFrames = [...frameById.values()];
    const atlas = renderAtlas(packer, currentFrames);
    const beforeExport = createSnapshotPackage({
      packer,
      project,
      atlas,
      label: `round-${roundIndex + 1}-pre-export`,
      snapshotId: `demo-round-${roundIndex + 1}`,
      capturedAt: `2026-11-16T00:0${roundIndex + 1}:00.000Z`,
    });
    const packageJson = buildAtlasPackage({
      packer,
      project,
      atlas,
      exportedAt: `2026-11-16T00:0${roundIndex + 1}:30.000Z`,
    });
    const validation = validateAtlasPackage(packageJson);
    const reloaded = packerFromPackage(packageJson);
    const movement = unaffectedMovement(previousPlacements, packer.placements, affectedIds);
    const restored = restoreCheck(packageJson, atlas, currentFrames);
    const reloadFingerprint = projectFingerprint(packageJson.project, reloaded);
    const exportFingerprint = projectFingerprint(project, packer);
    const snapshotMatches = packageFingerprint(beforeExport) === packageFingerprint(packageJson);
    rounds.push({
      round: roundIndex + 1,
      label: changes.label,
      frameCount: currentFrames.length,
      atlas: { width: packer.width, height: packer.height },
      utilizationBefore: previousUtilization,
      utilization: packer.metrics().utilization,
      utilizationDelta: packer.metrics().utilization - previousUtilization,
      rearrangedRegion: changeResult.rearrangedRegion,
      movedFrames: changeResult.moved.length,
      insertedFrames: changeResult.inserted.length,
      deletedFrames: changeResult.deleted.length,
      resizedFrames: changeResult.resized.length,
      unaffectedMovement: movement,
      compacted: changeResult.compacted,
      export: {
        pixelHash: hashPixels(atlas.pixels),
        packageBytes: JSON.stringify(packageJson).length,
        snapshotBytes: JSON.stringify(beforeExport).length,
        rotatedFrames: packageJson.frames.filter((slice) => slice.rotated).length,
        trimmedFrames: packageJson.frames.filter((slice) => slice.trimmed).length,
        noOverlap: validation.ok,
        restoreExact: restored.exact,
        restoreChecked: restored.checked,
        reloadFingerprintMatches: reloadFingerprint === exportFingerprint,
        snapshotMatches,
      },
      package: packageJson,
      beforeExport,
      ...(includeAtlasPixels ? { atlasPixels: atlas } : {}),
    });
    previousPlacements = new Map(packer.placements);
    previousUtilization = packer.metrics().utilization;
  }

  const checks = {
    noOverlap: rounds.every((round) => round.export.noOverlap),
    stableUnaffectedCoordinates: rounds.every(
      (round) => round.compacted || round.unaffectedMovement.moved === 0,
    ),
    noRunawayUtilization:
      Math.min(...rounds.map((round) => round.utilization)) >=
      baselineSummary.metrics.utilization - 0.05,
    losslessSlices: rounds.every((round) => round.export.restoreExact),
    reloadFingerprintStable: rounds.every((round) => round.export.reloadFingerprintMatches),
    preExportSnapshots: rounds.every((round) => round.export.snapshotMatches),
  };
  return {
    seed,
    count,
    options: packer.options,
    baseline: {
      width: baselineSummary.width,
      height: baselineSummary.height,
      utilization: baselineSummary.metrics.utilization,
      frameCount: baselineSummary.metrics.frameCount,
      noOverlap: packer.assertNoOverlaps(),
    },
    rounds,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function createProjectForFrames(frames) {
  return {
    version: 1,
    id: "sprite-lab-628",
    revision: 1,
    frameOrder: frames.map((frame) => frame.id),
    layers: [
      { id: "backdrop", name: "背景层", order: 0, visible: true, color: "#18243a", opacity: 1 },
      { id: "character", name: "角色层", order: 1, visible: true, color: "#ffb54a", opacity: 1 },
      { id: "effects", name: "特效层", order: 2, visible: true, color: "#6ee7ff", opacity: 0.86 },
    ],
    keyframes: [0, 33, 66, 99].map((index, order) => ({
      id: `key-${order}`,
      index,
      name: ["待机", "踏步", "冲刺", "收势"][order],
      frameId: frames[index].id,
      colors: {
        backdrop: ["#18243a", "#1b2b45", "#20304d", "#162033"][order],
        character: frames[index].colors[0],
        effects: ["#6ee7ff", "#ff6b9a", "#9d8cff", "#ffb54a"][order],
      },
      easing: "ease-in-out",
    })),
    selectedFrameId: frames[0].id,
    selectedLayerId: "character",
    palette: ["#ffb54a", "#6ee7ff", "#ff6b9a", "#9d8cff"],
    background: "#0b111d",
  };
}
