const PROJECT_KEY = "localstudio.project.v1";
const PEER_PREFIX = "localstudio.peer.v1:";
const CLAIM_PREFIX = "localstudio.claim.v1:";
const RECOVERY_KEY = "localstudio.recovery.v1";
const SESSION_PREFIX = "localstudio.session.v1:";
const TAB_ID_KEY = "localstudio.tab-id.v1";
const CHANNEL_NAME = "localstudio.project-sync.v1";
const LOCK_NAME = "localstudio.project-write.v1";
const PEER_TTL = 90_000;
const CLAIM_TTL = 90_000;
const MAX_CONFLICT_TRACE = 8;

const FIELDS = {
  title: { label: "场景标题", required: true, max: 80 },
  owner: { label: "负责人", required: true, max: 40 },
  type: { label: "对象类型", required: true },
  note: { label: "场景说明", required: false, max: 500 },
};

const TYPE_META = {
  scene: { label: "场景", glyph: "场" },
  character: { label: "角色", glyph: "角" },
  prop: { label: "道具", glyph: "道" },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  storageBanner: $("#storageBanner"),
  syncBadge: $("#syncBadge"),
  syncBadgeText: $("#syncBadgeText"),
  peerCount: $("#peerCount"),
  undoButton: $("#undoButton"),
  exportButton: $("#exportButton"),
  objectCount: $("#objectCount"),
  objectSearch: $("#objectSearch"),
  objectList: $("#objectList"),
  addObjectButton: $("#addObjectButton"),
  tabRegister: $("#tabRegister"),
  tabRegisterState: $("#tabRegisterState"),
  objectBreadcrumb: $("#objectBreadcrumb"),
  editorTitle: $("#editorTitle"),
  objectSaveState: $("#objectSaveState"),
  conflictSpotlight: $("#conflictSpotlight"),
  conflictSpotlightTitle: $("#conflictSpotlightTitle"),
  conflictSpotlightText: $("#conflictSpotlightText"),
  editorForm: $("#editorForm"),
  validationSummary: $("#validationSummary"),
  titleDraftState: $("#titleDraftState"),
  ownerDraftState: $("#ownerDraftState"),
  typeDraftState: $("#typeDraftState"),
  noteDraftState: $("#noteDraftState"),
  noteCounter: $("#noteCounter"),
  fieldVersions: $("#fieldVersions"),
  saveButton: $("#saveButton"),
  revertButton: $("#revertButton"),
  draftHint: $("#draftHint"),
  conflictCount: $("#conflictCount"),
  conflictList: $("#conflictList"),
  snapshotState: $("#snapshotState"),
  snapshotReasons: $("#snapshotReasons"),
  snapshotRevision: $("#snapshotRevision"),
  snapshotHash: $("#snapshotHash"),
  snapshotObjects: $("#snapshotObjects"),
  snapshotLastExport: $("#snapshotLastExport"),
  resourceList: $("#resourceList"),
  verifyResourcesButton: $("#verifyResourcesButton"),
  inspectInput: $("#inspectInput"),
  inspectDrafts: $("#inspectDrafts"),
  inspectStore: $("#inspectStore"),
  inspectRender: $("#inspectRender"),
  inspectSync: $("#inspectSync"),
  inspectFocus: $("#inspectFocus"),
  inspectScroll: $("#inspectScroll"),
  inspectTab: $("#inspectTab"),
  inspectJson: $("#inspectJson"),
  inspectPulse: $("#inspectPulse"),
  footerStatus: $("#footerStatus"),
  exportDialog: $("#exportDialog"),
  closeExportButton: $("#closeExportButton"),
  exportReadiness: $("#exportReadiness"),
  exportRevision: $("#exportRevision"),
  exportHash: $("#exportHash"),
  exportPeers: $("#exportPeers"),
  confirmExportButton: $("#confirmExportButton"),
  exportFailure: $("#exportFailure"),
  toastRegion: $("#toastRegion"),
};

function safeParse(raw, fallback = null) {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, value: fallback, raw: raw ?? "", empty: true };
  }
  try {
    return { ok: true, value: JSON.parse(raw), raw, empty: false };
  } catch (error) {
    return { ok: false, value: fallback, raw, error };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function formatClock(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function truncate(value, max = 52) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function hashString(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function projectHash(project) {
  return hashString(
    stableStringify({
      id: project.id,
      revision: project.revision,
      objects: project.objects,
      resources: project.resources,
      conflicts: project.conflicts,
    }),
  );
}

function field(value, revision, updatedBy = "初始项目") {
  return {
    value,
    revision,
    updatedAt: nowIso(),
    updatedBy,
  };
}

function createSeedProject() {
  const createdAt = nowIso();
  const project = {
    schema: "localstudio.project.v1",
    id: "project-rain-notes",
    title: "雨夜手记",
    revision: 7,
    createdAt,
    updatedAt: createdAt,
    objects: [
      {
        id: "scene-rain-open",
        updatedAt: createdAt,
        resourceIds: ["asset-rain-board"],
        fields: {
          title: field("雨夜开场", 3),
          owner: field("林澄", 2),
          type: field("scene", 1),
          note: field(
            "雨水沿旧城区的霓虹招牌落下。林澄在闭店前收到一盘没有寄件人的录音带，街对面的钟停在 23:17。",
            4,
          ),
        },
      },
      {
        id: "scene-rooftop",
        updatedAt: createdAt,
        resourceIds: ["asset-rain-board"],
        fields: {
          title: field("天台追逐", 2),
          owner: field("周迟", 2),
          type: field("scene", 1),
          note: field(
            "周迟从消防梯绕上天台，风把分镜纸吹散。追逐在广告牌背面结束，只留下半枚潮湿的鞋印。",
            3,
          ),
        },
      },
      {
        id: "character-lin",
        updatedAt: createdAt,
        resourceIds: ["asset-character-sheet"],
        fields: {
          title: field("林澄", 2),
          owner: field("林澄", 2),
          type: field("character", 1),
          note: field(
            "旧货店夜班店员，习惯把重要的话录下来。左耳听力较弱，总会不自觉站到别人右侧。",
            2,
          ),
        },
      },
      {
        id: "prop-recorder",
        updatedAt: createdAt,
        resourceIds: ["asset-character-sheet"],
        fields: {
          title: field("旧录音机", 1),
          owner: field("道具组", 1),
          type: field("prop", 1),
          note: field(
            "银色磁带机，边角有烧灼痕迹。播放键比停止键更亮，适合作为第二幕的视觉锚点。",
            1,
          ),
        },
      },
    ],
    resources: [
      {
        id: "asset-rain-board",
        name: "rain-board.svg",
        kind: "image",
        path: "./assets/rain-board.svg",
        detail: "雨夜街景分镜 · SVG · 1.2 KB",
      },
      {
        id: "asset-character-sheet",
        name: "character-sheet.svg",
        kind: "image",
        path: "./assets/character-sheet.svg",
        detail: "角色与道具设定 · SVG · 1.4 KB",
      },
    ],
    conflicts: [],
    lastExportedAt: null,
  };
  project.checksum = projectHash(project);
  return project;
}

let tabId;
let tabLabel;
try {
  tabId = sessionStorage.getItem(TAB_ID_KEY);
} catch {
  tabId = null;
}
if (!tabId) {
  tabId = `tab-${crypto.randomUUID().slice(0, 8)}`;
  try {
    sessionStorage.setItem(TAB_ID_KEY, tabId);
  } catch {
    // In-memory identity still supports this tab when session storage is blocked.
  }
}
tabLabel = `T-${tabId.slice(-4).toUpperCase()}`;
document.body.dataset.tabId = tabId;

const sessionKey = `${SESSION_PREFIX}${tabId}`;
let sessionWriteTimer = null;
let peerTimer = null;
let toastTimer = null;
let project = null;
let selectedId = null;
let drafts = {};
let undoStack = [];
let sessionRestore = {
  scrollY: 0,
  lastExport: null,
};
let lastRendered = {
  revision: 0,
  hash: "",
  selectedId: null,
  at: null,
};
let lastInputSignature = "";
let storageProblem = null;
let recoverySnapshot = null;
let bannerMode = null;
let ready = false;
let committing = false;
let exportTrigger = null;
let remoteSyncNotice = null;

const channel =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;

function projectLooksValid(candidate) {
  return Boolean(
    candidate &&
      typeof candidate === "object" &&
      catalogField(candidate.revision) &&
      Array.isArray(candidate.objects) &&
      Array.isArray(candidate.resources) &&
      Array.isArray(candidate.conflicts) &&
      candidate.objects.every((object) => object?.id && object?.fields),
  );
}

function catalogField(value) {
  return Number.isInteger(value) && value >= 0;
}

function readProjectRaw() {
  let raw;
  try {
    raw = localStorage.getItem(PROJECT_KEY);
  } catch (error) {
    return { ok: false, reason: "共享存储不可读取", error, raw: "" };
  }
  if (!raw) return { ok: true, value: null, raw: "" };
  const parsed = safeParse(raw);
  if (!parsed.ok) {
    return { ok: false, reason: "共享项目 JSON 已损坏", error: parsed.error, raw };
  }
  if (!projectLooksValid(parsed.value)) {
    return { ok: false, reason: "共享项目结构不完整", error: new Error("Invalid schema"), raw };
  }
  return { ok: true, value: parsed.value, raw };
}

function backupRecovery(raw, reason) {
  recoverySnapshot = { raw, reason, at: nowIso() };
  try {
    localStorage.setItem(RECOVERY_KEY, stableStringify(recoverySnapshot));
  } catch {
    // Keep the readable snapshot in memory and render it regardless.
  }
}

function writeProjectRaw(nextProject) {
  nextProject.updatedAt = nowIso();
  nextProject.checksum = projectHash(nextProject);
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(nextProject));
    storageProblem = null;
    if (bannerMode === "storage") {
      els.storageBanner.hidden = true;
      bannerMode = null;
    }
    return { ok: true, project: nextProject };
  } catch (error) {
    storageProblem = `共享存储写入失败：${error.message}`;
    showStorageBanner(storageProblem, JSON.stringify(nextProject, null, 2));
    return { ok: false, error, project: nextProject };
  }
}

function readJsonMap(key) {
  try {
    const parsed = safeParse(localStorage.getItem(key), {});
    return parsed.ok && parsed.value && typeof parsed.value === "object" ? parsed.value : {};
  } catch {
    return {};
  }
}

function writeJsonMap(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function loadSession() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(sessionKey);
  } catch (error) {
    recoverySnapshot = {
      raw: "(sessionStorage 不可读取)",
      reason: `标签页会话不可读取：${error.message}`,
      at: nowIso(),
    };
    return;
  }
  if (!raw) return;
  const parsed = safeParse(raw);
  if (!parsed.ok || typeof parsed.value !== "object") {
    backupRecovery(raw, "标签页会话 JSON 已损坏");
    return;
  }
  selectedId = typeof parsed.value.selectedId === "string" ? parsed.value.selectedId : null;
  drafts = parsed.value.drafts && typeof parsed.value.drafts === "object" ? parsed.value.drafts : {};
  undoStack = Array.isArray(parsed.value.undoStack) ? parsed.value.undoStack.slice(0, 20) : [];
  sessionRestore.scrollY = Number(parsed.value.scrollY) || 0;
  sessionRestore.lastExport = parsed.value.lastExport || null;
}

