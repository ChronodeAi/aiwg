/**
 * Session Launcher for External Ralph Loop
 *
 * Spawns provider CLI sessions. Per ADR-001, ALL argument construction is
 * owned by the active provider adapter (buildSessionArgs); this module
 * resolves the adapter, spawns the process, and captures output.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 * @security docs/ralph-external-security.md
 *
 * SECURITY WARNING
 * ================
 * This module spawns Claude Code with --dangerously-skip-permissions which
 * BYPASSES ALL PERMISSION PROMPTS. The spawned session can:
 *
 * - Read ANY file the process user can read
 * - Write/modify ANY file the process user can write
 * - Execute ANY shell command
 * - Make network requests
 * - Install packages
 * - Modify system configuration
 *
 * This is required for headless/daemon operation but carries significant
 * security implications. Sessions run autonomously for extended periods
 * without human oversight.
 *
 * BEFORE USING:
 * - Read docs/ralph-external-security.md in full
 * - Understand all risks
 * - Set appropriate budget and iteration limits
 * - Ensure clean git state for rollback
 * - Have monitoring and abort procedures ready
 */

import { spawn } from 'child_process';
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'path';
import { EventEmitter } from 'events';
import { homedir } from 'os';
import { DispatchCapabilityError } from './lib/provider-adapter.mjs';

// ── ADR-002: deliverable write-path gate ─────────────────────────────────────

/**
 * Typed dispatch refusal for the ADR-002 deliverable write-path gate. Carries
 * both sides of the mismatch — the operator's first diagnostic is the delta
 * between the sandbox root and the unwritable target (triage plan FC2 fix #1;
 * task 11159769 was the withheld-status cost of NOT naming both).
 */
export class DeliverableUnwritableError extends Error {
  /**
   * @param {{ target: string, sandboxRoot: string, provider: string, detail?: string }} params
   */
  constructor({ target, sandboxRoot, provider, detail }) {
    super(
      `deliverable path ${target} unwritable under provider sandbox root ${sandboxRoot} ` +
      `(provider: ${provider})${detail ? `: ${detail}` : ''}`
    );
    this.name = 'DeliverableUnwritableError';
    this.target = target;
    this.sandboxRoot = sandboxRoot;
    this.provider = provider;
    this.detail = detail ?? null;
  }
}

/**
 * Containment invariant (ADR-002 §4): sandboxRoot ⊇ path. A mission whose
 * target lies outside the declared root is rejected before spawn with the
 * same typed error as a refused writability probe.
 * @private
 * @param {string} pathValue
 * @param {string} sandboxRoot
 * @param {string} provider
 * @param {string} label - Config-surface name of the path ('projectRoot' | 'deliverable path')
 */
function _assertPathWithinSandboxRoot(pathValue, sandboxRoot, provider, label) {
  const resolved = resolvePath(pathValue);
  const root = resolvePath(sandboxRoot);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new DeliverableUnwritableError({
      target: resolved,
      sandboxRoot: root,
      provider,
      detail: `${label} lies outside the sandbox root (invariant: sandbox-root ⊇ ${label})`,
    });
  }
}

/**
 * Sentinel writability probe (ADR-002 §1): write+unlink a unique dot-file in
 * the nearest existing ancestor of dirPath (mkdir -p semantics — a not-yet-
 * created deliverable tree is probed at its first existing ancestor, so a
 * refused dispatch allocates nothing but a legitimate fresh target passes).
 * fs.accessSync(W_OK) runs on refusal to enrich the error detail.
 * @private
 * @param {string} dirPath - Directory that must be writable
 * @param {{ target: string, sandboxRoot: string, provider: string }} errCtx
 * @returns {true} When the probe succeeds
 * @throws {DeliverableUnwritableError} When the probe is refused
 */
