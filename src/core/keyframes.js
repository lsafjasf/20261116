import { findNode, validateNode } from './scene.js';

export const NUMERIC_CHANNELS = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity'];
export const COLOR_CHANNELS = ['fill'];

function sortedFrames(frames) {
  return [...frames].sort((a, b) => a.t - b.t);
}

export function addKeyframe(node, channel, t, value) {
  if (!Number.isFinite(t) || t < 0) {
    throw new RangeError(`关键帧时间必须是非负有限数值: ${String(t)}`);
  }
  if (NUMERIC_CHANNELS.includes(channel) && !Number.isFinite(value)) {
    throw new TypeError(`通道 ${channel} 的值必须是数值: ${String(value)}`);
  }
  if (COLOR_CHANNELS.includes(channel) && !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new TypeError(`颜色通道值必须是 #RRGGBB: ${String(value)}`);
  }
  if (!node.keyframes) node.keyframes = {};
  if (!node.keyframes[channel]) node.keyframes[channel] = [];
  const frames = node.keyframes[channel];
  const existing = frames.find((f) => f.t === t);
  if (existing) {
    existing.value = value;
  } else {
    frames.push({ t, value });
    frames.sort((a, b) => a.t - b.t);
  }
  return node;
}

function baseValue(node, channel) {
  if (channel === 'opacity') return node.style.opacity;
  if (channel === 'fill') return node.style.fill;
  return node.transform[channel];
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}

function sampleChannel(node, channel, t) {
  const frames = node.keyframes?.[channel];
  if (!frames || frames.length === 0) return baseValue(node, channel);
  const list = sortedFrames(frames);
  if (t <= list[0].t) return baseValue(node, channel);
  if (t >= list[list.length - 1].t) return list[list.length - 1].value;
  for (let i = 0; i < list.length - 1; i += 1) {
    const f0 = list[i];
    const f1 = list[i + 1];
    if (t >= f0.t && t <= f1.t) {
      if (COLOR_CHANNELS.includes(channel)) return f0.value;
      const k = (t - f0.t) / (f1.t - f0.t);
      return lerp(f0.value, f1.value, k);
    }
  }
  return baseValue(node, channel);
}

function applyChannel(node, channel, value) {
  if (channel === 'opacity') node.style.opacity = value;
  else if (channel === 'fill') node.style.fill = value;
  else node.transform[channel] = value;
}

// 在给定时刻采样整棵树，返回应用了动画值的深拷贝（不修改原树）
export function sampleAt(root, t) {
  if (!Number.isFinite(t) || t < 0) {
    throw new RangeError(`采样时间非法: ${String(t)}`);
  }
  const clone = structuredClone(root);
  const walk = (node) => {
    Object.keys(node.keyframes ?? {}).forEach((channel) => {
      applyChannel(node, channel, sampleChannel(node, channel, t));
    });
    node.children.forEach(walk);
  };
  walk(clone);
  validateNode(clone);
  return clone;
}

export function keyframeCount(root) {
  let count = 0;
  const walk = (node) => {
    Object.values(node.keyframes ?? {}).forEach((frames) => {
      count += frames.length;
    });
    node.children.forEach(walk);
  };
  walk(root);
  return count;
}

export function getKeyframes(node, id, channel) {
  const target = findNode(node, id);
  if (!target) throw new Error(`节点不存在: ${id}`);
  return target.keyframes?.[channel] ? sortedFrames(target.keyframes[channel]) : [];
}