function saveSession() {
  clearTimeout(sessionWriteTimer);
  persistSessionNow();
}

function persistSessionNow() {
  clearTimeout(sessionWriteTimer);
  const payload = {
    selectedId,
    drafts,
    undoStack,
    scrollY: Math.max(0, Math.round(window.scrollY)),
    lastExport: sessionRestore.lastExport,
    savedAt: nowIso(),
  };
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify(payload));
    if (recoverySnapshot?.reason === "标签页会话写入失败") recoverySnapshot = null;
  } catch (error) {
    backupRecovery(JSON.stringify(payload, null, 2), `标签页会话写入失败：${error.message}`);
    showRecoveryBanner();
  }
}

function showStorageBanner(message, rawSnapshot) {
  if (!els.storageBanner) return;
  const isRecovery = Boolean(rawSnapshot);
  bannerMode = isRecovery ? "recovery" : "storage";
  els.storageBanner.hidden = false;
  els.storageBanner.innerHTML = `
    <strong>${escapeHtml(message)}</strong>
    ${
      isRecovery
        ? `<details>
            <summary>查看可读恢复快照（原始内容不会被删除）</summary>
            <pre class="recovery-raw">${escapeHtml(rawSnapshot)}</pre>
            <button class="button button-small button-quiet" type="button" data-copy-recovery>复制快照</button>
          </details>`
        : ""
    }
  `;
  const copyButton = $("[data-copy-recovery]", els.storageBanner);
  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(rawSnapshot);
        toast("恢复快照已复制");
      } catch {
        toast("浏览器拒绝复制；请从只读快照中手动选择", true);
      }
    });
  }
}

function showRecoveryBanner() {
  if (!recoverySnapshot) return;
  let raw = recoverySnapshot.raw || "";
  try {
    raw = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // The unparsable original is already the most useful readable snapshot.
  }
  showStorageBanner(
    `恢复失败：${recoverySnapshot.reason}。当前页面已使用最后可读状态继续运行。`,
    raw,
  );
}

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  const node = document.createElement("div");
  node.className = `toast${isError ? " is-error" : ""}`;
  node.textContent = message;
  els.toastRegion.replaceChildren(node);
  toastTimer = setTimeout(() => {
    node.remove();
  }, 4200);
}

function getObject(objectId = selectedId) {
  return project?.objects.find((object) => object.id === objectId) || null;
}

function draftKey(objectId, fieldName) {
  return `${objectId}:${fieldName}`;
}

function objectDraftKeys(objectId) {
  return Object.keys(FIELDS).map((fieldName) => draftKey(objectId, fieldName));
}

function getDraft(objectId, fieldName) {
  return drafts[draftKey(objectId, fieldName)] || null;
}

function hasDrafts(objectId = null) {
  const keys = objectId ? objectDraftKeys(objectId) : Object.keys(drafts);
  return keys.some((key) => Boolean(drafts[key]));
}

function draftCount(objectId = null) {
  const keys = objectId ? objectDraftKeys(objectId) : Object.keys(drafts);
  return keys.filter((key) => Boolean(drafts[key])).length;
}

function openConflictCount() {
  return project?.conflicts.filter((conflict) => conflict.status === "open").length || 0;
}

function conflictsForObject(objectId) {
  return project?.conflicts.filter(
    (conflict) => conflict.status === "open" && conflict.objectId === objectId,
  ) || [];
}

function visibleFieldValues() {
  const values = {};
  for (const [fieldName] of Object.entries(FIELDS)) {
    const input = $(`[data-field="${fieldName}"]`);
    if (input) values[fieldName] = input.value;
  }
  return values;
}

function inputSignature() {
  const object = getObject();
  return stableStringify({
    objectId: object?.id || null,
    values: visibleFieldValues(),
  });
}

function prunePeers(peers, now = Date.now()) {
  for (const [id, peer] of Object.entries(peers)) {
    if (id === tabId) continue;
    if (!peer || now - Number(peer.lastSeen || 0) > PEER_TTL) delete peers[id];
  }
  return peers;
}

function readPeers() {
  const peers = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(PEER_PREFIX)) continue;
      const parsed = safeParse(localStorage.getItem(key));
      if (parsed.ok && parsed.value && typeof parsed.value === "object") {
        peers[key.slice(PEER_PREFIX.length)] = parsed.value;
      }
    }
  } catch {
    return {};
  }
  return prunePeers(peers);
}

function updatePresence({ broadcast = true } = {}) {
  const presence = {
    label: tabLabel,
    revision: project?.revision || 0,
    hash: project?.checksum || "",
    selectedId,
    draftCount: draftCount(),
    dirty: hasDrafts(),
    lastSeen: Date.now(),
  };
  writeJsonMap(`${PEER_PREFIX}${tabId}`, presence);
  if (broadcast) {
    channel?.postMessage({ type: "presence", source: tabId, revision: project?.revision || 0 });
  }
  renderPeers();
  renderExportReadiness();
  return readPeers();
}

function removeOwnPresence() {
  try {
    localStorage.removeItem(`${PEER_PREFIX}${tabId}`);
  } catch {
    // A blocked storage API cannot retain a lease beyond this tab's lifetime.
  }
  channel?.postMessage({ type: "presence", source: tabId, leaving: true });
}

function pruneClaims(claims, now = Date.now()) {
  for (const [assetId, leaseMap] of Object.entries(claims)) {
    if (!leaseMap || typeof leaseMap !== "object") {
      delete claims[assetId];
      continue;
    }
    for (const [leaseTabId, lease] of Object.entries(leaseMap)) {
      if (!lease || now - Number(lease.lastSeen || 0) > CLAIM_TTL) delete leaseMap[leaseTabId];
    }
    if (Object.keys(leaseMap).length === 0) delete claims[assetId];
  }
  return claims;
}

function readClaims() {
  const claims = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(CLAIM_PREFIX)) continue;
      const leaseTabId = key.slice(CLAIM_PREFIX.length);
      const parsed = safeParse(localStorage.getItem(key));
      if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") continue;
      for (const [assetId, lease] of Object.entries(parsed.value)) {
        claims[assetId] ||= {};
        claims[assetId][leaseTabId] = lease;
      }
    }
  } catch {
    return {};
  }
  return pruneClaims(claims);
}

