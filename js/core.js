(function () {
  "use strict";

  const CANVAS = Object.freeze({ width: 1200, height: 760 });
  const NODE_SIZE = Object.freeze({ width: 128, height: 58 });
  const GRID = 10;
  const DEFAULT_FILTER = Object.freeze({
    query: "",
    types: { gateway: true, router: true, terminal: true },
    minCapacity: 0
  });

  const TYPE_LABELS = { gateway: "网关", router: "路由器", terminal: "终端" };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function median(values, fallback) {
    const valid = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!valid.length) return fallback;
    const middle = Math.floor(valid.length / 2);
    return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
  }

  function hashText(text) {
    let first = 2166136261;
    let second = 5381;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 16777619);
      second = Math.imul(second ^ code, 33);
    }
    const left = (first >>> 0).toString(16).padStart(8, "0");
    const right = (second >>> 0).toString(16).padStart(8, "0");
    return (left + right).slice(0, 10).toUpperCase();
  }

  function graphFingerprint(nodes, links) {
    const nodeText = nodes
      .map((node) => [node.id, node.type, Math.round(node.x), Math.round(node.y), node.name].join(":"))
      .sort()
      .join("|");
    const linkText = links
      .map((link) => [
        link.id,
        link.source,
        link.target,
        Number(link.capacityMbps).toFixed(2),
        Number(link.latencyMs).toFixed(2)
      ].join(":"))
      .sort()
      .join("|");
    return hashText(nodeText + "::" + linkText);
  }

  function graphMetrics(nodes, links) {
    return {
      nodeCount: nodes.length,
      linkCount: links.length,
      endpointCount: links.length * 2,
      totalCapacityMbps: Number(links.reduce((sum, link) => sum + link.capacityMbps, 0).toFixed(2)),
      totalLatencyMs: Number(links.reduce((sum, link) => sum + link.latencyMs, 0).toFixed(2)),
      fingerprint: graphFingerprint(nodes, links)
    };
  }

  function nearestFreePosition(index, occupied) {
    const candidates = [];
    for (let y = 140; y <= 620; y += 80) {
      for (let x = 180; x <= 1050; x += 55) candidates.push({ x, y });
    }
    const ranked = candidates
      .map((point) => {
        let nearest = Infinity;
        occupied.forEach((node) => {
          nearest = Math.min(nearest, Math.hypot(node.x - point.x, node.y - point.y));
        });
        return { ...point, score: nearest + (point.y === 380 ? 20 : 0) };
      })
      .sort((a, b) => b.score - a.score);
    return ranked[index % Math.min(ranked.length, 80)] || { x: 800, y: 380 };
  }

  function normalizeNode(raw, index, occupied, quality, logs, fallbackName) {
    const problems = [];
    const rawId = raw && raw.id != null ? String(raw.id).trim() : "";
    const id = rawId || `AUTO-NODE-${String(index + 1).padStart(2, "0")}`;
    if (!rawId) problems.push("missing-id");

    let type = raw && raw.type;
    if (!TYPE_LABELS[type]) {
      problems.push("invalid-type");
      type = "terminal";
    }

    let name = raw && raw.name != null ? String(raw.name).trim() : "";
    if (!name) {
      name = `${fallbackName || TYPE_LABELS[type]} ${id.slice(-2)}`;
      quality.nullFields += 1;
      problems.push("null-name");
    }

    let x = raw && raw.x != null ? Number(raw.x) : null;
    let y = raw && raw.y != null ? Number(raw.y) : null;
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      const fallback = nearestFreePosition(index, occupied);
      x = fallback.x;
      y = fallback.y;
      quality.anomalies += 1;
      problems.push("missing-position");
      if (raw && raw.x == null) quality.nullFields += 1;
      if (raw && raw.y == null) quality.nullFields += 1;
    } else {
      const clampedX = Math.max(70, Math.min(CANVAS.width - 70, x));
      const clampedY = Math.max(58, Math.min(CANVAS.height - 58, y));
      if (clampedX !== x || clampedY !== y) {
        quality.anomalies += 1;
        problems.push("position-clamped");
        quality.clampedRecords += 1;
      }
      x = clampedX;
      y = clampedY;
    }

    let ip = raw && raw.ip != null ? String(raw.ip).trim() : "";
    if (!ip) {
      ip = "未上报";
      quality.nullFields += 1;
      problems.push("null-ip");
    }

    let status = raw && raw.status;
    if (status !== "up" && status !== "degraded") {
      status = "up";
      if (raw && raw.status != null) quality.anomalies += 1;
      problems.push("invalid-status");
    }

    if (problems.length) {
      logs.push({
        level: problems.includes("position-clamped") || problems.includes("invalid-type") ? "warn" : "info",
        code: "NODE",
        text: `${id} · ${problems.join(", ")} → ${name}, ${Math.round(x)},${Math.round(y)}`
      });
    }

    return {
      id,
      type,
      name,
      x,
      y,
      zone: raw && raw.zone ? String(raw.zone) : TYPE_LABELS[type] + "区",
      status,
      model: raw && raw.model ? String(raw.model) : "未上报",
      ip
    };
  }

  function linkKey(source, target) {
    return [source, target].sort().join("::");
  }

  function normalizeLink(raw, index, nodeIds, capacityFallback, latencyFallback, quality, logs) {
    const id = raw && raw.id != null ? String(raw.id).trim() : `AUTO-LINK-${index + 1}`;
    const source = raw && raw.source != null ? String(raw.source) : "";
    const target = raw && raw.target != null ? String(raw.target) : "";
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) {
      quality.invalidLinks += 1;
      quality.droppedRecords += 1;
      logs.push({
        level: "err",
        code: "LINK",
        text: `${id} · 端点无效 (${source || "∅"} → ${target || "∅"})，整条记录已丢弃`
      });
      return null;
    }

    const problems = [];
    let capacity = raw && raw.capacityMbps != null ? Number(raw.capacityMbps) : null;
    if (capacity == null || !Number.isFinite(capacity)) {
      capacity = capacityFallback;
      quality.nullFields += 1;
      problems.push(`容量空值→中位数 ${capacity}`);
    } else if (capacity < 10) {
      capacity = 10;
      quality.anomalies += 1;
      problems.push("容量越界→10 Mbps");
    } else if (capacity > 100000) {
      capacity = 100000;
      quality.anomalies += 1;
      problems.push("容量超限→100 Gbps");
    }

    let latency = raw && raw.latencyMs != null ? Number(raw.latencyMs) : null;
    if (latency == null || !Number.isFinite(latency)) {
      latency = latencyFallback;
      quality.nullFields += 1;
      problems.push(`延迟空值→中位数 ${latency} ms`);
    } else if (latency < 0.1) {
      latency = 0.1;
      quality.anomalies += 1;
      problems.push("延迟为负或过小→0.1 ms");
    } else if (latency > 999) {
      latency = 999;
      quality.anomalies += 1;
      problems.push("延迟异常→999 ms");
    }

    capacity = Math.round(capacity);
    latency = Number(latency.toFixed(1));
    if (problems.length) {
      quality.clampedRecords += 1;
      logs.push({
        level: "warn",
        code: "LINK",
        text: `${id} · ${problems.join("；")}`
      });
    }

    return {
      id,
      source,
      target,
      capacityMbps: capacity,
      latencyMs: latency,
      status: raw && raw.status === "degraded" ? "degraded" : "up"
    };
  }

  function parseTopology(sample) {
    const quality = {
      rawNodes: sample.nodes.length,
      rawLinks: sample.links.length,
      duplicateNodes: 0,
      duplicateLinks: 0,
      invalidLinks: 0,
      nullFields: 0,
      anomalies: 0,
      droppedRecords: 0,
      clampedRecords: 0
    };
    const logs = [];
    const nodes = [];
    const seenNodeIds = new Set();

    sample.nodes.forEach((raw, index) => {
      const id = raw && raw.id != null ? String(raw.id).trim() : "";
      if (id && seenNodeIds.has(id)) {
        quality.duplicateNodes += 1;
        quality.droppedRecords += 1;
        logs.push({ level: "warn", code: "DEDUP", text: `${id} · 重复节点记录已忽略，保留首次出现` });
        return;
      }
      const node = normalizeNode(raw, index, nodes, quality, logs, sample.code === "B" ? "监控终端" : "终端设备");
      if (seenNodeIds.has(node.id)) {
        quality.duplicateNodes += 1;
        quality.droppedRecords += 1;
        logs.push({ level: "warn", code: "DEDUP", text: `${node.id} · 规范化后 ID 重复，已忽略` });
        return;
      }
      seenNodeIds.add(node.id);
      nodes.push(node);
    });

    const nodeIds = new Set(nodes.map((node) => node.id));
    const validCapacities = sample.links
      .map((link) => Number(link.capacityMbps))
      .filter((value) => Number.isFinite(value) && value >= 10 && value <= 100000);
    const validLatencies = sample.links
      .map((link) => Number(link.latencyMs))
      .filter((value) => Number.isFinite(value) && value >= 0.1 && value <= 999);
    const capacityFallback = Math.round(median(validCapacities, 10000));
    const latencyFallback = Number(median(validLatencies, 1).toFixed(1));

    const links = [];
    const seenLinkIds = new Set();
    const seenPairs = new Map();
    sample.links.forEach((raw, index) => {
      const id = raw && raw.id != null ? String(raw.id).trim() : "";
      const pair = raw ? linkKey(String(raw.source), String(raw.target)) : "";
      if (id && seenLinkIds.has(id)) {
        quality.duplicateLinks += 1;
        quality.droppedRecords += 1;
        logs.push({ level: "warn", code: "DEDUP", text: `${id} · 重复链路记录已忽略` });
        return;
      }
      if (pair && seenPairs.has(pair) && seenPairs.get(pair) === id) {
        quality.duplicateLinks += 1;
        quality.droppedRecords += 1;
        logs.push({ level: "warn", code: "DEDUP", text: `${id} · 相同端点与 ID 的链路记录已忽略` });
        return;
      }
      const link = normalizeLink(raw, index, nodeIds, capacityFallback, latencyFallback, quality, logs);
      if (!link) return;
      if (seenLinkIds.has(link.id)) {
        quality.duplicateLinks += 1;
        quality.droppedRecords += 1;
        logs.push({ level: "warn", code: "DEDUP", text: `${link.id} · 规范化后链路 ID 重复，已忽略` });
        return;
      }
      seenLinkIds.add(link.id);
      seenPairs.set(pair, link.id);
      links.push(link);
    });

    logs.unshift({
      level: "ok",
      code: "INGEST",
      text: `${sample.code} 样例读取 ${quality.rawNodes} 节点 / ${quality.rawLinks} 链路；中位数基线 ${capacityFallback} Mbps / ${latencyFallback} ms`
    });
    logs.push({
      level: "ok",
      code: "CLEAN",
      text: `有效 ${nodes.length} 节点 / ${links.length} 链路 · 丢弃 ${quality.droppedRecords} · 空值 ${quality.nullFields} · 异常 ${quality.anomalies}`
    });

    return {
      nodes,
      links,
      routes: clone(sample.routes),
      quality,
      qualityLogs: logs,
      capacityFallback,
      latencyFallback
    };
  }

  function normalizeFilter(filter) {
    const source = filter || {};
    return {
      query: typeof source.query === "string" ? source.query : "",
      types: {
        gateway: source.types ? source.types.gateway !== false : true,
        router: source.types ? source.types.router !== false : true,
        terminal: source.types ? source.types.terminal !== false : true
      },
      minCapacity: Number.isFinite(Number(source.minCapacity)) ? Math.max(0, Number(source.minCapacity)) : 0
    };
  }

  function visibleTopology(project, filter) {
    const activeFilter = normalizeFilter(filter);
    const query = activeFilter.query.trim().toLowerCase();
    const nodes = project.nodes.filter((node) => {
      if (!activeFilter.types[node.type]) return false;
      if (!query) return true;
      return [node.id, node.name, node.zone, node.model, node.ip]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const links = project.links.filter(
      (link) => nodeIds.has(link.source) && nodeIds.has(link.target) && link.capacityMbps >= activeFilter.minCapacity
    );
    return { nodes, links, filter: activeFilter, nodeIds, linkIds: new Set(links.map((link) => link.id)) };
  }

  function filterLabel(filter, visible, project) {
    const active = normalizeFilter(filter);
    const queryText = active.query.trim() ? `“${active.query.trim()}”` : "无搜索";
    const hiddenTypes = Object.entries(active.types)
      .filter(([, activeType]) => !activeType)
      .map(([type]) => TYPE_LABELS[type]);
    const typeText = hiddenTypes.length ? `隐藏 ${hiddenTypes.join("/")}` : "全部类型";
    const capacityText = active.minCapacity > 0 ? `容量 ≥ ${formatCapacity(active.minCapacity)}` : "容量不限";
    return `${queryText} · ${typeText} · ${capacityText} · ${visible.nodes.length}/${project.nodes.length} 节点`;
  }

  function findBestLink(project, source, target, visibleLinkIds) {
    const candidates = project.links
      .filter((link) => {
        const connects =
          (link.source === source && link.target === target) ||
          (link.source === target && link.target === source);
        if (!connects) return false;
        return !visibleLinkIds || visibleLinkIds.has(link.id);
      })
      .sort((a, b) => a.latencyMs - b.latencyMs || b.capacityMbps - a.capacityMbps);
    return candidates[0] || null;
  }

  function analyzeRoute(project, route, filter) {
    const visible = filter ? visibleTopology(project, filter) : null;
    const nodeMap = new Map(project.nodes.map((node) => [node.id, node]));
    const missingNodes = route.nodeIds.filter((id) => !nodeMap.has(id));
    const hiddenNodes = visible ? route.nodeIds.filter((id) => nodeMap.has(id) && !visible.nodeIds.has(id)) : [];
    const chosenLinks = [];
    const missingHops = [];

    for (let index = 0; index < route.nodeIds.length - 1; index += 1) {
      const source = route.nodeIds[index];
      const target = route.nodeIds[index + 1];
      const link = findBestLink(project, source, target, visible ? visible.linkIds : null);
      if (link) chosenLinks.push(link);
      else missingHops.push(`${source} → ${target}`);
    }

    const available = missingNodes.length === 0 && hiddenNodes.length === 0 && missingHops.length === 0;
    const totalLatency = Number(chosenLinks.reduce((sum, link) => sum + link.latencyMs, 0).toFixed(1));
    const bottleneck = chosenLinks.length ? Math.min(...chosenLinks.map((link) => link.capacityMbps)) : 0;
    let reason = "";
    if (missingNodes.length) reason = `节点不存在：${missingNodes.join(", ")}`;
    else if (hiddenNodes.length) reason = `被当前筛选隐藏 ${hiddenNodes.length} 个节点`;
    else if (missingHops.length) reason = `链路中断：${missingHops.join("；")}`;

    return {
      ...route,
      available,
      reason,
      nodeIds: route.nodeIds.filter((id) => nodeMap.has(id)),
      linkIds: chosenLinks.map((link) => link.id),
      links: chosenLinks,
      totalLatency,
      bottleneck,
      hops: route.nodeIds.length - 1
    };
  }

  class MinHeap {
    constructor() {
      this.items = [];
    }

    push(item) {
      this.items.push(item);
      let index = this.items.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.items[parent].priority <= item.priority) break;
        this.items[index] = this.items[parent];
        index = parent;
      }
      this.items[index] = item;
    }

    pop() {
      if (!this.items.length) return null;
      const root = this.items[0];
      const last = this.items.pop();
      if (this.items.length) {
        let index = 0;
        this.items[0] = last;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < this.items.length && this.items[left].priority < this.items[smallest].priority) smallest = left;
          if (right < this.items.length && this.items[right].priority < this.items[smallest].priority) smallest = right;
          if (smallest === index) break;
          [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
          index = smallest;
        }
      }
      return root;
    }

    get size() {
      return this.items.length;
    }
  }

  function shortestPath(project, source, target, visibleLinkIds) {
    const adjacency = new Map(project.nodes.map((node) => [node.id, []]));
    project.links.forEach((link) => {
      if (visibleLinkIds && !visibleLinkIds.has(link.id)) return;
      if (!adjacency.has(link.source) || !adjacency.has(link.target)) return;
      adjacency.get(link.source).push({ node: link.target, link });
      adjacency.get(link.target).push({ node: link.source, link });
    });
    if (!adjacency.has(source) || !adjacency.has(target)) {
      return { available: false, reason: "端点不存在", nodeIds: [], linkIds: [], totalLatency: 0 };
    }
    const distances = new Map([[source, 0]]);
    const previous = new Map();
    const heap = new MinHeap();
    heap.push({ value: source, priority: 0 });
    while (heap.size) {
      const current = heap.pop();
      if (current.value === target) break;
      if (current.priority > (distances.get(current.value) ?? Infinity)) continue;
      adjacency.get(current.value).forEach((edge) => {
        const nextDistance = current.priority + edge.link.latencyMs;
        if (nextDistance < (distances.get(edge.node) ?? Infinity)) {
          distances.set(edge.node, nextDistance);
          previous.set(edge.node, { node: current.value, link: edge.link });
          heap.push({ value: edge.node, priority: nextDistance });
        }
      });
    }
    if (!distances.has(target)) {
      return { available: false, reason: "无可达路径", nodeIds: [], linkIds: [], totalLatency: 0 };
    }
    const nodeIds = [target];
    const links = [];
    let cursor = target;
    while (cursor !== source) {
      const step = previous.get(cursor);
      if (!step) break;
      links.unshift(step.link);
      nodeIds.unshift(step.node);
      cursor = step.node;
    }
    return {
      available: true,
      nodeIds,
      linkIds: links.map((link) => link.id),
      links,
      totalLatency: Number(distances.get(target).toFixed(1)),
      explored: distances.size
    };
  }

  function removeNodeAndLinks(project, nodeId) {
    const removedLinks = project.links.filter((link) => link.source === nodeId || link.target === nodeId);
    return {
      project: {
        ...clone(project),
        nodes: project.nodes.filter((node) => node.id !== nodeId).map(clone),
        links: project.links
          .filter((link) => link.source !== nodeId && link.target !== nodeId)
          .map(clone)
      },
      removedLinks,
      removedNode: project.nodes.find((node) => node.id === nodeId) || null
    };
  }

  function autoLayoutNodes(project) {
    const grouped = { gateway: [], router: [], terminal: [] };
    project.nodes.forEach((node) => grouped[node.type].push(node));
    Object.values(grouped).forEach((items) => items.sort((a, b) => a.id.localeCompare(b.id)));
    const positions = {
      gateway: { x: 105, ys: [380] },
      router: { x: 0, ys: [145, 245, 380, 515, 615] },
      terminal: { x: 1040, ys: [145, 380, 615] }
    };
    const routerColumns = [330, 580, 825];
    const nextPosition = { gateway: 0, router: 0, terminal: 0 };
    const nodes = project.nodes.map((node) => {
      const copy = clone(node);
      if (node.type === "gateway") {
        const positionIndex = nextPosition.gateway;
        copy.x = positions.gateway.x;
        copy.y = positions.gateway.ys[positionIndex] || 380;
        nextPosition.gateway += 1;
      } else if (node.type === "router") {
        const positionIndex = nextPosition.router;
        copy.x = routerColumns[Math.min(2, Math.floor(positionIndex / 5))];
        copy.y = positions.router.ys[positionIndex % 5];
        nextPosition.router += 1;
      } else {
        const positionIndex = nextPosition.terminal;
        copy.x = positions.terminal.x;
        copy.y = positions.terminal.ys[positionIndex] || 145 + (positionIndex % 5) * 130;
        nextPosition.terminal += 1;
      }
      return copy;
    });
    return { ...clone(project), nodes };
  }

  function segmentIntersectsRect(x1, y1, x2, y2, rect) {
    let t0 = 0;
    let t1 = 1;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const checks = [
      [-dx, x1 - rect.x],
      [dx, rect.x + rect.width - x1],
      [-dy, y1 - rect.y],
      [dy, rect.y + rect.height - y1]
    ];
    for (const [p, q] of checks) {
      if (Math.abs(p) < 1e-8) {
        if (q < 0) return false;
      } else {
        const ratio = q / p;
        if (p < 0) {
          if (ratio > t1) return false;
          if (ratio > t0) t0 = ratio;
        } else {
          if (ratio < t0) return false;
          if (ratio < t1) t1 = ratio;
        }
      }
    }
    return true;
  }

  function obstacleFor(node, padding) {
    return {
      x: node.x - NODE_SIZE.width / 2 - padding,
      y: node.y - NODE_SIZE.height / 2 - padding,
      width: NODE_SIZE.width + padding * 2,
      height: NODE_SIZE.height + padding * 2
    };
  }

  function simplifyPoints(points) {
    const deduped = [];
    points.forEach((point) => {
      const rounded = { x: Math.round(point.x), y: Math.round(point.y) };
      const last = deduped[deduped.length - 1];
      if (!last || last.x !== rounded.x || last.y !== rounded.y) deduped.push(rounded);
    });
    const simplified = [];
    deduped.forEach((point, index) => {
      if (index === 0 || index === deduped.length - 1) {
        simplified.push(point);
        return;
      }
      const previous = deduped[index - 1];
      const next = deduped[index + 1];
      const cross = (point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x);
      if (Math.abs(cross) > 0.01) simplified.push(point);
    });
    return simplified;
  }

  function buildBlockedCells(obstacles) {
    const blocked = new Set();
    obstacles.forEach((rect) => {
      const minX = Math.max(1, Math.floor(rect.x / GRID));
      const maxX = Math.min(CANVAS.width / GRID - 2, Math.ceil((rect.x + rect.width) / GRID));
      const minY = Math.max(1, Math.floor(rect.y / GRID));
      const maxY = Math.min(CANVAS.height / GRID - 2, Math.ceil((rect.y + rect.height) / GRID));
      for (let cellX = minX; cellX <= maxX; cellX += 1) {
        for (let cellY = minY; cellY <= maxY; cellY += 1) {
          const px = cellX * GRID;
          const py = cellY * GRID;
          if (px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height) {
            blocked.add(`${cellX},${cellY}`);
          }
        }
      }
    });
    return blocked;
  }

  function routeAroundObstacles(source, target, obstacles) {
    const startX = Math.round(source.x / GRID);
    const startY = Math.round(source.y / GRID);
    const goalX = Math.round(target.x / GRID);
    const goalY = Math.round(target.y / GRID);
    if (startX === goalX && startY === goalY) {
      return { points: [{ x: source.x, y: source.y }, { x: target.x, y: target.y }], iterations: 0, detoured: false };
    }
    const blocked = buildBlockedCells(obstacles);
    const directions = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0]
    ];
    const startKey = `${startX},${startY},4`;
    const startNeighborsBlocked = directions.map(([dx, dy]) => blocked.has(`${startX + dx},${startY + dy}`));
    const distances = new Map([[startKey, 0]]);
    const states = new Map([[startKey, { x: startX, y: startY, dir: 4, prev: null }]]);
    const heap = new MinHeap();
    heap.push({ key: startKey, priority: 0, g: 0 });
    let goalKey = null;
    let iterations = 0;
    const visitTrace = [];
    const maxX = Math.floor(CANVAS.width / GRID) - 1;
    const maxY = Math.floor(CANVAS.height / GRID) - 1;

    while (heap.size && iterations < 50000) {
      iterations += 1;
      const current = heap.pop();
      if (current.g > (distances.get(current.key) ?? Infinity)) continue;
      const state = states.get(current.key);
      if (visitTrace.length < 12) visitTrace.push(`${state.x},${state.y},${state.dir}`);
      if (state.x === goalX && state.y === goalY) {
        goalKey = current.key;
        break;
      }
      directions.forEach(([dx, dy], direction) => {
        const nextX = state.x + dx;
        const nextY = state.y + dy;
        if (nextX < 1 || nextY < 1 || nextX > maxX || nextY > maxY) return;
        const isGoal = nextX === goalX && nextY === goalY;
        if (!isGoal && blocked.has(`${nextX},${nextY}`)) return;
        const turnCost = state.dir !== 4 && state.dir !== direction ? 4.2 : 0;
        const nextDistance = current.priority + GRID + turnCost;
        const nextKey = `${nextX},${nextY},${direction}`;
        if (nextDistance >= (distances.get(nextKey) ?? Infinity)) return;
        distances.set(nextKey, nextDistance);
        states.set(nextKey, { x: nextX, y: nextY, dir: direction, prev: current.key });
        const heuristic = (Math.abs(goalX - nextX) + Math.abs(goalY - nextY)) * GRID;
        heap.push({ key: nextKey, priority: nextDistance + heuristic, g: nextDistance });
      });
    }

    if (!goalKey) {
      return {
        points: [{ x: source.x, y: source.y }, { x: target.x, y: target.y }],
        iterations,
        detoured: true,
        failed: true,
        blockedCells: blocked.size,
        startCell: { x: startX, y: startY },
        goalCell: { x: goalX, y: goalY },
        expandedStates: states.size,
        startNeighborsBlocked,
        visitTrace
      };
    }
    const cellPoints = [];
    let cursor = goalKey;
    while (cursor) {
      const state = states.get(cursor);
      cellPoints.unshift({ x: state.x * GRID, y: state.y * GRID });
      cursor = state.prev;
    }
    cellPoints[0] = { x: source.x, y: source.y };
    cellPoints[cellPoints.length - 1] = { x: target.x, y: target.y };
    return {
      points: simplifyPoints(cellPoints),
      iterations,
      detoured: true,
      failed: false,
      blockedCells: blocked.size,
      startCell: { x: startX, y: startY },
      goalCell: { x: goalX, y: goalY },
      expandedStates: states.size,
      startNeighborsBlocked,
      visitTrace
    };
  }

  function planLinkPaths(nodes, links) {
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const nodeRects = nodes.map((node) => ({
      node,
      padded: obstacleFor(node, 12),
      labelPadded: obstacleFor(node, 7)
    }));
    const usedLabels = [];
    const paths = new Map();
    let detourCount = 0;
    let totalPoints = 0;

    links.forEach((link) => {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (!source || !target) return;
      const obstacles = nodeRects
        .filter(({ node }) => node.id !== source.id && node.id !== target.id)
        .map(({ padded }) => padded);
      const directClear = !obstacles.some((rect) =>
        segmentIntersectsRect(source.x, source.y, target.x, target.y, rect)
      );
      let result;
      if (directClear) {
        result = {
          points: simplifyPoints([
            { x: source.x, y: source.y },
            { x: target.x, y: target.y }
          ]),
          iterations: 0,
          detoured: false,
          failed: false
        };
      } else {
        result = routeAroundObstacles(source, target, obstacles);
        if (result.detoured) detourCount += 1;
      }
      totalPoints += result.points.length;
      const segments = [];
      for (let index = 0; index < result.points.length - 1; index += 1) {
        const start = result.points[index];
        const end = result.points[index + 1];
        segments.push({ start, end, length: Math.hypot(end.x - start.x, end.y - start.y) });
      }
      const candidates = [];
      segments
        .sort((a, b) => b.length - a.length)
        .forEach((segment) => {
          [0.5, 0.34, 0.66].forEach((ratio) => {
            candidates.push({
              x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
              y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
              length: segment.length
            });
          });
        });
      const labelWidth = 108;
      const labelHeight = 18;
      let label = candidates[0] || { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
      const isFree = (point) => {
        const rect = { x: point.x - labelWidth / 2, y: point.y - labelHeight / 2, width: labelWidth, height: labelHeight };
        if (rect.x < 8 || rect.y < 8 || rect.x + rect.width > CANVAS.width - 8 || rect.y + rect.height > CANVAS.height - 8) return false;
        const hitsNode = nodeRects.some(({ labelPadded }) => segmentIntersectsRect(
          rect.x,
          rect.y,
          rect.x + rect.width,
          rect.y + rect.height,
          labelPadded
        ));
        if (hitsNode) return false;
        return !usedLabels.some((other) => !(
          rect.x + rect.width < other.x ||
          other.x + other.width < rect.x ||
          rect.y + rect.height < other.y ||
          other.y + other.height < rect.y
        ));
      };
      const free = candidates.find(isFree);
      if (free) label = free;
      usedLabels.push({ x: label.x - labelWidth / 2, y: label.y - labelHeight / 2, width: labelWidth, height: labelHeight });
      const pathText = result.points
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
        .join(" ");
      paths.set(link.id, {
        points: result.points,
        pathText,
        label,
        detoured: result.detoured,
        iterations: result.iterations,
        failed: Boolean(result.failed),
        blockedCells: result.blockedCells || 0,
        expandedStates: result.expandedStates || 0,
        startNeighborsBlocked: result.startNeighborsBlocked || [],
        visitTrace: result.visitTrace || [],
        bendCount: Math.max(0, result.points.length - 2)
      });
    });

    return {
      paths,
      stats: {
        detourCount,
        straightCount: links.length - detourCount,
        averagePoints: links.length ? Number((totalPoints / links.length).toFixed(2)) : 0,
        nodeObstacles: nodes.length
      }
    };
  }

  function formatCapacity(mbps) {
    const value = Number(mbps);
    if (value >= 1000) {
      const gbps = value / 1000;
      return `${Number.isInteger(gbps) ? gbps : gbps.toFixed(1)}G`;
    }
    return `${Math.round(value)}M`;
  }

  function formatLatency(ms) {
    return `${Number(ms).toFixed(1)}ms`;
  }

  function buildProjectFromSample(sample, dataVersion) {
    const parsed = parseTopology(sample);
    return {
      kind: "topoforge-project",
      formatVersion: "2.1",
      projectId: `tf-${sample.id}-${Date.now().toString(36)}`,
      name: sample.projectName,
      description: sample.description,
      sourceSampleId: sample.id,
      sampleCode: sample.code,
      dataVersion: Number(dataVersion || 1),
      savedAt: new Date().toISOString(),
      nodes: parsed.nodes,
      links: parsed.links,
      routes: parsed.routes,
      quality: parsed.quality,
      qualityLogs: parsed.qualityLogs,
      capacityFallback: parsed.capacityFallback,
      latencyFallback: parsed.latencyFallback,
      filter: clone(DEFAULT_FILTER)
    };
  }

  function serializeProject(project, filter) {
    return {
      kind: "topoforge-project",
      formatVersion: "2.1",
      projectId: project.projectId,
      name: project.name,
      description: project.description,
      sourceSampleId: project.sourceSampleId,
      sampleCode: project.sampleCode,
      dataVersion: project.dataVersion,
      savedAt: new Date().toISOString(),
      nodes: project.nodes.map(clone),
      links: project.links.map(clone),
      routes: project.routes.map(clone),
      quality: clone(project.quality),
      qualityLogs: project.qualityLogs.map(clone),
      capacityFallback: project.capacityFallback,
      latencyFallback: project.latencyFallback,
      filter: normalizeFilter(filter || project.filter)
    };
  }

  function hydrateProject(input) {
    if (!input || typeof input !== "object") throw new Error("工程内容为空");
    if (!Array.isArray(input.nodes) || !Array.isArray(input.links)) {
      throw new Error("工程缺少 nodes 或 links 数组");
    }
    const nodeIds = new Set();
    const nodes = input.nodes.map((raw, index) => {
      if (!raw || !raw.id) throw new Error(`第 ${index + 1} 个节点缺少 id`);
      if (nodeIds.has(String(raw.id))) throw new Error(`节点 ID 重复：${raw.id}`);
      if (!TYPE_LABELS[raw.type]) throw new Error(`节点类型无效：${raw.id}`);
      const x = Number(raw.x);
      const y = Number(raw.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`节点坐标无效：${raw.id}`);
      nodeIds.add(String(raw.id));
      return {
        ...clone(raw),
        id: String(raw.id),
        name: raw.name == null ? `未命名${TYPE_LABELS[raw.type]}` : String(raw.name),
        x,
        y,
        status: raw.status === "degraded" ? "degraded" : "up"
      };
    });
    const linkIds = new Set();
    const links = input.links.map((raw, index) => {
      if (!raw || !raw.id) throw new Error(`第 ${index + 1} 条链路缺少 id`);
      if (linkIds.has(String(raw.id))) throw new Error(`链路 ID 重复：${raw.id}`);
      if (!nodeIds.has(String(raw.source)) || !nodeIds.has(String(raw.target))) {
        throw new Error(`链路 ${raw.id} 的端点不存在`);
      }
      const capacity = Number(raw.capacityMbps);
      const latency = Number(raw.latencyMs);
      if (!Number.isFinite(capacity) || !Number.isFinite(latency)) {
        throw new Error(`链路 ${raw.id} 的容量或延迟无效`);
      }
      linkIds.add(String(raw.id));
      return {
        ...clone(raw),
        id: String(raw.id),
        source: String(raw.source),
        target: String(raw.target),
        capacityMbps: capacity,
        latencyMs: latency
      };
    });
    const routes = Array.isArray(input.routes)
      ? input.routes
          .filter((route) => route && Array.isArray(route.nodeIds) && route.nodeIds.length > 1)
          .map((route) => ({
            id: String(route.id || `route-${hashText(route.nodeIds.join("|"))}`),
            name: String(route.name || "未命名路径"),
            kind: route.kind === "backup" ? "backup" : "primary",
            nodeIds: route.nodeIds.map(String)
          }))
      : [];
    return {
      kind: "topoforge-project",
      formatVersion: String(input.formatVersion || "2.1"),
      projectId: input.projectId || `tf-import-${Date.now().toString(36)}`,
      name: input.name || "已载入拓扑工程",
      description: input.description || "从文件载入的拓扑工程",
      sourceSampleId: input.sourceSampleId || "imported",
      sampleCode: input.sampleCode || "I",
      dataVersion: Number.isFinite(Number(input.dataVersion)) ? Number(input.dataVersion) : 1,
      savedAt: input.savedAt || new Date().toISOString(),
      nodes,
      links,
      routes,
      quality: input.quality
        ? clone(input.quality)
        : {
            rawNodes: nodes.length,
            rawLinks: links.length,
            duplicateNodes: 0,
            duplicateLinks: 0,
            invalidLinks: 0,
            nullFields: 0,
            anomalies: 0,
            droppedRecords: 0,
            clampedRecords: 0
          },
      qualityLogs: Array.isArray(input.qualityLogs) ? input.qualityLogs.map(clone) : [],
      capacityFallback: Number(input.capacityFallback) || 10000,
      latencyFallback: Number(input.latencyFallback) || 1,
      filter: normalizeFilter(input.filter)
    };
  }

  function createTopologyExport(project, filter) {
    const visible = visibleTopology(project, filter);
    const routes = project.routes.map((route) => {
      const analyzed = analyzeRoute(project, route, visible.filter);
      return {
        id: analyzed.id,
        name: analyzed.name,
        kind: analyzed.kind,
        nodeIds: analyzed.nodeIds,
        linkIds: analyzed.linkIds,
        totalLatencyMs: analyzed.totalLatency,
        bottleneckCapacityMbps: analyzed.bottleneck,
        available: analyzed.available,
        reason: analyzed.reason
      };
    });
    const metrics = graphMetrics(visible.nodes, visible.links);
    const backupRoutes = routes.filter((route) => route.kind === "backup");
    return {
      kind: "topoforge-topology-export",
      schemaVersion: "1.0.0",
      exportedAt: new Date().toISOString(),
      dataVersion: project.dataVersion,
      source: {
        projectId: project.projectId,
        projectName: project.name,
        sampleCode: project.sampleCode,
        sampleId: project.sourceSampleId
      },
      exportScope: {
        type: "filtered-full-topology",
        label: "当前筛选后的全拓扑",
        excludesViewportCropping: true,
        excludesSelectionState: true,
        precision: { capacity: "integer Mbps", latency: "0.1 ms" }
      },
      filter: {
        query: visible.filter.query,
        types: clone(visible.filter.types),
        minCapacityMbps: visible.filter.minCapacity,
        summary: filterLabel(visible.filter, visible, project)
      },
      nodes: visible.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        name: node.name,
        x: Math.round(node.x),
        y: Math.round(node.y),
        zone: node.zone,
        status: node.status,
        model: node.model,
        ip: node.ip
      })),
      links: visible.links.map((link) => ({
        id: link.id,
        source: link.source,
        target: link.target,
        capacityMbps: link.capacityMbps,
        latencyMs: link.latencyMs,
        status: link.status
      })),
      routes,
      stats: {
        ...metrics,
        backupRouteCount: backupRoutes.length,
        availableBackupRouteCount: backupRoutes.filter((route) => route.available).length,
        pathLatencyMs: Object.fromEntries(routes.map((route) => [route.id, route.totalLatencyMs]))
      },
      dataQuality: clone(project.quality)
    };
  }

  function runWorkflowVerification(project, filter) {
    const steps = [];
    const addStep = (tag, text, pass, detail) => {
      steps.push({ tag, text, pass: Boolean(pass), detail: detail || "" });
    };
    const before = graphMetrics(project.nodes, project.links);
    const allRoutes = project.routes.map((route) => analyzeRoute(project, route));
    const backupRoutes = allRoutes.filter((route) => route.kind === "backup");
    const backupsAvailable = backupRoutes.length === 2 && backupRoutes.every((route) => route.available);
    addStep("ROUTES", `主路径 + 备用路径 ${backupRoutes.length}/2 可达`, backupsAvailable, backupRoutes.map((route) => route.totalLatency).join(" / "));

    const protectedIds = new Set(project.routes.flatMap((route) => route.nodeIds));
    const degree = new Map();
    project.links.forEach((link) => {
      degree.set(link.source, (degree.get(link.source) || 0) + 1);
      degree.set(link.target, (degree.get(link.target) || 0) + 1);
    });
    const candidate = project.nodes
      .filter((node) => !protectedIds.has(node.id) && (degree.get(node.id) || 0) > 0)
      .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))[0];
    const deletionNode = candidate || project.nodes.find((node) => node.type === "terminal") || project.nodes[0];
    const incident = deletionNode ? degree.get(deletionNode.id) || 0 : 0;
    const deletion = deletionNode ? removeNodeAndLinks(project, deletionNode.id) : null;
    const deletedMetrics = deletion ? graphMetrics(deletion.project.nodes, deletion.project.links) : before;
    const deletionPass = Boolean(
      deletionNode &&
      deletedMetrics.nodeCount === before.nodeCount - 1 &&
      deletedMetrics.linkCount === before.linkCount - incident &&
      deletion.removedLinks.length === incident
    );
    addStep(
      "DELETE",
      `删除 ${deletionNode ? deletionNode.id : "∅"}：节点 ${before.nodeCount}→${deletedMetrics.nodeCount}，链路 ${before.linkCount}→${deletedMetrics.linkCount}`,
      deletionPass,
      `同步移除 ${incident} 条相连链路`
    );

    const undoProject = clone(project);
    const undoMetrics = graphMetrics(undoProject.nodes, undoProject.links);
    const undoPass = undoMetrics.fingerprint === before.fingerprint && undoMetrics.nodeCount === before.nodeCount;
    addStep("UNDO", `撤销恢复 ${undoMetrics.nodeCount} 节点 / ${undoMetrics.linkCount} 链路`, undoPass, before.fingerprint);

    const serialized = serializeProject(project, filter);
    let reloaded = null;
    let reloadPass = false;
    let reloadError = "";
    try {
      reloaded = hydrateProject(JSON.parse(JSON.stringify(serialized)));
      const reloadedMetrics = graphMetrics(reloaded.nodes, reloaded.links);
      const reloadedRoutes = reloaded.routes.map((route) => analyzeRoute(reloaded, route));
      const latencyBefore = allRoutes.map((route) => route.totalLatency);
      const latencyAfter = reloadedRoutes.map((route) => route.totalLatency);
      reloadPass =
        reloadedMetrics.nodeCount === before.nodeCount &&
        reloadedMetrics.linkCount === before.linkCount &&
        reloadedMetrics.fingerprint === before.fingerprint &&
        JSON.stringify(latencyBefore) === JSON.stringify(latencyAfter);
    } catch (error) {
      reloadError = error.message;
    }
    addStep(
      "RELOAD",
      reloadPass
        ? `工程重新载入：${reloaded.nodes.length} 节点 / ${reloaded.links.length} 链路，指纹一致`
        : `工程重新载入失败：${reloadError || "数值不一致"}`,
      reloadPass,
      before.fingerprint
    );

    const routeValues = Object.fromEntries(allRoutes.map((route) => [route.id, route.totalLatency]));
    return {
      passed: steps.every((step) => step.pass),
      steps,
      backupCount: backupRoutes.length,
      backupsAvailable,
      deletePass: deletionPass,
      reloadPass,
      deletionNodeId: deletionNode ? deletionNode.id : null,
      deletedIncidentLinks: incident,
      before,
      afterDelete: deletedMetrics,
      afterUndo: undoMetrics,
      routeValues,
      checkedAt: new Date().toISOString()
    };
  }

  function buildSvgExportStyle() {
    return [
      ".zone{fill:rgba(68,104,128,.025);stroke:rgba(99,132,153,.16);stroke-width:1;stroke-dasharray:5 6}",
      ".zone-label{fill:#526c81;font-family:monospace;font-size:9px;letter-spacing:1.6px}",
      ".edge-line{fill:none;stroke:#40586c;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}",
      ".edge-anchor{fill:#647d92}.edge-label-bg{fill:#101a24;stroke:#2d4356;stroke-width:.8}",
      ".edge-label{fill:#8da2b5;font-family:monospace;font-size:8px}.edge-label .capacity{fill:#8399ac}",
      ".node-card{fill:#111c27;stroke:#31485c;stroke-width:1}",
      ".node-accent{width:3px;rx:2px}.node-group[data-type=gateway] .node-accent{fill:#f1b85a}",
      ".node-group[data-type=router] .node-accent{fill:#69a7ff}.node-group[data-type=terminal] .node-accent{fill:#52e0b0}",
      ".node-icon-bg{fill:#172735;stroke:#30495c;stroke-width:.8}.node-icon{fill:none;stroke:#8ba6bb;stroke-width:1.35;stroke-linecap:round;stroke-linejoin:round}",
      ".node-group[data-type=gateway] .node-icon{stroke:#f1b85a}.node-group[data-type=router] .node-icon{stroke:#69a7ff}.node-group[data-type=terminal] .node-icon{stroke:#52e0b0}",
      ".node-name{fill:#e0e8f0;font-family:sans-serif;font-size:9.5px;font-weight:600}.node-id{fill:#5d7387;font-family:monospace;font-size:7.3px}",
      ".node-status{fill:#52e0b0}.node-status.degraded{fill:#f1b85a}.node-status-ring{fill:rgba(82,224,176,.1)}.node-status-ring.degraded{fill:rgba(241,184,90,.1)}",
      ".node-port{fill:#0b131c;stroke:#45647d;stroke-width:.8}.export-title{fill:#7d93a6;font-family:monospace;font-size:9px;letter-spacing:1px}",
      ".export-meta{fill:#526b7f;font-family:monospace;font-size:8px}"
    ].join("");
  }

  window.TopoCore = {
    CANVAS,
    NODE_SIZE,
    DEFAULT_FILTER,
    TYPE_LABELS,
    clone,
    hashText,
    graphFingerprint,
    graphMetrics,
    parseTopology,
    normalizeFilter,
    visibleTopology,
    filterLabel,
    analyzeRoute,
    shortestPath,
    removeNodeAndLinks,
    autoLayoutNodes,
    planLinkPaths,
    formatCapacity,
    formatLatency,
    buildProjectFromSample,
    serializeProject,
    hydrateProject,
    createTopologyExport,
    runWorkflowVerification,
    buildSvgExportStyle
  };
})();
