import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { FileWatcher } from '../../../tools/daemon/file-watcher.mjs';
import { EventRouter } from '../../../tools/daemon/event-router.mjs';

// Real synthetic files + fake native hints and clock. Assertions describe the
// consumer's materialized view, so native watch delivery alone cannot pass.
describe('FileWatcher reconciliation', () => {
  let directory, root, watcher, handles, watch, view, events;
  const write = (name, content) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  const consume = event => {
    events.push(event);
    const target = event.payload.path;
    if (event.type === 'file.delete') view.delete(target);
    else view.set(target, fs.readFileSync(target, 'utf8'));
  };
  const advance = async (ms = 20) => vi.advanceTimersByTimeAsync(ms);
  const start = (config = {}, options = {}) => {
    watcher = new FileWatcher({ enabled: true, paths: [{ path: root }],
      reconcile_interval_ms: 100, poll_interval_ms: 50, ...config }, 10, { watch, ...options });
    if (!options.deliver) watcher.on('event', consume);
    watcher.start();
    return watcher;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-reconciliation-'));
    root = path.join(directory, 'source');
    fs.mkdirSync(root);
    view = new Map(); events = []; handles = [];
    watch = vi.fn((target, options, callback) => {
      const handle = new EventEmitter();
      handle.target = target;
      handle.hint = callback;
      handle.close = vi.fn(() => { handle.closed = true; });
      handles.push(handle);
      return handle;
    });
  });
  afterEach(() => {
    watcher?.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('converges after silent event loss using ctime for same-size writes with restored mtime, without reading files', async () => {
    const a = write('a.md', 'old');
    const time = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(a, time, time);
    let ctime = 1000;
    const filesystem = Object.create(fs);
    filesystem.statSync = target => {
      const stat = fs.statSync(target);
      // Control ctime independently of filesystem timestamp resolution.
      return target === a ? Object.assign(stat, { ctimeMs: ctime }) : stat;
    };
    filesystem.readFileSync = vi.fn(() => { throw new Error('stable files must not be read'); });
    start({}, { filesystem }); await advance();
    expect(view.get(a)).toBe('old');
    const before = filesystem.statSync(a);
    write('a.md', 'new'); fs.utimesSync(a, time, time);
    ctime++;
    const after = filesystem.statSync(a);
    expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    const b = write('b.md', 'added');
    await advance(100);
    expect(view).toEqual(new Map([[a, 'new'], [b, 'added']]));
    fs.unlinkSync(a);
    await advance(100);
    expect(view).toEqual(new Map([[b, 'added']]));
    // The stable file converged by ctime alone; only the freshly written b.md
    // is inside the racy window and may be hashed.
    expect(filesystem.readFileSync.mock.calls.filter(([target]) => target === a)).toEqual([]);
  });

  it('detects a same-size atomic replacement through inode even with identical timestamps', async () => {
    const a = write('a.md', 'old');
    const filesystem = Object.create(fs);
    filesystem.statSync = target => {
      const stat = fs.statSync(target);
      return target === a ? Object.assign(stat, { mtimeMs: 1000, ctimeMs: 1000 }) : stat;
    };
    start({ paths: [{ path: root, extensions: ['.md'] }] }, { filesystem }); await advance();
    const before = filesystem.statSync(a);
    const replacement = write('save.tmp', 'new');
    fs.renameSync(replacement, a);
    const after = filesystem.statSync(a);
    expect([after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.size, before.mtimeMs, before.ctimeMs]);
    expect(after.ino).not.toBe(before.ino);
    await advance(100);
    expect(view.get(a)).toBe('new');
    expect(events.map(event => event.type)).toEqual(['file.create', 'file.modify']);
  });

  it.each([null, undefined, ''])('reconciles a hint with missing filename %s even with routine scans disabled', async filename => {
    start({ reconcile_interval_ms: 0 }); await advance();
    const a = write('lost.md', 'found');
    handles[0].hint('change', filename);
    await advance();
    expect(view.get(a)).toBe('found');
  });

  it('recovers overflow/error by scanning, and replaces the failed native watch', async () => {
    start({ reconcile_interval_ms: 0 }); await advance();
    const a = write('lost.md', 'found');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handles[0].emit('error', Object.assign(new Error('overflow'), { code: 'EOVERFLOW' }));
    await advance();
    expect(view.get(a)).toBe('found');
    expect(handles[0].closed).toBe(true);
    expect(handles.filter(handle => !handle.closed)).toHaveLength(1);
  });

  it('finds an initially missing root and reattaches after disappearance and return without deletes during absence', async () => {
    fs.rmdirSync(root);
    start({ reconcile_interval_ms: 0 }); await advance();
    expect(watch).not.toHaveBeenCalled();
    const a = write('a.md', 'first');
    await advance(50);
    expect(view.get(a)).toBe('first');
    const old = path.join(directory, 'unmounted');
    fs.renameSync(root, old);
    handles[0].hint('rename', null); await advance();
    expect(view.get(a)).toBe('first');
    expect(events.some(event => event.type === 'file.delete')).toBe(false);
    expect(watcher.getStats().unavailable_roots).toEqual([root]);
    fs.renameSync(old, root);
    write('a.md', 'returned');
    await advance(50);
    expect(view.get(a)).toBe('returned');
    expect(watcher.getStats().unavailable_roots).toEqual([]);
  });

  it('detects a same-size rewrite inside one timestamp tick (racy stat signature)', async () => {
    const a = write('a.md', 'old');
    const pinned = { mtimeMs: Date.now(), ctimeMs: Date.now() };
    const filesystem = Object.create(fs);
    // Coarse timestamps: the rewrite keeps size, inode, mtime and ctime.
    filesystem.statSync = target => {
      const stat = fs.statSync(target);
      return target === a ? Object.assign(stat, pinned) : stat;
    };
    start({}, { filesystem }); await advance();
    expect(view.get(a)).toBe('old');
    write('a.md', 'new');
    watcher.reconcile(); await advance();
    expect(view.get(a)).toBe('new');
    // Once the content hash matches again, no further events are emitted.
    const count = events.length;
    watcher.reconcile(); await advance();
    expect(events).toHaveLength(count);
  });

  it('never reads files whose timestamps are outside the racy window', async () => {
    const a = write('a.md', 'old');
    const time = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(a, time, time);
    const filesystem = Object.create(fs);
    filesystem.statSync = target => {
      const stat = fs.statSync(target);
      return target === a ? Object.assign(stat, { ctimeMs: time.getTime() }) : stat;
    };
    filesystem.readFileSync = vi.fn(fs.readFileSync);
    start({}, { filesystem }); await advance();
    watcher.reconcile(); await advance(200);
    expect(view.get(a)).toBe('old');
    expect(filesystem.readFileSync.mock.calls.filter(([target]) => target === a)).toEqual([]);
  });

  it.each(['ENOENT', 'EACCES', 'ENOTCONN', 'EIO'])('retains the good snapshot while the root returns %s', async code => {
    let unavailable = false;
    const filesystem = Object.create(fs);
    filesystem.statSync = target => {
      if (target === root && unavailable) throw Object.assign(new Error('unavailable'), { code });
      return fs.statSync(target);
    };
    const a = write('a.md', 'old');
    start({}, { filesystem }); await advance();
    unavailable = true; watcher.reconcile(); await advance();
    expect(view.get(a)).toBe('old');
    expect(events).toHaveLength(1);
    expect(watcher.getStats().unavailable_roots).toEqual([root]);
    unavailable = false; write('a.md', 'new');
    await advance(100);
    expect(view.get(a)).toBe('new');
  });

  it('treats failure to read the root itself as unavailable and recovers without false deletes', async () => {
    const a = write('a.md', 'old');
    let unavailable = false;
    const filesystem = Object.create(fs);
    filesystem.readdirSync = (target, options) => {
      if (target === root && unavailable) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return fs.readdirSync(target, options);
    };
    start({ reconcile_interval_ms: 0 }, { filesystem }); await advance();
    const incomplete = vi.fn(); watcher.on('scan-incomplete', incomplete);
    unavailable = true; watcher.reconcile(); await advance();
    expect(watcher.getStats().unavailable_roots).toEqual([root]);
    expect(view.get(a)).toBe('old');
    expect(events).toHaveLength(1);
    expect(incomplete).not.toHaveBeenCalled();
    expect(handles[0].closed).toBe(true);
    unavailable = false; write('a.md', 'readable again'); await advance(50);
    expect(view.get(a)).toBe('readable again');
    expect(watcher.getStats().unavailable_roots).toEqual([]);
  });

  it.each(['EACCES', 'EPERM', 'ENOENT', 'EIO'])('keeps siblings live and retains an unreadable subtree on %s, then converges on recovery', async code => {
    const a = write('sub/a.md', 'old');
    const deleted = write('sub/deleted.md', 'retained until recovery');
    const sibling = write('sibling.md', 'old sibling');
    let unavailable = false;
    const filesystem = Object.create(fs);
    filesystem.readdirSync = (target, options) => {
      if (target === path.join(root, 'sub') && unavailable) throw Object.assign(new Error('denied'), { code });
      return fs.readdirSync(target, options);
    };
    start({}, { filesystem }); await advance();
    const incomplete = vi.fn(); watcher.on('scan-incomplete', incomplete);
    events.length = 0;
    write('sub/a.md', 'new'); fs.unlinkSync(deleted);
    write('sibling.md', 'updated sibling');
    const added = write('added.md', 'new sibling');
    unavailable = true; watcher.reconcile(); await advance();
    expect(view.get(a)).toBe('old');
    expect(view.has(deleted)).toBe(true);
    expect(view.get(sibling)).toBe('updated sibling');
    expect(view.get(added)).toBe('new sibling');
    expect(events.map(event => event.type)).toEqual(['file.create', 'file.modify']);
    expect(watcher.getStats().unavailable_roots).toEqual([]);
    expect(watcher.getStats().scan_incomplete_roots).toEqual([root]);
    expect(handles[0].closed).not.toBe(true);
    expect(incomplete).toHaveBeenCalledExactlyOnceWith({ path: path.join(root, 'sub'), code, error: expect.objectContaining({ code }) });
    unavailable = false;
    await advance(100);
    expect(view.get(a)).toBe('new');
    expect(view.has(deleted)).toBe(false);
    expect(events.filter(event => event.type === 'file.delete').map(event => event.payload.path)).toEqual([deleted]);
    expect(watcher.getStats().scan_incomplete_roots).toEqual([]);
  });

  it('retains a missing nested mount even when its ancestor can still be scanned', async () => {
    const a = write('mount/a.md', 'mounted');
    start({ paths: [{ path: root }, { path: path.join(root, 'mount') }] }); await advance();
    fs.renameSync(path.join(root, 'mount'), path.join(directory, 'unmounted'));
    watcher.reconcile(); await advance();
    expect(view.get(a)).toBe('mounted');
    expect(events.filter(event => event.type === 'file.delete')).toEqual([]);
    fs.renameSync(path.join(directory, 'unmounted'), path.join(root, 'mount'));
    fs.unlinkSync(a);
    await advance(100);
    expect(view.has(a)).toBe(false);
    expect(events.filter(event => event.type === 'file.delete')).toHaveLength(1);
  });

  it.each(['ENOSPC', 'EMFILE'])('falls back to polling on synchronous watch exhaustion %s', async code => {
    watch.mockImplementation(() => { throw Object.assign(new Error('watch exhausted'), { code }); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    start({ reconcile_interval_ms: 0 }); await advance();
    const a = write('a.md', 'polled');
    await advance(50);
    expect(view.get(a)).toBe('polled');
    expect(watcher.getStats().polling_roots).toEqual([root]);
    expect(watch).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalled();
  });

  it('falls back to polling on asynchronous watch exhaustion', async () => {
    start({ reconcile_interval_ms: 0 }); await advance();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handles[0].emit('error', Object.assign(new Error('exhausted'), { code: 'ENOSPC' }));
    await advance();
    const a = write('a.md', 'polled');
    await advance(50);
    expect(view.get(a)).toBe('polled');
    expect(watch).toHaveBeenCalledOnce();
  });

  it('supports global polling and per-root override with no native hints', async () => {
    const second = path.join(directory, 'native'); fs.mkdirSync(second);
    start({ polling: true, reconcile_interval_ms: 0, paths: [{ path: root }, { path: second, polling: false }] });
    await advance();
    expect(watch.mock.calls.map(call => call[0])).toEqual([second]);
    const a = write('a.md', 'polled'); await advance(50);
    expect(view.get(a)).toBe('polled');
  });

  it('polls only polling, unavailable, and uncovered unwatched roots; periodic scans and hints still scan all', async () => {
    const native = path.join(directory, 'native');
    const nested = path.join(native, 'nested'); fs.mkdirSync(nested, { recursive: true });
    const missing = path.join(directory, 'missing');
    const unwatched = path.join(directory, 'unwatched'); fs.mkdirSync(unwatched);
    const normalWatch = watch.getMockImplementation();
    watch.mockImplementation((target, ...args) => {
      if (target === unwatched) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return normalWatch(target, ...args);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    start({ paths: [{ path: root, polling: true }, { path: native }, { path: nested },
      { path: missing }, { path: unwatched }], reconcile_interval_ms: 200 });
    await advance();
    const scan = vi.spyOn(watcher, 'scan');
    await advance(30);
    expect(scan.mock.calls.map(([item]) => item.path)).toEqual([root, missing, unwatched]);
    scan.mockClear();
    handles.find(handle => handle.target === native).hint('change', null);
    await advance(10);
    expect(scan.mock.calls.map(([item]) => item.path)).toEqual([root, native, nested, missing, unwatched]);
    scan.mockClear();
    await advance(139); // Through poll ticks, before the periodic timer at 200.
    scan.mockClear();
    await advance(1);
    expect(new Set(scan.mock.calls.map(([item]) => item.path))).toEqual(new Set([root, native, nested, missing, unwatched]));
  });

  it('retains a deferred polling subset while a delivery is busy', async () => {
    const native = path.join(directory, 'native'); fs.mkdirSync(native);
    write('a.md', 'queued');
    let finish;
    start({ paths: [{ path: root, polling: true }, { path: native }], reconcile_interval_ms: 0 },
      { deliver: () => new Promise(resolve => { finish = resolve; }) });
    await advance();
    const scan = vi.spyOn(watcher, 'scan');
    await advance(30);
    expect(scan).not.toHaveBeenCalled();
    expect(watcher.getStats().reconciliation_pending).toBe(true);
    finish(); await advance();
    expect(scan.mock.calls.map(([item]) => item.path)).toEqual([root]);
  });

  it('supports per-root polling without changing other roots', async () => {
    start({ paths: [{ path: root, polling: true }], reconcile_interval_ms: 0 });
    await advance();
    const a = write('a.md', 'polled'); await advance(50);
    expect(view.get(a)).toBe('polled');
    expect(watch).not.toHaveBeenCalled();
  });

  it('coalesces atomic saves and rename/create/delete bursts to a single logical event per path', async () => {
    const a = write('a.md', 'old');
    start({ paths: [{ path: root, ignore: ['*.tmp'] }] }); await advance(); events.length = 0;
    fs.unlinkSync(a); watcher.reconcile();
    write('save.tmp', 'new'); fs.renameSync(path.join(root, 'save.tmp'), a); watcher.reconcile();
    write('a.md', 'final'); watcher.reconcile();
    const transient = write('transient.md', 'gone'); watcher.reconcile();
    fs.unlinkSync(transient); watcher.reconcile();
    await advance();
    expect(events.map(event => [event.type, event.payload.path])).toEqual([['file.modify', a]]);
    expect(view.get(a)).toBe('final');
    events.length = 0;
    fs.renameSync(a, path.join(root, 'renamed.md')); watcher.reconcile(); await advance();
    expect(events.map(event => event.type)).toEqual(['file.delete', 'file.create']);
    expect(view).toEqual(new Map([[path.join(root, 'renamed.md'), 'final']]));
  });

  it('coalesces native hints inside the debounce window before attempting delivery', async () => {
    start(); await advance();
    const transient = write('transient.md', 'temporary');
    handles[0].hint('rename', 'transient.md'); await advance(5);
    fs.unlinkSync(transient); handles[0].hint('rename', 'transient.md');
    await advance();
    expect(events).toEqual([]);
    expect(watcher.getStats().recovery_required).toBe(false);
  });

  it.each([0, 10, 500])('coalesces hints across turns into one scan with debounce %s', async debounceMs => {
    watcher = new FileWatcher({ enabled: true, paths: [{ path: root }],
      reconcile_interval_ms: 0, poll_interval_ms: 1000 }, debounceMs, { watch });
    watcher.start();
    const scan = vi.spyOn(watcher, 'scan');
    const delay = Math.min(debounceMs / 2, 100);
    for (let i = 0; i < 5; i++) {
      handles[0].hint('change', null);
      if (delay) await advance(delay / 5);
    }
    expect(scan).not.toHaveBeenCalled();
    await advance(delay || 1);
    expect(scan).toHaveBeenCalledOnce();
  });

  it('reconciles a late delete hint before delivering a ready create', async () => {
    start({ reconcile_interval_ms: 0 }); await advance();
    const transient = write('transient.md', 'temporary');
    handles[0].hint('rename', 'transient.md'); await advance(14);
    fs.unlinkSync(transient); handles[0].hint('rename', 'transient.md');
    await advance();
    expect(events).toEqual([]);
    expect(watcher.getStats().recovery_required).toBe(false);
  });

  it('holds queued changes across a disappearing mount and delivers them when it returns', async () => {
    const a = write('a.md', 'queued'); start();
    fs.renameSync(root, path.join(directory, 'unmounted'));
    handles[0].hint('rename', null); await advance();
    expect(view.size).toBe(0);
    expect(watcher.getStats().recovery_required).toBe(false);
    fs.renameSync(path.join(directory, 'unmounted'), root);
    await advance(50);
    expect(view.get(a)).toBe('queued');
  });

  it('shares one native watch for nested roots while retaining their separate filters', async () => {
    const a = write('sub/a.md', 'nested');
    start({ paths: [{ path: path.join(root, 'sub'), extensions: ['.md'] },
      { path: root, ignore: ['sub'], extensions: ['.js'] }, { path: root, extensions: ['.js'] }] });
    await advance();
    expect(watch).toHaveBeenCalledOnce();
    expect(watch.mock.calls[0][0]).toBe(root);
    expect(view.get(a)).toBe('nested');
    write('sub/a.md', 'updated'); handles[0].hint('change', 'sub/a.md'); await advance();
    expect(view.get(a)).toBe('updated');
    expect(events.filter(event => event.payload.path === a)).toHaveLength(2);
  });

  it('suppresses generated outputs, daemon state, ignored files, and extension mismatches during every scan', async () => {
    const a = write('source.md', 'source');
    write('index/out.md', 'generated'); write('local/out.md', 'generated');
    write('.aiwg/daemon/state.md', 'state'); write('sub/skip.tmp', 'temp'); write('script.js', 'code');
    start({ generated_output_paths: [path.join(root, 'index')], paths: [{ path: root,
      generated_output_paths: ['local'], ignore: ['*.tmp'], extensions: ['.md'] }] });
    await advance();
    expect(view).toEqual(new Map([[a, 'source']]));
    events.length = 0;
    write('index/out.md', 'updated'); write('.aiwg/daemon/state.md', 'updated');
    handles[0].hint('rename', '.aiwg/daemon/state.md'); await advance(120);
    expect(events).toEqual([]);
  });

  it('rebuilds state at restart even for modify-only subscriptions, without relying on native events', async () => {
    const a = write('a.md', 'before');
    start({ paths: [{ path: root, events: ['modify'] }] }); await advance();
    expect(view.get(a)).toBe('before');
    watcher.stop(); view.clear(); write('a.md', 'offline');
    start({ paths: [{ path: root, events: ['modify'] }] }); await advance();
    expect(view.get(a)).toBe('offline');
  });

  it('queues during a rebuild and leaves a further reconciliation pending, including a lost event during that rebuild', async () => {
    const a = write('a.md', 'initial');
    let finish;
    const deliver = vi.fn(event => {
      consume(event);
      if (!finish) return new Promise(resolve => { finish = resolve; });
    });
    start({}, { deliver }); await advance();
    write('a.md', 'during');
    const b = write('b.md', 'queued');
    handles[0].hint('change', 'a.md'); await advance(100);
    expect(watcher.getStats().reconciliation_pending).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    finish(); await advance();
    expect(view).toEqual(new Map([[a, 'during'], [b, 'queued']]));
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(watcher.getStats().reconciliation_pending).toBe(false);
  });

  it('converges on an event lost entirely during a rebuild through the periodic pending scan', async () => {
    const a = write('a.md', 'initial');
    let finish;
    const deliver = vi.fn(event => {
      consume(event);
      if (!finish) return new Promise(resolve => { finish = resolve; });
    });
    start({}, { deliver }); await advance();
    write('a.md', 'silent update'); await advance(100);
    expect(watcher.getStats().reconciliation_pending).toBe(true);
    finish(); await advance();
    expect(view.get(a)).toBe('silent update');
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('keeps a further scan pending for changes during the second rebuild', async () => {
    const a = write('a.md', 'initial');
    let finish;
    const deliver = vi.fn(event => {
      consume(event);
      return new Promise(resolve => { finish = resolve; });
    });
    start({}, { deliver }); await advance();
    write('a.md', 'second'); handles[0].hint('change', 'a.md');
    finish(); await advance();
    expect(view.get(a)).toBe('second');
    expect(deliver).toHaveBeenCalledTimes(2);
    write('a.md', 'third'); handles[0].hint('change', 'a.md');
    expect(watcher.getStats().reconciliation_pending).toBe(true);
    finish(); await advance();
    expect(view.get(a)).toBe('third');
    expect(deliver).toHaveBeenCalledTimes(3);
    finish(); await advance();
  });

  it('hands interrupted builds to the shared recovery path without transient retries, then converges after acknowledgement', async () => {
    const router = new EventRouter();
    const recovery = vi.fn(); router.on('schedule-recovery-required', recovery);
    const consumer = vi.fn().mockRejectedValueOnce(new Error('interrupted build')).mockImplementation(consume);
    router.on('event', consumer);
    const a = write('a.md', 'initial');
    start({}, { deliver: event => router.deliver(event) }); await advance();
    expect(recovery).toHaveBeenCalledOnce();
    expect(watcher.getStats().recovery_required).toBe(true);
    write('a.md', 'while blocked'); const b = write('b.md', 'new');
    await advance(1000);
    expect(consumer).toHaveBeenCalledOnce();
    expect(router.getDeadLetterQueue()).toEqual([]);
    watcher.resume(); await advance();
    expect(view).toEqual(new Map([[a, 'while blocked'], [b, 'new']]));
    expect(watcher.getStats().recovery_required).toBe(false);
  });

  it('recovers after a process restart interrupts an in-flight build', async () => {
    const a = write('a.md', 'initial');
    let finish;
    start({}, { deliver: () => new Promise(resolve => { finish = resolve; }) }); await advance();
    watcher.stop(); write('a.md', 'after crash');
    const old = watcher;
    start(); await advance();
    finish(); await Promise.resolve();
    expect(view.get(a)).toBe('after crash');
    expect(old.getStats().events_received).toBe(0);
    expect(watcher.getStats().events_received).toBe(1);
  });

  it('detects root inode replacement and installs a fresh watcher', async () => {
    const a = write('a.md', 'before'); start(); await advance();
    fs.renameSync(root, path.join(directory, 'replaced'));
    write('a.md', 'replacement'); await advance(100);
    expect(view.get(a)).toBe('replacement');
    expect(handles[0].closed).toBe(true);
    expect(handles.filter(handle => !handle.closed)).toHaveLength(1);
  });

  it('can disable routine scans and stops all polling and pending delivery', async () => {
    start({ reconcile_interval_ms: 0 }); await advance();
    write('a.md', 'silent'); await advance(1000);
    expect(view.size).toBe(0);
    handles[0].hint('rename', 'a.md'); watcher.stop(); await advance(1000);
    expect(view.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