function claimResources({ broadcast = true } = {}) {
  const ownClaims = {};
  for (const resource of project?.resources || []) {
    ownClaims[resource.id] = {
      label: tabLabel,
      lastSeen: Date.now(),
      projectId: project.id,
    };
  }
  writeJsonMap(`${CLAIM_PREFIX}${tabId}`, ownClaims);
  if (broadcast) {
    channel?.postMessage({ type: "resource-leases", source: tabId, tabLabel });
  }
  renderResources();
  return readClaims();
}

function releaseResources({ broadcast = true } = {}) {
  try {
    localStorage.removeItem(`${CLAIM_PREFIX}${tabId}`);
  } catch {
    // Expiry handles a lease that cannot be removed explicitly.
  }
  if (broadcast) {
    channel?.postMessage({
      type: "resource-leases",
      source: tabId,
      tabLabel,
      leaving: true,
    });
  }
  return readClaims();
}

function claimCounts() {
  const claims = readClaims();
  const counts = {};
  for (const resource of project?.resources || []) {
    counts[resource.id] = Object.keys(claims[resource.id] || {}).length;
  }
  return counts;
}

function peerStates() {
  return Object.entries(readPeers()).map(([id, peer]) => ({
    id,
    ...peer,
    self: id === tabId,
  }));
}

function syncProjectFromStore({ announce = true } = {}) {
  if (!project) return false;
  const result = readProjectRaw();
  if (!result.ok) {
    if (!storageProblem) {
      storageProblem = result.reason;
      backupRecovery(result.raw, result.reason);
      showRecoveryBanner();
    }
    return false;
  }
  const latest = result.value;
  if (!latest) return false;
  if (
    latest.revision < project.revision ||
    (latest.revision === project.revision && latest.checksum === project.checksum)
  ) {
    return false;
  }
  const previousRevision = project.revision;
  project = latest;
  if (!getObject()) {
    selectedId = project.objects[0]?.id || null;
  }
  renderAll();
  updatePresence({ broadcast: false });
  if (announce && previousRevision !== project.revision) {
    remoteSyncNotice = `已接收共享修订 rev ${project.revision}`;
    toast(remoteSyncNotice);
  }
  return true;
}

async function withProjectLock(callback) {
  if (navigator.locks?.request) {
    return navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, callback);
  }
  return callback();
}

async function initialize() {
  loadSession();
  try {
    const savedRecovery = safeParse(localStorage.getItem(RECOVERY_KEY));
    if (!recoverySnapshot && savedRecovery.ok && savedRecovery.value?.raw) {
      recoverySnapshot = savedRecovery.value;
    }
  } catch {
    // The session/project recovery path below will surface any storage failure.
  }

  const stored = readProjectRaw();
  if (!stored.ok) {
    backupRecovery(stored.raw, stored.reason);
    project = createSeedProject();
    storageProblem = stored.reason;
    showRecoveryBanner();
    // Preserve the unreadable original in RECOVERY_KEY before replacing the primary key.
    writeProjectRaw(project);
  } else if (stored.value) {
    project = stored.value;
  } else {
    project = createSeedProject();
    writeProjectRaw(project);
  }

  if (!selectedId || !getObject(selectedId)) {
    selectedId = project.objects[0]?.id || null;
  }

  sanitizeRestoredDrafts();
  ready = true;
  renderAll();
  if (recoverySnapshot) showRecoveryBanner();
  claimResources();
  updatePresence();
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: sessionRestore.scrollY, behavior: "instant" });
    renderInspect();
  });

  peerTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      claimResources({ broadcast: false });
      updatePresence();
    }
  }, 8_000);

  saveSession();
}

function sanitizeRestoredDrafts() {
  const valid = {};
  for (const [key, draft] of Object.entries(drafts)) {
    const [objectId, fieldName] = key.split(":");
    const object = getObject(objectId);
    if (!object || !FIELDS[fieldName] || !draft || typeof draft !== "object") continue;
    valid[key] = {
      value: String(draft.value ?? ""),
      baseValue: String(draft.baseValue ?? object.fields[fieldName]?.value ?? ""),
      baseRevision: Number(draft.baseRevision) || object.fields[fieldName]?.revision || 0,
      startedAt: draft.startedAt || nowIso(),
    };
  }
  drafts = valid;
}

function renderAll() {
  if (!ready || !project) return;
  renderObjectList();
  renderEditor();
  renderConflicts();
  renderResources();
  renderPeers();
  renderExportReadiness();
  renderInspect();
  lastRendered = {
    revision: project.revision,
    hash: project.checksum || projectHash(project),
    selectedId,
    at: nowIso(),
  };
  renderInspect();
}

function selectionTypeLabel(object) {
  return TYPE_META[object?.fields?.type?.value]?.label || "对象";
}

function renderObjectList() {
  if (!project) return;
  const focusedId = document.activeElement?.closest?.("[data-object-id]")?.dataset.objectId;
  const query = els.objectSearch.value.trim().toLocaleLowerCase("zh-CN");
  const objects = project.objects.filter((object) => {
    if (!query) return true;
    const haystack = `${object.fields.title.value} ${object.fields.owner.value}`.toLocaleLowerCase("zh-CN");
    return haystack.includes(query);
  });

  els.objectCount.textContent = String(project.objects.length);
  els.objectList.innerHTML = objects
    .map((object) => {
      const meta = TYPE_META[object.fields.type.value] || TYPE_META.scene;
      const isSelected = object.id === selectedId;
      const draftMarker = hasDrafts(object.id)
        ? `<span class="marker marker-draft" title="有未提交草稿" aria-label="有未提交草稿">草</span>`
        : "";
      const conflictMarker =
        conflictsForObject(object.id).length > 0
          ? `<span class="marker marker-conflict" title="有冲突" aria-label="有冲突">!</span>`
          : "";
      return `
        <button
          class="object-item"
          type="button"
          data-object-id="${escapeHtml(object.id)}"
          aria-current="${isSelected ? "true" : "false"}"
        >
          <span class="object-glyph" aria-hidden="true">${meta.glyph}</span>
          <span class="object-copy">
            <strong>${escapeHtml(object.fields.title.value)}</strong>
            <small>${meta.label} · ${escapeHtml(object.fields.owner.value)}</small>
          </span>
          <span class="object-markers">${draftMarker}${conflictMarker}</span>
        </button>
      `;
    })
    .join("");

  if (objects.length === 0) {
    els.objectList.innerHTML = `<div class="empty-state">没有匹配“${escapeHtml(
      els.objectSearch.value,
    )}”的对象。</div>`;
  }

  if (focusedId) {
    const target = $(`[data-object-id="${CSS.escape(focusedId)}"]`, els.objectList);
    target?.focus({ preventScroll: true });
  }
}

function setFieldValue(input, value, protectFocus = false) {
  if (protectFocus && document.activeElement === input) return;
  input.value = value ?? "";
}

function renderEditor() {
  const object = getObject();
  if (!object) {
    els.editorTitle.textContent = "没有可编辑对象";
    els.objectBreadcrumb.textContent = "PROJECT / EMPTY";
    return;
  }
  const typeMeta = TYPE_META[object.fields.type.value] || TYPE_META.scene;
  els.objectBreadcrumb.textContent = `${typeMeta.label.toUpperCase()} / ${object.id}`;
  els.editorTitle.textContent = object.fields.title.value || "未命名对象";

  for (const [fieldName] of Object.entries(FIELDS)) {
    const input = $(`[data-field="${fieldName}"]`);
    const draft = getDraft(object.id, fieldName);
    if (draft) {
      setFieldValue(input, draft.value, true);
    } else {
      setFieldValue(input, object.fields[fieldName]?.value ?? "");
    }
  }

  els.noteCounter.textContent = `${$('[data-field="note"]').value.length} / 500`;
  els.fieldVersions.innerHTML = Object.entries(FIELDS)
    .map(([fieldName, meta]) => {
      const current = object.fields[fieldName];
      return `<span class="version-pill">${escapeHtml(meta.label)} r${current?.revision ?? 0}</span>`;
    })
    .join("");
  renderDraftIndicators();
  renderValidationState();
}