function _probeWritable(dirPath, errCtx) {
  let dir = resolvePath(dirPath);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  try {
    const sentinel = join(
      dir,
      `.deliverable-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    writeFileSync(sentinel, '');
    unlinkSync(sentinel);
  } catch (err) {
    let accessDetail;
    try {
      accessSync(dir, fsConstants.W_OK);
      accessDetail = 'access(W_OK) reports writable (denial is enforcement-level, not mode-level)';
    } catch (accessErr) {
      accessDetail = `access(W_OK): ${accessErr.message}`;
    }
    throw new DeliverableUnwritableError({
      ...errCtx,
      detail: `writability probe failed at ${dir} (${err.message}); ${accessDetail}`,
    });
  }
  return true;
}

/**
 * ADR-002 pre-flight probe: verify the mission's deliverable path is writable
 * under the provider's *effective* sandbox root. Runs BEFORE spawn (and
 * before output-dir mkdir), so an unwritable target refuses the dispatch at
 * the cheapest possible point with both sides of the mismatch named.
 *
 * @param {{ targetPath: string, sandboxRoot: string, provider: string }} params
 * @returns {true} When the target is writable under the root
 * @throws {DeliverableUnwritableError} Containment or writability refusal
 */
export function assertDeliverableWritable({ targetPath, sandboxRoot, provider }) {
  const target = resolvePath(targetPath);
  const root = resolvePath(sandboxRoot);
  _assertPathWithinSandboxRoot(target, root, provider, 'deliverable path');

  // An existing deliverable file must itself be writable (overwrite path).
  if (existsSync(target)) {
    try {
      accessSync(target, fsConstants.W_OK);
    } catch (err) {
      throw new DeliverableUnwritableError({
        target,
        sandboxRoot: root,
        provider,
        detail: `existing deliverable file is not writable: ${err.message}`,
      });
    }
  }

  _probeWritable(dirname(target), { target, sandboxRoot: root, provider });
  return true;
}

/**
 * @typedef {Object} LaunchOptions
 * @property {string} prompt - The prompt to send
 * @property {string} sessionId - Session UUID for tracking
 * @property {string} [model='claude-sonnet-4-6'] - Pinned model variant (see #1450)
 * @property {number} [budget] - Budget per iteration in USD
 * @property {number} [maxTurns] - Maximum number of turns (requires Claude CLI support)
 * @property {boolean} [verbose=false] - Enable verbose output
 * @property {string} [systemPrompt] - System prompt to append
 * @property {Object} [mcpConfig] - MCP server configuration
 * @property {string} workingDir - Working directory for session
 * @property {string} stdoutPath - Path to capture stdout
 * @property {string} stderrPath - Path to capture stderr
 * @property {string} outputDir - Directory for session artifacts
 * @property {string} [projectRoot] - Mission project root (ADR-002): must be contained in the provider's effective sandbox root
 * @property {string} [deliverablePath] - Mission deliverable target (ADR-002): must be writable under the provider's effective sandbox root
 * @property {number} [timeoutMs] - Timeout in milliseconds
 */

/**
 * @typedef {Object} SessionResult
 * @property {number} exitCode - Process exit code
 * @property {string} stdoutPath - Path to stdout log
 * @property {string} stderrPath - Path to stderr log
 * @property {string} [transcriptPath] - Path to session transcript (if available)
 * @property {string} [parsedEventsPath] - Path to parsed stream events (if available)
 * @property {number} duration - Duration in milliseconds
 * @property {boolean} timedOut - Whether session timed out
 * @property {string} stdoutBuffer - Last portion of stdout
 * @property {number} [toolCallCount] - Number of tool calls detected
 * @property {number} [errorCount] - Number of errors detected
 * @property {number} [totalTokens] - Total token usage detected from stream events
 * @property {number} [inputTokens] - Input token usage detected from stream events
 * @property {number} [outputTokens] - Output token usage detected from stream events
 * @property {number} [costUsd] - Cost detected from stream events
 */

/**
 * @typedef {Object} StreamEvent
 * @property {string} type - Event type (e.g., 'tool_call', 'completion', 'error')
 * @property {number} timestamp - Unix timestamp
 * @property {Object} data - Event data
 */

/**
 * Capability → provider-CLI flags that capability governs (ADR-001). The
 * launcher refuses to spawn when the active adapter's buildSessionArgs()
 * emits any of these flags without the corresponding declared capability —
 * a claude-idiom flag reaching a binary that rejects it (the Aug-27
 * `error: unknown option '--resume'` crash class) becomes structurally
 * impossible, not audited-against.
 * @type {Record<string, string[]>}
 */
const CAPABILITY_FLAG_MAP = Object.freeze({
  sessionResume: ['--session-id', '--resume'],
  budgetControl: ['--max-budget-usd'],
  systemPrompt: ['--append-system-prompt'],
  streamJson: ['--output-format'],
  agentMode: ['--agent'],
  mcpConfig: ['--mcp-config'],
  maxTurns: ['--max-turns'],
});

export class SessionLauncher extends EventEmitter {
  constructor() {
    super();
    this.currentProcess = null;
    this.startTime = null;
    /** @type {import('./lib/provider-adapter.mjs').ProviderAdapter|null} */
    this.providerAdapter = null;
  }

  /**
   * Set the provider adapter for CLI abstraction
   * @param {import('./lib/provider-adapter.mjs').ProviderAdapter} adapter
   */
  setProviderAdapter(adapter) {
    this.providerAdapter = adapter;
  }

  /**
   * Structural capability gate (ADR-001): the launcher must never emit a
   * flag the active adapter does not declare. Checks the adapter-produced
   * args against CAPABILITY_FLAG_MAP and fails loud before spawn.
   *
   * @private
   * @param {string[]} args - Args produced by the adapter's buildSessionArgs()
   * @throws {DispatchCapabilityError} When an undeclared capability's flag appears
   */
  _assertFlagsWithinCapabilities(args) {
    const caps = this.providerAdapter.getCapabilities();
    for (const [capability, flags] of Object.entries(CAPABILITY_FLAG_MAP)) {
      if (caps[capability]) continue;
      const offender = flags.find((flag) => args.includes(flag));
      if (offender) {
        throw new DispatchCapabilityError(
          capability,
          `adapter emitted "${offender}" without declaring ${capability}`,
          this.providerAdapter.getName()
        );
      }
    }
  }

  /**
   * ADR-002 pre-flight gate. Resolves the provider's effective sandbox root —
   * adapter-declared getSandboxRoot(workingDir) per ADR-002 §3; adapters that
   * do not declare the capability are treated as root = workingDir (the
   * documented migration default until projectRoot is backfilled) — then
   * enforces the containment invariant sandboxRoot ⊇ projectRoot ⊇
   * deliverablePath plus writability of the mission target.
   *
   * @private
   * @param {LaunchOptions} options
   * @returns {void}
   * @throws {DeliverableUnwritableError} Before any spawn or allocation
   */
  _assertDeliverableWritable(options) {
    const provider = this.providerAdapter.getName();
    const sandboxRoot =
      typeof this.providerAdapter.getSandboxRoot === 'function'
        ? this.providerAdapter.getSandboxRoot(options.workingDir)
        : options.workingDir;

    if (options.projectRoot) {
      _assertPathWithinSandboxRoot(options.projectRoot, sandboxRoot, provider, 'projectRoot');
      _probeWritable(options.projectRoot, {
        target: resolvePath(options.projectRoot),
        sandboxRoot: resolvePath(sandboxRoot),
        provider,
      });
    }

    if (options.deliverablePath) {
      assertDeliverableWritable({ targetPath: options.deliverablePath, sandboxRoot, provider });
    }
  }

  /**
   * LEGACY (ADR-001): claude-style inline flag construction. Dead code on
   * the dispatch path — _launchSession routes every launch through the
   * active provider adapter's buildSessionArgs() and fails loud when no
   * adapter is set. Retained only so historical unit tests of the pure
   * method keep passing; do NOT add new call sites.
   *
   * @param {LaunchOptions} options
   * @returns {string[]}
   */
  buildArgs(options) {
    const args = [
      // SECURITY: This flag bypasses ALL permission prompts
      // Required for headless operation but enables:
      // - Unrestricted file read/write
      // - Arbitrary command execution
      // - Network access without confirmation
      // See docs/ralph-external-security.md
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'stream-json',
      '--session-id', options.sessionId,
    ];

    // Verbose mode
    if (options.verbose) {
      args.push('--verbose');
    }

    // Model selection
    if (options.model) {
      args.push('--model', options.model);
    }

    // Budget control
    if (options.budget) {
      args.push('--max-budget-usd', String(options.budget));
    }

    // Max turns control (if supported by Claude CLI)
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    // MCP configuration
    if (options.mcpConfig) {
      const configJson = typeof options.mcpConfig === 'string'
        ? options.mcpConfig
        : JSON.stringify(options.mcpConfig);
      args.push('--mcp-config', configJson);
    }

    // System prompt injection
    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    // The prompt itself
    args.push(options.prompt);

    return args;
  }

  /**
   * Launch a Claude Code session
   * @param {LaunchOptions} options
   * @returns {Promise<SessionResult>}
   */
  async launch(options) {
    const sessionResult = await this._launchSession(options);

    // Post-session artifact capture
    await this._captureSessionArtifacts(options, sessionResult);

    return sessionResult;
  }

  /**
   * Internal method to launch session and capture basic output
   * @private
   * @param {LaunchOptions} options
   * @returns {Promise<SessionResult>}
   */
  _launchSession(options) {
    // ADR-001: launching without an adapter previously fell back to inline
    // claude-style flags — that silent claude behavior was part of the FC1
    // blast radius, not a feature. Fail loud instead.
    if (!this.providerAdapter) {
      throw new Error(
        'No provider adapter configured: call setProviderAdapter() before launch() ' +
        '(ADR-001: all provider-CLI argument construction is adapter-owned)'
      );
    }

    // ADR-002: deliverable write-path gate — BEFORE the Promise body, before
    // output-dir mkdirSync, before spawn. A refused dispatch allocates
    // nothing and names both the effective sandbox root and the unwritable
    // target (task 11159769's failure discovered mid-loop, silently).
    this._assertDeliverableWritable(options);

    return new Promise((resolve, reject) => {
      // Ensure output directories exist
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      mkdirSync(dirname(options.stderrPath), { recursive: true });
      if (options.outputDir) {
        mkdirSync(options.outputDir, { recursive: true });
      }

      // ADR-001 §4 resume policy: a carried sessionId is ralph-external
      // bookkeeping and, historically, the resume identity. When the active
      // adapter declares sessionResume: false, refuse the resume loudly and
      // start a fresh session — never translate sessionId into whatever
      // flag the adapter happens to accept.
      if (options.sessionId && !this.providerAdapter.hasCapability('sessionResume')) {
        this.emit('resume-refused', {
          provider: this.providerAdapter.getName(),
          sessionId: options.sessionId,
          action: 'fresh-session',
          reason:
            'Adapter declares sessionResume: false; sessionId is ralph-external ' +
            'bookkeeping only and is not forwarded as a provider flag',
        });
      }

      // ADR-001: the adapter seam is mandatory — ALL provider-CLI flags are
      // born inside the active adapter's buildSessionArgs(), gated by its
      // declared capabilities. No inline fallback.
      const args = this.providerAdapter.buildSessionArgs({
        prompt: options.prompt,
        sessionId: options.sessionId,
        model: options.model,
        budget: options.budget,
        maxTurns: options.maxTurns,
        verbose: options.verbose,
        systemPrompt: options.systemPrompt,
        mcpConfig: options.mcpConfig,
      });
      this._assertFlagsWithinCapabilities(args);
      this.startTime = Date.now();

      // Create write streams for output capture
      const stdoutStream = createWriteStream(options.stdoutPath);
      const stderrStream = createWriteStream(options.stderrPath);

      // Buffer for last portion of stdout (for quick analysis)
      let stdoutBuffer = '';
      const maxBufferSize = 100000; // 100KB

      // Spawn process via the active provider adapter (ADR-001: no binary fallback)
      const binary = this.providerAdapter.getBinary();
      const envOverrides = this.providerAdapter.getEnvOverrides();

      this.currentProcess = spawn(binary, args, {
        cwd: options.workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...envOverrides,
        },
      });

      const child = this.currentProcess;

      // Capture stdout
      child.stdout.on('data', (chunk) => {
        stdoutStream.write(chunk);
        stdoutBuffer += chunk.toString();
        // Keep buffer size manageable
        if (stdoutBuffer.length > maxBufferSize) {
          stdoutBuffer = stdoutBuffer.slice(-maxBufferSize);
        }
        this.emit('stdout', chunk);
      });

      // Capture stderr
      child.stderr.on('data', (chunk) => {
        stderrStream.write(chunk);
        this.emit('stderr', chunk);
      });

      // Handle timeout
      let timeoutId = null;
      let timedOut = false;

      if (options.timeoutMs) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          this.emit('timeout');
          child.kill('SIGTERM');
          // Force kill after 5 seconds if still running
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }, options.timeoutMs);
      }

      // Handle process completion
      child.on('close', (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const duration = Date.now() - this.startTime;
        this.currentProcess = null;

        // Close streams
        stdoutStream.end();
        stderrStream.end();

        const result = {
          exitCode: code || 0,
          stdoutPath: options.stdoutPath,
          stderrPath: options.stderrPath,
          duration,
          timedOut,
          stdoutBuffer,
        };

        this.emit('complete', result);
        resolve(result);
      });

      // Handle process errors
      child.on('error', (err) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const duration = Date.now() - this.startTime;
        this.currentProcess = null;

        // Close streams
        stdoutStream.end();
        stderrStream.end();

        this.emit('error', err);
        reject(err);
      });

      this.emit('started', { pid: child.pid, args });
    });
  }

  /**
   * Capture session artifacts after completion
   * @private
   * @param {LaunchOptions} options
   * @param {SessionResult} result
   */
  async _captureSessionArtifacts(options, result) {
    if (!options.outputDir) {
      return; // No output directory specified
    }

    try {
      // Copy session transcript if available
      const transcriptPath = await this.copySessionTranscript(
        options.sessionId,
        options.workingDir,
        options.outputDir
      );
      if (transcriptPath) {
        result.transcriptPath = transcriptPath;
      }

      // Parse stream events from stdout
      const { path: eventsPath, stats } = await this.parseStreamEvents(
        options.stdoutPath,
        options.outputDir
      );
      if (eventsPath) {
        result.parsedEventsPath = eventsPath;
        result.toolCallCount = stats.toolCallCount;
        result.errorCount = stats.errorCount;
        result.inputTokens = stats.inputTokens;
        result.outputTokens = stats.outputTokens;
        result.totalTokens = stats.totalTokens;
        result.costUsd = stats.costUsd;
        // Whether the provider actually reported token/cost usage this session.
        // Distinguishes "observed 0" from "cannot observe" so token/spend
        // ceilings aren't silently inert on providers that emit no usage (#1766).
        result.tokenUsageObserved = stats.usageEvents > 0;
        result.costObserved = stats.costUsd > 0 || (stats.usageEvents > 0 && stats.costFieldSeen === true);
      }
    } catch (err) {
      // Log but don't fail the session
      this.emit('artifact-error', err);
    }
  }

  /**
   * Copy session transcript from Claude's project directory
   *
   * Claude stores session transcripts at:
   * ~/.claude/projects/{encoded-path}/{session-id}.jsonl
   *
   * Path encoding: Replace `/` with `-`, prepend `-`
   * Example: /foo/bar → -foo-bar
   *
   * @param {string} sessionId - Session UUID
   * @param {string} workingDir - Working directory path
   * @param {string} outputDir - Destination directory
   * @returns {Promise<string|null>} Path to copied transcript or null if not found
   */
  async copySessionTranscript(sessionId, workingDir, outputDir) {
    try {
      // Use adapter for transcript path if available
      let sourcePath;
      if (this.providerAdapter) {
        sourcePath = this.providerAdapter.getTranscriptPath(sessionId, workingDir);
        if (!sourcePath) {
          // Provider doesn't support transcripts
          this.emit('transcript-not-found', { reason: 'Provider does not support transcripts' });
          return null;
        }
      } else {
        // Legacy Claude-specific path
        const encodedPath = workingDir.replace(/\//g, '-');
        sourcePath = join(
          homedir(),
          '.claude',
          'projects',
          encodedPath,
          `${sessionId}.jsonl`
        );
      }

      // Check if transcript exists
      if (!existsSync(sourcePath)) {
        this.emit('transcript-not-found', { sourcePath });
        return null;
      }

      // Copy to output directory
      const destPath = join(outputDir, 'session-transcript.jsonl');
      copyFileSync(sourcePath, destPath);

      this.emit('transcript-copied', { sourcePath, destPath });
      return destPath;
    } catch (err) {
      this.emit('transcript-error', err);
      return null;
    }
  }

  /**
   * Parse stream-json events from stdout capture
   *
   * Extracts structured events from Claude's stream-json output format.
   * Tracks tool calls, completions, and errors.
   *
   * @param {string} stdoutPath - Path to stdout capture file
   * @param {string} outputDir - Directory to save parsed events
   * @returns {Promise<{path: string|null, stats: Object}>} Parsed events path and statistics
   */
  async parseStreamEvents(stdoutPath, outputDir) {
    const stats = {
      toolCallCount: 0,
      errorCount: 0,
      completionCount: 0,
      totalEvents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      usageEvents: 0,
      costFieldSeen: false,
    };

    try {
      // Read stdout file
      const content = readFileSync(stdoutPath, 'utf-8');

      // Parse stream-json events (each line is a JSON object)
      const events = [];
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Categorize event
          const eventType = this._categorizeStreamEvent(event);

          const structuredEvent = {
            type: eventType,
            timestamp: Date.now(), // Could extract from event if available
            data: event,
          };

          events.push(structuredEvent);
          stats.totalEvents++;

          // Update stats
          if (eventType === 'tool_call') {
            stats.toolCallCount++;
          } else if (eventType === 'error') {
            stats.errorCount++;
          } else if (eventType === 'completion') {
            stats.completionCount++;
          }

          const usage = this._extractUsageStats(event);
          if (usage.hasCostField) {
            stats.costFieldSeen = true;
          }
          if (usage.hasUsage) {
            stats.inputTokens += usage.inputTokens;
            stats.outputTokens += usage.outputTokens;
            stats.cacheCreationInputTokens += usage.cacheCreationInputTokens;
            stats.cacheReadInputTokens += usage.cacheReadInputTokens;
            stats.totalTokens += usage.totalTokens;
            stats.costUsd += usage.costUsd;
            stats.usageEvents++;
          }
        } catch (parseErr) {
          // Skip malformed lines
          continue;
        }
      }

      // Save parsed events
      const eventsPath = join(outputDir, 'parsed-events.json');
      const eventsData = {
        stats,
        events,
        parsedAt: new Date().toISOString(),
      };

      mkdirSync(dirname(eventsPath), { recursive: true });
      const fs = await import('fs/promises');
      await fs.writeFile(eventsPath, JSON.stringify(eventsData, null, 2));

      this.emit('events-parsed', { eventsPath, stats });
      return { path: eventsPath, stats };
    } catch (err) {
      this.emit('parse-error', err);
      return { path: null, stats };
    }
  }

  /**
   * Categorize a stream-json event
   * @private
   * @param {Object} event - Raw event object
   * @returns {string} Event type
   */
  _categorizeStreamEvent(event) {
    // Check for tool-related events first (before checking type field)
    // This handles events like { type: 'tool_use', name: 'read_file' }
    if (event.type === 'tool_use' || event.tool || event.tool_use || event.name?.includes('tool')) {
      return 'tool_call';
    }

    // Check for error events
    // Note: message can be a string or object, so check type before calling includes
    if (event.type === 'error' || event.error || (typeof event.message === 'string' && event.message.includes('error'))) {
      return 'error';
    }

    // Check for other common type fields
    if (event.type) {
      return event.type;
    }

    // Heuristic categorization based on content
    if (event.stop_reason || event.content?.some?.(c => c.type === 'text')) {
      return 'completion';
    }

    if (event.delta || event.content_block_delta) {
      return 'content_delta';
    }

    if (event.message_start || event.content_block_start) {
      return 'start';
    }

    if (event.message_stop || event.content_block_stop) {
      return 'stop';
    }

    return 'unknown';
  }

  /**
   * Get current process PID
   * @returns {number|null}
   */
  getPid() {
    return this.currentProcess?.pid || null;
  }

  /**
   * Check if a process is running
   * @returns {boolean}
   */
  isRunning() {
    return this.currentProcess !== null && !this.currentProcess.killed;
  }

  /**
   * Kill current process
   * @param {string} [signal='SIGTERM']
   */
  kill(signal = 'SIGTERM') {
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill(signal);
    }
  }

  /**
   * Get elapsed time since start
   * @returns {number|null}
   */
  getElapsed() {
    return this.startTime ? Date.now() - this.startTime : null;
  }

  /**
   * Extract token/cost usage from provider stream events.
   *
   * Providers differ here: Claude stream-json commonly reports usage on message
   * or result events, while other providers may use camelCase or aggregate cost
   * fields. This method intentionally reads only numeric fields and returns a
   * zero-usage result when the event has no observable accounting data.
   *
   * @private
   * @param {Object} event - Raw event object
   * @returns {Object} Usage counters
   */
  _extractUsageStats(event) {
    // Usage can live at event.usage (result events) OR event.message.usage
    // (assistant events). Reading only the former lost all usage on timed-out
    // sessions, whose terminal result event never arrives (#1766).
    const usage =
      (event?.usage && typeof event.usage === 'object' && event.usage) ||
      (event?.message?.usage && typeof event.message.usage === 'object' && event.message.usage) ||
      {};
    const numberFrom = (...values) => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return 0;
    };

    const inputTokens = numberFrom(
      usage.input_tokens,
      usage.inputTokens,
      event.input_tokens,
      event.inputTokens
    );
    const outputTokens = numberFrom(
      usage.output_tokens,
      usage.outputTokens,
      event.output_tokens,
      event.outputTokens
    );
    const cacheCreationInputTokens = numberFrom(
      usage.cache_creation_input_tokens,
      usage.cacheCreationInputTokens,
      event.cache_creation_input_tokens,
      event.cacheCreationInputTokens
    );
    const cacheReadInputTokens = numberFrom(
      usage.cache_read_input_tokens,
      usage.cacheReadInputTokens,
      event.cache_read_input_tokens,
      event.cacheReadInputTokens
    );
    const explicitTotal = numberFrom(
      usage.total_tokens,
      usage.totalTokens,
      event.total_tokens,
      event.totalTokens
    );
    const totalTokens = explicitTotal ||
      inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;
    const costCandidates = [
      event.cost_usd,
      event.total_cost_usd,
      event.costUsd,
      event.totalCostUsd,
      usage.cost_usd,
      usage.costUsd,
    ];
    const hasCostField = costCandidates.some(
      (v) => typeof v === 'number' && Number.isFinite(v)
    );
    const costUsd = numberFrom(...costCandidates);

    return {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens,
      costUsd,
      hasCostField,
      hasUsage: totalTokens > 0 || costUsd > 0,
    };
  }
}

/**
 * Check if Claude CLI is available
 * @returns {Promise<boolean>}
 */
export async function isClaudeAvailable() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], {
      stdio: 'pipe',
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Get Claude CLI version
 * @returns {Promise<string|null>}
 */
export async function getClaudeVersion() {
  return new Promise((resolve) => {
    let output = '';

    const child = spawn('claude', ['--version'], {
      stdio: 'pipe',
    });

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });

    child.on('error', () => {
      resolve(null);
    });
  });
}

export default SessionLauncher;
