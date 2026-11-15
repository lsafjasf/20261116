import {
  SNAPSHOT_STORAGE_KEY,
  createDefaultProject,
  createSnapshot,
  interpolateLayer,
  loadProject,
  normalizeProject,
  persistSnapshot,
  projectFingerprint,
  reorderLayer,
  saveProject,
  upsertKeyframe,
} from "./core/project.js";
import { FrameCache, makeFrameKey } from "./core/frame-cache.js";
import { ThumbnailScheduler } from "./core/thumbnail-scheduler.js";
import { createFrameSource } from "./core/frame-source.js";
import {
  formatTimecode,
  getCropRect,
  getOutputDimensions,
  getThumbnailCssSize,
  getThumbnailDimensions,
  renderProjectFrame,
} from "./core/renderer.js";

const CACHE_CAPACITY = 48;
const THUMBNAIL_GAP = 6;

const $ = (selector) => document.querySelector(selector);

class TimelineApp {
  constructor() {
    this.project = loadProject();
    this.revision = 1;
    this.currentTimeMs = 0;
    this.cropAspect = "16:9";
    this.zoom = 1;
    this.selectedLayerId = this.project.layers.at(-1)?.id ?? null;
    this.tileElements = new Map();
    this.currentSlots = [];
    this.lastSnapshot = null;
    this.lastExport = null;
    this.playTimer = null;
    this.timelineFrame = null;
    this.dragState = null;
    this.noticeTimer = null;

    this.dom = {
      projectName: $("#projectName"),
      projectRevision: $("#projectRevision"),
      hitRate: $("#hitRate"),
      queueLength: $("#queueLength"),
      cacheSize: $("#cacheSize"),
      staleDrops: $("#staleDrops"),
      cropSelect: $("#cropSelect"),
      previewCanvas: $("#previewCanvas"),
      currentTimecode: $("#currentTimecode"),
      timeSlider: $("#timeSlider"),
      playButton: $("#playButton"),
      outputSize: $("#outputSize"),
      layerList: $("#layerList"),
      layerX: $("#layerX"),
      layerY: $("#layerY"),
      layerColor: $("#layerColor"),
      layerOpacity: $("#layerOpacity"),
      selectedLayerName: $("#selectedLayerName"),
      selectedLayerId: $("#selectedLayerId"),
      keyframeInfo: $("#keyframeInfo"),
      timelineScroll: $("#timelineScroll"),
      timelineContent: $("#timelineContent"),
      thumbnailRow: $("#thumbnailRow"),
      trackArea: $("#trackArea"),
      ruler: $("#ruler"),
      playhead: $("#playhead"),
      zoomSlider: $("#zoomSlider"),
      zoomOutput: $("#zoomOutput"),
      timelineStatus: $("#timelineStatus"),
      timelineDot: $("#timelineDot"),
      lastAction: $("#lastAction"),
      notice: $("#notice"),
      noticeText: $("#noticeText"),
      exportStatus: $("#exportStatus"),
      verificationStatus: $("#verificationStatus"),
    };

    this.frameSource = createFrameSource();
    this.frameCache = new FrameCache({
      capacity: CACHE_CAPACITY,
      onStats: () => this.renderMetrics(),
    });
    this.scheduler = new ThumbnailScheduler({
      cache: this.frameCache,
      loadFrame: (request) => this.frameSource.loadFrame(request),
      concurrency: 3,
      onSlotState: (slotState) => this.handleSlotState(slotState),
      onStats: () => this.renderMetrics(),
    });

    this.bindEvents();
    this.renderProjectMeta();
    this.renderPreview();
    this.renderLayerList();
    this.syncInspector();
    this.renderTimelineChrome();
    this.readyPromise = this.initializeAfterFonts();
    this.exposeDebugApi();
  }

  async initializeAfterFonts() {
    try {
      await document.fonts.ready;
      await document.fonts.load('700 16px "Noto Sans SC"');
    } catch {
      // A system CJK fallback remains usable when the bundled font cannot load.
    }
    this.renderPreview();
    this.updateTimeline({ force: true });
  }

