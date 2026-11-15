# 架构说明

## 分层

- `src/core/math.js`：3x2 仿射矩阵，本地 TRS -> 世界矩阵级联、求逆与点变换。
- `src/core/scene.js`：场景图节点模型、增删/重排、父链、世界矩阵、实际可见性、参数校验。
- `src/core/keyframes.js`：关键帧通道（位移/旋转/缩放/透明度/填充色），数值线性插值、颜色阶跃，采样返回深拷贝。
- `src/core/commands.js`：编辑器控制器，选择高亮父链、移动、隐藏、删除（自动入历史）、撤销。
- `src/core/history.js`：快照式撤销栈，失败操作不会入栈。
- `src/core/resource-service.js`：缓存/缩略图/异步请求的多级回退与明确提示。
- `src/core/serialize.js`：工程序列化与带校验的反序列化。
- `src/core/exporter.js`：导出前工程快照、PNG 渲染、重载一致性校验、清单落盘。
- `src/render/`：虚拟光栅画布（无依赖 RGBA 光栅化）、共享渲染器、PNG 编码器。
- `web/`：浏览器检查器 UI，复用同一套 `renderScene` 渲染管线。

## 关键不变量

- 子节点世界矩阵 = 父世界矩阵 × 本地矩阵，移动父对象子对象自动同步，本地坐标不变。
- `children` 数组顺序即绘制顺序，靠后者覆盖靠前者。
- 父链上任一节点 `visible=false`，后代 `effectiveVisibility` 一律为 false，画面无残留。
- 预览与导出调用同一个 `renderScene`，虚拟画布与浏览器 Canvas 实现同一接口子集。
- 任何资源失败都返回 `status=fallback` 且 `notices` 非空，绝不静默空白。
