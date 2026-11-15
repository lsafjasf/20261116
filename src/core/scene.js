import { localMatrix, multiply, identity } from './math.js';

let idCounter = 0;
export function nextId(prefix = 'node') {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}
export function resetIdCounter(value = 0) {
  idCounter = value;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function assertFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`字段 ${field} 必须是有限数值，收到: ${String(value)}`);
  }
}

export function validateNode(node) {
  const t = node.transform;
  ['x', 'y', 'rotation', 'scaleX', 'scaleY'].forEach((k) =>
    assertFiniteNumber(t[k], `transform.${k}`),
  );
  if (node.geometry) {
    ['w', 'h'].forEach((k) => {
      assertFiniteNumber(node.geometry[k], `geometry.${k}`);
      if (node.geometry[k] < 0) {
        throw new RangeError(`geometry.${k} 不能为负数: ${node.geometry[k]}`);
      }
    });
  }
  if (node.style) {
    assertFiniteNumber(node.style.opacity, 'style.opacity');
    if (node.style.opacity < 0 || node.style.opacity > 1) {
      throw new RangeError(`style.opacity 必须在 [0,1] 内: ${node.style.opacity}`);
    }
    if (node.style.fill && !COLOR_RE.test(node.style.fill)) {
      throw new TypeError(`颜色必须是 #RRGGBB 格式: ${node.style.fill}`);
    }
  }
  if (!Array.isArray(node.children)) {
    throw new TypeError('节点 children 必须是数组');
  }
  node.children.forEach(validateNode);
  return true;
}

export function createNode(partial = {}) {
  const node = {
    id: partial.id ?? nextId(partial.type ?? 'node'),
    name: partial.name ?? partial.type ?? 'node',
    type: partial.type ?? 'group',
    visible: partial.visible ?? true,
    clipped: partial.clipped ?? false,
    clipRect: partial.clipRect ? { ...partial.clipRect } : { x: 0, y: 0, w: 100, h: 100 },
    transform: {
      x: partial.transform?.x ?? 0,
      y: partial.transform?.y ?? 0,
      rotation: partial.transform?.rotation ?? 0,
      scaleX: partial.transform?.scaleX ?? 1,
      scaleY: partial.transform?.scaleY ?? 1,
    },
    style: {
      fill: partial.style?.fill ?? '#4f8cff',
      opacity: partial.style?.opacity ?? 1,
      ...(partial.style?.stroke ? { stroke: partial.style.stroke } : {}),
    },
    geometry: partial.geometry ? { ...partial.geometry } : undefined,
    keyframes: partial.keyframes ? structuredClone(partial.keyframes) : {},
    children: [],
  };
  validateNode(node);
  (partial.children ?? []).forEach((child) => node.children.push(child));
  return node;
}

export function findNode(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

export function findParent(root, id) {
  for (const child of root.children) {
    if (child.id === id) return root;
    const hit = findParent(child, id);
    if (hit) return hit;
  }
  return null;
}

// 从根到目标节点的父链（含目标自身）
export function parentChain(root, id) {
  const chain = [];
  const walk = (node, path) => {
    const next = [...path, node];
    if (node.id === id) {
      chain.push(...next);
      return true;
    }
    return node.children.some((c) => walk(c, next));
  };
  walk(root, []);
  return chain;
}

export function addChild(root, parentId, node, index) {
  validateNode(node);
  if (findNode(node, node.id) && findNode(root, node.id)) {
    throw new Error(`节点 id 重复: ${node.id}`);
  }
  const parent = findNode(root, parentId);
  if (!parent) throw new Error(`父节点不存在: ${parentId}`);
  if (findNode(node, root.id)) {
    throw new Error('不能把节点移动到自身或其后代之下');
  }
  const at = index ?? parent.children.length;
  if (at < 0 || at > parent.children.length) {
    throw new RangeError(`插入下标越界: ${at}`);
  }
  parent.children.splice(at, 0, node);
  return node;
}

export function removeNode(root, id) {
  if (root.id === id) throw new Error('不能删除根节点');
  const parent = findParent(root, id);
  if (!parent) throw new Error(`节点不存在: ${id}`);
  const index = parent.children.findIndex((c) => c.id === id);
  const [removed] = parent.children.splice(index, 1);
  return { node: removed, parentId: parent.id, index };
}

// 调整同一父级内的绘制顺序（children 数组顺序即绘制顺序，靠后的在上层）
export function reorder(root, id, newIndex) {
  const parent = findParent(root, id);
  if (!parent) throw new Error(`节点不存在: ${id}`);
  const oldIndex = parent.children.findIndex((c) => c.id === id);
  const target = Math.min(newIndex, parent.children.length - 1);
  if (target === oldIndex) return oldIndex;
  const [node] = parent.children.splice(oldIndex, 1);
  parent.children.splice(target, 0, node);
  return target;
}

// 深度优先的绘制顺序：父先画，子按数组顺序依次覆盖
export function flattenDrawOrder(root) {
  const out = [];
  const walk = (node) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function computeWorldMatrices(root, parentMatrix = identity()) {
  const map = new Map();
  const walk = (node, parentM) => {
    const world = multiply(parentM, localMatrix(node));
    map.set(node.id, world);
    node.children.forEach((c) => walk(c, world));
  };
  walk(root, parentMatrix);
  return map;
}

// 父链上任一节点隐藏 => 自身实际不可见
export function effectiveVisibility(root, id) {
  return parentChain(root, id).every((n) => n.visible !== false);
}