  bindEvents() {
    $("#exportButton").addEventListener("click", () => this.exportNow());
    $("#snapshotButton").addEventListener("click", () => this.downloadSnapshot());
    $("#dismissNotice").addEventListener("click", () => this.hideNotice());
    $("#retryButton").addEventListener("click", () => this.retryFailedFrames());
    $("#invalidateButton").addEventListener("click", () => this.invalidateThumbnails());
    $("#addKeyframeButton").addEventListener("click", () => this.addKeyframe());
    this.dom.cropSelect.addEventListener("change", () => this.setCropAspect(this.dom.cropSelect.value));
    this.dom.zoomSlider.addEventListener("input", () => this.setZoom(Number(this.dom.zoomSlider.value)));
    this.dom.timeSlider.addEventListener("input", () => this.setCurrentTime(Number(this.dom.timeSlider.value)));
    this.dom.playButton.addEventListener("click", () => this.togglePlayback());
    this.dom.layerX.addEventListener("change", () => this.patchSelectedLayer({ x: Number(this.dom.layerX.value) }));
    this.dom.layerY.addEventListener("change", () => this.patchSelectedLayer({ y: Number(this.dom.layerY.value) }));
    this.dom.layerColor.addEventListener("change", () =>
      this.patchSelectedLayer({ color: this.dom.layerColor.value }),
    );
    this.dom.layerOpacity.addEventListener("change", () =>
      this.patchSelectedLayer({ opacity: Number(this.dom.layerOpacity.value) }),
    );
    this.dom.layerList.addEventListener("click", (event) => this.handleLayerListClick(event));
    this.dom.timelineScroll.addEventListener("scroll", () => this.requestTimelineRender());
    window.addEventListener("resize", () => this.requestTimelineRender());
    this.dom.timelineScroll.addEventListener("pointerdown", (event) => this.startTimelineDrag(event));
    this.dom.timelineScroll.addEventListener("pointermove", (event) => this.moveTimelineDrag(event));
    this.dom.timelineScroll.addEventListener("pointerup", (event) => this.endTimelineDrag(event));
    this.dom.timelineScroll.addEventListener("pointercancel", (event) => this.endTimelineDrag(event));
    this.dom.timelineScroll.addEventListener("keydown", (event) => this.handleTimelineKey(event));
    this.dom.timelineScroll.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    window.addEventListener("beforeunload", () => saveProject(this.project));
  }

  renderProjectMeta() {
    this.dom.projectName.textContent = this.project.name;
    this.dom.projectRevision.textContent = `rev ${this.revision}`;
    this.dom.timeSlider.max = String(this.project.durationMs);
    this.dom.timeSlider.step = String(Math.max(1, Math.round(1000 / this.project.fps)));
    this.dom.currentTimecode.textContent = formatTimecode(this.currentTimeMs);
  }

  renderMetrics() {
    const schedulerMetrics = this.scheduler?.metrics() ?? {
      queueLength: 0,
      pending: 0,
      active: 0,
      staleDrops: 0,
      cache: this.frameCache.metrics(),
    };
    const cache = schedulerMetrics.cache;
    this.dom.hitRate.textContent = `${(cache.hitRate * 100).toFixed(1)}%`;
    this.dom.queueLength.textContent = String(schedulerMetrics.queueLength);
    this.dom.cacheSize.textContent = `${cache.size} / ${cache.capacity}`;
    this.dom.staleDrops.textContent = String(schedulerMetrics.staleDrops);
    if (schedulerMetrics.queueLength > 0) {
      this.dom.timelineStatus.textContent = `队列 ${schedulerMetrics.queueLength} · 解码中 ${schedulerMetrics.active}`;
      this.dom.timelineDot.className = "status-dot busy";
    } else {
      const errors = this.currentSlots.filter(
        (slot) => this.tileElements.get(slot.slotId)?.dataset.state === "error",
      ).length;
      if (errors > 0) {
        this.dom.timelineStatus.textContent = `${errors} 格已回退占位 · 可重试`;
        this.dom.timelineDot.className = "status-dot error";
      } else {
        this.dom.timelineStatus.textContent = `缩略帧已同步 · ${cache.hits} 次命中`;
        this.dom.timelineDot.className = "status-dot";
      }
    }
  }

  setCurrentTime(timeMs, { renderTimeline = false } = {}) {
    this.currentTimeMs = Math.max(0, Math.min(this.project.durationMs, Math.round(timeMs)));
    this.dom.timeSlider.value = String(this.currentTimeMs);
    this.dom.currentTimecode.textContent = formatTimecode(this.currentTimeMs);
    this.renderPreview();
    this.syncInspector();
    this.updatePlayhead();
    if (renderTimeline) this.requestTimelineRender();
  }

  setCropAspect(aspect) {
    if (!["16:9", "9:16", "1:1"].includes(aspect)) {
      throw new RangeError(`unsupported crop aspect: ${aspect}`);
    }
    this.cropAspect = aspect;
    this.dom.cropSelect.value = aspect;
    this.renderPreview();
    this.showNotice("warn", `裁切比例已切换为 ${aspect}，旧分辨率缩略帧已隔离并自动重建。`);
    this.updateTimeline({ force: true });
  }

