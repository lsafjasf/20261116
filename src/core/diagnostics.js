import {
  FALLBACK_MESSAGES,
  VersionedResourceCache,
  createThumbnailFallback,
} from "./fallback.js";
import { StableAtlasPacker } from "./packer.js";
import { pixelsEqual, renderAtlas, restoreOriginalFrame } from "./render.js";
import {
  ATLAS_FORMAT,
  buildAtlasPackage,
  createSnapshotPackage,
  validateAtlasPackage,
} from "./schema.js";
import { runThreeRoundScenario } from "./scenario.js";
import { createSpriteFrame } from "./sprite.js";

export function createSolidFrame(id, width, height, color = [255, 180, 64]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = color[0];
    pixels[index * 4 + 1] = color[1];
    pixels[index * 4 + 2] = color[2];
    pixels[index * 4 + 3] = 255;
  }
  return { id, width, height, pixels, colors: ["#ffb440"], version: 0 };
}

function check(name, condition, details = {}) {
  return { name, ok: Boolean(condition), details };
}

function throws(action) {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}

export function runDefaultSuite() {
  const result = runThreeRoundScenario({ seed: 628, count: 100 });
  return {
    group: "default",
    title: "默认参数：100 帧 + 三轮增量",
    parameters: result.options,
    passed: result.passed,
    checks: Object.entries(result.checks).map(([name, ok]) => check(name, ok)),
    result,
  };
}

export function runBoundarySuite() {
  const checks = [];
  const exactOptions = {
    width: 64,
    height: 64,
    padding: 0,
    allowRotation: false,
    trim: false,
    autoGrow: false,
  };
  const exactFrames = [
    createSolidFrame("edge-0", 32, 32, [255, 0, 0]),
    createSolidFrame("edge-1", 32, 32, [0, 255, 0]),
    createSolidFrame("edge-2", 32, 32, [0, 0, 255]),
    createSolidFrame("edge-3", 32, 32, [255, 255, 0]),
  ];
  const exactPacker = new StableAtlasPacker(exactOptions);
  exactPacker.packAll(exactFrames);
  const exactAtlas = renderAtlas(exactPacker, exactFrames);
  const exactProject = { version: 1, frameOrder: exactFrames.map((frame) => frame.id), layers: [{ id: "l", order: 0, color: "#fff", visible: true }], keyframes: [] };
  const exactPackage = buildAtlasPackage({ packer: exactPacker, project: exactProject, atlas: exactAtlas });
  checks.push(check("4×32² 精确填满 64×64", exactPacker.metrics().utilization === 1));
  checks.push(check("边界图集无重叠", exactPacker.assertNoOverlaps()));
  checks.push(check("边界切片 JSON 有效", validateAtlasPackage(exactPackage).ok));
  const overflow = throws(() =>
    exactPacker.applyChanges({ upserts: [createSolidFrame("edge-overflow", 1, 1)] }),
  );
  checks.push(check("autoGrow=false 时明确报错", overflow instanceof RangeError));

  const one = new StableAtlasPacker({
    width: 1,
    height: 1,
    padding: 0,
    allowRotation: false,
    trim: false,
    autoGrow: false,
  });
  one.packAll([createSolidFrame("one-pixel", 1, 1)]);
  checks.push(check("1×1 原子边界", one.metrics().utilization === 1));

  const source = createSolidFrame("rot-trim", 26, 17);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const opaque = x >= 3 && x < 23 && y >= 5 && y < 12;
      source.pixels[offset + 3] = opaque ? 255 : 0;
      if (!opaque) {
        source.pixels[offset] = 0;
        source.pixels[offset + 1] = 0;
        source.pixels[offset + 2] = 0;
      }
    }
  }
  const rotated = new StableAtlasPacker({
    width: 8,
    height: 22,
    padding: 0,
    allowRotation: true,
    trim: true,
    autoGrow: false,
  });
  rotated.packAll([source]);
  const rotatedAtlas = renderAtlas(rotated, [source]);
  const rotatedPackage = buildAtlasPackage({
    packer: rotated,
    project: { version: 1, frameOrder: [source.id], layers: [{ id: "l", order: 0, color: "#fff", visible: true }], keyframes: [] },
    atlas: rotatedAtlas,
  });
  const slice = rotatedPackage.frames[0];
  const restored = restoreOriginalFrame(slice, rotatedAtlas);
  checks.push(check("窄图集强制旋转", slice.rotated === true));
  checks.push(
    check(
      "旋转 + 裁边 + 原尺寸回环",
      slice.spriteSourceSize.w === 20 &&
        slice.spriteSourceSize.h === 7 &&
        slice.sourceSize.w === 26 &&
        slice.sourceSize.h === 17 &&
        pixelsEqual(restored, source),
    ),
  );
  return {
    group: "boundary",
    title: "边界参数：精确填充、1×1、强制旋转",
    parameters: exactOptions,
    passed: checks.every((entry) => entry.ok),
    checks,
  };
}

export async function runExceptionSuite() {
  const checks = [];
  const base = createSolidFrame("dup", 4, 4);
  checks.push(check("重复 id 被拒绝", throws(() => new StableAtlasPacker().packAll([base, base])) instanceof Error));
  checks.push(check("零尺寸被拒绝", throws(() => new StableAtlasPacker().packAll([{ ...base, width: 0 }])) instanceof Error));
  const empty = createSolidFrame("empty", 4, 4);
  empty.pixels.fill(0);
  checks.push(check("全透明帧被拒绝", throws(() => new StableAtlasPacker().packAll([empty])) instanceof Error));
  checks.push(
    check(
      "损坏 JSON 被拒绝",
      !validateAtlasPackage({ format: ATLAS_FORMAT, version: 1, atlas: {}, frames: [] }).ok,
    ),
  );

  const cache = new VersionedResourceCache({ ttlMs: 1000, now: () => 0 });
  await cache.getOrLoad("atlas", {
    loader: async () => "cached-v1",
    fallback: async () => "unused",
  });
  cache.bumpVersion("atlas");
  const invalidated = await cache.getOrLoad("atlas", {
    version: 3,
    loader: async () => {
      throw new Error("network down");
    },
    fallback: async ({ message }) => `fresh:${message}`,
  });
  checks.push(
    check(
      "失效缓存不返回旧内容",
      invalidated.source === "fallback" && !invalidated.value.includes("cached-v1"),
      { message: invalidated.message },
    ),
  );
  const timedOut = await cache.getOrLoad("slow", {
    timeoutMs: 5,
    loader: () => new Promise(() => {}),
    fallback: async ({ message }) => `local:${message}`,
  });
  checks.push(
    check(
      "异步超时自动回退",
      timedOut.source === "fallback" && timedOut.message === FALLBACK_MESSAGES.TIMEOUT,
    ),
  );
  const placeholder = createThumbnailFallback(createSpriteFrame("thumb-1", 1));
  checks.push(
    check(
      "缩略图失败给颜色占位",
      placeholder.kind === "placeholder" && placeholder.color.startsWith("#") && Boolean(placeholder.message),
    ),
  );
  return {
    group: "exception",
    title: "异常参数：非法帧、损坏包、失效缓存与异步超时",
    passed: checks.every((entry) => entry.ok),
    checks,
  };
}

export async function runAllParameterGroups() {
  const [defaultSuite, exceptionSuite] = await Promise.all([
    Promise.resolve(runDefaultSuite()),
    runExceptionSuite(),
  ]);
  const suites = [defaultSuite, runBoundarySuite(), exceptionSuite];
  return {
    passed: suites.every((suite) => suite.passed),
    suites,
  };
}
