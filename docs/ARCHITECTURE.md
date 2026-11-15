# 架构与存档设计

## 模块划分

- `src/core/rng.js`：确定性 mulberry32 随机数，固定种子 → 固定地图。
- `src/core/checksum.js`：递归排序键的稳定序列化 + 32 位 FNV-1a 校验码。
- `src/core/pathfinder.js`：确定性 A*（二进制堆，插入序号打破平局）+ 容量可配的 LRU 路径缓存。
- `src/core/game.js`：地图、进度、设置、最近 20 条回放环形缓冲与快照/恢复。
- `src/core/metrics.js`：帧时间、候选数量、缓存命中率、扩展节点数四项滚动指标。
- `src/save/migrations.js`：v1→v2→v3 链式迁移与不支持版本的显式错误。
- `src/save/save_system.js`：信封封装、原子写入、双快照轮转、校验与恢复。
- `src/save/node_storage.js` / `browser_storage.js`：同接口存储适配器，均支持故障注入。
- `index.html` + `src/ui/`：画布、实时指标面板、恢复状态横幅与故障模拟按钮。

## 存档信封格式

```json
{
  "format": "offline-mini-save",
  "version": 3,
  "checksum": "F1E2D3C4",
  "createdAt": 1794764026012,
  "payload": {
    "map": { "id": "map-20261116", "cells": [0, 1], "...": "..." },
    "progress": { "player": {"x":1,"y":1}, "score": 100, "moves": 168, "tick": 10, "collected": [[3, 4]] },
    "settings": { "volume": 0.55, "difficulty": "normal", "particles": true },
    "replaySummary": { "capacity": 20, "count": 10, "totalSteps": 168, "totalGems": 1, "lastAction": "move", "recent": [] }
  }
}
```

校验码只覆盖 `payload` 的稳定序列化文本，因此信封键序不影响校验结果。

## 原子写入与轮转（永不覆盖唯一副本）

1. 完整信封写入临时键 `save.tmp.json`；中断只会损坏临时键。
2. 旧主存档整体复制为 `save.backup.json`（上一份完整快照保留）。
3. 临时键原子重命名为 `save.primary.json`。
4. 任何异常都会清理临时键，并把状态置为 `save-failed` / `quota`，已有快照不动。

加载顺序：主存档 → 备份。JSON 解析失败、信封残缺或校验码不一致都记为
`corrupt` 并继续尝试下一个槽位；两个槽位都不可用时返回 `empty`，界面提示
重新开始而不是静默丢档。

## 版本迁移

- v1→v2：音量 0..100 归一化为 0..1，补 `difficulty`。
- v2→v3：平面 `gems` 计数转为 `collected` 坐标列表，补 `replaySummary`。
- 高于当前版本或低于 v1：抛 `UnsupportedVersionError`，界面显示明确版本提示。
- 迁移成功后可再次保存，磁盘格式升级到当前版本，迁移只执行一次。

## 优化边界：只改性能，不改语义

A* 算法、平局规则、地图生成、移动与计分逻辑在缓存开关下完全相同；LRU
缓存只复用既有路径结果。固定场景通过规范化快照哈希断言优化前后输出逐字节
一致，异常日志也做深比较。
