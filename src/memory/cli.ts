/**
 * Memory CLI — `aiwg memory <subcommand>`
 *
 * Thin subsystem wrapper around `runSubsystemCli('memory', ...)` for
 * the `memory` storage subsystem. Subcommands and behavior live in
 * `src/storage/subsystem-cli.ts` so memory and reflections share the
 * same implementation.
 *
 * @issue #934
 * @issue #966
 */

import { runSubsystemCli } from '../storage/subsystem-cli.js';
import { memoryUsage, memoryInput, MEMORY_EXIT_USAGE } from './cli-result.js';
import { listProviderMemoryAdapters } from './provider-memory-adapter.js';
import type { ProjectMemoryLookup } from './project-registry.js';

interface ProjectMemoryCliOptions {
  id?: string;
  name?: string;
  workspace?: string;
  remote?: string;
  memoryRoot?: string;
}

export async function main(args: string[]): Promise<number | void> {
  if (args[0] === 'recommend') {
    const { runMemoryRecommendCli } = await import('./recommend-cli.js');
    return runMemoryRecommendCli(args.slice(1));
  }
  if (['plan', 'apply', 'verify', 'restore'].includes(args[0])) {
    const { runMemoryMaintenanceCli } = await import('./maintenance-cli.js');
    return runMemoryMaintenanceCli(args[0], args.slice(1));
  }
  if (args[0] === 'audit') {
    const { auditMemory, formatMemoryAudit } = await import('./audit.js');
    const opts = memoryUsage(() => parseMemoryAuditOptions(args.slice(1)));
    if (opts.help) { console.log(MEMORY_AUDIT_USAGE); return; }
    const report = await auditMemory(opts);
    if (opts.cost) {
      const { costMemory, formatMemoryCost } = await import('./cost.js');
      const cost = costMemory(report);
      console.log(opts.json ? JSON.stringify(cost, null, 2) : formatMemoryCost(cost));
      return report.findings.length ? 1 : 0;
    }
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatMemoryAudit(report));
    return report.findings.length ? 1 : 0;
  }
  if (args[0] === 'cost') {
    const { auditMemory } = await import('./audit.js');
    const { costMemory, formatMemoryCost } = await import('./cost.js');
    const opts = memoryUsage(() => parseMemoryCostOptions(args.slice(1)));
    if (opts.help) { console.log(MEMORY_COST_USAGE); return; }
    const report = await auditMemory(opts);
    const cost = costMemory(report, await memoryInput(() => resolveMemoryCostInputs(opts)));
    console.log(opts.json ? JSON.stringify(cost, null, 2) : formatMemoryCost(cost));
    return report.findings.length ? 1 : 0;
  }
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(MEMORY_AUDIT_USAGE);
    if (args.length) return;
  }
  if (args[0] === 'project') {
    await runProjectMemoryCli(args.slice(1));
    return;
  }
  await runSubsystemCli('memory', args);
}

async function runProjectMemoryCli(args: string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);
  const json = rest.includes('--json');
  const registry = await import('./project-registry.js');

  switch (subcommand) {
    case 'register': {
      const opts = parseProjectMemoryOptions(rest);
      const entry = await registry.registerProjectMemory({
        workspaceRoot: opts.workspace,
        id: opts.id,
        name: opts.name,
        memoryRoot: opts.memoryRoot,
      });
      if (json) console.log(JSON.stringify(entry, null, 2));
      else {
        console.log(`Registered project memory: ${entry.id}`);
        console.log(`  workspace: ${entry.workspaceRoots.join(', ')}`);
        console.log(`  memory:    ${entry.memoryRoot}`);
      }
      break;
    }
    case 'inspect':
    case 'resolve': {
      const opts = parseProjectMemoryOptions(rest);
      if (subcommand === 'resolve') {
        const resolved = await registry.resolveProjectMemoryRoot(opts.workspace ?? process.cwd());
        if (json) console.log(JSON.stringify(resolved, null, 2));
        else {
          console.log(resolved.root);
          console.log(`source: ${resolved.source} (${resolved.reason})`);
        }
        break;
      }
      const lookup = await registry.lookupProjectMemory({
        id: opts.id,
        workspaceRoot: opts.workspace ?? (!opts.id && !opts.remote ? process.cwd() : undefined),
        gitRemote: opts.remote,
      });
      if (json) console.log(JSON.stringify(lookup, null, 2));
      else printLookup(lookup);
      break;
    }
    case 'list': {
      const manifest = await registry.readProjectMemoryManifest();
      if (json) console.log(JSON.stringify(manifest.projects, null, 2));
      else if (manifest.projects.length === 0) console.log('No registered project memory entries.');
      else for (const entry of manifest.projects) console.log(`${entry.id}\t${entry.name}\t${entry.memoryRoot}`);
      break;
    }
    case 'reindex': {
      const index = await registry.writeProjectMemoryIndex();
      if (json) console.log(JSON.stringify(index, null, 2));
      else console.log(`Reindexed ${Object.keys(index.byProjectId).length} project memory entr${Object.keys(index.byProjectId).length === 1 ? 'y' : 'ies'} at ${registry.projectMemoryIndexPath()}`);
      break;
    }
    case 'relocate': {
      const id = rest.find((arg) => !arg.startsWith('--'));
      const target = rest.filter((arg) => !arg.startsWith('--'))[1];
      if (!id || !target) throw new Error('Usage: aiwg memory project relocate <id> <memory-root> [--json]');
      const entry = await registry.relocateProjectMemory(id, target);
      if (json) console.log(JSON.stringify(entry, null, 2));
      else console.log(`Relocated ${entry.id} to ${entry.memoryRoot}`);
      break;
    }
    case 'remove': {
      const id = rest.find((arg) => !arg.startsWith('--'));
      if (!id) throw new Error('Usage: aiwg memory project remove <id> [--delete-files] [--json]');
      const removed = await registry.removeProjectMemory(id, { deleteFiles: rest.includes('--delete-files') });
      if (json) console.log(JSON.stringify({ removed }, null, 2));
      else console.log(removed ? `Removed project memory mapping: ${removed.id}` : `No project memory mapping found for: ${id}`);
      break;
    }
    default:
      printProjectMemoryUsage();
      if (subcommand) throw new Error(`Unknown memory project subcommand: ${subcommand}`);
  }
}

