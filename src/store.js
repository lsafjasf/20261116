// 单一状态源 + 命令 reducer + 撤销栈 + localStorage 持久化。
// 鼠标与键盘的所有操作都转换为同一批 command，保证工程状态完全等价。

import { clamp, hitTest, MIN_SIZE, normalizeShape, round2 } from './geometry.js';
import { STORAGE_KEY, LAST_GOOD_KEY, CORRUPT_KEY } from './store-constants.js';

export { STORAGE_KEY, LAST_GOOD_KEY, CORRUPT_KEY };

export const TOOLS = ['select', 'rect', 'ellipse', 'line', 'pan'];

export function initialState() {
  return {
    version: 1,
    tool: 'select',
    elements: [],
    nextId: 1,
    selectedId: null,
    cursor: { x: 200, y: 160 },
    draft: null,
    view: { zoom: 1, panX: 0, panY: 0 },
    canvasSize: { width: 800, height: 520 },
    lastAction: 'init',
    lastError: null,
    savedAt: null,
  };
}

let idCounter = 1;
function makeId(state) {
  const id = `el-${Math.max(state.nextId, idCounter)}`;
  idCounter = Math.max(state.nextId, idCounter) + 1;
  return id;
}

function withAction(state, action) {
  return { ...state, lastAction: action };
}

function moveCursor(state, dx, dy) {
  return {
    ...state,
    cursor: {
      x: clamp(round2(state.cursor.x + dx), 0, state.canvasSize.width),
      y: clamp(round2(state.cursor.y + dy), 0, state.canvasSize.height),
    },
  };
}

function beginDraft(state) {
  if (state.tool === 'select') {
    const hit = hitTest(state.elements, state.cursor);
    return withAction({ ...state, selectedId: hit }, hit ? 'select-element' : 'deselect');
  }
  if (state.tool === 'pan') {
    return withAction({ ...state, draft: { kind: 'pan', start: { ...state.cursor }, origin: { ...state.view } } }, 'pan-start');
  }
  const id = makeId(state);
  const base = {
    id,
    type: state.tool,
    x1: state.cursor.x,
    y1: state.cursor.y,
    x2: state.cursor.x,
    y2: state.cursor.y,
  };
  return withAction({
    ...state,
    nextId: idCounter,
    selectedId: id,
    draft: { kind: 'shape', ...base },
  }, 'draw-begin');
}

function commitDraft(state) {
  const draft = state.draft;
  if (!draft) return state;
  if (draft.kind === 'pan') {
    return withAction({ ...state, draft: null }, 'pan-end');
  }
  const shape = normalizeShape(draft);
  if (shape.width < MIN_SIZE || shape.height < MIN_SIZE) {
    return withAction({ ...state, draft: null, selectedId: null }, 'draw-cancel-too-small');
  }
  return withAction({
    ...state,
 elements: [...state.elements, shape],
    draft: null,
  }, 'draw-commit');
}

function nudge(state, dx, dy) {
  if (!state.selectedId) return state;
  return withAction({
    ...state,
    elements: state.elements.map((el) => el.id === state.selectedId
      ? { ...el, x1: round2(el.x1 + dx), y1: round2(el.y1 + dy), x2: round2(el.x2 + dx), y2: round2(el.y2 + dy) }
      : el),
  }, 'nudge');
}

// 纯函数 reducer：输入 command，输出新 state。鼠标/键盘共用这唯一入口。
export function reducer(state, command) {
  switch (command.type) {
    case 'set-tool':
      if (!TOOLS.includes(command.tool) || command.tool === state.tool) return state;
      return withAction({ ...state, tool: command.tool, draft: null }, 'set-tool');

    case 'cursor-move':
      return moveCursor(state, command.dx, command.dy);

    case 'cursor-set':
      return withAction({ ...state, cursor: {
        x: clamp(round2(command.point.x), 0, state.canvasSize.width),
        y: clamp(round2(command.point.y), 0, state.canvasSize.height),
      } }, 'cursor-set');

    case 'set-canvas-size':
      return { ...state, canvasSize: { ...command.size } };

    case 'primary-down':
      return beginDraft({ ...state, cursor: { ...command.point } });

    case 'primary-move': {
      if (!state.draft) {
        return { ...state, cursor: {
          x: clamp(round2(command.point.x), 0, state.canvasSize.width),
          y: clamp(round2(command.point.y), 0, state.canvasSize.height),
        } };
      }
      if (state.draft.kind === 'pan') {
        const dx = command.point.x - state.draft.start.x;
        const dy = command.point.y - state.draft.start.y;
        return { ...state, view: {
          ...state.view,
          panX: round2(state.draft.origin.panX + dx),
          panY: round2(state.draft.origin.panY + dy),
        } };
      }
      return { ...state, draft: { ...state.draft, x2: command.point.x, y2: command.point.y } };
    }

    case 'primary-up':
      return commitDraft(state);

    case 'cancel':
      return withAction({
        ...state,
        draft: null,
        selectedId: state.draft?.kind === 'shape' && state.selectedId === state.draft.id
          ? null
          : state.selectedId,
      }, 'cancel-draft');

    case 'select-at-cursor':
      return withAction({ ...state, selectedId: hitTest(state.elements, state.cursor) }, 'select-at-cursor');

    case 'select-cycle': {
      if (state.elements.length === 0) return withAction({ ...state, selectedId: null }, 'select-empty');
      const idx = state.elements.findIndex((el) => el.id === state.selectedId);
      const nextIdx = command.dir === 'next'
        ? (idx + 1) % state.elements.length
        : (idx <= 0 ? state.elements.length - 1 : idx - 1);
      return withAction({ ...state, selectedId: state.elements[nextIdx].id }, 'select-cycle');
    }

    case 'deselect':
      return withAction({ ...state, selectedId: null }, 'deselect');

    case 'nudge':
      return nudge(state, command.dx, command.dy);

    case 'delete-selected': {
      if (!state.selectedId) return state;
      return withAction({
        ...state,
        elements: state.elements.filter((el) => el.id !== state.selectedId),
        selectedId: null,
      }, 'delete');
    }

    case 'pan-by':
      return { ...state, view: {
        ...state.view,
        panX: round2(state.view.panX + command.dx),
        panY: round2(state.view.panY + command.dy),
      }, lastAction: 'pan-by' };

    case 'zoom': {
      const zoom = clamp(round2(command.zoom), 0.25, 4);
      if (zoom === state.view.zoom) return state;
      return withAction({ ...state, view: { ...state.view, zoom } }, 'zoom');
    }

    case 'reset-view':
      return withAction({ ...state, view: { zoom: 1, panX: 0, panY: 0 } }, 'reset-view');

    case 'set-error':
      return { ...state, lastError: { message: command.message, at: Date.now() } };

    case 'clear-error':
      return state.lastError ? { ...state, lastError: null } : state;

    default:
      return state;
  }
}
