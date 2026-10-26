import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { normalizeResources } from './resource-bounds.mjs';
import { importImpl } from '../_resolve-impl.mjs';
import { validateUpdatePolicy } from './update-policy.mjs';

const { validateMemoryJobArgs } = await importImpl(import.meta.url, 'housekeeper/daemon-config.js');
const { resolveSensitiveInput } = await importImpl(import.meta.url, 'auth/sensitive-input.js');
const { credentialReferenceInput } = await importImpl(import.meta.url, 'mcp/credentials.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
  daemon: {
    // 'default' runs the full conversational stack; 'housekeeper' loads only
    // the scheduler/runner/store, watcher/router and minimal IPC (epic #3353).
    profile: 'default',
    heartbeat_interval_seconds: 30,
    max_parallel_actions: 3,
    action_timeout_minutes: 120,
    log: {
      max_size_mb: 50,
      max_files: 5,
      level: 'info'
    }
  },
  watch: {
    enabled: true,
    paths: [
      {
        path: '.aiwg/',
        events: ['create', 'modify', 'delete'],
        ignore: ['*.tmp', 'working/**', 'daemon/**']
      },
      {
        path: 'src/',
        events: ['modify'],
        extensions: ['.ts', '.js', '.mjs']
      },
      {
        path: 'test/',
        events: ['modify'],
        extensions: ['.test.ts', '.test.js']
      }
    ],
    debounce_ms: 2000,
    reconcile_interval_ms: 60000,
    polling: false,
    poll_interval_ms: 5000,
    generated_output_paths: ['.aiwg/daemon/']
  },
  webhook: {
    enabled: false,
    port: 9471,
    host: '127.0.0.1',
    secret_env: 'AIWG_WEBHOOK_SECRET',
    endpoints: [
      { path: '/ci', method: 'POST' },
      { path: '/health', method: 'GET' }
    ]
  },
  schedule: {
    enabled: true,
    jobs: [
      {
        id: 'health-check',
        cron: '0 */6 * * *',
        action: 'doctor'
      },
      {
        id: 'artifact-audit',
        cron: '0 9 * * 1',
        action: 'validate-metadata'
      }
    ]
  },
  supervisor: {
    max_concurrent: 4,
    max_queue_depth: 20,
    restart_intensity: { max_restarts: 3, window_seconds: 300 },
    circuit_breaker: { failure_threshold: 5, cooldown_ms: 120000 },
    daily_budget_usd: 0,
    behaviors: ['ops-toolset'],
  },
  interface: {
    web: {
      enabled: false,
      port: 7474,
      host: '127.0.0.1',
    },
  },
  rules: []
};

export class Config {
  #recipients = new Map();
  #secretNames = new Set();
  #secretValues = new Set();
  #warnedLiteral = false;

  constructor(configPath = '.aiwg/daemon.json') {
    this.configPath = configPath;
    this.config = null;
  }

  load() {
    // Try YAML first, then JSON, then defaults
    const yamlPath = this.configPath.replace(/\.json$/, '.yaml');
    const ymlPath = this.configPath.replace(/\.json$/, '.yml');

    try {
      if (fs.existsSync(yamlPath)) {
        const content = fs.readFileSync(yamlPath, 'utf8');
        this.config = YAML.parse(content);
        this.configPath = yamlPath;
      } else if (fs.existsSync(ymlPath)) {
        const content = fs.readFileSync(ymlPath, 'utf8');
        this.config = YAML.parse(content);
        this.configPath = ymlPath;
      } else if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(content);
      } else {
        this.config = DEFAULT_CONFIG;
        this.save();
      }
    } catch (error) {
      // Parser errors can quote the input, including literal credentials.
      console.error('Failed to load daemon config; using defaults. Check JSON/YAML syntax.');
      this.config = DEFAULT_CONFIG;
    }

