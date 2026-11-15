/* UI controller: wires the worker-based import, persistence,
 * virtualised preview list, undo, and the live debug state panel. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    fileInput: $("fileInput"), importBtn: $("importBtn"), fileMeta: $("fileMeta"),
    status: $("statusRegion"),
    errorPanel: $("errorPanel"), errMessage: $("errMessage"), errObject: $("errObject"),
    errPath: $("errPath"), errOffset: $("errOffset"), errSnippet: $("errSnippet"),
    resultPanel: $("resultPanel"), resCount: $("resCount"), resHash: $("resHash"),
    resFile: $("resFile"), resDuration: $("resDuration"),
    notes: $("notes"), commitNotesBtn: $("commitNotesBtn"), undoBtn: $("undoBtn"),
    notesState: $("notesState"),
    listBox: $("listBox"), listSpacer: $("listSpacer"), selInfo: $("selInfo"),
    debug: $("debugState"),
    snapshotBanner: $("snapshotBanner"), snapshotText: $("snapshotText"),
    dialog: $("progressDialog"), progressBar: $("progressBar"),
    progressText: $("progressText"), cancelBtn: $("cancelBtn")
  };

  var ROW_H = 28;
  var store = window.KfStore.createStore(window.localStorage);

  var state = {
    phase: "idle", // idle | importing | done | error | cancelled
    fileName: null,
    fileSize: null,
    progress: { parsed: 0, bytesRead: 0, totalBytes: 0 },
    result: null,       // committed only when the worker reports 'done'
    error: null,
    notes: "",
    notesHistory: [],
    selectedIndex: null,
    scrollTop: 0,
    preview: [],
    storageStatus: "init",
    lastSaveAt: null
  };

  var worker = null;
  var cancelFallbackTimer = null;

  /* ---------- persistence ---------- */

  function persistedState() {
    return {
      notes: state.notes,
      selectedIndex: state.selectedIndex,
      scrollTop: state.scrollTop,
      result: state.result,
      preview: state.preview
    };
  }

  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var res = store.save(persistedState());
      state.storageStatus = res.ok ? "saved" : "save-failed: " + res.error;
      state.lastSaveAt = new Date().toISOString();
      updateDebug();
    }, 150);
  }

  function restore() {
    var res = store.load();
    if (!res.ok) {
      state.storageStatus = "restore-failed: " + res.error;
      if (res.snapshot != null) {
        els.snapshotText.textContent = res.snapshot;
        els.snapshotBanner.hidden = false;
      }
      return;
    }
    state.storageStatus = res.state ? "restored" : "empty";
    if (!res.state) return;
    var s = res.state;
    state.notes = typeof s.notes === "string" ? s.notes : "";
    state.selectedIndex = typeof s.selectedIndex === "number" ? s.selectedIndex : null;
    state.scrollTop = typeof s.scrollTop === "number" ? s.scrollTop : 0;
    state.result = s.result || null;
    state.preview = Array.isArray(s.preview) ? s.preview : [];
    if (state.selectedIndex != null && state.selectedIndex >= state.preview.length) {
      state.selectedIndex = null;
    }
    if (state.result) {
      state.phase = "done";
      showResult(state.result);
    }
  }

  /* ---------- status / debug ---------- */

  var STATUS_TEXT = {
    idle: "就绪",
    importing: "正在导入…",
    done: "导入完成",
    error: "导入失败",
    cancelled: "导入已取消，未产生任何半成品数据"
  };

  function setStatus() {
    els.status.textContent = STATUS_TEXT[state.phase] || state.phase;
  }

  function updateDebug() {
    els.debug.textContent = JSON.stringify({
      phase: state.phase,
      文件: state.fileName ? { name: state.fileName, size: state.fileSize } : null,
      进度: state.progress,
      已提交结果: state.result
        ? { count: state.result.count, hash: state.result.hash }
        : null,
      草稿: { notes长度: state.notes.length, 可撤销步数: state.notesHistory.length },
      选中对象: state.selectedIndex,
      滚动位置: Math.round(state.scrollTop),
      存储状态: state.storageStatus,
      上次保存: state.lastSaveAt
    }, null, 2);
  }

  function refresh() {
    setStatus();
    updateDebug();
  }

  /* ---------- import flow ---------- */

  function ensureWorker() {
    if (!worker) {
      worker = new Worker("src/worker.js");
      worker.onmessage = onWorkerMessage;
      worker.onerror = function (e) {
        finishImport();
        state.phase = "error";
        showError({ message: "Worker 异常: " + (e.message || "未知错误") });
        refresh();
      };
    }
    return worker;
  }

  function startImport() {
    var file = els.fileInput.files && els.fileInput.files[0];
    if (!file || state.phase === "importing") return;
    state.phase = "importing";
    state.fileName = file.name;
    state.fileSize = file.size;
    state.progress = { parsed: 0, bytesRead: 0, totalBytes: file.size };
    state.error = null;
    els.errorPanel.hidden = true;
    els.importBtn.disabled = true;
    els.progressBar.value = 0;
    els.progressText.textContent = "0%（0 个对象）";
    refresh();
    if (typeof els.dialog.showModal === "function") {
      els.dialog.showModal();
    } else {
      els.dialog.setAttribute("open", "");
    }
    els.cancelBtn.focus();
    ensureWorker().postMessage({ type: "start", file: file });
  }

  function requestCancel() {
    if (state.phase !== "importing") return;
    if (worker) worker.postMessage({ type: "cancel" });
    // Fallback: if the worker is stuck, terminate it so no half-finished
    // state can leak into the committed result.
    clearTimeout(cancelFallbackTimer);
    cancelFallbackTimer = setTimeout(function () {
      if (state.phase === "importing" && worker) {
        worker.terminate();
        worker = null;
        onCancelled(0);
      }
    }, 2000);
  }

  function finishImport() {
    clearTimeout(cancelFallbackTimer);
    if (els.dialog.open) els.dialog.close();
    els.importBtn.disabled = !(els.fileInput.files && els.fileInput.files.length);
    els.importBtn.focus();
  }

  function onCancelled(parsed) {
    finishImport();
    // Staging is discarded: state.result is left untouched.
    state.phase = "cancelled";
    state.progress.parsed = parsed || 0;
    refresh();
  }

  function showError(err) {
    state.error = err;
    els.errorPanel.hidden = false;
    els.errMessage.textContent = err.message || "未知错误";
    els.errObject.textContent = err.objectIndex != null ? String(err.objectIndex) : "—";
    els.errPath.textContent = err.path || "—";
    els.errOffset.textContent = err.offset != null ? String(err.offset) : "—";
    els.errSnippet.textContent = err.snippet || "—";
  }

  function showResult(result) {
    els.resultPanel.hidden = false;
    els.resCount.textContent = result.count.toLocaleString("zh-CN");
    els.resHash.textContent = result.hash;
    els.resFile.textContent = result.fileName + "（" +
      (result.fileSize / 1048576).toFixed(1) + " MiB）";
    els.resDuration.textContent = result.durationMs + " ms";
  }

  function onWorkerMessage(event) {
    var msg = event.data;
    if (msg.type === "progress") {
      state.progress = { parsed: msg.parsed, bytesRead: msg.bytesRead, totalBytes: msg.totalBytes };
      var pct = msg.totalBytes ? Math.floor((msg.bytesRead / msg.totalBytes) * 100) : 0;
      els.progressBar.value = pct;
      els.progressText.textContent = pct + "%（已解析 " + msg.parsed.toLocaleString("zh-CN") + " 个对象）";
      updateDebug();
      return;
    }
    if (msg.type === "done") {
      finishImport();
      state.phase = "done";
      state.result = {
        count: msg.count,
        hash: msg.hash,
        fileName: state.fileName,
        fileSize: state.fileSize,
        durationMs: msg.durationMs,
        importedAt: new Date().toISOString()
      };
      state.preview = msg.preview || [];
      state.error = null;
      showResult(state.result);
      renderList();
      scheduleSave();
      refresh();
      return;
    }
    if (msg.type === "cancelled") {
      onCancelled(msg.parsed);
      return;
    }
    if (msg.type === "error") {
      finishImport();
      state.phase = "error";
      showError(msg.error);
      refresh();
    }
  }

  /* ---------- virtualised preview list ---------- */

  function rowText(kf, i) {
    return "#" + i + "  t=" + kf.time + "  bone=" + kf.meta.bone +
      "  pos=[" + kf.position.join(", ") + "]  easing=" + kf.meta.easing;
  }

  function renderList() {
    var items = state.preview;
    els.listSpacer.style.height = (items.length * ROW_H) + "px";
    var scrollTop = els.listBox.scrollTop;
    var start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
    var visible = Math.ceil(els.listBox.clientHeight / ROW_H) + 10;
    var end = Math.min(items.length, start + visible);
    var rows = els.listBox.querySelectorAll(".kf-row");
    for (var r = 0; r < rows.length; r++) rows[r].remove();
    for (var i = start; i < end; i++) {
      var row = document.createElement("div");
      row.className = "kf-row";
      row.id = "kf-row-" + i;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === state.selectedIndex ? "true" : "false");
      row.style.top = (i * ROW_H) + "px";
      row.textContent = rowText(items[i], i);
      row.dataset.index = i;
      els.listBox.appendChild(row);
    }
    updateSelInfo();
  }

  function updateSelInfo() {
    if (state.selectedIndex == null || !state.preview[state.selectedIndex]) {
      els.selInfo.textContent = "未选中对象";
      els.listBox.setAttribute("aria-activedescendant", "");
    } else {
      els.selInfo.textContent = "已选中: " + rowText(state.preview[state.selectedIndex], state.selectedIndex);
      els.listBox.setAttribute("aria-activedescendant", "kf-row-" + state.selectedIndex);
    }
  }

  function selectIndex(i, scrollIntoView) {
    if (i == null || i < 0 || i >= state.preview.length) return;
    state.selectedIndex = i;
    if (scrollIntoView) {
      var top = i * ROW_H;
      var bottom = top + ROW_H;
      if (top < els.listBox.scrollTop) els.listBox.scrollTop = top;
      else if (bottom > els.listBox.scrollTop + els.listBox.clientHeight) {
        els.listBox.scrollTop = bottom - els.listBox.clientHeight;
      }
    }
    renderList();
    scheduleSave();
    updateDebug();
  }

  /* ---------- notes & undo ---------- */

  function refreshNotesUi() {
    els.undoBtn.disabled = state.notesHistory.length === 0;
  }

  /* ---------- events ---------- */

  els.fileInput.addEventListener("change", function () {
    var file = els.fileInput.files && els.fileInput.files[0];
    els.importBtn.disabled = !file || state.phase === "importing";
    els.fileMeta.textContent = file
      ? file.name + "（" + (file.size / 1048576).toFixed(1) + " MiB）"
      : "未选择文件";
    updateDebug();
  });

  els.importBtn.addEventListener("click", startImport);
  els.cancelBtn.addEventListener("click", requestCancel);
  els.dialog.addEventListener("cancel", function (e) {
    e.preventDefault(); // Esc: route through the same cancel path
    requestCancel();
  });

  els.notes.addEventListener("input", function () {
    state.notes = els.notes.value;
    els.notesState.textContent = "草稿未提交（已自动保存）";
    scheduleSave();
    updateDebug();
  });

  els.commitNotesBtn.addEventListener("click", function () {
    state.notesHistory.push(state.notes);
    els.notesState.textContent = "备注已提交 " + new Date().toLocaleTimeString("zh-CN");
    refreshNotesUi();
    updateDebug();
  });

  els.undoBtn.addEventListener("click", function () {
    var prev = state.notesHistory.pop();
    if (prev != null) {
      state.notes = prev;
      els.notes.value = prev;
      els.notesState.textContent = "已撤销到上一次提交";
      scheduleSave();
    }
    refreshNotesUi();
    updateDebug();
  });

  els.listBox.addEventListener("click", function (e) {
    var row = e.target.closest(".kf-row");
    if (row) selectIndex(Number(row.dataset.index), false);
  });

  els.listBox.addEventListener("keydown", function (e) {
    var cur = state.selectedIndex == null ? -1 : state.selectedIndex;
    var page = Math.max(1, Math.floor(els.listBox.clientHeight / ROW_H) - 1);
    var next = null;
    if (e.key === "ArrowDown") next = Math.min(cur + 1, state.preview.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(cur - 1, 0);
    else if (e.key === "PageDown") next = Math.min(cur + page, state.preview.length - 1);
    else if (e.key === "PageUp") next = Math.max(cur - page, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = state.preview.length - 1;
    if (next != null && state.preview.length) {
      e.preventDefault();
      selectIndex(next, true);
    }
  });

  var scrollSaveTimer = null;
  els.listBox.addEventListener("scroll", function () {
    state.scrollTop = els.listBox.scrollTop;
    window.requestAnimationFrame(renderList);
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(function () {
      scheduleSave();
      updateDebug();
    }, 200);
  });

  /* ---------- init ---------- */

  restore();
  els.notes.value = state.notes;
  refreshNotesUi();
  refresh();
  // Restore scroll & selection after layout settles.
  window.requestAnimationFrame(function () {
    renderList();
    els.listBox.scrollTop = state.scrollTop;
    renderList();
  });
})();
