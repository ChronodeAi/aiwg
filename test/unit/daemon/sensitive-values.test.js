import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, fork, spawnSync, execFileSync } from 'node:child_process';
import { Config } from '../../../tools/daemon/config.mjs';
import { initProfile, listProfiles } from '../../../tools/daemon/init-profile.mjs';
import { createMessagingHub } from '../../../tools/messaging/index.mjs';
import { getRegistryStatus } from '../../../tools/messaging/adapter-registry.mjs';
import { ProviderWatcher } from '../../../tools/daemon/provider-watcher.mjs';
import { AgentSupervisor } from '../../../tools/daemon/agent-supervisor.mjs';
import { executeMaintenanceOwner } from '../../../tools/daemon/scheduled-task-runner.mjs';
import { TelegramAdapter } from '../../../tools/messaging/adapters/telegram.mjs';
import { DiscordAdapter } from '../../../tools/messaging/adapters/discord.mjs';
import { SlackAdapter } from '../../../tools/messaging/adapters/slack.mjs';
import { WebServer } from '../../../tools/daemon/web-server.mjs';
import { ChatHandler } from '../../../tools/messaging/chat-handler.mjs';
import { applyChildNiceness } from '../../../tools/daemon/resource-bounds.mjs';

vi.mock('node:child_process');
vi.mock('../../../tools/daemon/ipc-server.mjs', () => ({
  IPCServer: class {
    registerMethods() {}
    async start() {}
    async stop() {}
  },
}));

const surfaces = [
  ['web', 'interface.web.token_ref', 'token', 'AIWG_WEB_TOKEN'],
  ['webhook', 'webhook.secret_env', 'secret', 'AIWG_WEBHOOK_SECRET'],
  ['telegram', 'messaging.telegram.botToken_ref', 'botToken', 'AIWG_TELEGRAM_TOKEN'],
  ['discord', 'messaging.discord.botToken_ref', 'botToken', 'AIWG_DISCORD_TOKEN'],
  ['slack', 'messaging.slack.botToken_ref', 'botToken', 'AIWG_SLACK_BOT_TOKEN'],
  ['slack', 'messaging.slack.webhookUrl_ref', 'webhookUrl', 'AIWG_SLACK_WEBHOOK_URL'],
];
const fixtureValue = 'synthetic-private-value-3079';
let root;

