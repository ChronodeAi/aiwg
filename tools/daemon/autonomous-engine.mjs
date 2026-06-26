/**
 * AutonomousThinkingEngine — Self-directed task generation with safety constraints.
 *
 * Periodically reviews project state and proposes bounded improvement tasks.
 * Off by default. When enabled, constrained by allowlist, budget cap,
 * daily task limit, and optional human approval gate.
 *
 * @implements Plan: Daemon Starter — Autonomous Mode
 */

import { EventEmitter } from 'events';

/**
 * @typedef {Object} AutonomousConfig
 * @property {boolean} enabled
 * @property {number} thinking_interval_minutes
 * @property {number} max_daily_tasks
 * @property {number} budget_cap_usd
 * @property {boolean} require_approval
 * @property {string[]} allowed_actions
 * @property {string[]} blocked_actions
 */

/**
 * @typedef {Object} AutonomousEngineOptions
 * @property {import('../ralph-external/daemon-supervisor.mjs').DaemonSupervisor} supervisor
 * @property {AutonomousConfig} config
 * @property {import('../messaging/room-manager.mjs').RoomManager} [roomManager]
 */

/**
 * @typedef {Object} Proposal
 * @property {string} id
 * @property {string} action
 * @property {string} description
 * @property {string} prompt
 * @property {number} estimatedMinutes
 * @property {number} estimatedCostUsd
 * @property {'pending'|'approved'|'rejected'|'submitted'} status
 * @property {string} createdAt
 */

export class AutonomousEngine extends EventEmitter {
  /** @type {import('../ralph-external/daemon-supervisor.mjs').DaemonSupervisor} */
  #supervisor;

  /** @type {AutonomousConfig} */
  #config;

  /** @type {import('../messaging/room-manager.mjs').RoomManager|null} */
  #roomManager;

  /** @type {NodeJS.Timeout|null} */
  #timer = null;

  /** @type {number} */
  #dailyTaskCount = 0;

  /** @type {number} */
  #dailySpendUsd = 0;

  /** @type {string|null} */
  #lastResetDate = null;

  /** @type {Map<string, Proposal>} */
  #proposals = new Map();

  /** @type {number} */
  #proposalCounter = 0;

  /** @type {boolean} */
  #running = false;

