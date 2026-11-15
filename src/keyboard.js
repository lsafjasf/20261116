// 键盘 -> command 映射。所有键位只负责产生与鼠标相同的 command 对象。

import { FINE_STEP, STEP } from './geometry.js';

const TOOL_KEYS = { v: 'select', r: 'rect', e: 'ellipse', l: 'line', h: 'pan' };

function arrowToDelta(key, fine) {
  const step = fine ? FINE_STEP : STEP;
  switch (key) {
    case 'ArrowUp': return [0, -step];
    case 'ArrowDown': return [0, step];
    case 'ArrowLeft': return [-step, 0];
    case 'ArrowRight': return [step, 0];
    default: return null;
  }
}

// 返回 true 表示事件已被处理（应阻止默认行为）。
export function handleCanvasKeydown(event, store, hooks) {
  const { key, altKey, ctrlKey, metaKey, shiftKey } = event;
  const state = store.getState();
  const mod = ctrlKey || metaKey;

  if (mod && key.toLowerCase() === 'z') {
    event.preventDefault();
    if (shiftKey) store.redo(); else store.undo();
    hooks.announce(store.getState().lastAction);
    return true;
  }
  if (mod && key.toLowerCase() === 'y') {
    event.preventDefault();
    store.redo();
    hooks.announce(store.getState().lastAction);
    return true;
  }
  if (mod && key.toLowerCase() === 'e') {
    event.preventDefault();
    hooks.openExport();
    return true;
  }

  const delta = arrowToDelta(key, shiftKey);
  if (delta) {
    event.preventDefault();
    if (altKey) {
      store.dispatch({ type: 'pan-by', dx: delta[0], dy: delta[1] });
      hooks.announce('画布平移');
    } else if (shiftKey && state.selectedId) {
      store.dispatch({ type: 'nudge', dx: delta[0], dy: delta[1] });
      hooks.announce('微调选中元素');
    } else {
      store.dispatch({ type: 'cursor-move', dx: delta[0], dy: delta[1] });
      if (state.draft && state.draft.kind === 'shape') {
        store.dispatch({ type: 'primary-move', point: store.getState().cursor });
      }
    }
    return true;
  }

  if (key === ' ' || key === 'Enter') {
    event.preventDefault();
    if (state.draft) {
      store.commitTransaction();
      store.dispatch({ type: 'primary-up' });
    } else {
      store.beginTransaction();
      store.dispatch({ type: 'primary-down', point: { ...state.cursor } });
    }
    hooks.announce(store.getState().lastAction);
    return true;
  }

  if (key === 'Escape') {
    event.preventDefault();
    if (state.draft) {
      store.commitTransaction();
      store.dispatch({ type: 'cancel' });
    }
    else if (state.selectedId) store.dispatch({ type: 'deselect' });
    hooks.announce(store.getState().lastAction);
    return true;
  }

  if (key === '[') {
    event.preventDefault();
    store.dispatch({ type: 'select-cycle', dir: 'prev' });
    hooks.announce(store.getState().lastAction);
    return true;
  }
  if (key === ']') {
    event.preventDefault();
    store.dispatch({ type: 'select-cycle', dir: 'next' });
    hooks.announce(store.getState().lastAction);
    return true;
  }

  if (key === 'Delete' || key === 'Backspace') {
    if (state.selectedId) {
      event.preventDefault();
      store.dispatch({ type: 'delete-selected' });
      hooks.announce('已删除元素');
      return true;
    }
  }

  if (key === '+' || key === '=') {
    event.preventDefault();
    store.dispatch({ type: 'zoom', zoom: state.view.zoom + 0.1 });
    return true;
  }
  if (key === '-') {
    event.preventDefault();
    store.dispatch({ type: 'zoom', zoom: state.view.zoom - 0.1 });
    return true;
  }
  if (key === '0') {
    event.preventDefault();
    store.dispatch({ type: 'reset-view' });
    return true;
  }

  const lower = key.toLowerCase();
  if (TOOL_KEYS[lower]) {
    event.preventDefault();
    store.dispatch({ type: 'set-tool', tool: TOOL_KEYS[lower] });
    hooks.announce(`工具：${TOOL_KEYS[lower]}`);
    return true;
  }

  return false;
}