function renderDraftIndicators() {
  const object = getObject();
  if (!object) return;
  for (const [fieldName, meta] of Object.entries(FIELDS)) {
    const target = $(`#${fieldName}DraftState`);
    if (!target) continue;
    const draft = getDraft(object.id, fieldName);
    const conflicting = project.conflicts.some(
      (conflict) =>
        conflict.status === "open" &&
        conflict.objectId === object.id &&
        conflict.field === fieldName,
    );
    const remoteMoved = draft && draft.baseRevision !== object.fields[fieldName]?.revision;
    target.classList.toggle("is-dirty", Boolean(draft));
    target.classList.toggle("is-conflict", conflicting);
    if (conflicting) {
      target.textContent = "冲突";
    } else if (remoteMoved) {
      target.textContent = "远端已更新 · 草稿保留";
    } else if (draft) {
      target.textContent = "未提交";
    } else {
      target.textContent = "已同步";
    }
  }

  const count = draftCount(object.id);
  const conflicts = conflictsForObject(object.id).length;
  els.revertButton.disabled = count === 0;
  els.draftHint.textContent =
    count === 0
      ? conflicts
        ? "当前对象有未决冲突"
        : "没有未提交修改"
      : `${count} 个字段未提交 · 刷新后仍会保留`;

  els.objectSaveState.className = "status-chip";
  if (conflicts > 0) {
    els.objectSaveState.classList.add("status-error");
    els.objectSaveState.textContent = `${conflicts} 个冲突待处理`;
  } else if (count > 0) {
    els.objectSaveState.classList.add("status-warn");
    els.objectSaveState.textContent = `${count} 个字段未提交`;
  } else {
    els.objectSaveState.classList.add("status-ok");
    els.objectSaveState.textContent = `已同步 rev ${project.revision}`;
  }

  const countOpen = openConflictCount();
  els.conflictCount.textContent = String(countOpen);
  els.conflictSpotlight.hidden = countOpen === 0 || conflicts === 0;
  if (countOpen > 0 && conflicts > 0) {
    els.conflictSpotlightTitle.textContent =
      conflicts === 1 ? "检测到 1 个字段冲突" : `检测到 ${conflicts} 个字段冲突`;
    els.conflictSpotlightText.textContent =
      "本地草稿已保留。请核对本地、远端值与各自修订，再明确选择版本。";
  }
  els.saveButton.disabled = committing;
  els.undoButton.disabled = undoStack.length === 0 || committing;
  renderObjectList();
  renderInspect();
}

function renderValidationState() {
  const object = getObject();
  if (!object) return;
  for (const [fieldName, meta] of Object.entries(FIELDS)) {
    const input = $(`[data-field="${fieldName}"]`);
    const errorNode = $(`#${fieldName}Error`);
    const draft = getDraft(object.id, fieldName);
    const value = draft ? draft.value : input.value;
    const error = validateField(fieldName, value);
    if (error && input.getAttribute("aria-invalid") === "true") {
      errorNode.textContent = error;
      errorNode.hidden = false;
    } else if (!error) {
      input.setAttribute("aria-invalid", "false");
      errorNode.hidden = true;
    }
  }
}

function validateField(fieldName, rawValue) {
  const value = String(rawValue ?? "").trim();
  const meta = FIELDS[fieldName];
  if (meta.required && !value) return `${meta.label}不能为空。`;
  if (value.length > meta.max) return `${meta.label}不能超过 ${meta.max} 个字符。`;
  if (fieldName === "type" && !TYPE_META[value]) return "请选择有效对象类型。";
  return "";
}

function validateObject(object) {
  if (!object) return { title: "当前没有可编辑对象。" };
  const errors = {};
  const values = visibleFieldValues();
  for (const fieldName of Object.keys(FIELDS)) {
    const draft = getDraft(object.id, fieldName);
    const message = validateField(fieldName, draft ? draft.value : values[fieldName]);
    if (message) errors[fieldName] = message;
  }
  return errors;
}

function conflictCompound(objectId, fieldName) {
  return `${objectId}.${fieldName}`;
}

function renderConflicts() {
  if (!project) return;
  const open = project.conflicts.filter((conflict) => conflict.status === "open");
  const resolved = project.conflicts
    .filter((conflict) => conflict.status === "resolved")
    .slice(0, 3);
  els.conflictCount.textContent = String(open.length);
  els.conflictSpotlight.hidden = open.length === 0;

  if (open.length === 0 && resolved.length === 0) {
    els.conflictList.innerHTML = `
      <div class="empty-state">
        暂无冲突。两个标签页同时从同一字段版本提交不同值时，这里会保留两份值与提交标签页。
      </div>
    `;
    return;
  }

  els.conflictList.innerHTML = [
    ...open.map((conflict) => conflictCard(conflict, false)),
    ...resolved.map((conflict) => conflictCard(conflict, true)),
  ].join("");
}

function conflictCard(conflict, resolved) {
  const object = getObject(conflict.objectId);
  const currentTitle = object?.fields?.title?.value || conflict.objectTitle || conflict.objectId;
  const actionButtons = resolved
    ? `<span class="status-chip status-muted">${conflict.resolution === "local" ? "已采用本地值" : "已采用远端值"} · rev ${conflict.resolvedRevision}</span>`
    : `<div class="conflict-actions">
        <button class="button button-small button-primary" type="button"
          data-conflict-id="${escapeHtml(conflict.id)}" data-resolution="local">
          采用本地值
        </button>
        <button class="button button-small button-quiet" type="button"
          data-conflict-id="${escapeHtml(conflict.id)}" data-resolution="remote">
          采用远端值
        </button>
      </div>`;
  return `
    <article class="conflict-card${resolved ? " is-resolved" : ""}"
      data-conflict-card="${escapeHtml(conflict.id)}">
      <div class="conflict-card-head">
        <div>
          <h3>${escapeHtml(currentTitle)} · ${escapeHtml(FIELDS[conflict.field]?.label || conflict.field)}</h3>
          <span class="conflict-path">${escapeHtml(conflictCompound(conflict.objectId, conflict.field))}</span>
        </div>
        <span class="status-chip ${resolved ? "status-muted" : "status-warn"}">
          ${resolved ? "已留痕" : "待处理"}
        </span>
      </div>
      <dl class="conflict-values">
        <div class="value-box">
          <dt>本地值 · ${escapeHtml(conflict.localActor)} · 基于 r${conflict.baseRevision}</dt>
          <dd>${escapeHtml(conflict.localValue || "（空）")}</dd>
        </div>
        <div class="value-box">
          <dt>远端值 · ${escapeHtml(conflict.remoteActor)} · r${conflict.remoteRevision}</dt>
          <dd>${escapeHtml(conflict.remoteValue || "（空）")}</dd>
        </div>
        <div class="value-box">
          <dt>共同基线</dt>
          <dd>${escapeHtml(conflict.baseValue || "（空）")}</dd>
        </div>
        <div class="value-box">
          <dt>检测与处理</dt>
          <dd>${escapeHtml(formatClock(conflict.detectedAt))} 检测${
            resolved
              ? ` · ${escapeHtml(formatClock(conflict.resolvedAt))} 由 ${escapeHtml(conflict.resolvedBy)} 处理`
              : ` · 项目 rev ${conflict.projectRevision}`
          }</dd>
        </div>
      </dl>
      ${actionButtons}
      <p class="conflict-meta">trace=${escapeHtml(conflict.id)} · field=${escapeHtml(
        conflict.field,
      )} · remoteHash=${escapeHtml(conflict.remoteChecksum || "—")}</p>
    </article>
  `;
}