  /**
   * Resolve configured budget cap while preserving explicit zero.
   *
   * @returns {number}
   */
  #budgetCapUsd() {
    return this.#config.budget_cap_usd ?? 5;
  }

  /**
   * Resolve configured daily task limit while preserving explicit zero.
   *
   * @returns {number}
   */
  #dailyTaskLimit() {
    return this.#config.max_daily_tasks ?? 10;
  }

  /**
   * @param {AutonomousEngineOptions} options
   */
  constructor(options) {
    super();
    this.#supervisor = options.supervisor;
    this.#config = options.config;
    this.#roomManager = options.roomManager || null;
  }

  /**
   * Start the autonomous thinking loop.
   */
  start() {
    if (this.#running) return;
    if (!this.#config.enabled) return;

    this.#running = true;
    const intervalMs = (this.#config.thinking_interval_minutes || 30) * 60 * 1000;

    this.#timer = setInterval(() => {
      this.#think().catch(err => {
        console.error(`[autonomous] Thinking cycle error: ${err.message}`);
      });
    }, intervalMs);

    console.log(`[autonomous] Started (interval: ${this.#config.thinking_interval_minutes}min, ` +
      `max daily: ${this.#config.max_daily_tasks}, budget: $${this.#config.budget_cap_usd})`);
  }

  /**
   * Stop the autonomous thinking loop.
   */
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#running = false;
  }

  /**
   * Enable autonomous mode at runtime.
   */
  enable() {
    this.#config.enabled = true;
    if (!this.#running) this.start();
  }

  /**
   * Disable autonomous mode at runtime.
   */
  disable() {
    this.#config.enabled = false;
    this.stop();
  }

  /**
   * Approve a pending proposal.
   *
   * @param {string} proposalId
   * @returns {boolean}
   */
  async approveProposal(proposalId) {
    const proposal = this.#proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return false;

    proposal.status = 'approved';
    await this.#submitProposal(proposal);
    return true;
  }

  /**
   * Reject a pending proposal.
   *
   * @param {string} proposalId
   * @param {string} [reason]
   * @returns {boolean}
   */
  rejectProposal(proposalId, reason) {
    const proposal = this.#proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return false;

    proposal.status = 'rejected';
    this.emit('proposal:rejected', { proposal, reason });
    return true;
  }

  /**
   * Run one thinking cycle.
   */
  async #think() {
    this.#resetDailyCountersIfNeeded();

    // Check daily limits
    if (this.#dailyTaskCount >= this.#dailyTaskLimit()) {
      console.log('[autonomous] Daily task limit reached, skipping');
      return;
    }

    if (this.#dailySpendUsd >= this.#budgetCapUsd()) {
      console.log('[autonomous] Daily budget cap reached, skipping');
      return;
    }

    // Generate a thinking prompt
    const prompt = this.#buildThinkingPrompt();

    try {
      // Use the supervisor to run a lightweight analysis task
      const result = await this.#supervisor.submit({
        prompt,
        priority: 1, // Lowest priority — interactive and scheduled tasks first
        metadata: {
          source: 'autonomous',
          type: 'thinking',
        },
      });

      // The task output should contain a JSON proposal
      // For now, track that we submitted a thinking task
      this.#dailyTaskCount++;
      this.emit('think:completed', { taskId: result?.loopId || result?.taskId });
    } catch (error) {
      console.error(`[autonomous] Failed to submit thinking task: ${error.message}`);
    }
  }

  /**
   * Build the prompt for a thinking cycle.
   *
   * @returns {string}
   */
  #buildThinkingPrompt() {
    const allowed = (this.#config.allowed_actions || []).join(', ');
    const blocked = (this.#config.blocked_actions || []).join(', ');

    return `You are the autonomous maintenance daemon for this project.

Review the following and propose ONE specific, bounded improvement:
- Check .aiwg/ artifact health (missing fields, stale dates)
- Check recent git log (last 24h) for incomplete work
- Check test coverage gaps
- Check documentation drift

Constraints:
- You may ONLY perform actions in this allowlist: [${allowed}]
- You may NOT perform: [${blocked}]
- Keep the task under 10 minutes estimated execution time
- Keep estimated cost under $${this.#budgetCapUsd()}

Respond with ONLY a JSON object (no markdown fences):
{
  "action": "one of the allowed actions",
  "description": "what you want to do and why",
  "prompt": "the exact prompt to execute the action",
  "estimatedMinutes": 5,
  "estimatedCostUsd": 0.50,
  "skip": false,
  "skipReason": "only if skip is true — why nothing needs doing"
}

If the project is in good shape and nothing needs doing, set skip: true.`;
  }

  /**
   * Submit an approved proposal as a task.
   *
   * @param {Proposal} proposal
   */
  async #submitProposal(proposal) {
    // Validate against constraints
    if (!this.#validateProposal(proposal)) {
      proposal.status = 'rejected';
      return;
    }

    try {
      const result = await this.#supervisor.submit({
        prompt: proposal.prompt,
        priority: 1,
        metadata: {
          source: 'autonomous',
          type: 'proposal',
          proposalId: proposal.id,
          action: proposal.action,
        },
      });

      proposal.status = 'submitted';
      this.#dailyTaskCount++;
      this.#dailySpendUsd += proposal.estimatedCostUsd || 0;

      this.emit('proposal:submitted', {
        proposal,
        taskId: result?.loopId || result?.taskId,
      });
    } catch (error) {
      console.error(`[autonomous] Failed to submit proposal ${proposal.id}: ${error.message}`);
    }
  }

  /**
   * Validate a proposal against safety constraints.
   *
   * @param {Proposal} proposal
   * @returns {boolean}
   */
  #validateProposal(proposal) {
    const allowed = this.#config.allowed_actions || [];
    const blocked = this.#config.blocked_actions || [];

    if (blocked.includes(proposal.action)) {
      console.warn(`[autonomous] Blocked action: ${proposal.action}`);
      return false;
    }

    if (allowed.length > 0 && !allowed.includes(proposal.action)) {
      console.warn(`[autonomous] Action not in allowlist: ${proposal.action}`);
      return false;
    }

    if ((this.#dailySpendUsd + (proposal.estimatedCostUsd || 0)) > this.#budgetCapUsd()) {
      console.warn('[autonomous] Proposal would exceed daily budget');
      return false;
    }

    return true;
  }

  /**
   * Deterministically validate an action against autonomous safety constraints
   * without submitting work to a provider-backed agent.
   *
   * @param {string} action
   * @param {{ estimatedCostUsd?: number }} [options]
   * @returns {{ accepted: boolean, action: string, reason: string|null, noLlm: boolean }}
   */
  rehearseAction(action, options = {}) {
    const proposal = {
      id: 'rehearsal',
      action,
      description: 'deterministic daemon safety rehearsal',
      prompt: '',
      estimatedMinutes: 0,
      estimatedCostUsd: options.estimatedCostUsd ?? 0,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    const allowed = this.#config.allowed_actions || [];
    const blocked = this.#config.blocked_actions || [];

    if (blocked.includes(proposal.action)) {
      return { accepted: false, action, reason: 'blocked-action', noLlm: true };
    }

    if (allowed.length > 0 && !allowed.includes(proposal.action)) {
      return { accepted: false, action, reason: 'not-allowed', noLlm: true };
    }

    if ((this.#dailySpendUsd + proposal.estimatedCostUsd) > this.#budgetCapUsd()) {
      return { accepted: false, action, reason: 'budget-exceeded', noLlm: true };
    }

    return { accepted: true, action, reason: null, noLlm: true };
  }

  /**
   * Reset daily counters at midnight.
   */
  #resetDailyCountersIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.#lastResetDate !== today) {
      this.#dailyTaskCount = 0;
      this.#dailySpendUsd = 0;
      this.#lastResetDate = today;
    }
  }

  /**
   * Get pending proposals.
   *
   * @returns {Proposal[]}
   */
  getPendingProposals() {
    return [...this.#proposals.values()].filter(p => p.status === 'pending');
  }

  /**
   * Get status summary.
   *
   * @returns {Object}
   */
  getStatus() {
    return {
      enabled: this.#config.enabled,
      running: this.#running,
      dailyTaskCount: this.#dailyTaskCount,
      dailyTaskLimit: this.#dailyTaskLimit(),
      dailySpendUsd: this.#dailySpendUsd,
      budgetCapUsd: this.#budgetCapUsd(),
      pendingProposals: this.getPendingProposals().length,
      allowedActions: this.#config.allowed_actions || [],
      blockedActions: this.#config.blocked_actions || [],
      requireApproval: this.#config.require_approval || false,
    };
  }
}

export default AutonomousEngine;
