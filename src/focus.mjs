// 焦点管理：弹窗焦点陷阱、背景 inert、可编辑目标判定

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([disabled]):not([tabindex="-1"])',
].join(',');

export function getFocusable(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

// 在容器内安装 Tab 焦点陷阱，返回卸载函数
export function installFocusTrap(container, { onTabOut } = {}) {
  function onKeyDown(event) {
    if (event.key !== 'Tab') return;
    const items = getFocusable(container);
    if (items.length === 0) {
      event.preventDefault();
      onTabOut?.();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
  container.addEventListener('keydown', onKeyDown);
  return () => container.removeEventListener('keydown', onKeyDown);
}

// 打开弹窗时冻结背景；返回恢复函数
export function freezeBackground(backgroundRoots) {
  const previous = backgroundRoots.map((el) => ({
    el,
    inert: el.inert,
    ariaHidden: el.getAttribute('aria-hidden'),
  }));
  for (const el of backgroundRoots) {
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
  }
  return () => {
    for (const item of previous) {
      item.el.inert = item.inert;
      if (item.ariaHidden === null) item.el.removeAttribute('aria-hidden');
      else item.el.setAttribute('aria-hidden', item.ariaHidden);
    }
  };
}

// 记录触发元素并在关闭后归还焦点
export function createFocusReturn() {
  const trigger = document.activeElement;
  return function restore() {
    if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) {
      // 鼠标点击遮罩后 activeElement 可能已变为 body，这里强制归还
      trigger.focus({ preventScroll: false });
      return document.activeElement === trigger;
    }
    return false;
  };
}
