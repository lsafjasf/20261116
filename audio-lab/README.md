# Web Audio 集中资源管理实验台

面向“场景频繁切换、持续创建振荡器/延迟器/事件监听器”的 Web Audio 应用，
提供集中式节点生命周期管理，并用固定场景对比验证资源、听感与输出语义。

## 要解决的问题

- 旧实现（`NaiveResourceManager`）每次切场景只 `stop()` 振荡器，节点、连接、
  监听器仍被引用，20 次切换后活动节点单调增长到 195+。
- 销毁后的节点若收到平台迟到的 `ended` 事件，旧代码仍会执行业务回调。
- 缺少可观测手段，无法判断帧时间、缓存效率与内存趋势。

## 架构

- `src/resourceManager.mjs`
  - `ResourceManager`：统一登记节点、连接与监听器，按作用域（scope）批量释放；
    内部维护邻接表，不依赖具体 `AudioNode` 实现（真实浏览器与 Node mock 通用）。
  - 监听器通过守卫包装器注册；节点释放后包装器保留但短路，迟到事件只计数
    （`suppressedCallbacks`）并上报 `callback-after-release`，业务回调永不执行。
  - `NaiveResourceManager`：保留优化前行为作为对照基线。
- `src/sceneController.mjs`：同一份建图代码注入不同管理器，保证输出拓扑一致。
- `src/sceneConfig.mjs`：固定场景定义、参数归一化与 LRU 配置缓存（命中率指标）。
- `src/metrics.mjs`：指标采集与 DOM 渲染（9 项实时指标 + 历史快照）。
- `src/runner.mjs`：驱动 N 次切换，产出首尾计数、节点/堆序列与输出指纹。
- `src/offlineRender.mjs` / `src/wav.mjs`：`OfflineAudioContext` 离线渲染、
  PCM 指纹、感知指标（RMS/峰值/质心/基频）与 WAV 导出。
- `test/mockAudio.mjs`：确定性 Web Audio 子集，供 Node 夹具复用同一套引擎代码。

## 界面实时指标（≥3 项，实际 9 项）

活动节点、活动连接、活动监听器、帧时间(ms)、候选释放数、缓存命中率、
拦截回调数、堆内存(B)、异常数；另配节点/连接/监听器与堆内存两张趋势图。

## 三组固定场景

1. `before`：优化前泄漏基线，标准五场景，20 次切换。
2. `after`：优化后集中托管，同样标准五场景，20 次切换。
3. `boundary`：边界参数（0 声部、非法类型/频率、12 声部重负载），LRU 容量 2。

## 运行方式

```bash
npm test                 # Node 确定性夹具（含全部断言）
node tools/compare.mjs   # 生成 artifacts/comparison.{json,md}
npm run test:e2e         # 真实 Chromium E2E（需 Playwright 浏览器）
npm start                # 本地静态服务器 http://127.0.0.1:4731/
```

E2E 默认使用系统 Chromium，可用 `CHROMIUM_PATH` 覆盖可执行文件路径。

## 验证结论（制品见 `artifacts/`）

- 20 次切换：优化后节点序列按场景周期严格重复（如 `7,10,13,7,10` 循环），
  末次销毁后活动节点/连接/监听器全部为 0；优化前单调增长至 195（截图中为 202，
  含一次手动启动场景）。
- 回调安全：销毁后派发 `ended`，业务回调触发次数为 0，拦截计数等于派发数。
- 听感：优化前后离线渲染 PCM 指纹一致，RMS/峰值差异 ≤ 1e-7（低于可听阈值），
  导出 `listen-*.wav` 可直接试听。
- 内存：`memory-trend.json` 与堆趋势图显示泄漏路径节点持续留存；
  托管路径零留存，堆序列平稳。
- 语义不变：`sameFingerprints=true`、每场景指纹跨循环稳定、零异常，
  证明仅改变性能与错误处理，未改变视觉、交互与公开数据语义。