function set(record, key, value) {
  const parts = key.split('.');
  const field = parts.pop();
  for (const part of parts) record = record[part] ??= {};
  record[field] = value;
}
function configWith(key, value) {
  const config = new Config(path.join(root, 'daemon.json'));
  config.config = { daemon: {}, interface: { web: { enabled: true } }, webhook: { enabled: true, port: 9471 },
    messaging: { slack: { webhookUrl: 'https://hooks.slack.com/services/synthetic-webhook' } } };
  if (key) set(config.config, key, value);
  return config;
}
function privateFile() {
  const file = path.join(root, 'private');
  fs.writeFileSync(file, fixtureValue, { mode: 0o600 });
  return file;
}
function output() {
  return ['log', 'warn', 'error'].flatMap(method => console[method].mock.calls).flat().join('\n');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-sensitive-values-'));
  for (const [, , , name] of surfaces) vi.stubEnv(name, '');
  for (const method of ['log', 'warn', 'error']) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(surfaces)('%s credential %s', (recipient, key, field, legacyEnv) => {
  it.each(['file', 'store', 'env'])('resolves %s at startup without modifying saved references or leaking output', async source => {
    const reference = source === 'file' ? `file:${privateFile()}` : source === 'store' ? 'store:synthetic' : 'SYNTHETIC_SECRET';
    const config = configWith(key, reference);
    const readStore = vi.fn(async () => fixtureValue);
    await config.resolveSecrets({ environment: { SYNTHETIC_SECRET: fixtureValue }, readStore,
      isTTY: true, prompt: () => { throw new Error('must not prompt'); } });
    expect(config.recipientConfig(recipient)[field]).toBe(fixtureValue);
    config.save();
    expect(fs.readFileSync(config.configPath, 'utf8')).toContain(reference);
    expect(fs.readFileSync(config.configPath, 'utf8')).not.toContain(fixtureValue);
    expect(output()).not.toContain(fixtureValue);
    expect(readStore).toHaveBeenCalledTimes(source === 'store' ? 1 : 0);
  });

  it.each(['group', 'other', 'symlink', 'hardlink', 'owner'])('refuses an insecure %s file without disclosing bytes', async kind => {
    if (process.platform === 'win32') return;
    let file = privateFile();
    if (kind === 'group') fs.chmodSync(file, 0o640);
    if (kind === 'other') fs.chmodSync(file, 0o604);
    if (kind === 'symlink') { fs.symlinkSync(file, `${file}.link`); file += '.link'; }
    if (kind === 'hardlink') fs.linkSync(file, `${file}.link`);
    if (kind === 'owner') vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);
    const config = configWith(key, `file:${file}`);
    const error = await config.resolveSecrets({ environment: {} }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/group or other access|symlink|hard link|not owned/);
    expect(error.message).toContain(key.replace(/_ref$/, ''));
    expect(`${error.stack}\n${output()}`).not.toContain(fixtureValue);
  });

  it('retains the legacy environment name and exact bytes', async () => {
    const config = configWith();
    if (legacyEnv === 'AIWG_SLACK_WEBHOOK_URL') delete config.config.messaging.slack.webhookUrl;
    const value = ` ${fixtureValue} `;
    await config.resolveSecrets({ environment: { [legacyEnv]: value } });
    expect(config.recipientConfig(recipient)[field]).toBe(value);
  });

  it('fails a selected missing store without falling back to its legacy variable', async () => {
    const config = configWith(key, 'store:missing');
    await expect(config.resolveSecrets({ environment: { [legacyEnv]: fixtureValue }, readStore: async () => null }))
      .rejects.toThrow(/store.*ENV_NAME.*file:ABSOLUTE_PATH.*store:NAME/);
    expect(output()).not.toContain(fixtureValue);
  });
});

it('preserves literal precedence, aliases and bytes, with one warning for all literal config secrets', async () => {
  const config = configWith('interface.web.token', ' WEB_LITERAL ');
  set(config.config, 'messaging.telegram.token', ' TELEGRAM_LITERAL ');
  set(config.config, 'messaging.discord.botToken', ' DISCORD_LITERAL ');
  set(config.config, 'messaging.slack.botToken', ' SLACK_LITERAL ');
  await config.resolveSecrets({ environment: Object.fromEntries(surfaces.map(([, , , env]) => [env, 'env-fallback'])) });
  expect(config.recipientConfig('web').token).toBe(' WEB_LITERAL ');
  expect(config.recipientConfig('telegram').botToken).toBe(' TELEGRAM_LITERAL ');
  expect(config.recipientConfig('discord').botToken).toBe(' DISCORD_LITERAL ');
  expect(config.recipientConfig('slack').botToken).toBe(' SLACK_LITERAL ');
  expect(console.warn).toHaveBeenCalledTimes(1);
  await config.resolveSecrets({ environment: {} });
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(output()).not.toMatch(/WEB_LITERAL|TELEGRAM_LITERAL|DISCORD_LITERAL|SLACK_LITERAL|synthetic-webhook/);
});

it('keeps optional legacy input optional and does not resolve disabled scaffold references', async () => {
  const config = configWith();
  config.config.messaging = { telegram: { enabled: false, token: '${AIWG_TELEGRAM_TOKEN}' } };
  await config.resolveSecrets({ environment: {}, readStore: () => { throw new Error('unexpected store'); } });
  expect(config.recipientConfig('web').token).toBeUndefined();
  expect(config.recipientConfig('webhook').secret).toBeUndefined();
  expect(config.recipientConfig('telegram')).toBeUndefined();
  expect(console.warn).not.toHaveBeenCalled();
});

it('resolves existing enabled ${ENV_NAME} profile references', async () => {
  const config = configWith('messaging.telegram.token', '${SYNTHETIC_TOKEN}');
  await config.resolveSecrets({ environment: { SYNTHETIC_TOKEN: fixtureValue } });
  expect(config.recipientConfig('telegram').botToken).toBe(fixtureValue);
  expect(config.workerEnvironment({ SYNTHETIC_TOKEN: fixtureValue, PATH: '/synthetic/bin' })).toEqual({ PATH: '/synthetic/bin' });
});

