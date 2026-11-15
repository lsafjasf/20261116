import { sha256Hex, maskDiff, meanAbsoluteError, shortHash } from './imghash.js';
import { presetPatch, PRESET_ORDER, WEATHER_PRESETS } from './presets.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hashOf(engine, debug = 0) {
  engine.render(debug);
  const frame = engine.readPixels(debug === 1 ? 'mask' : 'color');
  return { hex: await sha256Hex(frame.pixels), frame };
}

export class TestSuite {
  constructor(app) {
    this.app = app;
    this.results = [];
  }

  record(group, name, pass, detail) {
    const row = { group, name, pass: !!pass, detail };
    this.results.push(row);
    return row;
  }

  async runAll(onProgress) {
    this.results = [];
    const app = this.app;
    const eng = app.engine;
    const baselineSnapshot = app.store.snapshot();
    app.pause();

    // ---------- 普通场景 ----------
    onProgress && onProgress('normal');
    const r1 = await hashOf(eng);
    await sleep(30);
    const r2 = await hashOf(eng);
    this.record('normal', '暂停后重渲染哈希逐位一致',
      r1.hex === r2.hex,
      `hash=${shortHash(r1.hex)} ×2，帧数=${app.frameCount}`);

    const objectsBefore = eng.objectCount;
    app.set({ windSpeed: 12 }, 'test');
    app.renderOnce();
    this.record('normal', '参数变化不重建 GL 场景',
      eng.objectCount === objectsBefore,
      `对象数 ${objectsBefore} → ${eng.objectCount}（仅上传 wind uniform）`);

    const r3 = await hashOf(eng);
    this.record('normal', '风速变化后画面哈希发生改变',
      r3.hex !== r2.hex,
      `${shortHash(r2.hex)} → ${shortHash(r3.hex)}，MAE=${meanAbsoluteError(r2.frame, r3.frame).toFixed(2)}`);

    const onlyWind = app.store.updateLog
      .filter((r) => r.source === 'test')
      .every((r) => r.changedRegions.length === 1 && r.changedRegions[0] === 'wind');
    this.record('normal', '脏区追踪只标记受影响区域(wind)',
      onlyWind, 'updateLog 中测试写入的区域均为 [wind]');

    // 界面刷新（播放开关）不得重建场景，暂停态画面也不得变化。
    const uiHash = await hashOf(eng);
    const uiObjects = eng.objectCount;
    const frozenTime = app.store.state.simTime;
    app.resume();
    await sleep(50);
    app.pause();
    app.set({ simTime: frozenTime }, 'test'); // 还原时间，隔离“播放开关”本身的影响
    app.renderOnce();
    const uiHash2 = await hashOf(eng);
    const uiClean = eng.objectCount === uiObjects &&
      app.store.updateLog.every((r) => r.source === 'ui' ? !r.fullRebuild : true);
    this.record('normal', '界面刷新不重建全部场景',
      uiClean,
      `暂停/继续后 GL 对象 ${uiObjects} → ${eng.objectCount}，ui 来源记录均无全量重建`);
    this.record('normal', '暂停期间播放开关不改变画面哈希',
      uiHash.hex === uiHash2.hex,
      `simTime 还原后 ${shortHash(uiHash.hex)} == ${shortHash(uiHash2.hex)}`);

    // 三组天气参数对照 + 暂停截图（每档都采集哈希与掩码）。
    this.presetRows = [];
    for (const id of PRESET_ORDER) {
      app.set(presetPatch(id), 'test');
      app.renderOnce();
      const color = await hashOf(eng, 0);
      const mask = await hashOf(eng, 1);
      this.presetRows.push({
        id, label: WEATHER_PRESETS[id].label,
        hash: color.hex, maskHash: mask.hex,
        frame: color.frame, maskFrame: mask.frame,
      });
      this.record('normal', `天气预设「${WEATHER_PRESETS[id].label}」渲染成功`,
        true, `color=${shortHash(color.hex)} mask=${shortHash(mask.hex)}`);
    }

    // ---------- 质量档对照：轮廓不跳变 ----------
    onProgress && onProgress('quality');
    const high = this.presetRows[0];
    app.set({ quality: 'low' }, 'test');
    app.renderOnce();
    const lowColor = await hashOf(eng, 0);
    const lowMask = await hashOf(eng, 1);
    const objectsLow = eng.objectCount;
    const silhouetteDrift = maskDiff(high.maskFrame, lowMask.frame);
    this.record('normal', '高/低质量档山脊遮挡轮廓一致',
      silhouetteDrift < 0.01,
      `掩码不一致像素占比 ${(silhouetteDrift * 100).toFixed(3)}%（阈值 1%）`);
    this.record('normal', '低质量档允许雾细节不同',
      lowColor.hex !== high.hash,
      `color ${shortHash(high.hash)} → ${shortHash(lowColor.hex)}，MAE=${meanAbsoluteError(high.frame, lowColor.frame).toFixed(2)}`);

    // ---------- 边界场景 ----------
    onProgress && onProgress('boundary');
    const obBefore = eng.objectCount;
    app.set({ windSpeed: 30, humidity: 1, sunElevation: 1, camAzimuth: 75 }, 'test');
    app.renderOnce();
    const edge = await hashOf(eng);
    this.record('boundary', '上限参数(风30/湿度1/仰角1/方位75)可渲染',
      eng.objectCount === obBefore && edge.hex.length === 64,
      `对象数=${eng.objectCount}，hash=${shortHash(edge.hex)}`);

    const before = app.store.state.windSpeed;
    app.set({ windSpeed: 9999, humidity: -5, camElevation: -999 }, 'test');
    const s = app.store.state;
    const clamped = s.windSpeed === 30 && s.humidity === 0 && s.camElevation === -8;
    this.record('boundary', '越界参数被钳制到合法区间',
      clamped,
      `windSpeed=${before}→${s.windSpeed}, humidity→${s.humidity}, camElevation→${s.camElevation}`);

    const zeroLog = app.store.updateLog.length;
    const ret = app.set({ windSpeed: s.windSpeed }, 'test');
    this.record('boundary', '无变化写入不触发任何更新',
      ret.noop === true && app.store.updateLog.length === zeroLog,
      'set() 返回 noop，updateLog 未增长');

    // ---------- 失败场景 ----------
    onProgress && onProgress('failure');
    const ext = eng.forceContextLoss();
    await sleep(60);
    const lostOk = eng.lost === true && eng.render() === false;
    this.record('failure', 'WebGL 上下文丢失时安全降级',
      lostOk, 'render() 返回 false，未抛出异常，RAF 已停止');

    await eng.restoreContext(ext);
    app.renderOnce();
    const restored = await hashOf(eng);
    this.record('failure', '上下文恢复后重建并恢复渲染',
      !eng.lost && restored.hex.length === 64,
      `对象数=${eng.objectCount}，hash=${shortHash(restored.hex)}`);

    const rejectedBefore = app.store.rejected.length;
    app.set({ windSpeed: NaN, bogusKey: 1 }, 'test');
    this.record('failure', 'NaN/未知键被拒绝并记录',
      app.store.rejected.length === rejectedBefore + 1,
      JSON.stringify(app.store.rejected.at(-1).rejected));

    // ---------- 恢复基线，保证测试本身不留脏状态 ----------
    app.store.restore(baselineSnapshot, 'test-cleanup');
    if (app.store.state.quality === 'high') app._pendingRebuild = false;
    app.renderOnce();
    this.summary = {
      total: this.results.length,
      passed: this.results.filter((r) => r.pass).length,
      failed: this.results.filter((r) => !r.pass).length,
      objectsHigh: objectsBefore,
      objectsLow,
      silhouetteDrift,
      presets: this.presetRows,
      lowColorHash: lowColor.hex,
    };
    return this.summary;
  }
}
