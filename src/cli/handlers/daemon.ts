/**
 * Daemon Command Handlers
 *
 * Handlers for daemon-related CLI commands (lifecycle, behavior management, daemon init).
 * Each handler delegates to existing scripts in tools/.
 *
 * @tests @test/unit/cli/handlers/coverage.test.ts
 */

import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { createScriptRunner } from './script-runner.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';

/**
 * Base class for daemon handlers that delegate to scripts
 */
abstract class DaemonHandler implements CommandHandler {
  abstract id: string;
  abstract name: string;
  abstract description: string;
  abstract scriptPath: string;

  category = 'daemon' as const;

  get aliases(): string[] {
    return [this.id];
  }

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run(this.scriptPath, ctx.args);
  }
}

/** Runs the existing daemon CLI without changing its shared lifecycle state. */
class DaemonControlHandler extends DaemonHandler {
  id = 'daemon';
  name = 'Daemon';
  description = 'Manage the daemon: start, stop, status, chat, attach and scheduled tasks';
  scriptPath = 'tools/daemon/index.mjs';

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const runner = createScriptRunner(await getFrameworkRoot());
    return runner.run(this.scriptPath, ctx.args, { cwd: ctx.cwd });
  }

  async help(ctx: HandlerContext): Promise<HandlerResult> {
    return this.execute({ ...ctx, args: ['--help'] });
  }
}

/**
 * Behavior Handler
 *
 * Manages behavior YAML bundles that bind directives and toolsets to agent types.
 */
class BehaviorHandler extends DaemonHandler {
  id = 'behavior';
  name = 'Behavior';
  description = 'Manage behavior YAML bundles that bind directives and toolsets to agent types';
  scriptPath = 'tools/daemon/behavior.mjs';
}

/**
 * Daemon Init Handler
 *
 * Initialize daemon config from a profile template.
 */
class DaemonInitHandler extends DaemonHandler {
  id = 'daemon-init';
  name = 'Daemon Init';
  description = 'Initialize daemon config from a profile template (default: manager)';
  scriptPath = 'tools/daemon/init-profile.mjs';
}

/**
 * Exported handler instances
 */
export const daemonHandler: CommandHandler = new DaemonControlHandler();
export const behaviorHandler: CommandHandler = new BehaviorHandler();
export const daemonInitHandler: CommandHandler = new DaemonInitHandler();

/**
 * All daemon handlers for registration
 */
export const daemonHandlers: CommandHandler[] = [
  daemonHandler,
  behaviorHandler,
  daemonInitHandler,
];