function renderPeers() {
  const peers = peerStates().sort((left, right) => {
    if (left.self !== right.self) return left.self ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
  const others = peers.filter((peer) => !peer.self);
  const stale = others.filter((peer) => peer.revision !== project?.revision);
  els.peerCount.textContent = `${peers.length} 个标签页`;
  els.tabRegisterState.textContent = stale.length > 0 ? "修订不一致" : "同步正常";
  els.syncBadge.className = "status-chip";
  if (storageProblem) {
    els.syncBadge.classList.add("status-error");
    els.syncBadgeText.textContent = "存储异常 · 快照可读";
  } else if (openConflictCount() > 0) {
    els.syncBadge.classList.add("status-warn");
    els.syncBadgeText.textContent = `${openConflictCount()} 个冲突待处理`;
  } else {
    els.syncBadge.classList.add("status-ok");
    els.syncBadgeText.textContent = `已同步 rev ${project?.revision ?? "—"}`;
  }
  els.footerStatus.textContent = storageProblem
    ? "共享存储异常；当前可读快照与草稿仍保留在页面中"
    : stale.length > 0
      ? `检测到 ${stale.length} 个标签页修订不一致`
      : `输入、会话草稿、共享存储与渲染已对齐 · ${peers.length} 个标签页`;
  els.tabRegister.innerHTML = peers
    .map((peer) => {
      const state =
        peer.self && hasDrafts()
          ? "本页 · 草稿"
          : peer.revision !== project?.revision
            ? `rev ${peer.revision}`
            : peer.dirty
              ? "草稿"
              : "已同步";
      return `<li class="${peer.self ? "self" : ""}">
        <span class="tab-dot" aria-hidden="true"></span>
        <span>${escapeHtml(peer.label)}</span>
        <span>${peer.self ? "本页" : "同浏览器"}</span>
        <span>${escapeHtml(state)}</span>
      </li>`;
    })
    .join("");
}

function renderResources() {
  if (!project) return;
  const counts = claimCounts();
  const leases = readClaims();
  const peerLabels = new Map(
    Object.entries(leases).flatMap(([, leaseMap]) =>
      Object.entries(leaseMap).map(([leaseTabId, lease]) => [
        leaseTabId,
        lease.label || leaseTabId,
      ]),
    ),
  );
  els.resourceList.innerHTML = project.resources
    .map((resource) => {
      const references = project.objects.filter((object) =>
        object.resourceIds?.includes(resource.id),
      ).length;
      const count = counts[resource.id] || 0;
      const users = Object.keys(leases[resource.id] || {})
        .map((id) => peerLabels.get(id) || id)
        .join("、");
      return `
        <article class="resource-card" data-resource-id="${escapeHtml(resource.id)}">
          <img class="resource-thumb" src="${escapeHtml(resource.path)}" alt="" />
          <div class="resource-copy">
            <strong>${escapeHtml(resource.name)}</strong>
            <small>${escapeHtml(resource.detail)} · 对象引用 ${references}</small>
            <small>${count > 0 ? `租约：${escapeHtml(users)}` : "当前无活动租约，源资源仍保留"}</small>
          </div>
          <span class="lease-badge${count === 0 ? " is-zero" : ""}">${count} 租约</span>
        </article>
      `;
    })
    .join("");
}

function evaluateReadiness() {
  const reasons = [];
  const peers = peerStates();
  const others = peers.filter((peer) => !peer.self);

  if (!project) reasons.push("项目尚未载入。");
  if (storageProblem) reasons.push(`共享存储异常：${storageProblem}`);
  const open = openConflictCount();
  if (open > 0) reasons.push(`仍有 ${open} 个字段冲突未处理。`);
  const localDrafts = draftCount();
  if (localDrafts > 0) reasons.push(`本页有 ${localDrafts} 个未提交草稿字段。`);
  const dirtyPeers = others.filter((peer) => peer.dirty);
  if (dirtyPeers.length > 0) {
    reasons.push(
      `${dirtyPeers.map((peer) => peer.label).join("、")} 仍有未提交草稿。`,
    );
  }
  const stalePeers = others.filter((peer) => peer.revision !== project?.revision);
  if (stalePeers.length > 0) {
    reasons.push(
      `${stalePeers
        .map((peer) => `${peer.label}@rev ${peer.revision}`)
        .join("、")} 与当前 rev ${project?.revision} 不一致。`,
    );
  }
  const invalidObjects = project
    ? project.objects.filter((object) => {
        const errors = {};
        for (const [fieldName, meta] of Object.entries(FIELDS)) {
          const message = validateField(fieldName, object.fields[fieldName]?.value);
          if (message) errors[fieldName] = message;
        }
        return Object.keys(errors).length > 0;
      })
    : [];
  if (invalidObjects.length > 0) {
    reasons.push(`${invalidObjects.length} 个对象未通过必填校验。`);
  }

  let stored = null;
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    const parsed = safeParse(raw);
    stored = parsed.ok ? parsed.value : null;
  } catch {
    // storageProblem above explains the failure.
  }
  if (stored && stored.checksum !== project?.checksum) {
    reasons.push("当前渲染与共享存储指纹不一致，请在同步后重试。");
  }
  if (stored && stored.revision !== project?.revision) {
    reasons.push("共享存储已出现新修订，请刷新当前状态。");
  }

  return {
    ready: reasons.length === 0,
    reasons,
    peers,
    revision: project?.revision ?? 0,
    hash: project?.checksum || "",
  };
}

function renderExportReadiness() {
  if (!ready || !project) return;
  const readiness = evaluateReadiness();
  els.snapshotState.className = "status-chip";
  els.snapshotState.classList.add(readiness.ready ? "status-ok" : "status-warn");
  els.snapshotState.textContent = readiness.ready ? "快照一致" : "暂不可导出";
  els.snapshotReasons.innerHTML =
    readiness.reasons.length > 0
      ? readiness.reasons
          .map((reason) => `<div class="check-item is-fail">${escapeHtml(reason)}</div>`)
          .join("")
      : `<div class="check-item">所有活动标签页位于同一修订</div>
         <div class="check-item">无未提交草稿，无未决冲突</div>
         <div class="check-item">存储指纹与当前渲染一致</div>`;
  els.snapshotRevision.textContent = `rev ${readiness.revision}`;
  els.snapshotHash.textContent = readiness.hash ? readiness.hash.slice(0, 12) : "—";
  els.snapshotObjects.textContent = String(project.objects.length);
  els.snapshotLastExport.textContent = sessionRestore.lastExport
    ? `rev ${sessionRestore.lastExport.revision} · ${formatClock(sessionRestore.lastExport.at)}`
    : "尚未导出";
  renderExportDialogState(readiness);
  return readiness;
}

function renderExportDialogState(readiness = evaluateReadiness()) {
  els.exportRevision.textContent = `rev ${readiness.revision}`;
  els.exportHash.textContent = readiness.hash ? readiness.hash.slice(0, 12) : "—";
  els.exportPeers.textContent = String(readiness.peers.length);
  els.exportReadiness.classList.toggle("is-blocked", !readiness.ready);
  els.exportReadiness.textContent = readiness.ready
    ? "检查通过：所有活动标签页已对齐，可以固定在当前修订导出。"
    : `暂不可导出：${readiness.reasons.join(" ")}`;
  els.confirmExportButton.disabled = !readiness.ready;
}

function describeFocus(element) {
  if (!element || element === document.body) return "文档";
  const label =
    element.getAttribute("aria-label") ||
    element.labels?.[0]?.textContent?.trim() ||
    element.textContent?.trim() ||
    element.id ||
    element.tagName;
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""} · ${truncate(label, 34)}`;
}

function renderInspect() {
  if (!ready || !project) return;
  const object = getObject();
  const values = visibleFieldValues();
  const signature = inputSignature();
  const inputChanged = signature !== lastInputSignature;
  lastInputSignature = signature;
  const store = readProjectRaw();
  const stored = store.ok ? store.value : null;

  els.inspectInput.textContent = object
    ? `${object.id}.${document.activeElement?.dataset?.field || "title"} = ${truncate(
        document.activeElement?.dataset?.field
          ? document.activeElement.value
          : values.title,
        24,
      )}`
    : "—";
  els.inspectDrafts.textContent = `${draftCount()} 个字段 · ${openConflictCount()} 冲突`;
  els.inspectStore.textContent = stored
    ? `rev ${stored.revision} · ${String(stored.checksum).slice(0, 8)}`
    : storageProblem
      ? "不可读取"
      : "尚未写入";
  els.inspectRender.textContent = lastRendered.revision
    ? `rev ${lastRendered.revision} · ${lastRendered.hash.slice(0, 8)}`
    : "等待渲染";
  els.inspectFocus.textContent = describeFocus(document.activeElement);
  els.inspectScroll.textContent = `${Math.round(window.scrollY)} px`;
  els.inspectTab.textContent = `${tabLabel} · ${tabId}`;

  const storeMatches =
    stored &&
    stored.revision === project.revision &&
    stored.checksum === project.checksum;
  const renderMatches =
    lastRendered.revision === project.revision && lastRendered.hash === project.checksum;
  let syncText = "输入 = 存储 = 渲染";
  let syncClass = "is-ok";
  if (storageProblem) {
    syncText = "存储异常 · 已保留可读快照";
    syncClass = "is-error";
  } else if (openConflictCount() > 0) {
    syncText = "冲突未决 · 导出锁定";
    syncClass = "is-error";
  } else if (draftCount() > 0) {
    syncText = "输入与存储有意不同 · 草稿已保存";
    syncClass = "is-warn";
  } else if (!storeMatches || !renderMatches || inputChanged) {
    syncText = "同步检查中";
    syncClass = "is-warn";
  }
  els.inspectSync.textContent = syncText;
  els.inspectSync.className = syncClass;

  els.inspectJson.textContent = JSON.stringify(
    {
      input: {
        objectId: object?.id || null,
        signature: hashString(signature).slice(0, 12),
        values,
      },
      sessionDrafts: Object.fromEntries(
        Object.entries(drafts).map(([key, draft]) => [
          key,
          {
            value: truncate(draft.value, 38),
            baseRevision: draft.baseRevision,
          },
        ]),
      ),
      store: stored
        ? { revision: stored.revision, checksum: stored.checksum, updatedAt: stored.updatedAt }
        : null,
      render: {
        revision: lastRendered.revision,
        checksum: lastRendered.hash,
        selectedId: lastRendered.selectedId,
        at: lastRendered.at,
      },
      tabId,
    },
    null,
    2,
  );
}

function updateDraftFromInput(fieldName) {
  const object = getObject();
  const input = $(`[data-field="${fieldName}"]`);
  if (!object || !input) return;
  const currentField = object.fields[fieldName];
  const key = draftKey(object.id, fieldName);
  let draft = drafts[key];
  if (!draft) {
    draft = {
      value: input.value,
      baseValue: currentField.value,
      baseRevision: currentField.revision,
      startedAt: nowIso(),
    };
  } else {
    draft.value = input.value;
  }
  if (draft.value === draft.baseValue) {
    delete drafts[key];
  } else {
    drafts[key] = draft;
  }
  els.noteCounter.textContent = `${$('[data-field="note"]').value.length} / 500`;
  const error = validateField(fieldName, input.value);
  if (!error) {
    input.setAttribute("aria-invalid", "false");
    const errorNode = $(`#${fieldName}Error`);
    errorNode.hidden = true;
  }
  saveSession();
  updatePresence();
  renderDraftIndicators();
  renderExportReadiness();
}

