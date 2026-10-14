import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => vi.restoreAllMocks());
import { createBridge, fetchJsonFirst } from '../../../apps/cockpit/bridge/src/server.mjs';

const page = await readFile(new URL('../../../apps/cockpit/bridge/src/public/index.html', import.meta.url), 'utf8');
const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const payload = `"' autofocus onfocus="globalThis.pwned=1"><img src=x onerror="globalThis.pwned=1">&`;
const attachUrl = 'ws://127.0.0.1:8140/api/pty/agents/instance/sessions/session/attach/nonce';
const escaped = '&quot;&#39; autofocus onfocus=&quot;globalThis.pwned=1&quot;&gt;&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt;&amp;';

// Exercise the page's real loaders and WebSocket listener, recording the HTML
// passed to the DOM. No test-only copy of its rendering or escaping logic.
function screen(responses) {
  const elements = new Map();
  const element = () => ({
    innerHTML: '', textContent: '', value: '', children: [], attributes: {}, listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    querySelectorAll() { return []; },
    replaceChildren(...children) { this.children = children; this.innerHTML = ''; },
    append(child) { this.children.push(child); },
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const sockets = [];
  const context = vm.createContext({
    document: { getElementById: get, querySelectorAll: () => [], createElement: element },
    window: {}, location: { hash: '', protocol: 'http:', host: '127.0.0.1:8140' }, URLSearchParams, URL,
    fetch: async (url) => ({ ok: true, json: async () => url === '/bootstrap/session' ? { csrf: 'test-csrf' } : responses[url] instanceof Error ? (() => { throw responses[url]; })() : responses[url] }),
    WebSocket: class {
      constructor() { this.listeners = {}; sockets.push(this); }
      addEventListener(name, listener) { this.listeners[name] = listener; }
    },
  });
  vm.runInContext(script + '\nglobalThis.ui = { esc, loadInventory, loadRunning, loadInstances, loadSessions, loadApprovals, loadActions, attach, discover, showCap, validatedAttachUrl };', context);
  return { ui: context.ui, get, sockets };
}

describe('Cockpit bridge UI security', () => {
  it('escapes both quote types, markup and ampersands in the shared escaper', () => {
    const { ui } = screen({ '/api/inventory': { instances: [] } });
    expect(ui.esc(payload)).toBe(escaped);
    expect(ui.esc('Tom & "Sam" <team>')).toBe('Tom &amp; &quot;Sam&quot; &lt;team&gt;');
    expect(ui.esc("x' onmouseover='bad` value")).toBe('x&#39; onmouseover=&#39;bad` value');
  });

  it('keeps hostile inventory, task, session, approval and action values inert in HTML and attributes', async () => {
    const { ui, get } = screen({
      '/api/inventory': { instances: [
        { id: payload, runtime: payload, loadout: payload, state: payload, tenant: payload },
        { id: payload, state: 'running' },
      ] },
      '/api/running': { count: payload, running: [{ instance_id: payload, task_id: payload, state: payload, tenant: payload }] },
      '/api/cost': { total: { usd: 1, input_tokens: payload, output_tokens: payload } },
      '/api/sessions?instance=instance': { sessions: [{ attach_url: attachUrl, id: payload, seq: payload, members: payload }] },
      '/api/approvals?status=pending': { approvals: [{ id: payload, instance_id: payload, prompt: payload, risk: payload }] },
      '/api/show?type=skill&name=hostile': { body: payload },
      '/api/capabilities?q=hostile&type=skill&limit=10': { results: [{ type: payload, name: payload, capability: payload }] },
      '/api/contributions': { actions: [{ id: payload, title: payload, icon: payload, inject: { command: payload } }] },
    });
    await ui.loadInventory();
    await ui.loadRunning();
    await ui.loadInstances();
    get('sel-instance').value = 'instance';
    await ui.loadSessions();
    await ui.loadApprovals();
    await ui.loadActions();
    get('ex-q').value = 'hostile';
    get('ex-type').value = 'skill';
    await ui.discover();
    await ui.showCap({ type: 'skill', name: 'hostile' });

    for (const id of ['inventory-view', 'running-view', 'sel-instance', 'approvals-view', 'actions-bar', 'ex-results', 'ex-body']) {
      const html = get(id).innerHTML;
      expect(html, id).toContain(escaped);
      expect(html, id).not.toContain(payload);
      expect(html, id).not.toMatch(/<(?:img|script|svg)\b/i);
      expect(html, id).not.toMatch(/"\s+(?:autofocus|onfocus|onerror)\b/);
    }
    expect(get('inventory-view').innerHTML).toContain(`title="${escaped}"`);
    expect(get('inventory-view').innerHTML).toContain(`data-id="${escaped}"`);
    expect(get('inventory-view').innerHTML).toContain(`class="state ${escaped}"`);
    const shortId = ui.esc(payload.slice(0, 8) + '…');
    for (const action of ['Start', 'Stop', 'Destroy']) {
      expect(get('inventory-view').innerHTML).toContain(`aria-label="${action} ${shortId}"`);
    }
    expect(get('running-view').innerHTML).toContain(`title="${escaped}"`);
    expect(get('running-view').innerHTML).toContain(`class="state ${escaped}"`);
    expect(get('running-view').innerHTML).toContain(`data-i="${escaped}" data-t="${escaped}"`);
    expect(get('running-view').innerHTML).toContain(`aria-label="Stop task ${shortId}"`);
    expect(get('sel-instance').innerHTML).toContain(`value="${escaped}"`);
    expect(get('sel-session').children[0].value).toBe(attachUrl);
    expect(get('sel-session').children[0].textContent).toBe(`${payload} · seq ${payload} · ${payload} viewer(s)`);
    expect(get('approvals-view').innerHTML).toContain(`data-id="${escaped}"`);
    expect(get('approvals-view').innerHTML).toContain(`title="${escaped}"`);
    expect(get('approvals-view').innerHTML).toContain(`class="badge "`);
    expect(get('actions-bar').innerHTML).toContain(`data-id="${escaped}"`);
    expect(get('actions-bar').innerHTML).toContain(`title="injects: ${escaped}"`);
    expect(get('ex-results').innerHTML).toContain('data-i="0"');
  });

  it('renders WebSocket roles using text and preserves controller behavior', () => {
    const { ui, get, sockets } = screen({ '/api/inventory': { instances: [] } });
    get('sel-session').value = attachUrl;
    ui.attach(false);
    const assign = (role) => sockets[0].listeners.message({ data: JSON.stringify({ op: 'role_assigned', payload: { role } }) });
    assign(payload);
    expect(get('role-badge').children).toEqual([]);
    expect(get('cmd').disabled).toBe(true);
    assign('controller');
    expect(get('role-badge').children[0].textContent).toBe('controller');
    expect(get('cmd').disabled).toBe(false);
    expect(get('cmd-send').disabled).toBe(false);
    assign('observer');
    expect(get('role-badge').children[0].attributes.class).toBe('badge observer');
    expect(get('cmd').disabled).toBe(true);
  });

  it('rejects foreign and executable attach URLs before opening a WebSocket', () => {
    const { ui, get, sockets } = screen({ '/api/inventory': { instances: [] } });
    for (const value of ['javascript:alert(1)', 'ws://evil.example/attach', attachUrl.replace('8140', '9999'), attachUrl.replace('ws:', 'wss:'), attachUrl.replace('://', '://user:secret@'), attachUrl + '?token=secret']) {
      get('sel-session').value = value;
      ui.attach(false);
    }
    expect(sockets).toEqual([]);
    expect(ui.validatedAttachUrl(attachUrl)).toBe(attachUrl);
  });

  it('renders session load errors as literal option text', async () => {
    const { ui, get } = screen({ '/api/inventory': { instances: [] }, '/api/sessions?instance=instance': new Error(payload) });
    get('sel-instance').value = 'instance';
    await ui.loadSessions();
    expect(get('sel-session').children[0].textContent).toBe(payload);
    expect(get('sel-session').children[0].value).toBe('');
    expect(get('sel-session').innerHTML).toBe('');
  });
});

// Feed the actual HTTP handler without opening a listening socket. The fetch
// seam records every outbound request, including redirect and bearer options.
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const request = (bridge, path, { method = 'GET', body } = {}) => new Promise((resolve) => {
  const req = { method, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); }, url: path, socket: { encrypted: false }, headers: { host: '127.0.0.1:8140', authorization: `Bearer ${bridge.cockpitToken}` } };
  let status;
  const responseHeaders = new Headers();
  bridge.emit('request', req, {
    setHeader(name, value) { responseHeaders.set(name, value); },
    writeHead(value, headers) { status = value; for (const [name, header] of Object.entries(headers ?? {})) responseHeaders.set(name, header); },
    end(body) { resolve(new Response(body, { status, headers: responseHeaders })); },
  });
});

const executorUrl = 'http://127.0.0.1:8122';

describe('Cockpit bridge outbound security', () => {
  it('allows the configured origin and rejects other hosts, ports, schemes and URL credentials before sending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));
    expect((await fetchJsonFirst([`${executorUrl}/allowed`], { executorUrl })).body).toEqual({ ok: true });
    for (const target of [
      'http://169.254.169.254/latest/meta-data', 'http://untrusted.example/',
      executorUrl.replace('127.0.0.1', 'localhost'), executorUrl.replace(/:\d+$/, ':1'),
      executorUrl.replace('http:', 'https:'), executorUrl.replace('http:', 'ftp:'),
      executorUrl.replace('://', '://user:password@'),
      '/relative-target', 'not a URL',
    ]) {
      await expect(fetchJsonFirst([target], { executorUrl })).rejects.toMatchObject({ code: 'executor_target_refused' });
    }
    expect(outbound).toHaveBeenCalledExactlyOnceWith(new URL(`${executorUrl}/allowed`), expect.objectContaining({ redirect: 'manual' }));
  });

  it('rejects non-HTTP executor configuration and credentials', () => {
    for (const executorUrl of ['file:///etc/passwd', 'ftp://127.0.0.1', 'http://user:password@127.0.0.1']) {
      expect(() => createBridge({ executorUrl })).toThrow(/HTTP\(S\) without URL credentials/);
    }
    const bridge = createBridge({ executorUrl: 'https://executor.example:8443' });
    expect(bridge.listening).toBe(false);
  });

  it('uses an explicit allowlist over request context without forwarding its bearer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wp2-explicit-origin-'));
    const tokenFile = join(directory, 'executor.token');
    await writeFile(tokenFile, 'synthetic-secret', { mode: 0o600 });
    const other = 'http://127.0.0.1:9234';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ results: [] }));
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, executorTokenFile: tokenFile, aiwgCommand: async () => {
      await expect(fetchJsonFirst([`${executorUrl}/wrong`], { executorUrl: other })).rejects.toMatchObject({ code: 'executor_target_refused' });
      const result = await fetchJsonFirst([`${other}/explicit`], { executorUrl: other });
      await fetchJsonFirst([`${executorUrl}/context`]);
      return JSON.stringify(result.body);
    } });
    try {
      expect((await request(bridge, '/api/capabilities?q=test')).status).toBe(200);
      expect(outbound.mock.calls.map(([target]) => target.href)).toEqual([`${other}/explicit`, `${executorUrl}/context`]);
      expect(outbound.mock.calls[0][1].headers.has('authorization')).toBe(false);
      expect(outbound.mock.calls[1][1].headers.get('authorization')).toBe('Bearer synthetic-secret');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('skips a refused POST candidate without sending it or suppressing the fixed fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ created: true }, 201));
    const result = await fetchJsonFirst(['http://untrusted.example/operation', `${executorUrl}/fallback`], { executorUrl, method: 'POST', body: '{}' });
    expect(result.status).toBe(201);
    expect(outbound).toHaveBeenCalledExactlyOnceWith(new URL(`${executorUrl}/fallback`), expect.objectContaining({ method: 'POST' }));
  });

  it('refuses a real redirect without sending credentials to its destination', async () => {
    const hits = [];
    const destination = http.createServer((req, res) => { hits.push(req.headers.authorization); res.end('{}'); });
    await new Promise((resolve, reject) => { destination.once('error', reject); destination.listen(0, '127.0.0.1', resolve); });
    const upstream = http.createServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/leak` });
      res.end();
    });
    try {
      await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
      const root = `http://127.0.0.1:${upstream.address().port}`;
      await expect(fetchJsonFirst([`${root}/redirect`], { executorUrl: root, headers: { authorization: 'Bearer synthetic-secret' } })).rejects.toMatchObject({ code: 'executor_redirect_refused' });
      expect(hits).toEqual([]);
    } finally {
      upstream.closeAllConnections(); destination.closeAllConnections();
      await Promise.all([upstream, destination].map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });

  it.each([301, 302, 303, 307, 308])('refuses cross-origin %i redirects and never retries a POST', async (status) => {
    const response = new Response('redirect body', {
      status, headers: { location: 'http://untrusted.example/private' },
    });
    const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(fetchJsonFirst([`${executorUrl}/redirect`, `${executorUrl}/fallback`], {
      executorUrl, method: 'POST', body: '{}', headers: { authorization: 'Bearer synthetic-secret' },
    })).rejects.toMatchObject({ code: 'executor_redirect_refused' });
    expect(outbound).toHaveBeenCalledExactlyOnceWith(new URL(`${executorUrl}/redirect`), expect.objectContaining({
      method: 'POST', body: '{}', redirect: 'manual',
    }));
    expect(outbound.mock.calls[0][1].headers.get('authorization')).toBe('Bearer synthetic-secret');
    expect(response.bodyUsed).toBe(true);
  });

  it.each([301, 302, 303, 307, 308])('refuses same-origin %i redirects without replaying the body or bearer', async (status) => {
    for (const location of ['/agents/other/v1/tasks', `${executorUrl}/admin/instances`]) {
      const response = new Response('redirect body', { status, headers: { location } });
      const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
      await expect(fetchJsonFirst([`${executorUrl}/first`, `${executorUrl}/fallback`], {
        executorUrl, method: 'POST', body: '{"task":"private"}',
        headers: { authorization: 'Bearer synthetic-secret', 'content-type': 'application/json' },
      })).rejects.toMatchObject({ code: 'executor_redirect_refused' });
      expect(outbound).toHaveBeenCalledExactlyOnceWith(new URL(`${executorUrl}/first`), expect.objectContaining({
        method: 'POST', body: '{"task":"private"}', redirect: 'manual',
      }));
      expect(outbound.mock.calls[0][1].headers.get('authorization')).toBe('Bearer synthetic-secret');
      expect(outbound.mock.calls[0][1].headers.get('content-type')).toBe('application/json');
      expect(response.bodyUsed).toBe(true);
      outbound.mockRestore();
    }
  });

  it.each([300, 304, 305, 306, 399])('refuses %i without Location and never tries a GET fallback', async (status) => {
    const response = new Response(null, { status });
    const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(fetchJsonFirst([`${executorUrl}/first`, `${executorUrl}/fallback`], { executorUrl }))
      .rejects.toMatchObject({ code: 'executor_redirect_refused' });
    expect(outbound).toHaveBeenCalledExactlyOnceWith(new URL(`${executorUrl}/first`), expect.objectContaining({ redirect: 'manual' }));
  });

  it('refuses a redirect loop on its first response', async () => {
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, {
      status: 302, headers: { location: '/loop' },
    }));
    await expect(fetchJsonFirst([`${executorUrl}/loop`], { executorUrl })).rejects.toMatchObject({ code: 'executor_redirect_refused' });
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it('skips hostile AgentCard origins and paths and uses a fixed agent fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let cardUrl;
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (target) => {
      if (target.pathname === '/admin/instances') return jsonResponse({ instances: [{ id: 'instance', state: 'running', runtime: 'host' }] });
      if (target.pathname.endsWith('/.well-known/agent-card.json')) return jsonResponse({ protocolVersion: '0.3.0', url: cardUrl });
      if (target.pathname === '/agents/instance/v1/tasks') return jsonResponse({ tasks: [{ id: 'task', status: { state: 'working' } }] });
      return jsonResponse({ error: 'not_found' }, 404);
    });
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, a2aProtocolPolicy: '0.3', executorTokenFile: '' });
    for (const url of ['http://untrusted.example', `${executorUrl}/admin/instances/victim/delete`, `${executorUrl}/agents/victim`, `${executorUrl}/agents/instance?admin=true`, `${executorUrl}/agents/instance/../victim`]) {
      cardUrl = url;
      const response = await request(bridge, '/api/running');
      expect(response.status).toBe(200);
      expect((await response.json()).running).toMatchObject([{ instance_id: 'instance', task_id: 'task' }]);
    }
    expect(outbound.mock.calls.length).toBeGreaterThan(0);
    expect(outbound.mock.calls.every(([target]) => target.origin === executorUrl)).toBe(true);
    expect(outbound.mock.calls.some(([target]) => /victim|delete/.test(target.pathname))).toBe(false);
  });

  it('checks the PTY target host, port, scheme and credentials before issuing an attach URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attachUrl;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (target) => {
      if (target.pathname === '/agents/instance/sessions') return jsonResponse({ sessions: [{ id: 'session', attach_url: attachUrl }] });
      return jsonResponse({ error: 'not_found' }, 404);
    });
    const bridge = createBridge({ executorUrl, allowMockExecutor: true });
    for (const target of [
      'ws://untrusted.example:8122', 'ws://127.0.0.1:9999',
      'wss://127.0.0.1:8122', 'ws://user:secret@127.0.0.1:8122',
    ]) {
      attachUrl = `${target}/agents/instance/sessions/session/attach`;
      const response = await request(bridge, '/api/sessions?instance=instance');
      expect(response.status).toBe(502);
      expect((await response.json()).error).toBe('executor_attach_target_refused');
    }
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      attachUrl = `ws://${host}:8122/agents/instance/sessions/session/attach`;
      const allowed = await request(bridge, '/api/sessions?instance=instance');
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).sessions[0].attach_url).toMatch(/^ws:\/\/127\.0\.0\.1:8140\/api\/pty\/agents\//);
    }
  });

  it.each(['attach_url', 'pty_ws_url'])('validates a %s PTY upgrade against its bridge instance', async (field) => {
    const root = 'http://127.0.0.1:9234';
    const directory = await mkdtemp(join(tmpdir(), 'wp2-pty-upgrade-'));
    const tokenFile = join(directory, 'executor.token');
    await writeFile(tokenFile, 'synthetic-pty-token', { mode: 0o600 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (target) => target.pathname === '/agents/instance/sessions'
      ? jsonResponse({ sessions: [{ id: 'session', [field]: field === 'pty_ws_url' ? 'wss://{host}/agents/instance/sessions/session/attach' : 'ws://localhost:9234/agents/instance/sessions/session/attach' }] })
      : jsonResponse({ error: 'not_found' }, 404));
    const bridge = createBridge({ executorUrl: root, executorTokenFile: tokenFile, allowMockExecutor: true });
    try {
      const sessions = await (await request(bridge, '/api/sessions?instance=instance')).json();
      const upstreamRequest = new EventEmitter();
      upstreamRequest.end = vi.fn();
      const outbound = vi.spyOn(http, 'request').mockReturnValue(upstreamRequest);
      const socket = { destroyed: false, end: vi.fn() };
      bridge.emit('upgrade', { url: new URL(sessions.sessions[0].attach_url).pathname, headers: {
        host: '127.0.0.1:8140', 'sec-websocket-protocol': `cockpit.${Buffer.from(bridge.cockpitToken).toString('base64url')}`,
        'sec-websocket-key': 'synthetic-key', 'sec-websocket-version': '13',
      } }, socket, Buffer.alloc(0));
      await vi.waitFor(() => expect(outbound).toHaveBeenCalledOnce());
      expect(outbound.mock.calls[0][0].href).toBe(`${root}/agents/instance/sessions/session/attach`);
      expect(outbound.mock.calls[0][1].headers.authorization).toBe('Bearer synthetic-pty-token');
      expect(socket.end).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ['admin.unavailable', true], ['a'.repeat(64), true], ['Bad Code', false],
    ['a'.repeat(65), false], ['', false], ['<private>', false], ['safe\n', false],
  ])('projects only a safe degraded inventory code: %s', async (code, valid) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (target) => target.pathname === '/admin/instances'
      ? jsonResponse({ code, status: 'private', title: 'private-title', detail: 'private-detail', error: 'private-error' }, 503)
      : jsonResponse({ agents: [] }));
    const bridge = createBridge({ executorUrl, allowMockExecutor: true });
    const response = await request(bridge, '/api/inventory');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.admin_error).toEqual({ status: 503, ...(valid ? { code } : {}) });
    expect(body.degraded_admin_inventory).toBe('/admin/instances returned 503');
    expect(JSON.stringify(body)).not.toMatch(/private-/);
  });

  it.each([401, 403, 404, 405, 429, 500, 503])('logs each %i upstream response once with bounded redacted detail', async (status) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({
      detail: 'operator-reason http://user:password@executor.example/path?token=query-secret',
      token: 'nested-secret', diagnostic: 'x'.repeat(10000),
    }, status));
    const bridge = createBridge({ executorUrl, allowMockExecutor: true });
    for (const path of ['/api/operations/operation', '/api/cost']) {
      log.mockClear(); outbound.mockClear();
      await request(bridge, path);
      const entries = log.mock.calls.filter(([message]) => message === '[cockpit-bridge] upstream request failed');
      expect(entries).toHaveLength(outbound.mock.calls.length);
      expect(entries.length).toBeGreaterThan(0);
      for (const [, entry] of entries) {
        expect(entry.status).toBe(status);
        expect(Buffer.byteLength(entry.body)).toBeLessThanOrEqual(4096);
        expect(entry.body).toContain('operator-reason');
        expect(entry.body).not.toMatch(/password|query-secret|nested-secret/);
      }
    }
  });

  it('logs a non-JSON upstream failure and a refused redirect once each', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('redirect diagnostic token=redirect-secret', { status: 307, headers: { location: '/last' } }))
      .mockResolvedValueOnce(new Response('plain diagnostic Bearer text-secret', { status: 500 }));
    await expect(fetchJsonFirst([`${executorUrl}/first`], { executorUrl })).rejects.toMatchObject({ code: 'executor_redirect_refused' });
    expect(log).toHaveBeenCalledTimes(1);
    await fetchJsonFirst([`${executorUrl}/failure`], { executorUrl });
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).toMatch(/redirect diagnostic/);
    expect(JSON.stringify(log.mock.calls)).toMatch(/plain diagnostic/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/redirect-secret|text-secret/);
  });

  it.each([
    [429, '120', '120'], [503, 'Wed, 21 Oct 2026 07:28:00 GMT', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    [503, 'not a date', null], [429, '-1', null], [429, '1.5', null],
    [503, 'Wed, 99 Oct 2026 07:28:00 GMT', null], [500, '120', null], [503, null, null],
  ])('forwards only valid Retry-After for status %i and value %s', async (status, value, expected) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = await mkdtemp(join(tmpdir(), 'wp2-retry-after-'));
    const mcpTokenFile = join(directory, 'mcp.token');
    await writeFile(mcpTokenFile, 'synthetic-mcp', { mode: 0o600 });
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status,
      headers: { ...(value ? { 'retry-after': value } : {}), 'x-private-upstream': 'private' },
    }));
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, mcpTokenFile, auditDir: directory });
    try {
      for (const [path, options] of [
        ['/api/operations/operation', {}], ['/api/cost', {}],
        ['/api/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }],
        ['/api/instances/instance/start', { method: 'POST' }],
      ]) {
        log.mockClear(); outbound.mockClear();
        const response = await request(bridge, path, options);
        expect(log.mock.calls.filter(([message]) => message === '[cockpit-bridge] upstream request failed')).toHaveLength(outbound.mock.calls.length);
        expect(outbound).toHaveBeenCalled();
        expect(response.status, path).toBe(status);
        expect(response.headers.get('retry-after'), path).toBe(expected);
        expect(response.headers.has('x-private-upstream'), path).toBe(false);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('projects managed Docker and version errors without logging a second time', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      message: 'refuses startup profiles that materialize raw credential refs', detail: 'private',
    }, 422));
    const managed = await fetchJsonFirst([`${executorUrl}/launch`], { executorUrl });
    expect(managed.body.error).toBe('managed_docker_raw_credentials_rejected');
    expect(log).toHaveBeenCalledTimes(1);
    log.mockClear();
    outbound.mockResolvedValue(jsonResponse({ code: 'version_not_supported', detail: 'private' }, 400));
    const version = await fetchJsonFirst([`${executorUrl}/tasks`], { executorUrl });
    expect(version.body).toEqual({ error: 'version_not_supported', code: 'version_not_supported', message: 'Bridge request failed.' });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('returns generic errors and logs the original stack only on the server', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('private-path-and-secret\n    at internalFunction (/private/server.mjs:42:7)');
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, aiwgCommand: async () => { throw failure; } });
    const response = await request(bridge, '/api/capabilities?q=anything');
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'bridge_upstream_error', message: 'Bridge request failed.' });
    expect(body).not.toMatch(/stack|private-path|internalFunction|server\.mjs/);
    expect(log).toHaveBeenCalledWith('[cockpit-bridge] request failed', expect.objectContaining({ stack: failure.stack }));
    expect(log.mock.calls[0][1].stack).toContain('internalFunction');
  });

  it('redacts URL credentials, query tokens and bearer headers from error logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('http://user:password@executor.example/path?token=query-secret Authorization: Bearer header-secret');
    failure.headers = { authorization: 'Bearer nested-secret' };
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, aiwgCommand: async () => { throw failure; } });
    expect((await request(bridge, '/api/capabilities?q=test')).status).toBe(502);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('http://executor.example/path');
    expect(logged).not.toMatch(/user|password|query-secret|header-secret|nested-secret/);
  });

  it('does not expose exception diagnostics through an arbitrary error code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = Object.assign(new Error('private subprocess stderr'), { code: 'private-path'.repeat(1000) });
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, aiwgCommand: async () => { throw failure; } });
    const response = await request(bridge, '/api/capabilities?q=test');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'bridge_upstream_error', message: 'Bridge request failed.' });
  });

  it('keeps activity validation errors actionable without echoing hostile filter names', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = createBridge({ executorUrl, allowMockExecutor: true });
    const scope = await request(bridge, '/api/activity/coverage', { method: 'POST', body: {} });
    expect(scope.status).toBe(400);
    expect(await scope.json()).toEqual({ error: 'activity_scope_required', message: 'Activity requires tenant_id, host_id, instance_id and agent_id.' });
    const invalid = await request(bridge, '/api/activity/timeline', { method: 'POST', body: { tenant_id: 't', host_id: 'h', instance_id: 'i', agent_id: 'a', filter: { [payload]: 'x' } } });
    expect(invalid.status).toBe(400);
    const text = await invalid.text();
    expect(text).toContain('Activity filters must use supported names');
    expect(text).not.toContain(payload);
  });

  it('preserves safe bootstrap recovery without accepting upstream recovery text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ status: 'disabled', recovery: 'private-path', ca_provider: { configured: false }, bootstrap: { token_store_configured: false } }));
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, requireSandboxMtls: true });
    const response = await request(bridge, '/api/inventory');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'executor_trust_required', message: 'Bridge request failed.', recovery: 'Plaintext local development mode only; enable sandbox mTLS before using remote or shared executors.' });
  });

  it('retains safe A2A version negotiation when an upstream error contains private diagnostics', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (target) => {
      if (target.pathname === '/admin/instances') return jsonResponse({ instances: [{ id: 'instance', state: 'running', runtime: 'host' }] });
      if (target.pathname.endsWith('/.well-known/agent-card.json')) return jsonResponse({ supportedInterfaces: [
        { url: `${executorUrl}/agents/instance`, protocolVersion: '1.0', protocolBinding: 'HTTP+JSON' },
        { url: `${executorUrl}/agents/instance`, protocolVersion: '0.3', protocolBinding: 'REST' },
      ] });
      if (target.pathname === '/agents/instance/tasks') return jsonResponse({ type: 'https://a2a-protocol.org/errors/version-not-supported', stack: 'private-path' }, 400);
      if (target.pathname === '/agents/instance/v1/tasks') return jsonResponse({ tasks: [{ id: 'task', status: { state: 'working' } }] });
      return jsonResponse({ error: 'not_found' }, 404);
    });
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, a2aProtocolPolicy: 'auto', allowA2AProtocolFallback: true });
    const response = await request(bridge, '/api/running');
    expect(response.status).toBe(200);
    expect((await response.json()).running).toMatchObject([{ task_id: 'task' }]);
  });

  it('drops upstream stack, detail, recovery and nested error messages from failed proxy responses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = await mkdtemp(join(tmpdir(), 'wp2-proxy-errors-'));
    const mcpTokenFile = join(directory, 'mcp.token');
    await writeFile(mcpTokenFile, 'synthetic-mcp', { mode: 0o600 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ error: { message: 'private-path', stack: 'at /private/executor.mjs:42' }, detail: 'private-path', recovery: 'private-path', stack: 'private-path' }, 500));
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, mcpTokenFile, auditDir: directory });
    try {
      for (const [path, options] of [['/api/operations/operation', {}], ['/api/cost', {}], ['/api/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }]]) {
        const response = await request(bridge, path, options);
        expect(response.status, path).toBe(500);
        expect(await response.json()).toEqual({ error: 'bridge_upstream_error', message: 'Bridge request failed.' });
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps locally caught screen, capability, discovery and CLI failures generic', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-path at /private/executor.mjs:42'));
    const directory = await mkdtemp(join(tmpdir(), 'wp2-local-errors-'));
    const bridge = createBridge({ executorUrl, allowMockExecutor: true, auditDir: directory, aiwgCommand: async () => { throw new Error('private-path CLI diagnostics'); } });
    try {
      for (const [path, options] of [
        ['/api/instances/instance/sessions/session/screen', {}], ['/api/executor/capabilities', {}],
        ['/api/mcp/discovery', {}], ['/api/show?type=skill&name=missing', {}],
        ['/api/index/graphs', { method: 'POST', body: { name: 'invalid/name' } }],
        ['/api/instances/instance/sessions', { method: 'POST' }],
        ['/api/approvals/instance%3A%3Atask?decision=approve', { method: 'POST' }],
      ]) {
        const response = await request(bridge, path, options);
        const text = await response.text();
        expect(text, path).not.toMatch(/private-path|executor\.mjs|diagnostics/);
        if (!path.endsWith('/sessions')) expect(text, path).toContain('Bridge request failed.');
        else expect(text).toContain('agent_not_registered');
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps errors in a local proxy catch generic without changing fallback status', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ error: 'not_found' }, 404));
    const bridge = createBridge({ executorUrl, allowMockExecutor: true });
    const response = await request(bridge, '/api/operations/operation');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'upstream_not_found', message: 'Bridge request failed.' });
    expect(log).toHaveBeenCalled();
  });
});
