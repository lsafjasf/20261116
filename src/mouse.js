// 鼠标/指针 -> command 映射。与键盘产生完全相同的 command 类型。

import { screenToDoc } from './geometry.js';

export function bindMouse(canvasEl, store) {
  function toDoc(event) {
    const rect = canvasEl.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return screenToDoc(screen, store.getState().view, {
      width: rect.width,
      height: rect.height,
    });
  }

  let pointerDown = false;
  let panGesture = null;

  canvasEl.addEventListener('pointerdown', (event) => {
    if (event.button === 1) {
      // 中键平移：任何工具下可用，产生与 Alt+方向键相同的 pan 视图状态。
      event.preventDefault();
      canvasEl.focus({ preventScroll: true });
      const rect = canvasEl.getBoundingClientRect();
      panGesture = {
        startX: event.clientX - rect.left,
        startY: event.clientY - rect.top,
        basePan: { ...store.getState().view },
      };
      canvasEl.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    canvasEl.focus({ preventScroll: true });
    pointerDown = true;
    canvasEl.setPointerCapture(event.pointerId);
    const point = toDoc(event);
    store.beginTransaction();
    store.dispatch({ type: 'primary-down', point });
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (panGesture) {
      const rect = canvasEl.getBoundingClientRect();
      const dx = event.clientX - rect.left - panGesture.startX;
      const dy = event.clientY - rect.top - panGesture.startY;
      store.dispatch({
        type: 'pan-by',
        dx: dx - (panGesture.appliedX ?? 0),
        dy: dy - (panGesture.appliedY ?? 0),
      });
      panGesture.appliedX = dx;
      panGesture.appliedY = dy;
      return;
    }
    if (!pointerDown) {
      store.dispatch({ type: 'cursor-set', point: toDoc(event) });
      return;
    }
    store.dispatch({ type: 'primary-move', point: toDoc(event) });
  });

  function endPointer(event) {
    if (panGesture) {
      panGesture = null;
      try { canvasEl.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
      return;
    }
    if (!pointerDown) return;
    pointerDown = false;
    try { canvasEl.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
    store.commitTransaction();
    store.dispatch({ type: 'primary-up' });
  }

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', () => {
    pointerDown = false;
    store.cancelTransaction();
    store.dispatch({ type: 'cancel' });
  });

  canvasEl.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (store.getState().draft) {
      store.cancelTransaction();
      store.dispatch({ type: 'cancel' });
    }
  });

  canvasEl.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const state = store.getState();
    const factor = event.deltaY > 0 ? -0.1 : 0.1;
    store.dispatch({ type: 'zoom', zoom: state.view.zoom + factor });
  }, { passive: false });

  canvasEl.addEventListener('dblclick', (event) => {
    event.preventDefault();
    canvasEl.focus({ preventScroll: true });
  });
}
