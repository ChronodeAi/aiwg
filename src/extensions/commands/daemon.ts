// Command definitions for the shared daemon runtime and its existing profiles.
import type { Extension, SkillMetadata } from '../types.js';

export const daemonCommand: Extension = {
  id: 'daemon',
  type: 'skill',
  name: 'Daemon',
  description: 'Manage the daemon: start, stop, status, chat, attach and scheduled tasks',
  version: '1.0.0',
  capabilities: ['cli', 'daemon', 'lifecycle'],
  keywords: ['daemon', 'start', 'stop', 'status', 'chat', 'attach'],
  category: 'daemon',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: false },
  metadata: {
    type: 'skill',
    triggerPhrases: ['daemon', 'daemon start', 'daemon status'],
    commandHint: {
      template: 'utility',
      argumentHint: '<start|stop|status|restart|logs|chat|attach|task|init|rooms|autonomous|schedule|memory|pty> [options]',
      allowedTools: ['Bash', 'Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const behaviorCommand: Extension = {
  id: 'behavior',
  type: 'skill',
  name: 'Behavior',
  description: 'Manage behavior YAML bundles that bind directives and toolsets to agent types',
  version: '1.0.0',
  capabilities: ['cli', 'behavior', 'daemon', 'configuration'],
  keywords: ['behavior', 'directive', 'toolset', 'daemon', 'ops', 'agent-type'],
  category: 'daemon',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['behavior', 'list behaviors', 'apply behavior', 'manage behaviors'],
    commandHint: {
      template: 'utility',
      argumentHint: '<list|info|apply|remove> [name] [--to <agent>] [--from <agent>]',
      allowedTools: ['Read', 'Bash', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const daemonInitCommand: Extension = {
  id: 'daemon-init',
  type: 'skill',
  name: 'Daemon Init',
  description: 'Initialize daemon config from a profile template (default: manager)',
  version: '1.0.0',
  capabilities: ['cli', 'daemon', 'configuration', 'scaffolding'],
  keywords: ['daemon', 'init', 'profile', 'manager', 'orchestrator', 'config'],
  category: 'daemon',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['daemon init', 'init daemon', 'initialize daemon', 'daemon setup'],
    commandHint: {
      template: 'utility',
      argumentHint: '[profile-name] [--force]',
      allowedTools: ['Bash', 'Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const housekeeperCommand: Extension = {
  id: 'housekeeper',
  type: 'skill',
  name: 'Housekeeper',
  description: 'Deterministic maintenance daemon: start/stop/status/run-once, jobs, watch roots, autostart units',
  version: '1.0.0',
  capabilities: ['cli', 'daemon', 'maintenance', 'scheduler'],
  keywords: ['housekeeper', 'daemon', 'maintenance', 'schedule', 'run-once', 'autostart'],
  category: 'daemon',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['housekeeper', 'housekeeper status', 'housekeeper start', 'maintenance daemon'],
    commandHint: {
      template: 'utility',
      argumentHint: '<start|stop|status|run-once|job|watch|install|uninstall> [options]',
      allowedTools: ['Bash', 'Read', 'Write'],
      executionSteps: [
        'Parse subcommand and flags',
        'Start/stop/query the housekeeper-profile daemon or edit its config',
        'Run one job without a daemon (run-once) or write autostart units (install)',
        'Display result',
      ],
    },
  } satisfies SkillMetadata,
};

