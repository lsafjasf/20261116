import { createNode, validateNode } from './scene.js';

export const SCHEMA_VERSION = 1;

function revive(node) {
  const children = (node.children ?? []).map(revive);
  return createNode({
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    clipped: node.clipped,
    clipRect: node.clipRect,
    transform: node.transform,
    style: node.style,
    geometry: node.geometry,
    keyframes: node.keyframes,
    children,
  });
}

export function serializeScene(root) {
  validateNode(root);
  return JSON.stringify(
    {
      schema: 'scene-graph-editor',
      version: SCHEMA_VERSION,
      root: structuredClone(root),
    },
    null,
    2,
  );
}

export function deserializeScene(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (err) {
    throw new TypeError(`工程文件不是合法 JSON: ${err.message}`);
  }
  if (!data || data.schema !== 'scene-graph-editor' || !data.root) {
    throw new TypeError('工程文件缺少 schema/root 字段，无法载入');
  }
  if (data.version > SCHEMA_VERSION) {
    throw new RangeError(`工程版本 ${data.version} 高于当前支持版本 ${SCHEMA_VERSION}`);
  }
  const root = revive(data.root);
  validateNode(root);
  const ids = new Set();
  let duplicated = null;
  const walk = (node) => {
    if (ids.has(node.id)) duplicated = node.id;
    ids.add(node.id);
    node.children.forEach(walk);
  };
  walk(root);
  if (duplicated) throw new Error(`载入工程存在重复节点 id: ${duplicated}`);
  return root;
}

// 规范化比较：忽略键顺序，只比较数据本身（用于重载一致性）
export function canonicalScene(root) {
  return JSON.stringify(sortKeys(JSON.parse(serializeScene(root))));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}
