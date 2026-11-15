import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => window.RecordingWorkbench);
});

test("两次录制：单声道声源在不同麦克风布置下产生可验证差异，节拍点保持一致", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderOffline, DEFAULT_LAYOUT } = window.RecordingWorkbench;
    const layoutB = (base) => {
      const next = structuredClone(base);
      next.mics[0].x = 0.5;
      next.mics[0].y = 0.66;
      next.mics[0].angle = Math.PI / 2;
      next.mics[1].x = 0.12;
      next.mics[1].y = 0.12;
      next.mics[1].gain = 0.7;
      next.mics[2].x = 0.5;
      next.mics[2].y = 0.2;
      next.mics[2].angle = Math.PI; // 主轴水平，正下方人声落在双指向零点
      return next;
    };
    const rms = (buf, ch) => {
      const d = buf.getChannelData(ch);
      let s = 0;
      for (const v of d) s += v * v;
      return Math.sqrt(s / d.length);
    };
    const take1 = await renderOffline(DEFAULT_LAYOUT, { seconds: 4 });
    const take2 = await renderOffline(layoutB(DEFAULT_LAYOUT), { seconds: 4 });

    const solo = (layout, idx) =>
      renderOffline(layout, { seconds: 4, soloMic: idx }).then((r) => ({
        left: rms(r.buffer, 0),
        right: rms(r.buffer, 1),
      }));
    const micEnergyA = await Promise.all(DEFAULT_LAYOUT.mics.map((_, i) => solo(DEFAULT_LAYOUT, i)));
    const micEnergyB = await Promise.all(layoutB(DEFAULT_LAYOUT).mics.map((_, i) =>
      solo(layoutB(DEFAULT_LAYOUT), i)));
    return {
      beatEqual: JSON.stringify(take1.beats) === JSON.stringify(take2.beats),
      beats: take1.beats,
      pan1: take1.panValues,
      pan2: take2.panValues,
      micEnergyA,
      micEnergyB,
      weightsA: take1.weights,
      weightsB: take2.weights,
    };
  });

  expect(result.beatEqual).toBe(true);
  expect(result.beats.length).toBeGreaterThan(3);
  // 声像随位置变化：布置 B 的 A 麦回到中央，B 麦更靠左。
  expect(result.pan1[0].pan).not.toBeCloseTo(result.pan2[0].pan, 5);
  expect(result.pan2[0].pan).toBeCloseTo(0, 5);
  expect(result.pan2[1].pan).toBeLessThan(result.pan1[1].pan);
  // 三支麦克风因指向性/距离不同，能量本身就有差异。
  const energiesA = result.micEnergyA.map((m) => m.left + m.right);
  expect(new Set(energiesA.map((v) => v.toFixed(6))).size).toBe(3);
  // 改变布置后同一支麦克风的能量发生变化。
  result.micEnergyA.forEach((energy, idx) => {
    const before = energy.left + energy.right;
    const after = result.micEnergyB[idx].left + result.micEnergyB[idx].right;
    expect(Math.abs(before - after) / before).toBeGreaterThan(0.05);
  });
  // 双指向麦把零点对准人声后，人声权重应接近零、显著低于原始布置。
  expect(Math.abs(result.weightsB[2].voice)).toBeLessThan(0.12);
  expect(Math.abs(result.weightsB[2].voice)).toBeLessThan(Math.abs(result.weightsA[2].voice) * 0.4);
});

test("输入中断：切断后人声支路能量归零且不影响其余声源", async ({ page }) => {
  const data = await page.evaluate(async () => {
    const { renderOffline, DEFAULT_LAYOUT } = window.RecordingWorkbench;
    const voiceOnly = structuredClone(DEFAULT_LAYOUT);
    voiceOnly.sources.rain.enabled = false;
    voiceOnly.sources.wind.enabled = false;
    const rms = (buf, from, to) => {
      const d = buf.getChannelData(0);
      let s = 0;
      let n = 0;
      for (let i = from; i < to; i++) {
        s += d[i] * d[i];
        n++;
      }
      return Math.sqrt(s / n);
    };
    const normal = await renderOffline(voiceOnly, { seconds: 4 });
    const cut = await renderOffline(voiceOnly, {
      seconds: 4,
      interruptAt: 1.2,
      interruptName: "voice",
    });
    const sr = normal.buffer.sampleRate;
    const tail = (buf) => rms(buf, Math.floor(2.5 * sr), Math.floor(4 * sr));
    const beforeCut = rms(cut.buffer, Math.floor(0.3 * sr), Math.floor(1.1 * sr));
    return {
      normalTail: tail(normal.buffer),
      cutTail: tail(cut.buffer),
      beforeCut,
      cutHasNodes: cut.activeNodesAtEnd,
    };
  });
  // 仅人声场景下，切断后窗口应几乎归零，远低于未切断基准与切断前窗口。
  expect(data.cutTail).toBeLessThan(data.normalTail * 0.1);
  expect(data.cutTail).toBeLessThan(data.beforeCut * 0.1);
  expect(data.cutHasNodes).toBe(0);
});

test("停止后无尾音：淡出结束后输出严格为零", async ({ page }) => {
  const data = await page.evaluate(async () => {
    const { renderOffline, DEFAULT_LAYOUT } = window.RecordingWorkbench;
    const rendered = await renderOffline(DEFAULT_LAYOUT, { seconds: 4, stopAt: 2.0 });
    const sr = rendered.buffer.sampleRate;
    const data0 = rendered.buffer.getChannelData(0);
    const data1 = rendered.buffer.getChannelData(1);
    let maxAfter = 0;
    for (let i = Math.floor(2.4 * sr); i < data0.length; i++) {
      maxAfter = Math.max(maxAfter, Math.abs(data0[i]), Math.abs(data1[i]));
    }
    return { maxAfter, nodes: rendered.activeNodesAtEnd };
  });
  expect(data.maxAfter).toBe(0);
  expect(data.nodes).toBe(0);
});

test("离线导出立体声 WAV：声道、采样率与时长正确", async ({ page }) => {
  const info = await page.evaluate(async () => {
    const { renderOffline, DEFAULT_LAYOUT, encodeWav, wavDurationSeconds } = window.RecordingWorkbench;
    const rendered = await renderOffline(DEFAULT_LAYOUT, { seconds: 3.25 });
    const blob = encodeWav(rendered.buffer);
    const duration = await wavDurationSeconds(blob);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      duration,
      size: blob.size,
      header: String.fromCharCode(...bytes.slice(0, 4)),
      channels: new DataView(bytes.buffer).getUint16(22, true),
      sampleRate: new DataView(bytes.buffer).getUint32(24, true),
    };
  });
  expect(info.header).toBe("RIFF");
  expect(info.channels).toBe(2);
  expect(info.sampleRate).toBe(48000);
  expect(info.duration).toBeCloseTo(3.25, 2);
  expect(info.size).toBe(44 + Math.floor(3.25 * 48000) * 4);
});