function parseProjectMemoryOptions(args: string[]): ProjectMemoryCliOptions {
  const opts: ProjectMemoryCliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--id') opts.id = args[++i];
    else if (arg === '--name') opts.name = args[++i];
    else if (arg === '--workspace') opts.workspace = args[++i];
    else if (arg === '--remote') opts.remote = args[++i];
    else if (arg === '--memory-root') opts.memoryRoot = args[++i];
  }
  return opts;
}

function printLookup(lookup: ProjectMemoryLookup): void {
  if (lookup.status === 'missing') {
    console.log(`No project memory mapping found: ${lookup.reason}`);
    return;
  }
  if (lookup.status === 'ambiguous') {
    console.log(lookup.reason);
    for (const entry of lookup.entries) console.log(`  ${entry.id}\t${entry.memoryRoot}`);
    return;
  }
  console.log(`Project memory: ${lookup.entry.id}`);
  console.log(`  matched by: ${lookup.matchedBy}`);
  console.log(`  name:       ${lookup.entry.name}`);
  console.log(`  memory:     ${lookup.entry.memoryRoot}`);
  console.log(`  workspace:  ${lookup.entry.workspaceRoots.join(', ')}`);
  if (lookup.entry.gitRemotes.length > 0) console.log(`  remotes:    ${lookup.entry.gitRemotes.join(', ')}`);
}

function printProjectMemoryUsage(): void {
  console.log(`Usage: aiwg memory project <subcommand>

Subcommands:
  register [--id <id>] [--name <name>] [--workspace <path>] [--memory-root <path>] [--json]
  inspect [--id <id> | --workspace <path> | --remote <url>] [--json]
  resolve [--workspace <path>] [--json]
  list [--json]
  reindex [--json]
  relocate <id> <memory-root> [--json]
  remove <id> [--delete-files] [--json]

The manifest lives at ~/.aiwg/projects/manifest.json and each registered
project memory root uses a private .aiwg layout under ~/.aiwg/projects/<id>/.aiwg.`);
}


export const MEMORY_AUDIT_USAGE = `Usage: aiwg memory audit [--scope global|project|provider] [--provider <id>] [--json] [--cost]
       aiwg memory cost [--scope global|project|provider] [--provider <id>] [--json] [--demote <id|path> ...] [--startup-measurement <file>] [--usage <file>]

Read-only static memory and instruction inventory. Defaults to this workspace;
global roots require --scope global. --scope provider requires --provider <id>.
Reports include exposure chains, unavailable/opaque surfaces and scan bounds.
Static eligibility does not establish live context loading. JSON: aiwg.memory-audit.v1.
--cost renders the same inventory through the resident-cost view (JSON: aiwg.memory-cost.v1).
The cost subcommand adds --demote previews, a #2936 startup-measurement report
and caller-supplied usage evidence; all views are read-only and write nothing.
Read-only recommendations: recommend (use --help for evidence and review export).
Reviewed lifecycle: plan, apply, verify, restore (use --help for exact-plan options).
Other memory subcommands: path, list, get, put, delete, append-log, project.
${MEMORY_EXIT_USAGE}`;

