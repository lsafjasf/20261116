// 快照式历史：任何可撤销操作前 push，undo 恢复上一份快照
export class History {
  constructor(limit = 200) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`历史容量必须是正整数: ${String(limit)}`);
    }
    this.limit = limit;
    this.stack = [];
  }

  get size() {
    return this.stack.length;
  }

  get canUndo() {
    return this.stack.length > 0;
  }

  push(root, label = '') {
    if (!root || !root.id) throw new TypeError('快照必须是有效场景根节点');
    this.stack.push({ label, snapshot: structuredClone(root) });
    if (this.stack.length > this.limit) this.stack.shift();
  }

  undo(currentRoot) {
    const entry = this.stack.pop();
    if (!entry) {
      return { root: currentRoot, restored: false, label: '' };
    }
    return { root: structuredClone(entry.snapshot), restored: true, label: entry.label };
  }

  clear() {
    this.stack.length = 0;
  }
}
