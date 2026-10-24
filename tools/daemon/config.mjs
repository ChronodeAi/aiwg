import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { normalizeResources } from './resource-bounds.mjs';

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
      console.error(`Failed to load config from ${this.configPath}:`, error.message);
      this.config = DEFAULT_CONFIG;
    }

    return this.config;
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