it.each(['file:relative', 'store:', '', 'stdin:secret', 'interactive:secret'])('rejects invalid reference %s without prompting', async reference => {
  await expect(configWith('interface.web.token_ref', reference).resolveSecrets({ environment: {} }))
    .rejects.toThrow(/ENV_NAME.*file:ABSOLUTE_PATH.*store:NAME/);
});

it('does not print malformed config contents in parser diagnostics', () => {
  const config = configWith();
  fs.writeFileSync(config.configPath, `{"token":"${fixtureValue}",BROKEN`);
  config.load();
  expect(output()).not.toContain(fixtureValue);
  expect(output()).toContain('Check JSON/YAML syntax');
});

it('daemon-init copies references without reading environment values into either scaffold', () => {
  vi.stubEnv('AIWG_TELEGRAM_TOKEN', fixtureValue);
  vi.stubEnv('AIWG_WEB_TOKEN', fixtureValue);
  const writes = [];
  const exists = fs.existsSync.bind(fs);
  vi.spyOn(fs, 'existsSync').mockImplementation(file => file === '.env.example' ? false : exists(file));
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, content) => writes.push([file, content]));
  for (const profile of listProfiles()) initProfile({ profile, outputPath: path.join(root, `${profile}.yaml`) });
  expect(writes.length).toBeGreaterThan(0);
  expect(JSON.stringify(writes)).toContain('${AIWG_TELEGRAM_TOKEN}');
  expect(JSON.stringify(writes)).not.toContain(fixtureValue);
});

it.each(['network', 'response'])('routes only recipient credentials to actual adapters and redacts reflected %s failures', async failure => {
  const config = configWith('interface.web.token_ref', 'store:web');
  for (const [recipient, key] of surfaces.slice(1)) set(config.config, key, `store:${key}`);
  set(config.config, 'messaging.telegram.defaultChatId', 'synthetic-chat');
  set(config.config, 'messaging.discord.defaultChannelId', 'synthetic-channel');
  const secrets = Object.fromEntries(['web', ...surfaces.slice(1).map(([, key]) => key)].map(name =>
    [name, name.includes('webhookUrl') ? 'https://hooks.slack.com/services/secret-fixture' : `private-${name}`]));
  await config.resolveSecrets({ environment: {}, readStore: async name => secrets[name] });
  const requests = [];
  vi.stubGlobal('fetch', vi.fn());
  // Services can reflect their own secret; unrelated secrets never reach them.
  // Use per-service failures to model that boundary accurately.
  fetch.mockImplementation(async (url, options) => {
    requests.push([url, options]);
    const name = String(url).includes('telegram') ? 'telegram' : String(url).includes('discord') ? 'discord' : 'slack';
    const reflected = Object.entries(secrets).filter(([key]) => key.includes(`messaging.${name}`)).map(([, value]) => value).join(' ');
    if (failure === 'network') throw new Error(`Synthetic network failure ${reflected}`);
    return { ok: false, status: 401, json: async () => ({ ok: false, description: reflected, message: reflected }),
      text: async () => reflected };
  });
  const hub = await createMessagingHub({ chatHandler: false, adapterConfigs: Object.fromEntries(
    ['telegram', 'discord', 'slack'].map(name => [name, config.recipientConfig(name)])) });
  expect(hub).toBeNull();
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    const text = JSON.stringify(request);
    const platform = text.includes('telegram') ? 'telegram' : text.includes('discord') ? 'discord' : 'slack';
    for (const [name, value] of Object.entries(secrets)) {
      if (!name.includes(`messaging.${platform}`)) expect(text).not.toContain(value);
    }
  }
  for (const secret of Object.values(secrets)) expect(output() + JSON.stringify(getRegistryStatus())).not.toContain(secret);
});

