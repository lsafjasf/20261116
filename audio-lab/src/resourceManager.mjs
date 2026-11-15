// Centralized lifecycle management for Web Audio nodes and their listeners.
// Every node, connection and event listener is registered here so that
// stopping a scene can deterministically release everything it owns.

export class ResourceManager {
  constructor(context, { name = 'managed', onViolation = null } = {}) {
    this.context = context;
    this.name = name;
    this.onViolation = onViolation;
    this._records = new Map();      // node -> record
    this._scopes = new Map();       // scope name -> Set of nodes
    this._activeScope = null;
    this._adjacency = new Map();    // node -> Set of destination nodes
    this._connections = 0;
    this._releases = 0;
    this._candidates = 0;
    this._suppressedCallbacks = 0;
    this._wrapped = new WeakMap();  // original handler -> wrapped handler
  }

  track(node, label = node.nodeType || 'node') {
    if (this._records.has(node)) return node;
    const record = {
      node,
      label,
      released: false,
      listeners: [], // { type, original, wrapped }
      scope: this._activeScope,
    };
    this._records.set(node, record);
    if (this._activeScope) this._scopes.get(this._activeScope).add(node);
    return node;
  }

  connect(source, destination) {
    source.connect(destination);
    if (!this._adjacency.has(source)) this._adjacency.set(source, new Set());
    this._adjacency.get(source).add(destination);
    this._connections += 1;
    return destination;
  }

  // Registers a listener through a guard so a released node can never invoke
  // user code again. The guard is the single choke point for this guarantee.
  on(node, type, handler) {
    const record = this._requireRecord(node);
    const wrapped = (event) => {
      if (record.released) {
        this._suppressedCallbacks += 1;
        this.onViolation?.({
          kind: 'callback-after-release',
          label: record.label,
          type,
        });
        return;
      }
      return handler.call(node, event);
    };
    this._wrapped.set(handler, wrapped);
    record.listeners.push({ type, original: handler, wrapped });
    node.addEventListener(type, wrapped);
    return wrapped;
  }

  off(node, type, handler) {
    const record = this._records.get(node);
    if (!record) return;
    const wrapped = this._wrapped.get(handler) || handler;
    node.removeEventListener(type, wrapped);
    record.listeners = record.listeners.filter(
      (entry) => !(entry.type === type && entry.original === handler),
    );
  }

  beginScope(name) {
    if (!this._scopes.has(name)) this._scopes.set(name, new Set());
    this._activeScope = name;
  }

  endScope(name) {
    const nodes = this._scopes.get(name);
    if (!nodes) return 0;
    this._candidates += nodes.size;
    for (const node of [...nodes]) this.releaseNode(node);
    this._scopes.delete(name);
    if (this._activeScope === name) this._activeScope = null;
    return nodes.size;
  }

  releaseNode(node) {
    const record = this._records.get(node);
    if (!record || record.released) return false;
    record.released = true;
    try {
      if (typeof node.stop === 'function' && node.started && !node.stopped) {
        node.stop(this.context.currentTime);
      }
    } catch (error) {
      this.onViolation?.({ kind: 'stop-failed', label: record.label, error });
    }
    // Guarded wrappers stay attached on purpose: the platform may deliver a
    // late event after release, and the wrapper guarantees user code never
    // runs again while recording a violation. Raw listeners were only ever
    // registered through these wrappers.
    const outgoing = this._adjacency.get(node)?.size || 0;
    if (typeof node.disconnect === 'function') node.disconnect();
    this._connections = Math.max(0, this._connections - outgoing);
    this._adjacency.delete(node);
    record.released = true;
    if (typeof node.close === 'function') {
      try { node.close(); } catch { /* already closed */ }
    }
    this._releases += 1;
    this._records.delete(node);
    for (const set of this._scopes.values()) set.delete(node);
    return true;
  }

  releaseAll() {
    const nodes = [...this._records.keys()];
    this._candidates += nodes.length;
    for (const node of nodes) this.releaseNode(node);
    this._scopes.clear();
    return nodes.length;
  }

  _requireRecord(node) {
    const record = this._records.get(node);
    if (!record) throw new Error('Node is not managed by ResourceManager');
    return record;
  }

  get stats() {
    return {
      activeNodes: this._records.size,
      activeConnections: this._connections,
      activeListeners: [...this._records.values()].reduce(
        (sum, record) => sum + record.listeners.length, 0),
      releases: this._releases,
      candidates: this._candidates,
      suppressedCallbacks: this._suppressedCallbacks,
    };
  }
}

// Baseline implementation that models the application before the fix:
// nodes and listeners are created per scene but never released.
export class NaiveResourceManager {
  constructor(context, { name = 'naive', onViolation = null } = {}) {
    this.context = context;
    this.name = name;
    this.onViolation = onViolation;
    this._records = new Map();
    this._connections = 0;
    this._releases = 0;
    this._candidates = 0;
    this._suppressedCallbacks = 0;
  }

  track(node, label = node.nodeType || 'node') {
    if (!this._records.has(node)) {
      this._records.set(node, { node, label, released: false, listeners: [] });
    }
    return node;
  }

  connect(source, destination) {
    source.connect(destination);
    this._connections += 1;
    return destination;
  }

  on(node, type, handler) {
    const record = this._records.get(node);
    record.listeners.push({ type, original: handler, wrapped: handler });
    node.addEventListener(type, handler);
    return handler;
  }

  off(node, type, handler) {
    node.removeEventListener(type, handler);
  }

  beginScope() { /* scopes are ignored: nothing gets released */ }
  endScope() { return 0; }

  releaseNode(node) {
    // Old code only stops oscillators; nodes and listeners remain referenced.
    const record = this._records.get(node);
    if (!record || record.released) return false;
    try {
      if (typeof node.stop === 'function' && node.started && !node.stopped) {
        node.stop(this.context.currentTime);
      }
    } catch { /* ignore */ }
    record.released = true;
    // Deliberately not counted as a release: the node graph and its listeners
    // stay referenced, which is exactly the leak this refactor eliminates.
    return true;
  }

  releaseAll() {
    // Simulates page teardown only; normal scene switches never call this.
    const count = this._records.size;
    for (const record of this._records.values()) {
      try { record.node.disconnect?.(); } catch { /* noop */ }
    }
    this._records.clear();
    this._connections = 0;
    return count;
  }

  get stats() {
    return {
      activeNodes: this._records.size,
      activeConnections: this._connections,
      activeListeners: [...this._records.values()].reduce(
        (sum, record) => sum + record.listeners.length, 0),
      releases: this._releases,
      candidates: this._candidates,
      suppressedCallbacks: this._suppressedCallbacks,
    };
  }
}