function ensureVisibleDrafts() {
  const object = getObject();
  if (!object) return;
  for (const [fieldName] of Object.entries(FIELDS)) {
    const input = $(`[data-field="${fieldName}"]`);
    if (!input) continue;
    const key = draftKey(object.id, fieldName);
    if (input.value !== object.fields[fieldName].value && !drafts[key]) {
      drafts[key] = {
        value: input.value,
        baseValue: object.fields[fieldName].value,
        baseRevision: object.fields[fieldName].revision,
        startedAt: nowIso(),
      };
    }
  }
  saveSession();
  updatePresence();
}

function showValidationErrors(errors) {
  const labels = Object.keys(errors).map((fieldName) => FIELDS[fieldName].label);
  els.validationSummary.hidden = false;
  els.validationSummary.innerHTML = `
    <strong>提交失败：请修正 ${labels.length} 个字段。</strong>
    <ul>${Object.entries(errors)
      .map(([fieldName, message]) => `<li><a href="#field${fieldName[0].toUpperCase()}${fieldName.slice(1)}">${escapeHtml(message)}</a></li>`)
      .join("")}</ul>
  `;
  let firstInput = null;
  for (const [fieldName, message] of Object.entries(errors)) {
    const input = $(`[data-field="${fieldName}"]`);
    const errorNode = $(`#${fieldName}Error`);
    input.setAttribute("aria-invalid", "true");
    errorNode.textContent = message;
    errorNode.hidden = false;
    firstInput ||= input;
  }
  els.validationSummary.focus();
  toast("提交失败：未提交内容仍保存在本页草稿中", true);
}

