import { addLog, loadState, persist, STORAGE_KEY } from "./core.js";
import { createUI } from "./ui.js";

const boot = loadState();
const state = boot.state;
let ui = null;
let guardTripped = false;

function exposeDiagnostics() {
  window.__FRAMECRAFT__ = {
    getState: () => state,
    getStorage: () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    getModule: (moduleId) => state.modules[moduleId],
    getResourceCount: () => Object.keys(state.resources).length,
    getLogs: () => [...state.logs],
    runModule: (moduleId, options) => ui?.runModuleAction(moduleId, options),
    setStepDelay: (milliseconds) => ui?.setStepDelay(milliseconds),
    flushSave: (label = "手动检查点") => {
      persist(state, label);
      ui?.renderAll();
      return state.meta;
    },
    toast: (message) => ui?.toast(message)
  };
}

try {
  persist(state, "已载入本地工程");
  ui = createUI(state);
  ui.mount();
  exposeDiagnostics();

  if (boot.warning) {
    const banner = document.getElementById("global-banner");
    if (banner) banner.hidden = false;
    const text = document.getElementById("global-banner-text");
    if (text) text.textContent = boot.warning;
    addLog(state, {
      level: "error",
      module: "恢复",
      stage: "安全快照",
      message: boot.warning
    });
    persist(state, "已保留安全快照");
    ui.renderMirror();
  }
} catch (error) {
  const banner = document.getElementById("global-banner");
  if (banner) banner.hidden = false;
  const text = document.getElementById("global-banner-text");
  if (text) text.textContent = `初始化视图失败，但静态编辑内容仍可读：${String(error?.message || error)}`;
  console.error("[Framecraft init]", error);
}

function reportGlobalFailure(kind, error) {
  if (guardTripped) return;
  guardTripped = true;
  const message = `${kind}被统一安全层拦截；当前页面与本地快照不会被清空。`;
  if (ui) {
    ui.showGlobalError(message, error);
    ui.toast(message);
  } else {
    const banner = document.getElementById("global-banner");
    if (banner) banner.hidden = false;
    const text = document.getElementById("global-banner-text");
    if (text) text.textContent = message;
  }
  setTimeout(() => {
    guardTripped = false;
  }, 1500);
}

window.addEventListener("error", (event) => {
  reportGlobalFailure("未捕获脚本错误", event.error || new Error(event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  reportGlobalFailure("未处理的异步错误", event.reason);
});