export const MEMORY_COST_USAGE = `Usage: aiwg memory cost [--scope global|project|provider] [--provider <id>] [--json] [--demote <id|path> ...] [--startup-measurement <file>] [--usage <file>]

Read-only resident context cost and memory utility over the static audit inventory.
Token estimates reuse the existing UTF-8 bytes estimators (#2936 startup measure,
#2938 inline-budget guard); no new tokenizer. Anything not measurable locally
stays unknown, never guessed. --demote previews before/after cost with the
retrieval anchors required to keep demoted content reachable. --usage reads a
JSON object of { "<item-id>": { retrieved, used, rejected, evidence } } held in
memory only. JSON: aiwg.memory-cost.v1. Writes nothing.
${MEMORY_EXIT_USAGE}`;

export function parseMemoryAuditOptions(args: string[]): {
  scope?: 'global' | 'project' | 'provider'; provider?: string; json?: boolean; help?: boolean; cost?: boolean;
} {
  const opts: ReturnType<typeof parseMemoryAuditOptions> = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const [flag, inline, ...extra] = args[index].split('=');
    if (!['--scope', '--provider', '--json', '--cost', '--help', '-h'].includes(flag) || extra.length) throw new Error(`Unknown memory audit argument: ${args[index]}`);
    if (seen.has(flag)) throw new Error(`Duplicate memory audit option: ${flag}`);
    seen.add(flag);
    if (flag === '--json' || flag === '--cost' || flag === '--help' || flag === '-h') {
      if (inline !== undefined) throw new Error(`${flag} takes no value`);
      if (flag === '--json') opts.json = true;
      else if (flag === '--cost') opts.cost = true;
      else opts.help = true;
      continue;
    }
    const value = inline ?? args[++index];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    if (flag === '--scope') {
      if (!['global', 'project', 'provider'].includes(value)) throw new Error('--scope must be global, project or provider');
      opts.scope = value as typeof opts.scope;
    } else opts.provider = value;
  }
  if (opts.scope === 'provider' && !opts.provider && !opts.help) throw new Error('--scope provider requires --provider <id>');
  if (!opts.help && opts.provider && !listProviderMemoryAdapters().some(adapter => adapter.providerId === opts.provider)) throw new Error(`Unknown memory provider '${opts.provider}'`);
  return opts;
}

export interface MemoryCostCliOptions {
  scope?: 'global' | 'project' | 'provider';
  provider?: string;
  json?: boolean;
  help?: boolean;
  demote: string[];
  startupMeasurement?: string;
  usage?: string;
}

export function parseMemoryCostOptions(args: string[]): MemoryCostCliOptions {
  const opts: MemoryCostCliOptions = { demote: [] };
  const once = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const [flag, inline, ...extra] = args[index].split('=');
    if (!['--scope', '--provider', '--json', '--demote', '--startup-measurement', '--usage', '--help', '-h'].includes(flag) || extra.length) {
      throw new Error(`Unknown memory cost argument: ${args[index]}`);
    }
    if (flag !== '--demote') {
      if (once.has(flag)) throw new Error(`Duplicate memory cost option: ${flag}`);
      once.add(flag);
    }
    if (flag === '--json' || flag === '--help' || flag === '-h') {
      if (inline !== undefined) throw new Error(`${flag} takes no value`);
      if (flag === '--json') opts.json = true;
      else opts.help = true;
      continue;
    }
    const value = inline ?? args[++index];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    if (flag === '--scope') {
      if (!['global', 'project', 'provider'].includes(value)) throw new Error('--scope must be global, project or provider');
      opts.scope = value as NonNullable<MemoryCostCliOptions['scope']>;
    } else if (flag === '--provider') opts.provider = value;
    else if (flag === '--demote') opts.demote.push(value);
    else if (flag === '--startup-measurement') opts.startupMeasurement = value;
    else opts.usage = value;
  }
  if (opts.scope === 'provider' && !opts.provider && !opts.help) throw new Error('--scope provider requires --provider <id>');
  if (!opts.help && opts.provider && !listProviderMemoryAdapters().some(adapter => adapter.providerId === opts.provider)) throw new Error(`Unknown memory provider '${opts.provider}'`);
  return opts;
}

/** Read-only input resolution for the cost view. Reads input files; writes nothing. */
export async function resolveMemoryCostInputs(opts: MemoryCostCliOptions): Promise<{
  usage?: Record<string, { retrieved?: boolean; used?: boolean; rejected?: boolean; evidence?: string }>;
  startupMeasurement?: unknown;
  demote?: string[];
}> {
  const fs = await import('node:fs/promises');
  const readJson = async (file: string, label: string): Promise<unknown> => {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      throw new Error(`${label} could not be read: ${(error as NodeJS.ErrnoException).message}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} is not valid JSON: ${file}`);
    }
  };
  return {
    usage: opts.usage ? (await readJson(opts.usage, 'Usage evidence')) as Record<string, { retrieved?: boolean; used?: boolean; rejected?: boolean; evidence?: string }> : undefined,
    startupMeasurement: opts.startupMeasurement ? await readJson(opts.startupMeasurement, 'Startup measurement') : undefined,
    demote: opts.demote.length ? [...opts.demote] : undefined,
  };
}
