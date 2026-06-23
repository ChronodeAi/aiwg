#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Config from './config.mjs';
import FileWatcher from './file-watcher.mjs';
import CronScheduler from './cron-scheduler.mjs';
import EventRouter from './event-router.mjs';
import { IPCServer } from './ipc-server.mjs';
import { AgentSupervisor } from './agent-supervisor.mjs';
import { TaskStore } from './task-store.mjs';
import { AutomationEngine } from './automation-engine.mjs';
import { registerOpsHandlers } from './ipc-ops-handlers.mjs';
import { DaemonSupervisor } from '../ralph-external/daemon-supervisor.mjs';
import { BehaviorRegistry } from '../ralph-external/lib/behavior-registry.mjs';
import { WebServer } from './web-server.mjs';
import { MessageRouter } from './message-router.mjs';
import { ScheduledTaskRunner } from './scheduled-task-runner.mjs';
import { AutonomousEngine } from './autonomous-engine.mjs';
import { MemoryManager } from './memory-manager.mjs';
import { ProviderWatcher } from './provider-watcher.mjs';
import { DaemonBehaviorLoader } from './behavior-loader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class DaemonMain {
  constructor() {
    this.config = null;
    this.fileWatcher = null;
    this.cronScheduler = null;
    this.eventRouter = null;
    this.messagingBus = null;
    this.ipcServer = null;
    this.supervisor = null;
    this.taskStore = null;
    this.automationEngine = null;
    this.daemonSupervisor = null;
    this.behaviorRegistry = null;
    this.webServer = null;
    this.messageRouter = null;
    this.opsHandlersApi = null;
    this.scheduledTaskRunner = null;
    this.autonomousEngine = null;
    this.roomManager = null;
    this.memoryManager = null;
    this.providerWatcher = null;
    this.behaviorLoader = null;
    this.shutdownInProgress = false;
    this.isRotating = false;
    this.startTime = Date.now();
    this.pidFile = '.aiwg/daemon.pid';
    this.lockFile = '.aiwg/daemon/.lock';
    this.heartbeatFile = '.aiwg/daemon/heartbeat';
    this.stateFile = '.aiwg/daemon/state.json';
    this.logFile = '.aiwg/daemon/daemon.log';
    this.socketPath = '.aiwg/daemon/daemon.sock';
    this.taskStorePath = '.aiwg/daemon/tasks.json';
    this.lockFd = null;
  }

  async start() {
    try {
      this.setupDirectories();
      this.acquireLock();
      this.writePidFile();
      this.setupSignalHandlers();
      this.redirectLogs();
      this.loadConfig();
      await this.initializeSubsystems();
      this.startHeartbeat();
      this.log('Daemon started successfully');
    } catch (error) {
      this.logStartupFailure(error);
      await this.cleanupStartupFailure();
      process.exit(1);
    }
  }

  logStartupFailure(error) {
    const timestamp = new Date().toISOString();
    const detail = error?.stack || `${error?.name || 'Error'}: ${error?.message || String(error)}`;
    const message = `[${timestamp}] Fatal error during startup:\n${detail}\n`;
    try {
      fs.appendFileSync(this.logFile, message);
    } catch {
      process.stderr.write(message);
    }
  }

  async cleanupStartupFailure() {
    try {
      if (this.ipcServer) {
        await this.ipcServer.stop();
      }
    } catch {
      // Best-effort startup cleanup; preserve the original startup error.
    }

    try {
      this.stopSubsystems();
    } catch {
      // Best-effort startup cleanup; preserve the original startup error.
    }

    this.cleanup();
  }

  setupDirectories() {
    const dirs = [
      '.aiwg/daemon',
      '.aiwg/daemon/actions',
      '.aiwg/daemon/events',
      '.aiwg/daemon/memory',
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  acquireLock() {
    try {
      this.lockFd = fs.openSync(this.lockFile, 'wx');
      fs.writeSync(this.lockFd, String(process.pid));
    } catch (error) {
      if (error.code === 'EEXIST') {
        this.log('Daemon is already running (lock file exists)');
        process.exit(1);
      }
      throw error;
    }
  }

  writePidFile() {
    const tmpFile = `${this.pidFile}.tmp`;
    fs.writeFileSync(tmpFile, String(process.pid));
    fs.renameSync(tmpFile, this.pidFile);
  }

  setupSignalHandlers() {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGHUP', () => this.reloadConfig());
  }

  redirectLogs() {
    const logStream = fs.createWriteStream(this.logFile, { flags: 'a' });

    process.stdout.write = (chunk) => {
      this.rotateLogIfNeeded();
      return logStream.write(chunk);
    };

    process.stderr.write = (chunk) => {
      this.rotateLogIfNeeded();
      return logStream.write(chunk);
    };
  }

  rotateLogIfNeeded() {
    if (this.isRotating) return;

    try {
      const stats = fs.statSync(this.logFile);
      const maxSize = (this.config?.get('daemon.log.max_size_mb') || 50) * 1024 * 1024;
      const maxFiles = this.config?.get('daemon.log.max_files') || 5;

      if (stats.size > maxSize) {
        this.isRotating = true;

        for (let i = maxFiles - 1; i >= 1; i--) {
          const oldFile = `${this.logFile}.${i}`;
          const newFile = `${this.logFile}.${i + 1}`;
          if (fs.existsSync(oldFile)) {
            fs.renameSync(oldFile, newFile);
          }
        }

        fs.renameSync(this.logFile, `${this.logFile}.1`);

        if (fs.existsSync(`${this.logFile}.${maxFiles + 1}`)) {
          fs.unlinkSync(`${this.logFile}.${maxFiles + 1}`);
        }

        this.isRotating = false;
      }
    } catch (error) {
      this.isRotating = false;
    }
  }

  loadConfig() {
    this.config = new Config();
    this.config.load();

    const errors = this.config.validate();
    if (errors.length > 0) {
      this.log(`Configuration validation errors: ${errors.join(', ')}`);
      throw new Error('Invalid configuration');
    }
  }

  reloadConfig() {
    this.log('Reloading configuration (SIGHUP received)');
    try {
      this.loadConfig();
      this.stopSubsystems();
      this.initializeSubsystems();
      this.log('Configuration reloaded successfully');
    } catch (error) {
      this.log(`Failed to reload configuration: ${error.message}`);
    }
  }

  async initializeSubsystems() {
    // Initialize memory manager (cross-session context for concierge)
    this.memoryManager = new MemoryManager({ projectRoot: process.cwd() });
    const memorySnapshot = this.memoryManager.load();
    const totalEntries = memorySnapshot.project.length + memorySnapshot.user.length;
    this.log(`Memory manager initialized (${totalEntries} persistent entries loaded)`);

    this.eventRouter = new EventRouter();

    // Initialize task store (persistent task tracking)
    this.taskStore = new TaskStore(this.taskStorePath);
    await this.taskStore.initialize();
    this.log(`Task store initialized (${this.taskStore.size} existing tasks)`);

    // Initialize agent supervisor (spawns claude -p subprocesses)
    const maxConcurrency = this.config.get('daemon.max_parallel_actions') || 3;
    const taskTimeoutMs = (this.config.get('daemon.action_timeout_minutes') || 120) * 60 * 1000;
    this.supervisor = new AgentSupervisor({
      maxConcurrency,
      taskStore: this.taskStore,
      taskTimeout: taskTimeoutMs,
    });
    this.supervisor.on('task:started', (e) => this.log(`Agent task started: ${e.taskId} (PID ${e.pid})`));
    this.supervisor.on('task:completed', (e) => this.log(`Agent task completed: ${e.taskId} (${e.duration}ms)`));
    this.supervisor.on('task:failed', (e) => this.log(`Agent task failed: ${e.taskId} - ${e.error}`));
    this.supervisor.on('task:timeout', (e) => this.log(`Agent task timed out: ${e.taskId}`));
    this.log(`Agent supervisor started (max ${maxConcurrency} concurrent)`);

    // Wrap AgentSupervisor with DaemonSupervisor for production governance
    const supConfig = this.config.get('supervisor') || {};
    this.daemonSupervisor = new DaemonSupervisor({
      agentSupervisor: this.supervisor,
      maxConcurrent: supConfig.max_concurrent ?? maxConcurrency,
      maxQueueDepth: supConfig.max_queue_depth ?? 20,
      dailyBudgetUsd: supConfig.daily_budget_usd ?? 0,
      restartIntensity: {
        maxRestarts: supConfig.restart_intensity?.max_restarts ?? 3,
        windowMs: (supConfig.restart_intensity?.window_seconds ?? 300) * 1000,
      },
      circuitBreaker: supConfig.circuit_breaker,
    });
    this.daemonSupervisor.on('loop:started', (e) => this.log(`Loop started: ${e.loopId}`));
    this.daemonSupervisor.on('loop:completed', (e) => this.log(`Loop completed: ${e.loopId}`));
    this.daemonSupervisor.on('loop:failed', (e) => this.log(`Loop failed: ${e.loopId} (permanent: ${e.permanent})`));
    this.daemonSupervisor.on('circuit:trip', (e) => this.log(`Circuit breaker tripped: ${e.consecutiveFailures} failures`));
    this.daemonSupervisor.on('budget:warning', (e) => this.log(`Budget warning: ${e.percentUsed}% used`));
    this.log('DaemonSupervisor initialized');

    // Load behavior registry
    try {
      const projectRoot = process.cwd();
      this.behaviorRegistry = new BehaviorRegistry({
        projectRoot,
        frameworkRoot: projectRoot,
      });
      const behaviors = await this.behaviorRegistry.loadAll();
      this.log(`Behavior registry loaded ${behaviors.size} behavior(s)`);
    } catch (err) {
      this.log(`Behavior registry init failed (non-fatal): ${err.message}`);
    }

    // Load and activate daemon behaviors (injectable orchestrators)
    try {
      this.behaviorLoader = new DaemonBehaviorLoader({
        projectRoot: process.cwd(),
        supervisor: this.supervisor,
        memoryManager: this.memoryManager,
        provider: this.config.get('provider') || null,
        config: this.config,
      });
      const active = await this.behaviorLoader.loadAll();
      if (active.size > 0) {
        this.log(`Daemon behaviors activated: ${[...active.keys()].join(', ')}`);
      }
    } catch (err) {
      this.log(`Behavior loader init failed (non-fatal): ${err.message}`);
    }

    // Initialize MessageRouter
    this.messageRouter = new MessageRouter({ supervisor: this.supervisor });
    this.log('MessageRouter initialized');

    // Initialize automation engine (trigger-action rules)
    this.automationEngine = new AutomationEngine({
      supervisor: this.supervisor,
    });
    const rules = this.config.get('rules') || [];
    if (rules.length > 0) {
      this.automationEngine.loadRules(rules);
      this.log(`Automation engine loaded ${this.automationEngine.ruleCount} rules`);
    }

    // Initialize IPC server (Unix domain socket for CLI communication)
    this.ipcServer = new IPCServer(this.socketPath);
    this._registerIPCMethods();
    await this.ipcServer.start();
    this.log(`IPC server listening on ${this.socketPath}`);

    const watchConfig = this.config.get('watch');
    if (watchConfig?.enabled) {
      this.fileWatcher = new FileWatcher(watchConfig, watchConfig.debounce_ms);
      this.fileWatcher.on('event', (event) => this.eventRouter.route(event));
      this.fileWatcher.start();
      this.log('File watcher started');
    }

    const scheduleConfig = this.config.get('schedule');
    if (scheduleConfig?.enabled) {
      this.cronScheduler = new CronScheduler(scheduleConfig);
      this.cronScheduler.on('event', (event) => this.eventRouter.route(event));
      this.cronScheduler.start();
      this.log('Cron scheduler started');
    }

    // Initialize RoomManager for multi-room messaging
    try {
      const { RoomManager } = await import('../messaging/room-manager.mjs');
      this.roomManager = new RoomManager();
      const messagingConfig = this.config.get('messaging');
      if (messagingConfig) {
        this.roomManager.loadFromConfig(messagingConfig);
        this.log(`RoomManager loaded ${this.roomManager.size} room(s)`);
      }
    } catch (error) {
      this.log(`RoomManager init failed (non-fatal): ${error.message}`);
    }

    // Initialize messaging subsystem if any adapters are configured
    try {
      const { createMessagingHub } = await import('../messaging/index.mjs');
      const messagingConfig = this.config.get('messaging');
      // 2-way AI chat is on by default. Setting messaging.chat.enabled: false in
      // daemon.yaml restricts the bot to slash-commands + event notifications
      // (no free-text claude-p workers). Passing chatHandler:false to the hub is
      // the documented way to disable it (see tools/messaging/index.mjs).
      const chatEnabled = messagingConfig?.chat?.enabled !== false;
      // Write-command authorization: users granted 'write' may run write-class
      // commands (/approve, /reject, ...). Sourced from AIWG_WRITE_USERS (CSV)
      // and/or messaging.write_users in daemon.yaml. Without any grant, write
      // commands are denied to everyone (read stays open to allowlisted chats).
      const writeUsers = [
        ...(process.env.AIWG_WRITE_USERS || '')
          .split(',')
          .map((u) => u.trim())
          .filter(Boolean),
        ...(Array.isArray(messagingConfig?.write_users) ? messagingConfig.write_users.map(String) : []),
      ];
      this.messagingBus = await createMessagingHub({
        roomManager: this.roomManager,
        messagingConfig,
        ...(writeUsers.length > 0 ? { writeUsers } : {}),
        ...(chatEnabled ? {} : { chatHandler: false }),
      });
      if (this.messagingBus) {
        this.log(`Messaging hub initialized with ${this.messagingBus.adapterCount} adapter(s)`);
      }
    } catch (error) {
      this.log(`Messaging subsystem not available: ${error.message}`);
    }

    // Initialize ScheduledTaskRunner to bridge cron events to tasks
    if (this.daemonSupervisor && this.eventRouter) {
      this.scheduledTaskRunner = new ScheduledTaskRunner({
        supervisor: this.daemonSupervisor,
        eventRouter: this.eventRouter,
        roomManager: this.roomManager,
      });
      this.scheduledTaskRunner.start();
      this.log('ScheduledTaskRunner started');
    }

    // Initialize AutonomousEngine if enabled
    const modesConfig = this.config.get('modes');
    if (modesConfig?.autonomous && this.daemonSupervisor) {
      this.autonomousEngine = new AutonomousEngine({
        supervisor: this.daemonSupervisor,
        config: modesConfig.autonomous,
        roomManager: this.roomManager,
      });
      if (modesConfig.autonomous.enabled) {
        this.autonomousEngine.start();
        this.log('AutonomousEngine started');
      } else {
        this.log('AutonomousEngine initialized (disabled — enable via config or IPC)');
      }
    }

    // Initialize ProviderWatcher if configured
    const providerWatchConfig = this.config.get('provider_watch');
    if (providerWatchConfig?.enabled) {
      this.providerWatcher = new ProviderWatcher({
        stateDir: '.aiwg/daemon/provider-watch',
        providers: providerWatchConfig.providers || undefined,
        intervalHours: providerWatchConfig.interval_hours || 6,
      });
      this.providerWatcher.on('changes-detected', (e) => {
        this.log(`Provider changes detected: ${e.changes.length} change(s)`);
        this.eventRouter.route({
          source: 'provider-watch',
          type: 'provider.changes',
          payload: e,
        });
      });
      this.providerWatcher.on('error', (e) => {
        this.log(`Provider watcher error (${e.provider}): ${e.error}`);
      });
      this.providerWatcher.start();

      // Register default automation rule for PR creation on provider changes
      if (this.automationEngine) {
        const existingRule = this.automationEngine.getRule('provider-watch-pr');
        if (!existingRule) {
          const prRule = ProviderWatcher.getAutomationRule();
          this.automationEngine.loadRules([
            ...this.automationEngine.rules,
            prRule,
          ]);
          this.log('Registered provider-watch-pr automation rule');
        }
      }

      this.log(`ProviderWatcher initialized (${this.providerWatcher.providers.length} providers, every ${this.providerWatcher.intervalHours}h)`);
    }

    // Start web server if configured
    const webConfig = this.config.get('interface.web');
    if (webConfig?.enabled) {
      // In Docker mode, bind to 0.0.0.0 so port mapping works
      const webHost = process.env.AIWG_DOCKER === '1' ? '0.0.0.0' : (webConfig.host ?? '127.0.0.1');
      this.webServer = new WebServer({
        port: webConfig.port ?? 7474,
        host: webHost,
        token: webConfig.token || process.env.AIWG_WEB_TOKEN || null,
        daemonSupervisor: this.daemonSupervisor,
        opsHandlers: this.opsHandlersApi,
      });
      await this.webServer.start();
      this.log(`Web server listening on ${this.webServer.url}`);
    }

    // Route events through automation engine and adapters
    this.eventRouter.on('event', (event) => {
      this.handleEvent(event);
      this.automationEngine.processEvent(event);
    });

    // Forward DaemonSupervisor events to MessageRouter and WebServer
    if (this.daemonSupervisor) {
      for (const eventName of ['loop:started', 'loop:completed', 'loop:failed', 'loop:queued', 'circuit:trip', 'circuit:recover', 'budget:warning']) {
        this.daemonSupervisor.on(eventName, (data) => {
          if (this.messageRouter) {
            this.messageRouter.broadcast({ type: eventName, data });
          }
          if (this.webServer) {
            this.webServer.broadcastEvent(eventName, data);
          }
        });
      }
    }
  }

  /**
   * Register IPC method handlers for CLI communication
   */
  _registerIPCMethods() {
    this.ipcServer.registerMethods({
      // Daemon status
      'daemon.status': () => ({
        pid: process.pid,
        uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
        started_at: new Date(this.startTime).toISOString(),
        health: 'healthy',
        subsystems: {
          ipc: { clients: this.ipcServer.clientCount },
          supervisor: this.supervisor.getStatus(),
          automation: this.automationEngine.getStatus(),
          file_watcher: this.fileWatcher?.getStats() || { enabled: false },
          scheduler: this.cronScheduler?.getStats() || { enabled: false },
          messaging: this.messagingBus ? { enabled: true, adapters: this.messagingBus.adapterCount } : { enabled: false },
          provider_watcher: this.providerWatcher ? { enabled: true, ...this.providerWatcher.getStatus() } : { enabled: false },
          behaviors: this.behaviorLoader ? this.behaviorLoader.getStatus() : { active: {}, count: 0 },
        },
      }),

      // Task management
      'task.submit': (params) => {
        if (!params.prompt) {
          const err = new Error('Missing required parameter: prompt');
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        const task = this.supervisor.submit(params.prompt, {
          agent: params.agent,
          priority: params.priority || 0,
        });
        return { taskId: task.id, state: task.state };
      },

      'task.cancel': (params) => {
        if (!params.taskId) {
          const err = new Error('Missing required parameter: taskId');
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        const cancelled = this.supervisor.cancel(params.taskId);
        return { cancelled };
      },

      'task.list': (params) => {
        return this.taskStore.getTasks({
          state: params?.state,
          limit: params?.limit || 20,
        });
      },

      'task.get': (params) => {
        if (!params.taskId) {
          const err = new Error('Missing required parameter: taskId');
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        const task = this.taskStore.getTask(params.taskId);
        if (!task) {
          const err = new Error(`Task not found: ${params.taskId}`);
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        return task;
      },

      'task.stats': () => {
        return this.taskStore.getStats();
      },

      // Automation
      'automation.status': () => {
        return this.automationEngine.getStatus();
      },

      'automation.enable': (params) => {
        if (params.ruleId) {
          return { success: this.automationEngine.setRuleEnabled(params.ruleId, true) };
        }
        this.automationEngine.setEnabled(true);
        return { enabled: true };
      },

      'automation.disable': (params) => {
        if (params.ruleId) {
          return { success: this.automationEngine.setRuleEnabled(params.ruleId, false) };
        }
        this.automationEngine.setEnabled(false);
        return { enabled: false };
      },

      // Chat (send message via IPC for non-tmux clients)
      // Routes through active chat-message behaviors when available.
      'chat.send': async (params) => {
        if (!params.message) {
          const err = new Error('Missing required parameter: message');
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        // Route through behaviors registered for chat-message trigger
        if (this.behaviorLoader && !params.raw) {
          const handlers = this.behaviorLoader.getForTrigger('chat-message');
          for (const handler of handlers) {
            if (typeof handler.handleMessage === 'function') {
              try {
                return await handler.handleMessage(params.message, {
                  source: 'ipc-chat',
                  provider: params.provider,
                });
              } catch (err) {
                this.log(`Behavior chat handler error (falling back): ${err.message}`);
              }
            }
          }
        }
        // Fallback: direct supervisor submit (no behavior mediation)
        const task = this.supervisor.submit(params.message, {
          priority: params.priority || 5,
          metadata: { source: 'ipc-chat' },
        });
        return { taskId: task.id };
      },

      // Ping for health checks
      'ping': () => ({ pong: true, timestamp: new Date().toISOString() }),

      // Memory management (cross-session context)
      'memory.show': (params) => {
        if (!this.memoryManager) return { error: 'Memory manager not initialized', available: false };
        return this.memoryManager.show(params?.scope);
      },

      'memory.clear': (params) => {
        if (!this.memoryManager) return { error: 'Memory manager not initialized', available: false };
        const scope = params?.scope;
        if (!scope) {
          const err = new Error('Missing required parameter: scope');
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        return this.memoryManager.clear(scope);
      },

      'memory.write': (params) => {
        if (!this.memoryManager) return { error: 'Memory manager not initialized', available: false };
        const { scope, key, content, name, description, type } = params || {};
        if (!scope || !key || !content) {
          const err = new Error('Missing required parameters: scope, key, content');
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        return this.memoryManager.write(scope, key, content, { name, description, type });
      },

      'memory.context': () => {
        if (!this.memoryManager) return { context: '', available: false };
        return { context: this.memoryManager.getContext(), available: true };
      },

      // Behavior management (injectable daemon behaviors)
      'behaviors.status': () => {
        return this.behaviorLoader ? this.behaviorLoader.getStatus() : { active: {}, count: 0 };
      },

      'behaviors.list': () => {
        if (!this.behaviorLoader) return { behaviors: [] };
        const status = this.behaviorLoader.getStatus();
        return { behaviors: Object.entries(status.active).map(([name, info]) => ({ name, ...info })) };
      },

      'behaviors.apply': async (params) => {
        if (!params?.name) {
          const err = new Error('Missing required parameter: name');
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        if (!this.behaviorLoader) {
          const err = new Error('Behavior loader not initialized');
          err.code = 'INVALID_STATE';
          throw err;
        }
        return await this.behaviorLoader.apply(params.name);
      },

      'behaviors.remove': (params) => {
        if (!params?.name) {
          const err = new Error('Missing required parameter: name');
          err.code = 'INVALID_PARAMS';
          throw err;
        }
        if (!this.behaviorLoader) {
          return { removed: false, name: params.name };
        }
        return this.behaviorLoader.remove(params.name);
      },

      // Autonomous mode management
      'autonomous.status': () => {
        return this.autonomousEngine ? this.autonomousEngine.getStatus() : { enabled: false };
      },

      'autonomous.enable': () => {
        if (!this.autonomousEngine) {
          const err = new Error('Autonomous engine not initialized');
          err.code = 'INVALID_STATE';
          throw err;
        }
        this.autonomousEngine.enable();
        return { enabled: true };
      },

      'autonomous.disable': () => {
        if (!this.autonomousEngine) {
          const err = new Error('Autonomous engine not initialized');
          err.code = 'INVALID_STATE';
          throw err;
        }
        this.autonomousEngine.disable();
        return { enabled: false };
      },

      // Scheduled task runner
      'schedule.status': () => {
        return this.scheduledTaskRunner ? this.scheduledTaskRunner.getStatus() : { started: false };
      },

      // Provider watch
      'provider-watch.status': () => {
        return this.providerWatcher ? this.providerWatcher.getStatus() : { enabled: false };
      },

      'provider-watch.check': async () => {
        if (!this.providerWatcher) {
          const err = new Error('Provider watcher not initialized — enable provider_watch in daemon config');
          err.code = 'INVALID_STATE';
          throw err;
        }
        const changes = await this.providerWatcher.checkAll();
        return { changes, count: changes.length };
      },

      // Room management
      'rooms.list': () => {
        return this.roomManager ? this.roomManager.getStatus() : { totalRooms: 0 };
      },
    });

    // Register ops-toolset IPC methods
    if (this.daemonSupervisor) {
      this.opsHandlersApi = registerOpsHandlers(this.ipcServer, this.daemonSupervisor);
      this.log('Ops-toolset IPC methods registered (7 methods)');
    }
  }

  handleEvent(event) {
    this.log(`Event received: ${event.source} - ${event.type}`);

    // Forward daemon events to messaging bus if available
    if (this.messagingBus) {
      this.messagingBus.publish({
        topic: event.type,
        source: event.source || 'daemon',
        severity: 'info',
        summary: `${event.source}: ${event.type}`,
        details: event.payload || {},
        project: path.basename(process.cwd()),
        timestamp: new Date().toISOString(),
      });
    }
  }

  startHeartbeat() {
    const intervalSeconds = this.config.get('daemon.heartbeat_interval_seconds') || 30;

    setInterval(() => {
      this.writeHeartbeat();
      this.writeState();
    }, intervalSeconds * 1000);

    this.writeHeartbeat();
    this.writeState();
  }

  writeHeartbeat() {
    const heartbeat = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000)
    };

    const tmpFile = `${this.heartbeatFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(heartbeat, null, 2));
    fs.renameSync(tmpFile, this.heartbeatFile);
  }

  writeState() {
    const supervisorStatus = this.supervisor ? this.supervisor.getStatus() : { running: 0, queued: 0, tasks: { running: [], queued: [] } };
    const daemonStatus = this.daemonSupervisor ? this.daemonSupervisor.status() : null;
    const taskStats = this.taskStore ? this.taskStore.getStats() : {};

    const state = {
      pid: process.pid,
      started_at: new Date(this.startTime).toISOString(),
      last_heartbeat: new Date().toISOString(),
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
      restart_count: 0,
      ipc: {
        socket: this.socketPath,
        clients: this.ipcServer ? this.ipcServer.clientCount : 0,
      },
      agents: {
        running: supervisorStatus.running,
        queued: supervisorStatus.queued,
        max_concurrency: supervisorStatus.maxConcurrency,
        tasks: supervisorStatus.tasks,
      },
      task_stats: taskStats,
      monitors: {
        file_watcher: this.fileWatcher?.getStats() || { enabled: false },
        webhook: { enabled: false },
        scheduler: this.cronScheduler?.getStats() || { enabled: false }
      },
      automation: this.automationEngine ? {
        enabled: this.automationEngine.enabled,
        rule_count: this.automationEngine.ruleCount,
      } : { enabled: false },
      daemon_supervisor: daemonStatus ? {
        concurrency: `${daemonStatus.concurrencyUsed}/${daemonStatus.concurrencyMax}`,
        queue: `${daemonStatus.queueDepth}/${daemonStatus.queueMax}`,
        circuit: daemonStatus.circuitState?.state || 'unknown',
        budget: daemonStatus.budgetLimit > 0
          ? `$${daemonStatus.budgetUsed.toFixed(2)}/$${daemonStatus.budgetLimit.toFixed(2)}`
          : 'unlimited',
      } : null,
      web_server: this.webServer ? { url: this.webServer.url } : null,
      rooms: this.roomManager ? this.roomManager.getStatus() : null,
      scheduled_tasks: this.scheduledTaskRunner ? this.scheduledTaskRunner.getStatus() : null,
      autonomous: this.autonomousEngine ? this.autonomousEngine.getStatus() : null,
      health: {
        status: 'healthy',
        last_check: new Date().toISOString(),
        issues: []
      }
    };

    const tmpFile = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, this.stateFile);
  }

  stopSubsystems() {
    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher = null;
    }

    if (this.cronScheduler) {
      this.cronScheduler.stop();
      this.cronScheduler = null;
    }

    if (this.scheduledTaskRunner) {
      this.scheduledTaskRunner.stop();
      this.scheduledTaskRunner = null;
    }

    if (this.autonomousEngine) {
      this.autonomousEngine.stop();
      this.autonomousEngine = null;
    }

    if (this.providerWatcher) {
      this.providerWatcher.stop();
      this.providerWatcher = null;
    }

    if (this.behaviorLoader) {
      this.behaviorLoader = null;
    }
  }

  async shutdown(signal) {
    if (this.shutdownInProgress) {
      return;
    }

    this.shutdownInProgress = true;
    this.log(`Shutdown initiated (${signal})`);

    // Stop IPC server (reject new connections)
    if (this.ipcServer) {
      try {
        await this.ipcServer.stop();
        this.log('IPC server stopped');
      } catch (error) {
        this.log(`Error stopping IPC server: ${error.message}`);
      }
    }

    // Stop web server
    if (this.webServer) {
      try {
        await this.webServer.stop();
        this.log('Web server stopped');
      } catch (error) {
        this.log(`Error stopping web server: ${error.message}`);
      }
    }

    // Drain DaemonSupervisor (which delegates to AgentSupervisor)
    if (this.daemonSupervisor) {
      try {
        await this.daemonSupervisor.shutdown(15000);
        this.log('DaemonSupervisor drained');
      } catch (error) {
        this.log(`Error draining DaemonSupervisor: ${error.message}`);
      }
    } else if (this.supervisor) {
      try {
        this.log(`Draining supervisor (${this.supervisor.runningCount} running, ${this.supervisor.queuedCount} queued)`);
        await this.supervisor.shutdown(15000);
        this.log('Agent supervisor drained');
      } catch (error) {
        this.log(`Error draining supervisor: ${error.message}`);
      }
    }

    // Shutdown messaging adapters
    if (this.messagingBus) {
      try {
        await this.messagingBus.shutdown();
        this.log('Messaging hub shut down');
      } catch (error) {
        this.log(`Error shutting down messaging: ${error.message}`);
      }
    }

    // Flush session memory to project scope before exit
    if (this.memoryManager) {
      try {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        this.memoryManager.flushSession({ duration: `${uptime}s` });
        this.log('Session memory flushed to project scope');
      } catch (error) {
        this.log(`Memory flush failed (non-fatal): ${error.message}`);
      }
    }

    this.stopSubsystems();
    this.writeState();
    this.cleanup();

    this.log('Daemon stopped gracefully');
    process.exit(0);
  }

  cleanup() {
    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch (error) {
      this.log(`Failed to remove PID file: ${error.message}`);
    }

    try {
      if (this.lockFd !== null) {
        fs.closeSync(this.lockFd);
        fs.unlinkSync(this.lockFile);
      }
    } catch (error) {
      this.log(`Failed to remove lock file: ${error.message}`);
    }
  }

  log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }
}

const daemon = new DaemonMain();
daemon.start();
