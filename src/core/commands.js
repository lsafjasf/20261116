import {
  findNode,
  findParent,
  parentChain,
  removeNode,
  reorder,
} from './scene.js';
import { History } from './history.js';

export class EditorController {
  constructor(root, { historyLimit = 200 } = {}) {
    this.root = root;
    this.history = new History(historyLimit);
    this.selectedId = null;
  }

  // 选择节点：返回需要高亮的父链 id；找不到时抛错由调用方转提示
  select(id) {
    if (id == null) {
      this.selectedId = null;
      return { selected: null, highlightIds: new Set() };
    }
    const node = findNode(this.root, id);
    if (!node) throw new Error(`无法选择：节点不存在 ${id}`);
    this.selectedId = id;
    return {
      selected: id,
      highlightIds: new Set(parentChain(this.root, id).map((n) => n.id)),
    };
  }

  highlightSet() {
    if (!this.selectedId) return new Set();
    return new Set(parentChain(this.root, this.selectedId).map((n) => n.id));
  }

  moveBy(id, dx, dy) {
    const node = findNode(this.root, id);
    if (!node) throw new Error(`无法移动：节点不存在 ${id}`);
    if (![dx, dy].every(Number.isFinite)) {
      throw new TypeError('移动量必须是有限数值');
    }
    this.history.push(this.root, `move:${id}`);
    node.transform.x += dx;
    node.transform.y += dy;
    return node;
  }

  setVisibility(id, visible) {
    const node = findNode(this.root, id);
    if (!node) throw new Error(`无法设置可见性：节点不存在 ${id}`);
    this.history.push(this.root, `visibility:${id}`);
    node.visible = visible;
    return node;
  }

  hide(id) {
    return this.setVisibility(id, false);
  }

  show(id) {
    return this.setVisibility(id, true);
  }

  // 从检查器删除节点（根节点禁止删除），可通过 undo 完整恢复
  deleteNode(id) {
    if (!findNode(this.root, id)) throw new Error(`无法删除：节点不存在 ${id}`);
    if (!findParent(this.root, id)) {
      throw new Error('根节点不允许删除');
    }
    this.history.push(this.root, `delete:${id}`);
    const removed = removeNode(this.root, id);
    if (this.selectedId === id) this.selectedId = null;
    return removed;
  }

  moveInOrder(id, newIndex) {
    this.history.push(this.root, `reorder:${id}`);
    return reorder(this.root, id, newIndex);
  }

  undo() {
    const result = this.history.undo(this.root);
    if (result.restored) {
      this.root = result.root;
      if (this.selectedId && !findNode(this.root, this.selectedId)) {
        this.selectedId = null;
      }
    }
    return result;
  }
}