it('awaits startup resolution and gives the web server and messaging hub separate recipient configs', async () => {
  vi.stubEnv('AIWG_DAEMON_NO_AUTOSTART', '1');
  const { DaemonMain } = await import('../../../tools/daemon/daemon-main.mjs');
  const captured = {};
  const stub = (name, methods = {}) => class {
    constructor(options) { captured[name] = options; Object.assign(this, methods); }
    on() {}
  };
  const fixture = configWith('interface.web.token_ref', `file:${privateFile()}`);
  set(fixture.config, 'messaging.telegram.botToken', 'synthetic-telegram-only');
  fixture.config.messaging.slack = undefined;
  vi.spyOn(Config.prototype, 'load').mockImplementation(function () { this.config = fixture.config; return this.config; });
  const createHub = vi.fn(async options => { captured.hub = options; return null; });
  const daemon = new DaemonMain({
    MemoryManager: stub('memory', { load: () => ({ project: [], user: [] }) }),
    AgentSupervisor: stub('agent'), DaemonSupervisor: stub('supervisor'),
    BehaviorRegistry: stub('registry', { loadAll: async () => new Map() }),
    DaemonBehaviorLoader: stub('behaviors', { loadAll: async () => new Map() }),
    MessageRouter: stub('router'), AutomationEngine: stub('automation'),
    ScheduledTaskRunner: stub('runner', { start() {} }),
    WebServer: stub('web', { start: async () => {} }), createMessagingHub: createHub,
  });
  daemon.log = vi.fn();
  daemon.taskStorePath = path.join(root, 'tasks.json');
  await daemon.loadConfig();
  await daemon.initializeSubsystems();
  expect(captured.web.token).toBe(fixtureValue);
  expect(captured.hub.adapterConfigs.telegram.botToken).toBe('synthetic-telegram-only');
  expect(JSON.stringify(captured.hub)).not.toContain(fixtureValue);
  expect(JSON.stringify(captured.web)).not.toContain('synthetic-telegram-only');
  expect(JSON.stringify(captured.agent)).not.toContain(fixtureValue);
  expect(output()).not.toContain(fixtureValue);
  expect(daemon.log.mock.calls.flat().join(' ')).not.toContain(fixtureValue);
});

it('authenticates the web UI with only its resolved token', async () => {
  const config = configWith('interface.web.token_ref', `file:${privateFile()}`);
  await config.resolveSecrets({ environment: {} });
  const server = new WebServer(config.recipientConfig('web'));
  const url = new URL('http://localhost/api/status');
  expect(server._checkAuth({ headers: { authorization: `Bearer ${fixtureValue}` } }, url)).toBe(true);
  expect(server._checkAuth({ headers: { authorization: 'Bearer unrelated-recipient' } }, url)).toBe(false);
  expect(output()).not.toContain(fixtureValue);
});

it.each([['telegram', TelegramAdapter], ['discord', DiscordAdapter], ['slack', SlackAdapter]])(
  '%s sends/updates with its own credentials and redacts returned errors and status', async (platform, Adapter) => {
    const config = configWith();
    const token = `${platform}-synthetic-bot-secret`;
    const webhook = 'https://hooks.slack.com/services/synthetic-private-url';
    config.config.messaging = { [platform]: { botToken_ref: 'store:bot', defaultChatId: 'chat', defaultChannelId: 'channel',
      ...(platform === 'slack' ? { webhookUrl_ref: 'store:url' } : {}) } };
    await config.resolveSecrets({ environment: {}, readStore: async name => name === 'bot' ? token : webhook });
    const reflected = [token, encodeURIComponent(token), ...(platform === 'slack' ? [webhook, encodeURIComponent(webhook)] : [])].join(' ');
    let fail = false;
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      requests.push([url, options]);
      return { ok: !fail, status: fail ? 401 : 200, headers: new Headers(), text: async () => fail ? reflected : 'ok',
        json: async () => fail ? { ok: false, description: reflected, message: reflected, error: reflected }
          : { ok: true, id: 'message', username: 'syntheticbot', discriminator: '0001',
            result: { username: 'syntheticbot', chat: { id: 'chat' }, message_id: 1 } } };
    }));
    const adapter = new Adapter(config.recipientConfig(platform));
    const message = { title: 'Synthetic title', body: 'Synthetic body', severity: 'info', project: 'test', timestamp: '2026-01-01T00:00:00Z' };
    await adapter.initialize();
    const sent = await adapter.send(message);
    fail = true;
    const result = await adapter.send(message).catch(error => error.message);
    const update = await adapter.update(sent.messageId ?? sent, message).catch(error => error.message);
    const visible = output() + JSON.stringify([result, update, adapter.getStatus()]);
    expect(visible).not.toContain(token);
    expect(visible).not.toContain(webhook);
    expect(visible).not.toContain(encodeURIComponent(webhook));
    expect(JSON.stringify(requests)).toContain(token);
    if (platform === 'slack') {
      expect(requests.at(-1)[1].headers.Authorization).toBe(`Bearer ${token}`);
      expect(requests[0][0]).toBe(webhook);
    }
    await adapter.shutdown();
  });

