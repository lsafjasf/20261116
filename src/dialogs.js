// 模态对话框：焦点陷阱、Esc 关闭、焦点归还；导出失败时保留可读快照。

import { exportJSON, exportSVG } from './renderer.js';

function focusable(root) {
  return [...root.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export function createDialogController(backdrop, opts) {
  const inner = backdrop.querySelector('.dialog');
  let lastFocused = null;

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable(inner);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function open() {
    lastFocused = document.activeElement;
    backdrop.hidden = false;
    document.addEventListener('keydown', onKeydown, true);
    opts.onOpen?.();
    const items = focusable(inner);
    (items[0] || inner).focus();
  }

  function close() {
    backdrop.hidden = true;
    document.removeEventListener('keydown', onKeydown, true);
    opts.onClose?.();
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }

  return { open, close, get isOpen() { return !backdrop.hidden; } };
}

export function bindExportDialog(store, announce) {
  const backdrop = document.getElementById('export-dialog');
  const preview = document.getElementById('export-preview');
  const alertBox = document.getElementById('export-alert');
  const simFail = document.getElementById('export-sim-fail');

  function currentExport() {
    const format = backdrop.querySelector('input[name="export-format"]:checked').value;
    return { format, content: format === 'svg' ? exportSVG(store.getState()) : exportJSON(store.getState()) };
  }

  function refreshPreview() {
    const { content } = currentExport();
    preview.textContent = content;
  }

  function showError(message) {
    alertBox.hidden = false;
    alertBox.textContent = `导出失败：${message}。图形与上次快照仍保留在页面与本地存储中，可重试或直接复制预览内容。`;
    announce('导出失败，快照已保留');
  }

  const controller = createDialogController(backdrop, {
    onOpen: () => {
      alertBox.hidden = true;
      refreshPreview();
    },
  });

  backdrop.querySelectorAll('input[name="export-format"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      alertBox.hidden = true;
      refreshPreview();
    });
  });

  document.getElementById('btn-export-copy').addEventListener('click', async () => {
    try {
      if (simFail.checked) throw new Error('模拟的剪贴板写入错误');
      await navigator.clipboard.writeText(currentExport().content);
      alertBox.hidden = true;
      announce('导出内容已复制到剪贴板');
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById('btn-export-download').addEventListener('click', () => {
    try {
      if (simFail.checked) throw new Error('模拟的下载错误');
      const { format, content } = currentExport();
      const blob = new Blob([content], { type: format === 'svg' ? 'image/svg+xml' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `drawing.${format}`;
      link.click();
      URL.revokeObjectURL(url);
      announce(`已下载 drawing.${format}`);
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById('btn-export-close').addEventListener('click', controller.close);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) controller.close();
  });

  return controller;
}

export function bindHelpDialog() {
  const backdrop = document.getElementById('help-dialog');
  const controller = createDialogController(backdrop, {});
  document.getElementById('btn-help-close').addEventListener('click', controller.close);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) controller.close();
  });
  return controller;
}