  setZoom(zoom) {
    this.zoom = Math.max(0.5, Math.min(4, Number(zoom)));
    this.dom.zoomSlider.value = String(this.zoom);
    this.dom.zoomOutput.textContent = `${this.zoom.toFixed(1)}×`;
    this.updateTimeline({ force: true });
  }

  renderPreview() {
    const dimensions = getOutputDimensions(this.cropAspect);
    const canvas = this.dom.previewCanvas;
    if (canvas.width !== dimensions.width || canvas.height !== dimensions.height) {
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
    }
    const source = document.createElement("canvas");
    source.width = dimensions.width;
    source.height = dimensions.height;
    const sourceContext = source.getContext("2d", { willReadFrequently: true });
    renderProjectFrame(sourceContext, this.project, this.currentTimeMs, {
      width: dimensions.width,
      height: dimensions.height,
      cropAspect: this.cropAspect,
      overlay: true,
    });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(source, 0, 0);
    this.dom.outputSize.textContent = `${dimensions.width} × ${dimensions.height}`;
  }

  renderLayerList() {
    const elements = [];
    for (let index = this.project.layers.length - 1; index >= 0; index -= 1) {
      const layer = this.project.layers[index];
      const item = document.createElement("div");
      item.className = `layer-item${layer.id === this.selectedLayerId ? " selected" : ""}`;
      item.dataset.layerId = layer.id;
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      item.innerHTML = `
        <span class="layer-swatch" style="background:${layer.color}"></span>
        <span class="layer-copy">
          <strong>${escapeHtml(layer.name)}</strong>
          <span>${layer.shape} · ${layer.keyframes.length} KF</span>
        </span>
        <span class="layer-moves">
          <button type="button" data-move="1" title="上移图层" aria-label="上移图层">↑</button>
          <button type="button" data-move="-1" title="下移图层" aria-label="下移图层">↓</button>
        </span>
      `;
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.selectLayer(layer.id);
        }
      });
      elements.push(item);
    }
    this.dom.layerList.replaceChildren(...elements);
  }

  handleLayerListClick(event) {
    const item = event.target.closest(".layer-item");
    if (!item) return;
    const layerId = item.dataset.layerId;
    const moveButton = event.target.closest("[data-move]");
    if (moveButton) {
      event.stopPropagation();
      const direction = Number(moveButton.dataset.move);
      const next = reorderLayer(this.project, layerId, direction);
      this.applyProject(next, `图层顺序已更新：${layerId}`);
      return;
    }
    this.selectLayer(layerId);
  }

  selectLayer(layerId) {
    if (!this.project.layers.some((layer) => layer.id === layerId)) return;
    this.selectedLayerId = layerId;
    this.renderLayerList();
    this.syncInspector();
  }

  syncInspector() {
    const layer = this.project.layers.find((item) => item.id === this.selectedLayerId);
    if (!layer) {
      this.dom.selectedLayerName.textContent = "未选择图层";
      this.dom.selectedLayerId.textContent = "—";
      return;
    }
    const state = interpolateLayer(layer, this.currentTimeMs);
    this.dom.selectedLayerName.textContent = layer.name;
    this.dom.selectedLayerId.textContent = layer.id;
    this.dom.layerX.value = String(Math.round(state.x));
    this.dom.layerY.value = String(Math.round(state.y));
    this.dom.layerColor.value = state.color;
    this.dom.layerOpacity.value = String(Number(state.opacity).toFixed(2));
    const exact = layer.keyframes.some((keyframe) => Math.abs(keyframe.timeMs - this.currentTimeMs) < 0.5);
    this.dom.keyframeInfo.textContent = exact
      ? `播放头 ${formatTimecode(this.currentTimeMs)} 处已有可编辑关键帧 · 共 ${layer.keyframes.length} 个`
      : `播放头处将新增关键帧 · 当前图层共 ${layer.keyframes.length} 个`;
  }

  patchSelectedLayer(patch) {
    if (!this.selectedLayerId) return;
    const values = { ...patch };
    for (const field of ["x", "y", "opacity"]) {
      if (field in values && !Number.isFinite(values[field])) return;
    }
    if ("color" in values && !/^#[0-9a-f]{6}$/i.test(values.color)) return;
    try {
      const next = upsertKeyframe(this.project, this.selectedLayerId, this.currentTimeMs, values);
      this.applyProject(next, `已写入 ${formatTimecode(this.currentTimeMs)} 的关键帧`);
    } catch (error) {
      this.showNotice("error", `图层修改失败：${error.message}`);
    }
  }

  addKeyframe() {
    if (!this.selectedLayerId) return;
    const layer = this.project.layers.find((item) => item.id === this.selectedLayerId);
    const state = interpolateLayer(layer, this.currentTimeMs);
    const next = upsertKeyframe(this.project, this.selectedLayerId, this.currentTimeMs, state);
    this.applyProject(next, `已锁定 ${formatTimecode(this.currentTimeMs)} 的关键帧`);
  }

  applyProject(nextProject, message) {
    this.project = normalizeProject(nextProject);
    this.revision += 1;
    saveProject(this.project);
    this.renderProjectMeta();
    this.renderLayerList();
    this.syncInspector();
    this.renderPreview();
    this.renderTimelineChrome();
    this.frameCache.clear("project revision changed");
    this.showNotice("warn", `${message}。旧缩略帧已失效，正在自动重建。`);
    this.updateTimeline({ force: true });
  }

  requestTimelineRender() {
    if (this.timelineFrame !== null) return;
    this.timelineFrame = requestAnimationFrame(() => {
      this.timelineFrame = null;
      this.updateTimeline();
    });
  }

  updateTimeline({ force = false } = {}) {
    if (force && this.timelineFrame !== null) {
      cancelAnimationFrame(this.timelineFrame);
      this.timelineFrame = null;
    }
    const slots = this.buildSlots();
    this.currentSlots = slots;
    this.syncTileElements(slots);
    this.scheduler.update(slots);
    this.updatePlayhead();
    this.renderTimelineChrome();
    this.renderMetrics();
  }

  buildSlots() {
    const viewport = this.dom.timelineScroll;
    const pps = 12 * this.zoom;
    const cssSize = getThumbnailCssSize(this.cropAspect);
    const intrinsic = getThumbnailDimensions(this.cropAspect);
    const stepPx = cssSize.width + THUMBNAIL_GAP;
    const stepMs = (stepPx / pps) * 1000;
    const firstIndex = Math.max(0, Math.floor(viewport.scrollLeft / stepPx) - 1);
    const visibleCount = Math.ceil(viewport.clientWidth / stepPx) + 3;
    const lastIndex = Math.floor(this.project.durationMs / stepMs);
    const slots = [];
    for (let index = firstIndex; index <= Math.min(lastIndex, firstIndex + visibleCount); index += 1) {
      const timeMs = Math.max(0, Math.min(this.project.durationMs, Math.round(index * stepMs)));
      const key = makeFrameKey({
        sourceId: this.project.id,
        revision: this.revision,
        timeMs,
        width: intrinsic.width,
        height: intrinsic.height,
        cropAspect: this.cropAspect,
      });
      slots.push({
        slotId: `tile-${index}`,
        index,
        timeMs,
        key,
        sourceId: this.project.id,
        revision: this.revision,
        project: this.project,
        cropAspect: this.cropAspect,
        width: intrinsic.width,
        height: intrinsic.height,
        cssSize,
        leftPx: (timeMs / 1000) * pps,
        priority: slots.length,
      });
    }
    return slots;
  }

  syncTileElements(slots) {
    const liveIds = new Set(slots.map((slot) => slot.slotId));
    for (const [slotId, element] of this.tileElements) {
      if (!liveIds.has(slotId)) {
        element.remove();
        this.tileElements.delete(slotId);
      }
    }
    for (const slot of slots) {
      let tile = this.tileElements.get(slot.slotId);
      if (!tile) {
        tile = document.createElement("div");
        tile.className = "thumbnail-cell";
        tile.dataset.slotId = slot.slotId;
        const canvas = document.createElement("canvas");
        tile.append(canvas);
        this.tileElements.set(slot.slotId, tile);
        this.dom.thumbnailRow.append(tile);
      }
      tile.style.left = `${slot.leftPx}px`;
      tile.style.width = `${slot.cssSize.width}px`;
      tile.style.height = `${slot.cssSize.height}px`;
      tile.dataset.timeMs = String(slot.timeMs);
      tile.dataset.timecode = formatTimecode(slot.timeMs);
      tile.dataset.key = slot.key;
      const canvas = tile.querySelector("canvas");
      if (canvas.width !== slot.width || canvas.height !== slot.height) {
        canvas.width = slot.width;
        canvas.height = slot.height;
      }
    }
  }

  handleSlotState(slotState) {
    const tile = this.tileElements.get(slotState.slotId);
    if (!tile) return;
    const canvas = tile.querySelector("canvas");
    const timecode = formatTimecode(slotState.timeMs);
    tile.dataset.timeMs = String(Math.round(slotState.timeMs));
    tile.dataset.timecode = timecode;
    tile.dataset.key = slotState.key;
    tile.dataset.state = slotState.state === "ready" ? "ready" : slotState.state;
    tile.dataset.message = slotState.message ?? "";
    tile.title = `${timecode} · ${slotState.message ?? ""}`;

    if (slotState.state === "ready") {
      const frame = slotState.frame;
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(frame.canvas, 0, 0);
      tile.dataset.frameTimeMs = String(Math.round(frame.timeMs));
      tile.dataset.frameKey = frame.key;
      tile.dataset.decodeMs = frame.decodeMs.toFixed(1);
      this.dom.lastAction.textContent = `已锁定 ${timecode} · ${frame.width}×${frame.height}`;
    } else {
      delete tile.dataset.frameTimeMs;
      delete tile.dataset.frameKey;
      this.paintFallback(canvas, slotState);
      if (slotState.state === "loading") {
        this.dom.lastAction.textContent = `请求 ${timecode} · 旧帧已清除`;
      }
      if (slotState.state === "fallback") {
        this.dom.lastAction.textContent = `回退占位 ${timecode} · 等待重建`;
      }
      if (slotState.state === "error") {
        this.dom.lastAction.textContent = `失败 ${timecode} · 已显示安全占位`;
        this.showNotice(
          "error",
          `${slotState.message}（${timecode}）：${slotState.error?.message ?? "未知错误"}。没有继续显示旧内容。`,
        );
      }
    }
    this.renderMetrics();
  }

  paintFallback(canvas, slotState) {
    if (canvas.width !== slotState.width || canvas.height !== slotState.height) {
      canvas.width = slotState.width;
      canvas.height = slotState.height;
    }
    const context = canvas.getContext("2d");
    const { width, height } = canvas;
    const isError = slotState.state === "error";
    const hue = isError ? "#3a1119" : "#172a35";
    context.clearRect(0, 0, width, height);
    context.fillStyle = hue;
    context.fillRect(0, 0, width, height);
    context.save();
    context.globalAlpha = 0.28;
    context.strokeStyle = isError ? "#ff7b82" : "#ffbe68";
    context.lineWidth = 1;
    const stripe = Math.max(10, width / 9);
    for (let offset = -height; offset < width + height; offset += stripe) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset - height, height);
      context.stroke();
    }
    context.restore();
    context.strokeStyle = isError ? "rgba(255,123,130,0.72)" : "rgba(255,190,104,0.54)";
    context.lineWidth = 1;
    context.strokeRect(1, 1, width - 2, height - 2);
    context.fillStyle = isError ? "#ffc3c6" : "#ffd7a2";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const compact = width < 120;
    context.font = `700 ${compact ? 8 : 10}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    context.fillText(isError ? "FALLBACK" : "LOCKING", width / 2, height / 2 - (compact ? 8 : 10));
    context.font = `600 ${compact ? 7 : 9}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    context.fillText(formatTimecode(slotState.timeMs), width / 2, height / 2 + (compact ? 6 : 8));
  }

  renderTimelineChrome() {
    const pps = 12 * this.zoom;
    const durationSeconds = this.project.durationMs / 1000;
    const thumbnailSize = getThumbnailCssSize(this.cropAspect);
    const thumbnailRowHeight = Math.max(86, thumbnailSize.height + 8);
    this.dom.thumbnailRow.style.height = `${thumbnailRowHeight}px`;
    this.dom.trackArea.style.top = `${30 + thumbnailRowHeight}px`;
    const minimumWidth = this.dom.timelineScroll.clientWidth;
    this.dom.timelineContent.style.width = `${Math.max(minimumWidth, durationSeconds * pps + 24)}px`;

    const targetTickPx = 62;
    const tickOptions = [1, 2, 5, 10, 15, 30, 60, 120];
    const tickSeconds = tickOptions.find((seconds) => seconds * pps >= targetTickPx) ?? 120;
    const marks = [];
    for (let second = 0; second <= durationSeconds; second += tickSeconds) {
      const mark = document.createElement("span");
      mark.className = "ruler-mark";
      mark.style.left = `${second * pps}px`;
      mark.textContent = formatRulerTime(second);
      marks.push(mark);
    }
    this.dom.ruler.replaceChildren(...marks);

    const lanes = [];
    for (const layer of [...this.project.layers].reverse()) {
      const lane = document.createElement("div");
      lane.className = "track-lane";
      lane.title = layer.name;
      const bar = document.createElement("span");
      bar.className = "track-bar";
      bar.style.left = "0px";
      bar.style.width = `${durationSeconds * pps}px`;
      bar.style.background = layer.color;
      lane.append(bar);
      for (const keyframe of layer.keyframes) {
        const marker = document.createElement("span");
        marker.className = "track-keyframe";
        marker.style.left = `${(keyframe.timeMs / 1000) * pps}px`;
        marker.title = `${layer.name} · ${formatTimecode(keyframe.timeMs)}`;
        lane.append(marker);
      }
      lanes.push(lane);
    }
    this.dom.trackArea.replaceChildren(...lanes);
    this.updatePlayhead();
  }

  updatePlayhead() {
    const pps = 12 * this.zoom;
    this.dom.playhead.style.left = `${(this.currentTimeMs / 1000) * pps}px`;
  }

  startTimelineDrag(event) {
    if (event.button !== 0 || event.target.closest("button, input, select, a")) return;
    this.dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScroll: this.dom.timelineScroll.scrollLeft,
      moved: 0,
    };
    this.dom.timelineScroll.setPointerCapture(event.pointerId);
    this.dom.timelineScroll.classList.add("dragging");
  }

  moveTimelineDrag(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    const delta = event.clientX - this.dragState.startX;
    this.dragState.moved = Math.abs(delta);
    this.dom.timelineScroll.scrollLeft = this.dragState.startScroll - delta;
    this.requestTimelineRender();
  }

  endTimelineDrag(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    if (this.dom.timelineScroll.hasPointerCapture(event.pointerId)) {
      this.dom.timelineScroll.releasePointerCapture(event.pointerId);
    }
    this.dom.timelineScroll.classList.remove("dragging");
    this.dom.lastAction.textContent = `已拖动时间线 ${Math.round(this.dragState.moved)} px`;
    this.dragState = null;
  }

  handleTimelineKey(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    this.dom.timelineScroll.scrollLeft += direction * 90;
    this.requestTimelineRender();
  }

  handleWheel(event) {
    if (Math.abs(event.deltaX) < 1 && Math.abs(event.deltaY) < 1) return;
    event.preventDefault();
    this.dom.timelineScroll.scrollLeft += event.deltaX + event.deltaY;
    this.requestTimelineRender();
  }

  togglePlayback() {
    if (this.playTimer) {
      this.stopPlayback();
      return;
    }
    this.dom.playButton.textContent = "❚❚";
    let previous = performance.now();
    this.playTimer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - previous;
      previous = now;
      let next = this.currentTimeMs + elapsed;
      if (next >= this.project.durationMs) {
        next = this.project.durationMs;
        this.stopPlayback();
      }
      this.setCurrentTime(next);
    }, 33);
  }

  stopPlayback() {
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
    this.dom.playButton.textContent = "▶";
  }

  invalidateThumbnails(reason = "手动模拟缓存失效") {
    this.scheduler.invalidate(reason);
    this.dom.verificationStatus.textContent = "缓存已失效 · 等待当前时间线重新校验";
    this.dom.verificationStatus.className = "verification";
    this.showNotice("warn", `${reason}：所有旧缩略帧已立即隔离，正在按当前时间与分辨率自动重建。`);
    this.renderMetrics();
  }

  retryFailedFrames() {
    this.frameSource.recover();
    this.scheduler.retryFailed();
    this.showNotice("ok", "失效帧已进入重试队列，安全占位会保留到新帧校验通过。");
  }

  async exportNow({ download = true } = {}) {
    if (this.exporting) {
      return { ok: false, error: "导出正在进行中" };
    }
    this.exporting = true;
    const exportButton = $("#exportButton");
    exportButton.disabled = true;
    exportButton.textContent = "校验并导出…";
    this.dom.exportStatus.textContent = "正在冻结导出前工程快照…";
    try {
      await this.readyPromise;
      const uiState = {
        currentTimeMs: this.currentTimeMs,
        cropAspect: this.cropAspect,
        zoom: this.zoom,
        selectedLayerId: this.selectedLayerId,
      };
      const snapshot = createSnapshot(this.project, uiState, "before-export");
      persistSnapshot(snapshot);
      this.lastSnapshot = snapshot;

      this.renderPreview();
      const dimensions = getOutputDimensions(this.cropAspect);
      const previewCanvas = this.dom.previewCanvas;
      const previewContext = previewCanvas.getContext("2d", { willReadFrequently: true });
      const previewPixels = previewContext.getImageData(0, 0, dimensions.width, dimensions.height);

      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = dimensions.width;
      exportCanvas.height = dimensions.height;
      const exportContext = exportCanvas.getContext("2d", { willReadFrequently: true });
      renderProjectFrame(exportContext, this.project, this.currentTimeMs, {
        width: dimensions.width,
        height: dimensions.height,
        cropAspect: this.cropAspect,
        overlay: true,
      });
      const exportPixels = exportContext.getImageData(0, 0, dimensions.width, dimensions.height);
      const differences = countPixelDifferences(previewPixels.data, exportPixels.data);
      const previewHash = hashPixels(previewPixels.data);
      const exportHash = hashPixels(exportPixels.data);
      if (differences !== 0 || previewHash !== exportHash) {
        throw new Error(`导出与预览像素不一致：${differences} 个通道差异`);
      }

      const fingerprint = projectFingerprint(this.project);
      const fileStem = `frame-lock_${formatFileTime(this.currentTimeMs)}_${fingerprint}`;
      if (download) {
        const pngBlob = await canvasToBlob(exportCanvas, "image/png");
        downloadBlob(pngBlob, `${fileStem}.png`);
        downloadBlob(
          new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
          `${fileStem}.before-export.json`,
        );
      }

      this.lastExport = {
        width: dimensions.width,
        height: dimensions.height,
        timeMs: this.currentTimeMs,
        fingerprint,
        pixelDifferences: differences,
        previewHash,
        exportHash,
        snapshotCreatedAt: snapshot.createdAt,
      };
      const message = `导出与预览逐像素一致（${dimensions.width}×${dimensions.height}，差异 0）；导出前快照已保留。`;
      this.dom.exportStatus.textContent = message;
      this.showNotice("ok", message);
      return { ok: true, ...this.lastExport };
    } catch (error) {
      this.dom.exportStatus.textContent = `导出已阻止：${error.message}`;
      this.showNotice("error", `导出已阻止：${error.message}。未写入过期画面。`);
      return { ok: false, error: error.message };
    } finally {
      this.exporting = false;
      exportButton.disabled = false;
      exportButton.textContent = "导出 PNG + 快照";
    }
  }

  downloadSnapshot() {
    const snapshot =
      this.lastSnapshot ??
      createSnapshot(
        this.project,
        {
          currentTimeMs: this.currentTimeMs,
          cropAspect: this.cropAspect,
          zoom: this.zoom,
          selectedLayerId: this.selectedLayerId,
        },
        "manual",
      );
    this.lastSnapshot = snapshot;
    persistSnapshot(snapshot);
    const fingerprint = projectFingerprint(this.project);
    downloadBlob(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      `frame-lock_${fingerprint}_${snapshot.reason}.json`,
    );
    this.showNotice("ok", `工程快照已保留（${snapshot.fingerprint}，${snapshot.reason}）。`);
  }

  async whenIdle() {
    await this.readyPromise;
    await this.scheduler.whenIdle();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (this.scheduler.queueLength > 0) return this.whenIdle();
    return true;
  }

  async verifyThumbnails() {
    await this.whenIdle();
    const mismatches = [];
    const verified = [];
    for (const slot of this.currentSlots) {
      const tile = this.tileElements.get(slot.slotId);
      if (!tile) {
        mismatches.push({ slotId: slot.slotId, reason: "缩略格元素不存在" });
        continue;
      }
      const state = tile.dataset.state;
      if (state !== "ready") {
        mismatches.push({ slotId: slot.slotId, timeMs: slot.timeMs, reason: `状态为 ${state}` });
        continue;
      }
      if (Number(tile.dataset.timeMs) !== Math.round(slot.timeMs)) {
        mismatches.push({ slotId: slot.slotId, reason: "缩略格时间戳被旧请求改写" });
        continue;
      }
      if (Number(tile.dataset.frameTimeMs) !== Math.round(slot.timeMs)) {
        mismatches.push({ slotId: slot.slotId, reason: "实际帧时间与目标时间不一致" });
        continue;
      }
      if (tile.dataset.frameKey !== slot.key) {
        mismatches.push({ slotId: slot.slotId, reason: "实际帧缓存键与当前请求不一致" });
        continue;
      }

      const expectedCanvas = document.createElement("canvas");
      expectedCanvas.width = slot.width;
      expectedCanvas.height = slot.height;
      const context = expectedCanvas.getContext("2d", { willReadFrequently: true });
      renderProjectFrame(context, slot.project, slot.timeMs, {
        width: slot.width,
        height: slot.height,
        cropAspect: slot.cropAspect,
        overlay: true,
      });
      const actualCanvas = tile.querySelector("canvas");
      const actualHash = hashCanvas(actualCanvas);
      const expectedHash = hashCanvas(expectedCanvas);
      if (actualHash !== expectedHash) {
        mismatches.push({
          slotId: slot.slotId,
          timeMs: slot.timeMs,
          reason: "像素哈希与独立复算结果不一致",
          actualHash,
          expectedHash,
        });
        continue;
      }
      verified.push({
        slotId: slot.slotId,
        timeMs: slot.timeMs,
        timecode: formatTimecode(slot.timeMs),
        key: slot.key,
        hash: actualHash,
      });
    }
    const result = {
      ok: mismatches.length === 0 && verified.length > 0,
      checked: verified.length,
      mismatches,
      cells: verified,
      verifiedAt: new Date().toISOString(),
    };
    if (result.ok) {
      this.dom.verificationStatus.textContent = `一致性通过：${result.checked} 格均对应正确时间与缓存键`;
      this.dom.verificationStatus.className = "verification ok";
    } else {
      this.dom.verificationStatus.textContent = `一致性失败：${mismatches.length} 格不匹配`;
      this.dom.verificationStatus.className = "verification error";
      this.showNotice("error", `缩略帧一致性验证失败：${mismatches[0]?.reason ?? "没有可验证缩略格"}`);
    }
    return result;
  }

  async runFastDragValidation(iterations = 20) {
    const scroll = this.dom.timelineScroll;
    const maxScroll = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    for (let index = 0; index < iterations; index += 1) {
      const target = ((index * 197 + 311) % Math.max(1, Math.round(maxScroll))) || 0;
      scroll.scrollLeft = target;
      this.updateTimeline({ force: true });
      await Promise.resolve();
    }
    return this.verifyThumbnails();
  }

  showNotice(kind, message, { autoHideMs = 0 } = {}) {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.dom.notice.hidden = false;
    this.dom.notice.dataset.kind = kind;
    this.dom.noticeText.textContent = message;
    if (autoHideMs > 0) {
      this.noticeTimer = setTimeout(() => this.hideNotice(), autoHideMs);
    }
  }

  hideNotice() {
    this.dom.notice.hidden = true;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }

  exposeDebugApi() {
    const app = this;
    window.__timelineApp = {
      getProject: () => structuredClone(app.project),
      getRevision: () => app.revision,
      getMetrics: () => app.scheduler.metrics(),
      getSlots: () =>
        app.currentSlots.map((slot) => ({
          slotId: slot.slotId,
          timeMs: slot.timeMs,
          key: slot.key,
          width: slot.width,
          height: slot.height,
          cropAspect: slot.cropAspect,
        })),
      getTileStates: () =>
        [...app.tileElements.entries()].map(([slotId, tile]) => ({
          slotId,
          state: tile.dataset.state,
          timeMs: Number(tile.dataset.timeMs),
          frameTimeMs: Number(tile.dataset.frameTimeMs),
          frameKey: tile.dataset.frameKey ?? null,
          key: tile.dataset.key ?? null,
        })),
      getSnapshots: () => {
        try {
          return JSON.parse(localStorage.getItem(SNAPSHOT_STORAGE_KEY) || "[]");
        } catch {
          return [];
        }
      },
      setCurrentTime: (timeMs) => app.setCurrentTime(timeMs, { renderTimeline: true }),
      setCropAspect: (aspect) => app.setCropAspect(aspect),
      setZoom: (zoom) => app.setZoom(zoom),
      scrollToTime: (timeMs) => {
        const pps = 12 * app.zoom;
        app.dom.timelineScroll.scrollLeft = (timeMs / 1000) * pps;
        app.updateTimeline({ force: true });
      },
      updateTimeline: () => app.updateTimeline({ force: true }),
      whenIdle: () => app.whenIdle(),
      verifyThumbnails: () => app.verifyThumbnails(),
      runFastDragValidation: (iterations) => app.runFastDragValidation(iterations),
      exportNow: (options) => app.exportNow(options),
      getLastExport: () => (app.lastExport ? { ...app.lastExport } : null),
      getLastSnapshot: () => (app.lastSnapshot ? structuredClone(app.lastSnapshot) : null),
      debug: {
        invalidateCache: (reason) => app.invalidateThumbnails(reason ?? "调试：缓存失效"),
        failNextFrames: (count, options) => app.frameSource.failNext(count, options),
        corruptNextFrames: (count) => app.frameSource.corruptNext(count),
        setLatency: (milliseconds, jitter) => app.frameSource.setLatency(milliseconds, jitter),
        recoverFrames: () => app.frameSource.recover(),
        retryFailed: () => app.retryFailedFrames(),
        resetProject: () => app.applyProject(createDefaultProject(), "已恢复默认工程"),
        clearSnapshots: () => localStorage.removeItem(SNAPSHOT_STORAGE_KEY),
      },
    };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatRulerTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatFileTime(timeMs) {
  return formatTimecode(timeMs).replaceAll(":", "-").replace(".", "_");
}

function hashPixels(pixels) {
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index += 1) {
    hash ^= pixels[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hashCanvas(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return hashPixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
}

function countPixelDifferences(left, right) {
  if (left.length !== right.length) return Math.max(left.length, right.length);
  let differences = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) differences += 1;
  }
  return differences;
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("画布无法编码为 PNG"));
    }, type);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

new TimelineApp();