it('keeps daemon-only secrets out of worker argv and environments while preserving provider auth', async () => {
  const config = configWith('interface.web.token_ref', 'SYNTHETIC_WEB');
  await config.resolveSecrets({ environment: { SYNTHETIC_WEB: fixtureValue } });
  const environment = config.workerEnvironment({ SYNTHETIC_WEB: fixtureValue, AIWG_WEB_TOKEN: 'legacy-secret',
    COPY_OF_WEB: fixtureValue, ANTHROPIC_API_KEY: 'synthetic-provider-auth', PATH: '/synthetic/bin' });
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(), send: vi.fn() });
  spawn.mockReturnValue(child);
  fork.mockReturnValue(child);
  const supervisor = new AgentSupervisor({ environment });
  supervisor.submit('synthetic prompt');
  child.emit('exit', 0);
  const chat = new ChatHandler({ environment });
  const answer = chat.processMessage('synthetic prompt', { chatId: 'chat', platform: 'telegram' });
  child.stdout.emit('data', Buffer.from('synthetic reply'));
  child.emit('exit', 0);
  expect((await answer).response).toBe('synthetic reply');
  const receipt = executeMaintenanceOwner({ id: 'synthetic', kind: 'index.verify' }, { environment });
  child.emit('message', { exitStatus: 0 });
  child.emit('exit', 0);
  await receipt;
  for (const calls of [spawn.mock.calls, fork.mock.calls]) {
    expect(calls).toHaveLength(calls === spawn.mock.calls ? 2 : 1);
    expect(JSON.stringify(calls)).not.toContain(fixtureValue);
    expect(JSON.stringify(calls)).not.toContain('legacy-secret');
    expect(calls[0][2].env.ANTHROPIC_API_KEY).toBe('synthetic-provider-auth');
  }
  expect(output()).not.toContain(fixtureValue);
});

it('keeps daemon secrets out of the npm provider watcher while preserving npm configuration', async () => {
  const config = configWith('interface.web.token_ref', 'SYNTHETIC_WEB');
  await config.resolveSecrets({ environment: { SYNTHETIC_WEB: fixtureValue } });
  const environment = config.workerEnvironment({ SYNTHETIC_WEB: fixtureValue,
    npm_config_registry: 'https://registry.example.test/', PATH: '/synthetic/bin' });
  execFileSync.mockReturnValue(JSON.stringify({ version: '1.2.3' }));
  const watcher = new ProviderWatcher({ stateDir: path.join(os.tmpdir(), 'aiwg-unused-watch'), environment });
  const change = await watcher.checkNpm('fixture', { url: 'synthetic-package' }, { lastSeenVersions: {} });
  expect(change).toMatchObject({ newVersion: '1.2.3' });
  const options = execFileSync.mock.calls.at(-1)[2];
  expect(options.env.npm_config_registry).toBe('https://registry.example.test/');
  expect(JSON.stringify(execFileSync.mock.calls)).not.toContain(fixtureValue);
});

it('keeps daemon credentials out of scheduling-priority helper argv and environment', () => {
  if (process.platform !== 'linux') return;
  vi.stubEnv('AIWG_WEB_TOKEN', fixtureValue);
  vi.stubEnv('SYNTHETIC_CUSTOM_SECRET', fixtureValue);
  vi.spyOn(os, 'setPriority').mockImplementation(() => {});
  spawnSync.mockReturnValue({ status: 0 });
  expect(applyChildNiceness(123)).toMatchObject({ applied: true, ioIdle: true });
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(spawnSync.mock.calls)).not.toContain(fixtureValue);
});
