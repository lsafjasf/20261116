// 存储包装：current 损坏时回退 last-good；任何写入前先校验，损坏永远不覆盖好快照。

import { validateConfig } from './storage.js';

export const KEYS = {
  current: 'charCfg.v1.current',
  lastGood: 'charCfg.v1.lastGood',
  corrupted: 'charCfg.v1.corrupted',
  session: 'charCfg.v1.session',
  backupBeforeImport: 'charCfg.v1.preImport',
};

function safeParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err.message}` };
  }
}

function readOne(storage, key) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch (err) {
    return { state: 'unreadable', raw: null, error: `读取 ${key} 失败：${err.message}` };
  }
  if (raw === null) return { state: 'empty', raw: null };
  const parsed = safeParse(raw);
  if (!parsed.ok) return { state: 'corrupt', raw, error: parsed.error };
  const checked = validateConfig(parsed.value);
  if (!checked.ok) return { state: 'corrupt', raw, error: checked.error };
  return { state: 'ok', raw, value: checked.value };
}

// 加载结果：
// - current 有效 -> 用 current，并同步 lastGood
// - current 损坏/缺失 -> 回退 lastGood，损坏原文隔离到 corrupted，current 暂停写入
// - 两者都不可用 -> 内置默认值
export function loadState(storage = localStorage) {
  const current = readOne(storage, KEYS.current);
  const lastGood = readOne(storage, KEYS.lastGood);
  const notes = [];
  let config = null;
  let source = 'default';
  let saveBlocked = false;

  if (current.state === 'ok') {
    config = current.value;
    source = 'current';
    if (lastGood.state !== 'ok' || lastGood.raw !== current.raw) {
      try { storage.setItem(KEYS.lastGood, current.raw); } catch (err) {
        notes.push(`lastGood 同步失败：${err.message}`);
      }
    }
  } else {
    if (current.state === 'corrupt' || current.state === 'unreadable') {
      notes.push(`当前配置${current.state === 'corrupt' ? '损坏' : '无法读取'}：${current.error}`);
      if (current.raw !== null) {
        try { storage.setItem(KEYS.corrupted, current.raw); } catch (err) {
          notes.push(`损坏快照隔离失败：${err.message}`);
        }
      }
      saveBlocked = true;
    }
    if (lastGood.state === 'ok') {
      config = lastGood.value;
      source = 'lastGood';
      notes.push('已回退到最后可读快照（last-good）。');
    } else {
      notes.push('没有可读快照，使用内置默认配置。');
      if (lastGood.state === 'corrupt') notes.push(`lastGood 同样损坏：${lastGood.error}`);
    }
  }

  return {
    config,
    source,
    saveBlocked,
    notes,
    currentState: current.state,
    lastGoodState: lastGood.state,
  };
}

// 持久化一份已校验配置。返回 { ok, error }，失败时不动任何已有键。
export function persistConfig(config, storage = localStorage) {
  const checked = validateConfig(config);
  if (!checked.ok) {
    return { ok: false, error: `拒绝写入非法配置：${checked.error}` };
  }
  const raw = JSON.stringify(checked.value);
  try {
    // 先写 lastGood 再写 current；任一步失败都不会用坏数据覆盖。
    storage.setItem(KEYS.lastGood, raw);
    storage.setItem(KEYS.current, raw);
    return { ok: true, raw };
  } catch (err) {
    return { ok: false, error: `写入存储失败（可能已满或被禁用）：${err.message}` };
  }
}

export function saveRaw(key, value, storage = localStorage) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function readRaw(key, fallback, storage = localStorage) {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return structuredClone(fallback);
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

// 解除“当前槽损坏”的封锁：用一份有效配置重建两个槽。
export function rebuildAfterRecovery(config, storage = localStorage) {
  const checked = validateConfig(config);
  if (!checked.ok) return { ok: false, error: checked.error };
  const raw = JSON.stringify(checked.value);
  try {
    storage.setItem(KEYS.lastGood, raw);
    storage.setItem(KEYS.current, raw);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