    return this.config;
  }

  /** Resolve only active recipients, without replacing references in saved config. Never prompts. */
  async resolveSecrets(dependencies = {}) {
    const environment = dependencies.environment ?? process.env;
    const recipients = new Map();
    this.#secretNames = new Set(['AIWG_WEB_TOKEN', 'AIWG_WEBHOOK_SECRET', 'AIWG_TELEGRAM_TOKEN',
      'AIWG_DISCORD_TOKEN', 'AIWG_SLACK_BOT_TOKEN', 'AIWG_SLACK_WEBHOOK_URL']);
    this.#secretValues.clear();
    const warnLiteral = () => {
      if (this.#warnedLiteral) return;
      this.#warnedLiteral = true;
      (dependencies.warn ?? console.warn)('Warning: daemon config contains literal secrets; use ENV_NAME, file:ABSOLUTE_PATH, or store:NAME references in *_ref fields.');
    };
    for (const [section, fields] of [['interface.web', ['token']], ['messaging.telegram', ['botToken', 'token']],
      ['messaging.discord', ['botToken', 'token']], ['messaging.slack', ['botToken', 'webhookUrl']]]) {
      const settings = this.get(section) ?? {};
      for (const field of fields) {
        const value = settings[field];
        const template = typeof value === 'string' && /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
        const reference = settings[`${field}_ref`] ?? template?.[1];
        if (typeof reference === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) this.#secretNames.add(reference);
        if (value && !template && !(typeof value === 'string' && /^(?:file|store):/.test(value))) {
          this.#secretValues.add(value);
          warnLiteral();
        }
      }
    }
    const webhookRef = this.get('webhook.secret_env');
    if (typeof webhookRef === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(webhookRef)) this.#secretNames.add(webhookRef);
    const resolve = async (settings, field, legacyEnv, label, aliases = []) => {
      const referenceField = label === 'webhook.secret_env' ? label : `${label}_ref`;
      const fields = [field, ...aliases];
      const refField = fields.find(key => settings[`${key}_ref`] !== undefined);
      const literalField = fields.find(key => settings[key]);
      const literal = literalField ? settings[literalField] : undefined;
      // Existing profile templates use ${NAME}. Explicit *_ref fields avoid
      // guessing whether an ordinary literal token is an environment name.
      const template = typeof literal === 'string' && /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(literal);
      const reference = refField ? settings[`${refField}_ref`]
        : template ? template[1]
          : typeof literal === 'string' && /^(?:file|store):/.test(literal) ? literal : undefined;
      if (refField || reference !== undefined) {
        let source;
        try { source = credentialReferenceInput(reference); }
        catch { throw new Error(`${label}: use ENV_NAME, file:ABSOLUTE_PATH, or store:NAME in ${referenceField}.`); }
        if (source.env) this.#secretNames.add(source.env);
        try {
          const value = await resolveSensitiveInput({ prefix: 'value', ...source }, { ...dependencies, isTTY: false });
          this.#secretValues.add(value);
          return value;
        } catch (error) {
          // Shared resolver diagnostics contain source names/checks, never file/store bytes.
          throw new Error(`${label}: ${error.message} Supply ENV_NAME, file:ABSOLUTE_PATH, or store:NAME via ${referenceField}.`);
        }
      }
      if (literal) {
        warnLiteral();
        this.#secretValues.add(literal);
        return literal;
      }
      // Implicit legacy input stays optional and keeps its original bytes.
      const value = environment[legacyEnv];
      if (value) this.#secretValues.add(value);
      return value;
    };
    if (this.get('daemon.profile') !== 'housekeeper') {
      const web = this.get('interface.web');
      if (web?.enabled) recipients.set('web', { ...web,
        token: await resolve(web, 'token', 'AIWG_WEB_TOKEN', 'interface.web.token') });
      const webhook = this.get('webhook');
      if (webhook?.enabled) {
        // secret_env is the existing reference field; preserve the optional
        // default variable while explicit missing references fail closed.
        const legacyName = webhook.secret_env ?? 'AIWG_WEBHOOK_SECRET';
        const legacyVariable = typeof legacyName === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(legacyName);
        const selected = legacyVariable ? {} : { secret_ref: legacyName };
        recipients.set('webhook', { ...webhook,
          secret: await resolve(selected, 'secret', legacyVariable ? legacyName : 'AIWG_WEBHOOK_SECRET', 'webhook.secret_env') });
      }
      for (const [name, envName] of [['telegram', 'AIWG_TELEGRAM_TOKEN'], ['discord', 'AIWG_DISCORD_TOKEN'],
        ['slack', 'AIWG_SLACK_WEBHOOK_URL']]) {
        const settings = this.get(`messaging.${name}`) ?? {};
        if (settings.enabled === false && !environment[envName]) continue;
        // Keep legacy env discovery; a configured credential also enables its recipient.
        const credential = (name === 'slack' ? ['webhookUrl'] : ['botToken', 'token'])
          .some(field => settings[field] || settings[`${field}_ref`] !== undefined);
        if (!credential && !environment[envName]) continue;
        const resolved = { ...settings };
        if (name === 'slack') {
          resolved.webhookUrl = await resolve(settings, 'webhookUrl', envName, 'messaging.slack.webhookUrl');
          resolved.botToken = await resolve(settings, 'botToken', 'AIWG_SLACK_BOT_TOKEN', 'messaging.slack.botToken');
        } else {
          resolved.botToken = await resolve(settings, 'botToken', envName, `messaging.${name}.botToken`, ['token']);
          delete resolved.token;
        }
        recipients.set(name, resolved);
      }
    }
    this.#recipients = recipients;
  }

  /** Each consumer asks for its own config, never the complete resolved secret set. */
  recipientConfig(name) { return this.#recipients.get(name); }

  /** Preserve worker/provider auth while excluding daemon-only credentials. */
  workerEnvironment(environment = process.env) {
    return Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
      !this.#secretNames.has(name) && !this.#secretValues.has(value)));
  }

  save() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error(`Failed to save config to ${this.configPath}:`, error.message);
    }
  }

  validate() {
    const errors = [];

    if (!this.config.daemon) {
      errors.push('Missing daemon configuration section');
    }

    if (this.config.daemon?.profile !== undefined
      && !['default', 'housekeeper'].includes(this.config.daemon.profile)) {
      errors.push('daemon.profile must be "default" or "housekeeper"');
    }

    if (this.config.watch?.enabled && !Array.isArray(this.config.watch.paths)) {
      errors.push('watch.paths must be an array');
    }

    if (this.config.watch) {
      const watch = this.config.watch;
      for (const [key, minimum] of [['debounce_ms', 0], ['reconcile_interval_ms', 0], ['poll_interval_ms', 1]]) {
        if (watch[key] !== undefined && (!Number.isFinite(watch[key]) || watch[key] < minimum)) {
          errors.push(`watch.${key} must be a number >= ${minimum}`);
        }
      }
      for (const [label, settings] of [['watch', watch], ...(Array.isArray(watch.paths)
        ? watch.paths.map((root, index) => [`watch.paths[${index}]`, root]) : [])]) {
        if (!settings || typeof settings !== 'object') {
          errors.push(`${label} must be an object`);
          continue;
        }
        if (settings.polling !== undefined && typeof settings.polling !== 'boolean') {
          errors.push(`${label}.polling must be a boolean`);
        }
        if (settings.generated_output_paths !== undefined && (!Array.isArray(settings.generated_output_paths) ||
            settings.generated_output_paths.some(output => typeof output !== 'string' || !output))) {
          errors.push(`${label}.generated_output_paths must be an array of non-empty paths`);
        }
        if (label !== 'watch' && (typeof settings.path !== 'string' || !settings.path)) {
          errors.push(`${label}.path must be a non-empty path`);
        }
      }
    }

    if (this.config.webhook?.enabled) {
      if (!this.config.webhook.port || this.config.webhook.port < 1 || this.config.webhook.port > 65535) {
        errors.push('webhook.port must be between 1 and 65535');
      }
    }

    if (this.config.schedule?.enabled && !Array.isArray(this.config.schedule.jobs)) {
      errors.push('schedule.jobs must be an array');
    }
    for (const job of Array.isArray(this.config.schedule?.jobs) ? this.config.schedule.jobs : []) {
      if (!job?.kind?.startsWith('memory.')) continue;
      try { validateMemoryJobArgs(job.kind, job.args); }
      catch (error) { errors.push(`schedule job "${job.id}": ${error.message}`); }
      if (job.kind === 'memory.apply') errors.push(...validateUpdatePolicy({ windows: job.args?.windows }));
    }

    // B6 resource bounds: validated envelope with safe defaults; the runner
    // and watcher enforce the normalized values (see resource-bounds.mjs).
    if (this.config.resources !== undefined) {
      if (!this.config.resources || typeof this.config.resources !== 'object' || Array.isArray(this.config.resources)) {
        errors.push('resources must be an object');
      } else {
        for (const message of normalizeResources(this.config.resources).errors) errors.push(message);
      }
    }

    // The housekeeper profile runs deterministic owner operations only: no
    // prompt-based actions, so no model calls are possible (epic #3353).
    if (this.config.daemon?.profile === 'housekeeper' && Array.isArray(this.config.schedule?.jobs)) {
      for (const job of this.config.schedule.jobs) {
        if (job?.action || job?.prompt) {
          errors.push(`schedule job "${job?.id || '?'}": action/prompt jobs are not allowed in the housekeeper profile`);
        }
      }
    }

    // Validate modes section
    if (this.config.modes?.autonomous?.enabled) {
      if (!Array.isArray(this.config.modes.autonomous.allowed_actions)) {
        errors.push('modes.autonomous.allowed_actions must be an array');
      }
      if (typeof this.config.modes.autonomous.budget_cap_usd !== 'number' || this.config.modes.autonomous.budget_cap_usd < 0) {
        errors.push('modes.autonomous.budget_cap_usd must be a non-negative number');
      }
    }

    // Validate messaging rooms
    if (this.config.messaging) {
      for (const [platform, pConfig] of Object.entries(this.config.messaging)) {
        if (pConfig?.rooms && !Array.isArray(pConfig.rooms)) {
          errors.push(`messaging.${platform}.rooms must be an array`);
        }
      }
    }

    // Validate docker section
    if (this.config.docker?.enabled) {
      if (!this.config.docker.image) {
        errors.push('docker.image is required when docker is enabled');
      }
    }

    return errors;
  }

  get(key) {
    const keys = key.split('.');
    let value = this.config;
    for (const k of keys) {
      if (value === undefined || value === null) return undefined;
      value = value[k];
    }
    return value;
  }
}

export default Config;