function clearValidationErrors() {
  els.validationSummary.hidden = true;
  els.validationSummary.innerHTML = "";
  for (const [fieldName] of Object.entries(FIELDS)) {
    const input = $(`[data-field="${fieldName}"]`);
    input.setAttribute("aria-invalid", "false");
    const errorNode = $(`#${fieldName}Error`);
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
}

async function commitSelected() {
  if (committing) return;
  const object = getObject();
  if (!object) {
    toast("没有可提交的对象", true);
    return;
  }
  clearValidationErrors();
  ensureVisibleDrafts();
  const errors = validateObject(object);
  if (Object.keys(errors).length > 0) {
    showValidationErrors(errors);
    return;
  }
  const selectedDrafts = Object.entries(drafts).filter(([key]) =>
    key.startsWith(`${object.id}:`),
  );
  if (selectedDrafts.length === 0) {
    toast("没有需要提交的修改");
    renderAll();
    return;
  }

  committing = true;
  els.saveButton.disabled = true;
  els.saveButton.textContent = "正在提交…";
  try {
    const result = await withProjectLock(async () => {
      const stored = readProjectRaw();
      if (!stored.ok || !stored.value) {
        return { ok: false, error: stored.reason || "共享项目不可读取", project: null };
      }
      const latest = stored.value;
      const latestObject = latest.objects.find((item) => item.id === object.id);
      if (!latestObject) {
        return { ok: false, error: "对象已在其他标签页被移除", project: latest };
      }

      const changes = [];
      const clashes = [];
      for (const [key, draft] of selectedDrafts) {
        const fieldName = key.split(":")[1];
        const latestField = latestObject.fields[fieldName];
        if (!latestField) continue;
        if (
          latestField.revision !== draft.baseRevision &&
          latestField.value !== draft.value
        ) {
          clashes.push({ fieldName, draft, latestField });
        } else if (latestField.value !== draft.value) {
          changes.push({ fieldName, draft, latestField });
        }
      }

      if (clashes.length > 0) {
        const remoteChecksum = latest.checksum;
        for (const clash of clashes) {
          const compound = conflictCompound(object.id, clash.fieldName);
          let conflict = latest.conflicts.find(
            (item) => item.status === "open" && item.compound === compound,
          );
          if (!conflict) {
            conflict = {
              id: `conflict-${crypto.randomUUID().slice(0, 8)}`,
              compound,
              objectId: object.id,
              objectTitle: latestObject.fields.title.value,
              field: clash.fieldName,
              fieldLabel: FIELDS[clash.fieldName].label,
              baseValue: clash.draft.baseValue,
              localValue: clash.draft.value,
              remoteValue: clash.latestField.value,
              baseRevision: clash.draft.baseRevision,
              remoteRevision: clash.latestField.revision,
              localActor: tabLabel,
              remoteActor: clash.latestField.updatedBy || "另一标签页",
              remoteChecksum,
              detectedAt: nowIso(),
              projectRevision: latest.revision + 1,
              status: "open",
            };
            latest.conflicts.unshift(conflict);
          } else {
            conflict.localValue = clash.draft.value;
            conflict.baseValue = clash.draft.baseValue;
            conflict.baseRevision = clash.draft.baseRevision;
            conflict.remoteValue = clash.latestField.value;
            conflict.remoteRevision = clash.latestField.revision;
            conflict.remoteActor = clash.latestField.updatedBy || "另一标签页";
            conflict.remoteChecksum = remoteChecksum;
            conflict.detectedAt = nowIso();
          }
        }
        latest.revision += 1;
        latest.conflicts = latest.conflicts.slice(0, MAX_CONFLICT_TRACE);
        const written = writeProjectRaw(latest);
        if (!written.ok) {
          return {
            ok: false,
            error: "冲突记录未能写入共享存储；本地草稿与可读快照已保留",
            project: null,
          };
        }
        return { ok: false, conflict: true, project: latest, clashes };
      }

      if (changes.length === 0) {
        return { ok: true, noChanges: true, project: latest, changes: [] };
      }

      const undoEntries = [];
      const timestamp = nowIso();
      for (const change of changes) {
        const previous = latestObject.fields[change.fieldName];
        undoEntries.push({
          objectId: object.id,
          field: change.fieldName,
          previousValue: previous.value,
          nextValue: change.draft.value,
          fieldRevisionAfter: previous.revision + 1,
          at: timestamp,
        });
        latestObject.fields[change.fieldName] = {
          value: change.draft.value,
          revision: previous.revision + 1,
          updatedAt: timestamp,
          updatedBy: tabLabel,
        };
      }
      latestObject.updatedAt = timestamp;
      latest.revision += 1;
      const written = writeProjectRaw(latest);
      if (!written.ok) {
        return {
          ok: false,
          error: "共享存储写入失败；本地草稿与可读快照已保留",
          project: null,
        };
      }
      return { ok: true, project: latest, changes, undoEntries };
    });

    if (!result.project) {
      toast(`提交失败：${result.error}`, true);
      return;
    }
    project = result.project;
    notifyProjectUpdate();

    if (result.conflict) {
      toast("检测到同一字段冲突；两份值已留痕，草稿未被覆盖", true);
      renderAll();
      updatePresence({ broadcast: true });
      requestAnimationFrame(() => {
        $("#conflictPanel")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      return;
    }

    for (const [key] of selectedDrafts) delete drafts[key];
    if (result.undoEntries?.length) {
      undoStack.unshift(...result.undoEntries);
      undoStack = undoStack.slice(0, 20);
    }
    saveSession();
    renderAll();
    updatePresence({ broadcast: true });
    toast(
      result.noChanges
        ? "没有内容变化，草稿已清理"
        : `已提交 ${result.changes.length} 个字段 · rev ${project.revision}`,
    );
  } catch (error) {
    toast(`提交失败：${error.message}。草稿仍保留。`, true);
  } finally {
    committing = false;
    els.saveButton.textContent = "提交修改";
    const keyHint = document.createElement("span");
    keyHint.className = "key-hint";
    keyHint.textContent = "Ctrl S";
    els.saveButton.append(keyHint);
    renderDraftIndicators();
  }
}

async function resolveConflict(conflictId, resolution) {
  const result = await withProjectLock(async () => {
    const stored = readProjectRaw();
    if (!stored.ok || !stored.value) return { ok: false, error: stored.reason || "共享项目不可读取" };
    const latest = stored.value;
    const conflict = latest.conflicts.find(
      (item) => item.id === conflictId && item.status === "open",
    );
    if (!conflict) return { ok: false, error: "该冲突已在其他标签页处理" };
    const object = latest.objects.find((item) => item.id === conflict.objectId);
    if (!object) return { ok: false, error: "冲突对象已不存在" };
    const currentField = object.fields[conflict.field];
    if (!currentField) return { ok: false, error: "冲突字段已不存在" };
    const value = resolution === "local" ? conflict.localValue : conflict.remoteValue;
    object.fields[conflict.field] = {
      value,
      revision: currentField.revision + 1,
      updatedAt: nowIso(),
      updatedBy: tabLabel,
    };
    conflict.status = "resolved";
    conflict.resolution = resolution;
    conflict.resolvedAt = nowIso();
    conflict.resolvedBy = tabLabel;
    conflict.resolvedRevision = latest.revision + 1;
    latest.revision += 1;
    const written = writeProjectRaw(latest);
    if (!written.ok) {
      return { ok: false, error: "共享存储写入失败；冲突与可读快照已保留" };
    }
    return {
      ok: true,
      project: latest,
      conflict,
      draftKey: draftKey(conflict.objectId, conflict.field),
      value,
    };
  });

  if (!result.ok) {
    toast(`处理冲突失败：${result.error}`, true);
    syncProjectFromStore({ announce: false });
    return;
  }
  delete drafts[result.draftKey];
  project = result.project;
  saveSession();
  renderAll();
  notifyProjectUpdate();
  updatePresence({ broadcast: true });
  toast(
    `冲突已处理：采用${result.conflict.resolution === "local" ? "本地" : "远端"}值 · rev ${project.revision}`,
  );
}

function revertDrafts() {
  const object = getObject();
  if (!object) return;
  const removed = draftCount(object.id);
  for (const key of objectDraftKeys(object.id)) delete drafts[key];
  clearValidationErrors();
  saveSession();
  updatePresence();
  renderAll();
  toast(`已放弃 ${removed} 个字段草稿；选中对象与滚动位置保持不变`);
}

async function undoLastCommit() {
  const entry = undoStack[0];
  if (!entry) {
    toast("没有可撤销的已提交修改");
    return;
  }
  const result = await withProjectLock(async () => {
    const stored = readProjectRaw();
    if (!stored.ok || !stored.value) return { ok: false, error: stored.reason || "共享项目不可读取" };
    const latest = stored.value;
    const object = latest.objects.find((item) => item.id === entry.objectId);
    const current = object?.fields?.[entry.field];
    if (!object || !current) return { ok: false, error: "字段已不存在" };
    if (current.revision !== entry.fieldRevisionAfter) {
      return {
        ok: false,
        error: "该字段已被其他提交更新，撤销会覆盖新内容，因此已阻止",
      };
    }
    object.fields[entry.field] = {
      value: entry.previousValue,
      revision: current.revision + 1,
      updatedAt: nowIso(),
      updatedBy: tabLabel,
    };
    object.updatedAt = nowIso();
    latest.revision += 1;
    const written = writeProjectRaw(latest);
    if (!written.ok) {
      return { ok: false, error: "共享存储写入失败；草稿与可读快照已保留" };
    }
    return { ok: true, project: latest, entry };
  });

  if (!result.ok) {
    toast(`撤销失败：${result.error}。草稿、选中对象与滚动位置均保留。`, true);
    return;
  }
  undoStack.shift();
  project = result.project;
  saveSession();
  renderAll();
  notifyProjectUpdate();
  updatePresence({ broadcast: true });
  toast(`已撤销“${FIELDS[entry.field].label}”最近一次提交 · rev ${project.revision}`);
}

async function addObject() {
  const result = await withProjectLock(async () => {
    const stored = readProjectRaw();
    if (!stored.ok || !stored.value) return { ok: false, error: stored.reason || "共享项目不可读取" };
    const latest = stored.value;
    const id = `scene-${crypto.randomUUID().slice(0, 6)}`;
    const timestamp = nowIso();
    latest.objects.push({
      id,
      updatedAt: timestamp,
      resourceIds: [],
      fields: {
        title: field("未命名场景", 1, tabLabel),
        owner: field(tabLabel, 1, tabLabel),
        type: field("scene", 1, tabLabel),
        note: field("", 1, tabLabel),
      },
    });
    latest.revision += 1;
    const written = writeProjectRaw(latest);
    if (!written.ok) return { ok: false, error: "共享存储写入失败" };
    return { ok: true, project: latest, id };
  });
  if (!result.ok) {
    toast(`新建失败：${result.error}`, true);
    return;
  }
  selectedId = result.id;
  project = result.project;
  saveSession();
  renderAll();
  notifyProjectUpdate();
  updatePresence({ broadcast: true });
  $('[data-field="title"]')?.focus();
  toast("已新建场景 · 标题、负责人和说明均可编辑");
}

function notifyProjectUpdate() {
  channel?.postMessage({
    type: "project-updated",
    source: tabId,
    revision: project?.revision || 0,
    checksum: project?.checksum || "",
  });
}

const probeWaiters = new Map();

function probeOtherTabs(expectedRevision) {
  const expected = peerStates()
    .filter((peer) => !peer.self)
    .map((peer) => peer.id);
  if (expected.length === 0) {
    return Promise.resolve({ ok: true, responses: [], expected: [] });
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const waiter = {
      expected: new Set(expected),
      responses: new Map(),
      timer: null,
      resolve,
    };
    waiter.timer = setTimeout(() => {
      probeWaiters.delete(requestId);
      resolve({
        ok: false,
        responses: [...waiter.responses.values()],
        expected,
        missing: [...waiter.expected],
      });
    }, 450);
    probeWaiters.set(requestId, waiter);
    channel?.postMessage({
      type: "export-probe",
      requestId,
      source: tabId,
      revision: expectedRevision,
    });
    if (!channel) {
      clearTimeout(waiter.timer);
      probeWaiters.delete(requestId);
      resolve({ ok: false, responses: [], expected, missing: expected });
    }
  });
}

function handleProbeResponse(message) {
  const waiter = probeWaiters.get(message.requestId);
  if (!waiter || !waiter.expected.has(message.source)) return;
  waiter.responses.set(message.source, message);
  waiter.expected.delete(message.source);
  if (waiter.expected.size === 0) {
    clearTimeout(waiter.timer);
    probeWaiters.delete(message.requestId);
    waiter.resolve({ ok: true, responses: [...waiter.responses.values()], expected: [] });
  }
}

function openExportDialog() {
  if (!ready || !project) return;
  exportTrigger = document.activeElement;
  updatePresence();
  const readiness = renderExportReadiness();
  els.exportFailure.hidden = true;
  els.exportFailure.textContent = "";
  if (typeof els.exportDialog.showModal === "function") {
    if (!els.exportDialog.open) els.exportDialog.showModal();
    requestAnimationFrame(() => {
      (readiness?.ready ? els.confirmExportButton : els.closeExportButton).focus();
    });
  } else {
    els.exportDialog.setAttribute("open", "");
  }
}

function closeExportDialog() {
  if (els.exportDialog.open && typeof els.exportDialog.close === "function") {
    els.exportDialog.close("cancel");
  } else {
    els.exportDialog.removeAttribute("open");
  }
}

function buildSnapshot(latest, probeResponses) {
  return {
    schema: "localstudio.consistent-snapshot.v1",
    exportedAt: nowIso(),
    exportedBy: tabLabel,
    project: {
      id: latest.id,
      title: latest.title,
      revision: latest.revision,
      checksum: latest.checksum,
      createdAt: latest.createdAt,
      updatedAt: latest.updatedAt,
    },
    consistency: {
      policy: "no-open-conflicts + no-uncommitted-drafts + matching-peer-revisions",
      activeTabs: probeResponses.length + 1,
      peerRevisions: probeResponses.map((response) => ({
        tab: response.label || response.source,
        revision: response.revision,
        checksum: response.checksum,
      })),
    },
    objects: latest.objects.map((object) => ({
      id: object.id,
      updatedAt: object.updatedAt,
      resourceIds: object.resourceIds || [],
      fields: Object.fromEntries(
        Object.entries(object.fields).map(([fieldName, fieldValue]) => [
          fieldName,
          {
            value: fieldValue.value,
            revision: fieldValue.revision,
            updatedAt: fieldValue.updatedAt,
            updatedBy: fieldValue.updatedBy,
          },
        ]),
      ),
    })),
    resources: latest.resources,
    conflictTrace: latest.conflicts,
  };
}

function downloadSnapshot(snapshot) {
  const text = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rain-notes-rev${snapshot.project.revision}-${snapshot.project.checksum.slice(0, 8)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function confirmExport() {
  if (!project) return;
  els.confirmExportButton.disabled = true;
  const originalText = els.confirmExportButton.textContent;
  els.confirmExportButton.textContent = "正在校验…";
  els.exportFailure.hidden = true;
  try {
    const result = await withProjectLock(async () => {
      const stored = readProjectRaw();
      if (!stored.ok || !stored.value) {
        return { ok: false, error: stored.reason || "共享项目不可读取" };
      }
      const latest = stored.value;
      if (latest.revision !== project.revision || latest.checksum !== project.checksum) {
        return { ok: false, error: "共享项目在打开弹窗后已变化，请同步后重试。" };
      }
      if (draftCount() > 0) {
        return { ok: false, error: "本页仍有未提交草稿，不能导出一致快照。" };
      }
      if (latest.conflicts.some((conflict) => conflict.status === "open")) {
        return { ok: false, error: "仍有未决冲突，不能导出一致快照。" };
      }
      updatePresence({ broadcast: false });
      const probe = await probeOtherTabs(latest.revision);
      if (!probe.ok) {
        return {
          ok: false,
          error: `有活动标签页未确认快照（${probe.missing.join("、")}），请稍后重试。`,
        };
      }
      const mismatched = probe.responses.filter(
        (response) =>
          response.revision !== latest.revision ||
          response.checksum !== latest.checksum ||
          response.dirty,
      );
      if (mismatched.length > 0) {
        return {
          ok: false,
          error: `标签页 ${mismatched
            .map((response) => response.label || response.source)
            .join("、")} 存在未提交草稿或修订不一致。`,
        };
      }
      const afterProbe = readProjectRaw();
      if (
        !afterProbe.ok ||
        !afterProbe.value ||
        afterProbe.value.revision !== latest.revision ||
        afterProbe.value.checksum !== latest.checksum
      ) {
        return { ok: false, error: "校验期间共享项目发生变化，请重试。" };
      }
      return {
        ok: true,
        snapshot: buildSnapshot(latest, probe.responses),
        probe,
      };
    });

    if (!result.ok) {
      els.exportFailure.textContent = `导出失败：${result.error} 当前可见编辑状态和草稿均已保留。`;
      els.exportFailure.hidden = false;
      els.exportReadiness.classList.add("is-blocked");
      els.exportReadiness.textContent = `导出已阻止：${result.error}`;
      toast(`导出失败：${result.error}`, true);
      renderExportReadiness();
      return;
    }
    downloadSnapshot(result.snapshot);
    sessionRestore.lastExport = {
      at: result.snapshot.exportedAt,
      revision: result.snapshot.project.revision,
      checksum: result.snapshot.project.checksum,
    };
    saveSession();
    renderExportReadiness();
    els.exportReadiness.classList.remove("is-blocked");
    els.exportReadiness.textContent = `快照已固定并下载：rev ${result.snapshot.project.revision} · ${result.snapshot.project.checksum.slice(0, 12)} · ${result.probe.responses.length + 1} 个标签页已确认。`;
    renderInspect();
    toast(`一致快照已下载 · rev ${result.snapshot.project.revision}`);
  } catch (error) {
    els.exportFailure.textContent = `导出失败：${error.message}。可读编辑状态仍保留。`;
    els.exportFailure.hidden = false;
    toast(`导出失败：${error.message}`, true);
  } finally {
    els.confirmExportButton.textContent = originalText;
    els.confirmExportButton.disabled = !evaluateReadiness().ready;
  }
}

function selectObject(objectId, { focus = false, scroll = false } = {}) {
  if (!getObject(objectId)) return;
  selectedId = objectId;
  saveSession();
  updatePresence({ broadcast: true });
  renderAll();
  if (focus) {
    $(`[data-object-id="${CSS.escape(objectId)}"]`, els.objectList)?.focus({
      preventScroll: true,
    });
  }
  if (scroll) {
    $(".editor-topline")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

function focusObjectByOffset(offset) {
  const buttons = $$("[data-object-id]", els.objectList);
  if (buttons.length === 0) return;
  const currentIndex = buttons.indexOf(document.activeElement);
  const nextIndex =
    currentIndex === -1
      ? 0
      : (currentIndex + offset + buttons.length) % buttons.length;
  buttons[nextIndex].focus();
  selectObject(buttons[nextIndex].dataset.objectId);
}

function rerenderFromExternalChange() {
  if (!project) return;
  if (!getObject()) selectedId = project.objects[0]?.id || null;
  renderAll();
  updatePresence({ broadcast: false });
}

function wireEvents() {
  els.objectList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-object-id]");
    if (!button) return;
    selectObject(button.dataset.objectId);
  });

  els.objectList.addEventListener("keydown", (event) => {
    if (event.altKey) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusObjectByOffset(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusObjectByOffset(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = $("[data-object-id]", els.objectList);
      if (first) {
        first.focus();
        selectObject(first.dataset.objectId);
      }
    } else if (event.key === "End") {
      event.preventDefault();
      const buttons = $$("[data-object-id]", els.objectList);
      const last = buttons.at(-1);
      if (last) {
        last.focus();
        selectObject(last.dataset.objectId);
      }
    }
  });

  els.objectSearch.addEventListener("input", renderObjectList);

  for (const [fieldName] of Object.entries(FIELDS)) {
    const input = $(`[data-field="${fieldName}"]`);
    input.addEventListener("input", () => updateDraftFromInput(fieldName));
    input.addEventListener("change", () => updateDraftFromInput(fieldName));
  }

  els.editorForm.addEventListener("submit", (event) => {
    event.preventDefault();
    commitSelected();
  });

  els.revertButton.addEventListener("click", revertDrafts);
  els.undoButton.addEventListener("click", undoLastCommit);
  els.exportButton.addEventListener("click", openExportDialog);
  els.addObjectButton.addEventListener("click", addObject);
  els.confirmExportButton.addEventListener("click", confirmExport);
  els.closeExportButton.addEventListener("click", (event) => {
    event.preventDefault();
    closeExportDialog();
  });
  els.exportDialog.addEventListener("close", () => {
    if (exportTrigger instanceof HTMLElement) {
      exportTrigger.focus({ preventScroll: true });
    }
  });

  els.conflictList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-conflict-id][data-resolution]");
    if (!button) return;
    resolveConflict(button.dataset.conflictId, button.dataset.resolution);
  });

  els.verifyResourcesButton.addEventListener("click", () => {
    const counts = claimCounts();
    const missing = project.resources.filter((resource) => !counts[resource.id]);
    const broken = project.objects.filter((object) =>
      (object.resourceIds || []).some(
        (resourceId) => !project.resources.some((resource) => resource.id === resourceId),
      ),
    );
    if (broken.length > 0) {
      toast(`资源检查失败：${broken.length} 个对象引用了不存在的资源`, true);
    } else if (missing.length > 0) {
      toast(`资源源文件仍在；${missing.length} 个资源当前无活动租约`);
    } else {
      toast("资源检查通过：所有对象引用完整，活动标签页租约有效");
    }
  });

  document.addEventListener("focusin", renderInspect);
  document.addEventListener("focusout", () => {
    queueMicrotask(renderInspect);
  });

  let scrollFrame = null;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        saveSession();
        renderInspect();
      });
    },
    { passive: true },
  );

  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      commitSelected();
    } else if (event.altKey && event.key.toLowerCase() === "e") {
      event.preventDefault();
      openExportDialog();
    } else if (event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoLastCommit();
    } else if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const objects = project?.objects || [];
      const current = objects.findIndex((object) => object.id === selectedId);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = objects[(Math.max(current, 0) + offset + objects.length) % objects.length];
      if (next) selectObject(next.id, { focus: true });
    }
  });

  window.addEventListener("pagehide", (event) => {
    saveSession();
    if (!event.persisted) {
      releaseResources();
      removeOwnPresence();
    }
  });

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      claimResources();
      updatePresence();
    }
  });

  window.addEventListener("online", () => {
    claimResources();
    updatePresence();
    syncProjectFromStore({ announce: true });
  });

  window.addEventListener("storage", (event) => {
    if (event.key === PROJECT_KEY) syncProjectFromStore({ announce: true });
    if (event.key?.startsWith(PEER_PREFIX)) {
      renderPeers();
      renderExportReadiness();
    }
    if (event.key?.startsWith(CLAIM_PREFIX)) renderResources();
  });

  channel?.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.source === tabId) return;
    if (message.type === "project-updated") {
      syncProjectFromStore({ announce: true });
    } else if (message.type === "presence") {
      renderPeers();
      renderExportReadiness();
    } else if (message.type === "resource-leases") {
      renderResources();
    } else if (message.type === "export-probe") {
      channel.postMessage({
        type: "export-probe-ack",
        requestId: message.requestId,
        source: tabId,
        label: tabLabel,
        revision: project?.revision || 0,
        checksum: project?.checksum || "",
        dirty: hasDrafts(),
        selectedId,
      });
    } else if (message.type === "export-probe-ack") {
      handleProbeResponse(message);
    }
  });
}

wireEvents();
initialize().catch((error) => {
  project ||= createSeedProject();
  selectedId ||= project.objects[0]?.id || null;
  storageProblem = `初始化失败：${error.message}`;
  backupRecovery(JSON.stringify(project, null, 2), storageProblem);
  ready = true;
  showRecoveryBanner();
  renderAll();
  toast("初始化失败；已显示最后可读快照", true);
});
