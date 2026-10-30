import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'events';

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Filesystem timestamps are coarse (often a few ms, up to seconds on network or
// overlay filesystems). A same-size rewrite inside one timestamp tick keeps the
// whole stat signature, so files modified this recently are "racy" (as in git's
// racy-clean check): their contents are hashed once, and compared on the next
// scan even when the stat signature is unchanged. Stable files are never read.
const RACY_WINDOW_MS = 2000;

export class FileWatcher extends EventEmitter {
  // Timers use the ambient clock (injectable by fake timers); filesystem and
  // delivery seams keep recovery tests independent of native watch reliability.
  constructor(config, debounceMs = config.debounce_ms ?? 500, { filesystem = fs, watch, deliver, maxHandles = null } = {}) {
    super();
    this.config = config;
    this.debounceMs = debounceMs;
    this.fs = filesystem;
    this.watch = watch || ((...args) => this.fs.watch(...args));
    this.deliver = deliver;
    // Watch-handle cap (B6 resource bounds): roots beyond the cap stay on
    // polling per the B3 reconciliation contract instead of failing.
    this.maxHandles = maxHandles ?? config.max_handles ?? Infinity;
    this.watchers = [];
    this.timers = new Map();
    this.pending = new Map();
    this.roots = [];
    this.eventsReceived = 0;
    this.started = false;
    this.stopped = false;
    this.busy = false;
    this.blocked = false;
    this.reconcilePending = false;
    this.pendingRoots = new Set();
    this.generation = 0;
  }

  start() {
    if (!this.config.enabled || this.started) return;
    this.started = true;
    this.stopped = false;
    this.blocked = false;
    this.reconcilePending = false;
    this.pendingRoots.clear();
    this.generation++;
    this.roots = this.config.paths.map(config => ({ config, path: path.resolve(config.path),
      state: new Map(), hashes: new Map(), available: false, polling: config.polling ?? this.config.polling ?? false,
      watcher: null, identity: null, incompletePaths: [] }));
    this.reconcile();
    // Recovery probing remains enabled even if routine reconciliation is off.
    this.pollTimer = setInterval(() => {
      const roots = this.roots.filter(root => root.polling || !root.available || (!root.watcher && !this.covered(root)));
      if (roots.length) this.reconcile(roots);
    }, this.config.poll_interval_ms ?? 5000);
    this.pollTimer.unref?.();
    const interval = this.config.reconcile_interval_ms ?? 60000;
    if (interval > 0) {
      this.reconcileTimer = setInterval(() => this.reconcile(), interval);
      this.reconcileTimer.unref?.();
    }
  }

  covered(root) {
    return this.roots.some(other => other !== root && other.watcher && inside(other.path, root.path));
  }

  watchPath(watchConfig) {
    const root = this.roots.find(item => item.config === watchConfig);
    if (!this.fs.existsSync(watchConfig.path)) {
      console.warn(`Watch path does not exist: ${watchConfig.path}`);
      return null;
    }
    const watcher = this.watch(watchConfig.path, { recursive: true }, () => {
      // Every event, including overflow or a missing filename, is only a hint.
      // Scan all logical roots so nested roots retain their own filter policy.
      this.requestReconcile();
    });
    watcher.on?.('error', error => {
      if (this.stopped) return;
      if (root) this.closeWatch(root);
      this.watchFailed(root, error);
      this.requestReconcile();
    });
    return watcher;
  }

  watchFailed(root, error) {
    if (root && ['ENOSPC', 'EMFILE', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'].includes(error.code)) {
      root.polling = true;
    }
    console.error(`Failed to watch ${root?.config.path ?? 'root'}; reconciling${root?.polling ? ' by polling' : ''}:`, error.message);
    this.emit('watch-unavailable', { path: root?.path, polling: root?.polling ?? false, error });
  }

  closeWatch(root) {
    root.watcher?.close();
    this.watchers = this.watchers.filter(watcher => watcher !== root.watcher);
    root.watcher = null;
  }

  requestReconcile() {
    this.reconcilePending = true;
    for (const root of this.roots) this.pendingRoots.add(root);
    if (this.busy || this.blocked || this.stopped) return;
    clearTimeout(this.hintTimer);
    // Batch hints across turns, with a shorter delay than the per-path debounce.
    // Hold ready deliveries until these hints are reconciled so a following
    // delete/atomic replacement cannot leave a stale create ready to deliver.
    this.hintTimer = setTimeout(() => this.reconcile(), Math.min(this.debounceMs / 2, 100));
  }

  isIgnored(root, filepath) {
    const relative = path.relative(root.path, filepath).split(path.sep).join('/');
    const absolute = filepath.split(path.sep).join('/');
    if (this.shouldIgnore(relative, root.config.ignore || []) ||
        this.shouldIgnore(`${relative}/`, root.config.ignore || []) || this.shouldIgnore(absolute, [])) return true;
    const generated = [
      ...(this.config.generated_output_paths || []).map(output => path.resolve(output)),
      ...(root.config.generated_output_paths || []).map(output => path.resolve(root.path, output))
    ];
    return generated.some(output => inside(output, filepath));
  }

  scan(root) {
    const state = new Map();
    const hashes = new Map();
    const changed = new Set();
    const incompletePaths = [];
    const scanStart = Date.now();
    const previousHashes = root.hashes ?? new Map();
    const stat = this.fs.statSync(root.path);
    const preserve = (filepath, error) => {
      for (const [previous, signature] of root.state) {
        if (inside(filepath, previous)) state.set(previous, signature);
      }
      for (const [previous, digest] of previousHashes) {
        if (inside(filepath, previous)) hashes.set(previous, digest);
      }
      incompletePaths.push(filepath);
      this.emit('scan-incomplete', { path: filepath, code: error.code, error });
    };
    const visit = directory => {
      let entries;
      try {
        entries = this.fs.readdirSync(directory, { withFileTypes: true })
          .sort((a, b) => compare(a.name, b.name));
      } catch (error) {
        if (directory === root.path) throw error;
        preserve(directory, error);
        return;
      }
      for (const entry of entries) {
        const filepath = path.join(directory, entry.name);
        if (this.isIgnored(root, filepath)) continue;
        if (entry.isDirectory()) visit(filepath);
        else if (entry.isFile() && (!(root.config.extensions?.length) || this.hasExtension(entry.name, root.config.extensions))) {
          try {
            const { size, mtimeMs, ctimeMs, ino } = this.fs.statSync(filepath);
            // ctime detects writes with restored mtime; ino detects atomic saves.
            const signature = `${size}:${mtimeMs}:${ctimeMs}:${ino}`;
            state.set(filepath, signature);
            const racy = Math.max(mtimeMs, ctimeMs) >= scanStart - RACY_WINDOW_MS;
            const recheck = previousHashes.has(filepath) && root.state.get(filepath) === signature;
            if (racy || recheck) {
              const digest = this.contentDigest(filepath);
              if (digest !== null) {
                if (racy) hashes.set(filepath, digest);
                if (recheck && digest !== previousHashes.get(filepath)) changed.add(filepath);
              }
            }
          } catch (error) { preserve(filepath, error); }
        }
        // Symlinks are not followed: no loops or traversal outside a root.
      }
    };
    visit(root.path);
    return { state, hashes, changed, identity: `${stat.dev}:${stat.ino}`, incompletePaths };
  }

  // Unreadable racy files fall back to the stat signature alone.
  contentDigest(filepath) {
    try { return createHash('sha256').update(this.fs.readFileSync(filepath)).digest('hex'); }
    catch { return null; }
  }

  reconcile(roots = this.roots) {
    if (this.stopped) return;
    if (this.busy || this.blocked) {
      this.reconcilePending = true;
      for (const root of roots) this.pendingRoots.add(root);
      return;
    }
    roots = new Set([...roots, ...this.pendingRoots]);
    this.pendingRoots.clear();
    clearTimeout(this.hintTimer);
    this.hintTimer = null;
    this.reconcilePending = false;
    // Build one union before diffing: overlapping policies cannot duplicate a
    // path or turn another available root's file into a deletion.
    const changes = new Map();
    for (const root of roots) {
      let next;
      try { next = this.scan(root); }
      catch (error) {
        // Only failures at the root make it unavailable. Descendant failures
        // retain just that subtree in scan(), allowing siblings to converge.
        if (root.available) this.emit('root-unavailable', { path: root.path, error });
        root.available = false;
        this.closeWatch(root);
        continue;
      }
      root.available = true;
      root.incompletePaths = next.incompletePaths ?? [];
      if (root.identity !== next.identity) this.closeWatch(root);
      root.identity = next.identity;
      const paths = new Set([...root.state.keys(), ...next.state.keys()]);
      for (const filepath of paths) {
        const before = root.state.get(filepath);
        const after = next.state.get(filepath);
        if (before === after && !next.changed?.has(filepath)) continue;
        let type = before === undefined ? 'create' : after === undefined ? 'delete' : 'modify';
        // A modify-only subscription still needs startup/restart catch-up.
        if (type === 'create' && root.config.events?.includes('modify') && !root.config.events.includes('create')) type = 'modify';
        if (!root.config.events || root.config.events.includes(type)) changes.set(filepath, type);
      }
      root.state = next.state;
      root.hashes = next.hashes ?? new Map();
    }
    // Attach shallowest first; logical nested roots still get independent scans.
    for (const root of [...this.roots].sort((a, b) => a.path.length - b.path.length || compare(a.path, b.path))) {
      if (!root.available || root.polling || root.watcher || this.covered(root)) continue;
      if (this.watchers.length >= this.maxHandles) {
        root.polling = true;
        this.emit('watch-unavailable', { path: root.path, polling: true,
          error: Object.assign(new Error(`Watch-handle cap reached (${this.maxHandles}); polling instead`), { code: 'WATCH_CAP' }) });
        continue;
      }
      try {
        root.watcher = this.watchPath(root.config);
        if (root.watcher) this.watchers.push(root.watcher);
      } catch (error) { this.watchFailed(root, error); }
    }
    // A returning ancestor replaces any native watches attached to its children.
    for (const root of this.roots) if (root.watcher && this.roots.some(other =>
      other !== root && other.watcher && other.path !== root.path && inside(other.path, root.path))) this.closeWatch(root);
    for (const [filepath, type] of [...changes].sort(([a], [b]) => compare(a, b))) {
      if (type === 'delete' && this.roots.some(root => root.state.has(filepath) &&
        (!root.available || root.incompletePaths.some(directory => inside(directory, filepath))))) continue;
      this.handleRawEvent(type, filepath);
    }
    void this.drain();
  }

  handleRawEvent(eventType, filepath) {
    const previous = this.pending.get(filepath);
    const first = previous?.type;
    let type = eventType;
    if (first === 'create' && eventType === 'delete') type = null;
    else if (first === 'create') type = 'create';
    else if (first === 'delete' && eventType === 'create') type = 'modify';
    clearTimeout(this.timers.get(filepath));
    this.timers.delete(filepath);
    if (type === null) { this.pending.delete(filepath); return; }
    this.pending.set(filepath, { type, ready: false });
    this.timers.set(filepath, setTimeout(() => {
      this.timers.delete(filepath);
      const item = this.pending.get(filepath);
      if (item) item.ready = true;
      void this.drain();
    }, this.debounceMs));
  }

  async drain() {
    if (this.busy || this.blocked || this.stopped || this.hintTimer) return;
    this.busy = true;
    const generation = this.generation;
    try {
      while (!this.stopped && generation === this.generation && !this.blocked) {
        const entry = [...this.pending].find(([filepath, item]) => item.ready &&
          !this.roots.some(root => !root.available && inside(root.path, filepath)));
        if (!entry) break;
        const [filepath, item] = entry;
        this.pending.delete(filepath);
        const event = { source: 'watch', type: `file.${item.type}`,
          payload: { path: filepath, event_type: item.type } };
        try {
          if (this.deliver) await this.deliver(event);
          else {
            // Await consumers in registration order, including once listeners.
            for (const listener of this.rawListeners('event')) {
              const result = listener.call(this, event);
              if (result?.then) await result;
            }
          }
          if (this.stopped || generation !== this.generation) break;
          this.eventsReceived++;
        } catch (error) {
          if (this.stopped || generation !== this.generation) break;
          // An unknown build outcome requires inspection, never timer retries.
          this.pending.set(filepath, this.pending.get(filepath) || item);
          this.blocked = true;
          this.reconcilePending = true;
          for (const root of this.roots) this.pendingRoots.add(root);
          this.emit('delivery-failed', { event, error });
        }
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        if (this.reconcilePending && !this.blocked && !this.stopped) this.reconcile([...this.pendingRoots]);
      }
    }
  }

  // Explicit operator acknowledgement; no independent retry/backoff authority.
  resume() {
    this.blocked = false;
    this.reconcile();
    void this.drain();
  }

  shouldIgnore(filename, ignorePatterns) {
    for (const pattern of ignorePatterns) {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
        if (regex.test(filename)) return true;
      } else if (filename.includes(pattern)) return true;
    }
    return filename.includes('node_modules') || filename.includes('.git') ||
      filename.includes('.aiwg/working') || filename.includes('.aiwg/daemon');
  }

  hasExtension(filename, extensions) {
    return extensions.some(ext => filename.endsWith(ext));
  }

  normalizeEventType(eventType, filepath) {
    if (eventType === 'rename') return this.fs.existsSync(filepath) ? 'create' : 'delete';
    return eventType === 'change' ? 'modify' : eventType;
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.generation++;
    this.busy = false;
    for (const watcher of this.watchers) watcher?.close();
    this.watchers = [];
    clearTimeout(this.hintTimer);
    this.hintTimer = null;
    clearInterval(this.pollTimer);
    clearInterval(this.reconcileTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.pendingRoots.clear();
  }

  getStats() {
    return {
      enabled: this.config.enabled,
      max_handles: Number.isFinite(this.maxHandles) ? this.maxHandles : null,
      watch_handles: this.watchers.length,
      paths: this.config.paths.map(p => p.path),
      events_received: this.eventsReceived,
      unavailable_roots: this.roots.filter(root => !root.available).map(root => root.path),
      polling_roots: this.roots.filter(root => root.polling).map(root => root.path),
      scan_incomplete_roots: this.roots.filter(root => root.incompletePaths.length).map(root => root.path),
      pending_changes: this.pending.size,
      reconciliation_pending: this.reconcilePending,
      recovery_required: this.blocked
    };
  }
}

export default FileWatcher;
