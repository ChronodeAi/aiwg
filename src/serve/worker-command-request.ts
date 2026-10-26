// Parses direct worker requests; configured role authority is validated by the resolver.
import { DEFAULT_WORKER_SELECTION, WorkerPolicyError } from '../models/provider-policy.js';

export interface WorkerCommandRequest {
  role: string;
  task: string;
  group: string;
  brief: string;
  workdir: string;
  final_output: string;
  transport?: 'shell' | 'mcp';
  format?: 'shell' | 'json';
  /** Managed parent supplies the validated task authority; never a CLI override. */
  managedIntent?: import('../mission-protocol/types.js').WorkerSelectionIntent;
  authority?: { premiumAuthorized: true; maxAutoTier: 3 };
}

/** Only fixed argument guidance is safe to expose in public request diagnostics. */
export class WorkerRequestArgumentError extends WorkerPolicyError {
  readonly pointer: string;

  constructor(key: 'task' | 'brief' | 'workdir' | 'final_output') {
    super('OG_CONFIG_REFERENCE', key === 'task'
      ? `Missing required --task. Valid task classes: ${Object.keys(DEFAULT_WORKER_SELECTION.taskClasses!).join(', ')}, plus classes configured in defaults.workerSelection.taskClasses.`
      : `--${key.replace('_', '-')} must be an absolute path; relative paths are not resolved against cwd or --workdir.`);
    this.pointer = `/request/${key}`;
  }
}

/** Reject unsupported syntax before discovery or any path reads. */
export function parseWorkerCommandArgs(args: string[]): WorkerCommandRequest {
  const names: Record<string, string> = { role: 'role', task: 'task', group: 'group', brief: 'brief',
    workdir: 'workdir', 'final-output': 'final_output', transport: 'transport', format: 'format' };
  const result: Record<string, string> = {};
  let json = false;
  let premiumAuthorized = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--authorize-premium') {
      if (premiumAuthorized) throw new Error('Duplicate --authorize-premium');
      premiumAuthorized = true; continue;
    }
    if (token === '--json') { if (json) throw new Error('Duplicate --json'); json = true; continue; }
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(token);
    if (!match || !Object.hasOwn(names, match[1])) throw new Error(`Unsupported models resolve argument: ${token}`);
    const key = names[match[1]];
    if (key in result) throw new Error(`Duplicate --${match[1]}`);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--') && match[2] === undefined || value.includes('\0')) {
      if (key === 'task' && !value?.includes('\0')) throw new WorkerRequestArgumentError('task');
      throw new Error(`--${match[1]} requires a value`);
    }
    result[key] = value;
  }
  if (json && result.format && result.format !== 'json') throw new Error('--json conflicts with --format');
  if (json) result.format = 'json';
  for (const key of ['role', 'task', 'group', 'brief', 'workdir', 'final_output']) {
    if (key === 'task' && !result[key]) throw new WorkerRequestArgumentError('task');
    if (!result[key]) throw new Error(`Missing ${key}`);
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(result.role)) throw new Error('Unsupported role');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(result.group)) throw new Error('Invalid group');
  if (result.transport && !['shell', 'mcp'].includes(result.transport)) throw new Error('Unsupported transport');
  if (result.format && !['shell', 'json'].includes(result.format)) throw new Error('Unsupported renderer; use POSIX shell or JSON');
  return { ...result, ...(premiumAuthorized ? { authority: { premiumAuthorized: true, maxAutoTier: 3 } } : {}) } as unknown as WorkerCommandRequest;
}
