/* Canvas editor: state, persistence, i18n. Language switch re-renders chrome and
   re-measures text, but never mutates object coordinates. */
(function () {
  "use strict";

  const STORAGE_KEY = "ml-canvas-draft-v1";

  const state = {
    lang: "zh-CN",
    objects: [], // {id, kind, x, y, w, h, text}
    selectedId: null,
    scroll: { left: 0, top: 0 },
    dirty: false,
    lastSaved: null,
    nextId: 1,
    undoStack: [],
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    html: document.documentElement,
    langSelect: $("language-select"),
    canvas: $("canvas"),
    canvasScroll: $("canvas-scroll"),
    editor: $("object-editor"),
    toast: $("toast"),
    recoverBanner: $("recover-banner"),
    recoverSnapshot: $("recover-snapshot"),
    helpDialog: $("help-dialog"),
  };

  /* ---------- persistence ---------- */

  function snapshot() {
    return JSON.stringify({
      lang: state.lang,
      objects: state.objects,
      selectedId: state.selectedId,
      scroll: state.scroll,
      dirty: state.dirty,
      nextId: state.nextId,
      savedAt: new Date().toISOString(),
    });
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, snapshot());
      state.lastSaved = new Date().toISOString();
    } catch (err) {
      showToast(String(err), "err");
    }
    renderStatus();
  }

  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.objects)) throw new Error("bad shape");
      state.lang = I18N[data.lang] ? data.lang : "zh-CN";
      state.objects = data.objects;
      state.selectedId = data.selectedId ?? null;
      state.scroll = data.scroll || { left: 0, top: 0 };
      state.dirty = !!data.dirty;
      state.nextId = data.nextId || data.objects.length + 1;
      state.lastSaved = data.savedAt || null;
    } catch (err) {
      // Recovery failed: keep a readable raw snapshot visible instead of dropping data.
      els.recoverBanner.hidden = false;
      els.recoverSnapshot.textContent = raw;
    }
  }

  /* ---------- i18n ---------- */

  function applyLanguage(lang) {
    state.lang = lang;
    const dict = I18N[lang];
    els.html.lang = lang;
    els.html.dir = dict.dir;
    document.title = dict.appTitle;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = dict[node.dataset.i18n] || node.dataset.i18n;
    });
    els.editor.placeholder = dict.editorPlaceholder;
    els.editor.setAttribute("aria-label", dict.editorLabel);
    els.canvas.setAttribute("aria-label", dict.canvasLabel);
    // Re-measure object text for the new locale; coordinates stay untouched.
    state.objects.forEach((obj) => remeasure(obj));
    renderCanvas();
    persist();
  }

  function buildLanguageOptions() {
    I18N_LANGS.forEach((lang) => {
      const opt = document.createElement("option");
      opt.value = lang;
      opt.textContent = I18N[lang].langName;
      els.langSelect.appendChild(opt);
    });
    els.langSelect.value = state.lang;
    els.langSelect.addEventListener("change", () => applyLanguage(els.langSelect.value));
  }

  /* ---------- status panel ---------- */

  function renderStatus() {
    const dict = I18N[state.lang];
    $("st-language").textContent = dict.langName + " (" + state.lang + ")";
    $("st-count").textContent = String(state.objects.length);
    $("st-selected").textContent =
      state.selectedId != null ? dict.objectN + " #" + state.selectedId : dict.statusNone;
    $("st-scroll").textContent =
      Math.round(state.scroll.left) + ", " + Math.round(state.scroll.top);
    $("st-dirty").textContent = state.dirty ? dict.statusYes : dict.statusNo;
    let size = 0;
    try {
      size = (localStorage.getItem(STORAGE_KEY) || "").length;
    } catch (err) {
      size = -1;
    }
    $("st-storage").textContent = size >= 0 ? size + " B" : dict.statusNone;
    $("st-saved").textContent = state.lastSaved || dict.statusNone;
  }

  function showToast(message, kind) {
    els.toast.textContent = message;
    els.toast.className = "toast " + (kind || "");
  }

  /* ---------- object model ---------- */

  function pushUndo() {
    state.undoStack.push(
      JSON.stringify({ objects: state.objects, selectedId: state.selectedId, nextId: state.nextId })
    );
    if (state.undoStack.length > 50) state.undoStack.shift();
  }

  function undo() {
    const prev = state.undoStack.pop();
    if (!prev) return;
    const data = JSON.parse(prev);
    state.objects = data.objects;
    state.selectedId = data.selectedId;
    state.nextId = data.nextId;
    state.dirty = true;
    renderCanvas();
    persist();
  }

  function addObject(kind) {
    pushUndo();
    const id = state.nextId++;
    const obj = {
      id,
      kind,
      x: 40 + (id % 6) * 60,
      y: 40 + (id % 5) * 50,
      w: kind === "text" ? 220 : 160,
      h: kind === "text" ? 90 : 110,
      text: I18N[state.lang].untitledText + " #" + id,
    };
    remeasure(obj);
    state.objects.push(obj);
    state.selectedId = id;
    state.dirty = true;
    renderCanvas();
    persist();
    focusObject(id);
  }

  function deleteSelected() {
    if (state.selectedId == null) return;
    pushUndo();
    state.objects = state.objects.filter((o) => o.id !== state.selectedId);
    state.selectedId = null;
    state.dirty = true;
    renderCanvas();
    persist();
  }

  // Re-measure text height only; x/y/w are never changed by measurement.
  function remeasure(obj) {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;visibility:hidden;width:" + obj.w + "px;font-size:0.9rem;line-height:1.5;padding:4px;";
    probe.textContent = obj.text;
    document.body.appendChild(probe);
    const needed = Math.max(60, Math.ceil(probe.offsetHeight) + 8);
    probe.remove();
    obj.h = Math.max(obj.h, Math.min(needed, 300));
  }

  /* ---------- rendering ---------- */

  function renderCanvas() {
    const focusedId =
      document.activeElement && document.activeElement.dataset
        ? document.activeElement.dataset.id
        : null;
    els.canvas.querySelectorAll(".canvas-object").forEach((n) => n.remove());
    state.objects.forEach((obj) => {
      const node = document.createElement("div");
      node.className = "canvas-object kind-" + obj.kind;
      if (obj.id === state.selectedId) node.classList.add("selected");
      node.style.left = obj.x + "px";
      node.style.top = obj.y + "px";
      node.style.width = obj.w + "px";
      node.style.height = obj.h + "px";
      node.textContent = obj.text;
      node.tabIndex = 0;
      node.dataset.id = String(obj.id);
      node.dataset.testid = "canvas-object-" + obj.id;
      node.setAttribute("role", "button");
      node.setAttribute(
        "aria-label",
        I18N[state.lang].objectN + " #" + obj.id + ": " + obj.text
      );
      node.addEventListener("pointerdown", (e) => startDrag(e, obj));
      node.addEventListener("dblclick", () => openEditor(obj));
      node.addEventListener("focus", () => selectObject(obj.id));
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openEditor(obj);
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          deleteSelected();
        }
      });
      els.canvas.appendChild(node);
    });
    if (focusedId != null) {
      const node = els.canvas.querySelector('[data-id="' + focusedId + '"]');
      if (node) node.focus();
    }
    renderStatus();
  }

  function selectObject(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    renderCanvas();
    persist();
  }

  function focusObject(id) {
    const node = els.canvas.querySelector('[data-id="' + id + '"]');
    if (node) node.focus();
  }

  /* ---------- drag (pointer-based; coordinates only change via drag) ---------- */

  function startDrag(e, obj) {
    if (!els.editor.hidden) return;
    e.preventDefault();
    selectObject(obj.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = obj.x;
    const origY = obj.y;
    let moved = false;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!moved) {
        moved = true;
        pushUndo();
      }
      obj.x = Math.max(0, Math.round(origX + dx));
      obj.y = Math.max(0, Math.round(origY + dy));
      const node = els.canvas.querySelector('[data-id="' + obj.id + '"]');
      if (node) {
        node.style.left = obj.x + "px";
        node.style.top = obj.y + "px";
      }
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) {
        state.dirty = true;
        persist();
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /* ---------- inline text editor ---------- */

  function openEditor(obj) {
    const node = els.canvas.querySelector('[data-id="' + obj.id + '"]');
    if (!node) return;
    const wrapRect = els.canvasScroll.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    els.editor.hidden = false;
    els.editor.style.left = nodeRect.left - wrapRect.left + els.canvasScroll.scrollLeft + "px";
    els.editor.style.top = nodeRect.top - wrapRect.top + els.canvasScroll.scrollTop + "px";
    els.editor.style.width = Math.max(obj.w, 120) + "px";
    els.editor.value = obj.text;
    els.editor.dataset.editing = String(obj.id);
    els.editor.focus();
    els.editor.select();
  }

  function commitEditor() {
    if (els.editor.hidden) return;
    const id = Number(els.editor.dataset.editing);
    const obj = state.objects.find((o) => o.id === id);
    if (obj && els.editor.value !== obj.text) {
      pushUndo();
      obj.text = els.editor.value;
      remeasure(obj);
      state.dirty = true;
    }
    els.editor.hidden = true;
    renderCanvas();
    persist();
    focusObject(id);
  }

  /* ---------- submit / dialog ---------- */

  function submit() {
    if (state.objects.length === 0) {
      showToast(I18N[state.lang].submitFailEmpty, "err");
      return;
    }
    state.objects = [];
    state.selectedId = null;
    state.dirty = false;
    state.undoStack = [];
    renderCanvas();
    persist();
    showToast(I18N[state.lang].submitOk, "ok");
  }

  /* ---------- wiring ---------- */

  function bindEvents() {
    $("btn-add-rect").addEventListener("click", () => addObject("rect"));
    $("btn-add-text").addEventListener("click", () => addObject("text"));
    $("btn-delete").addEventListener("click", deleteSelected);
    $("btn-undo").addEventListener("click", undo);
    $("btn-submit").addEventListener("click", submit);
    $("btn-help").addEventListener("click", () => els.helpDialog.showModal());
    els.helpDialog.addEventListener("close", () => {
      // Closing the dialog must not disturb editing state; just report it.
      showToast(I18N[state.lang].dialogClosed, "ok");
      renderStatus();
    });

    els.editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEditor();
      } else if (e.key === "Escape") {
        els.editor.hidden = true;
        focusObject(Number(els.editor.dataset.editing));
      }
      e.stopPropagation();
    });
    els.editor.addEventListener("blur", commitEditor);

    els.canvasScroll.addEventListener("scroll", () => {
      state.scroll.left = els.canvasScroll.scrollLeft;
      state.scroll.top = els.canvasScroll.scrollTop;
      renderStatus();
      persist();
    });

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    });
  }

  /* ---------- init ---------- */

  restore();
  buildLanguageOptions();
  bindEvents();
  applyLanguage(state.lang);
  // Restore scroll after first render; keep selection and unsubmitted draft intact.
  requestAnimationFrame(() => {
    els.canvasScroll.scrollLeft = state.scroll.left;
    els.canvasScroll.scrollTop = state.scroll.top;
    renderStatus();
  });

  window.__app = { state, persist, restore, STORAGE_KEY };
})();
