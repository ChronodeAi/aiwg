import { memoryUsage, memoryInput, MEMORY_EXIT_USAGE } from './cli-result.js';
import { readFile } from 'node:fs/promises';
import { parseMemoryCostOptions, resolveMemoryCostInputs, type MemoryCostCliOptions } from './cli.js';
import { auditMemory } from './audit.js';
import { formatMemoryRecommendations, recommendMemory, RecommendationInputsSchema } from './recommend.js';

export const MEMORY_RECOMMEND_USAGE = `Usage: aiwg memory recommend [--scope global|project|provider] [--provider <id>] [--json]
    [--evidence <json-file>] [--usage <json-file>] [--candidate <id> --emit-review-input]
Read-only recommendations: duplicates, taxonomy, conflicts, supersession, tiers and retirement.
JSON: aiwg.memory-recommendations.v1. Writes nothing; never approves or applies a plan.
--evidence supplies per-item owner/provenance/criticality/pin/review/creation/history evidence
and configurable thresholds. --usage uses the same observed utility input as memory cost.
Unknown history and rare obligations block retirement. Thresholds are local starting points.
New knowledge defaults to indexed storage; prefer buildWorkspaceContextPack before residency.
--emit-review-input prints one selected advisory candidate as JSON to stdout. Save it with
shell redirection, review it, then use memory plan --recommendation <file> --reviewer <name>
--out <new-plan-file>. Conflicts and blocked/rejected proposals require owner resolution.
${MEMORY_EXIT_USAGE}`;

export interface MemoryRecommendCliOptions extends MemoryCostCliOptions {
  evidence?: string;
  candidate?: string;
  emitReviewInput?: boolean;
}
export function parseMemoryRecommendOptions(args: string[]): MemoryRecommendCliOptions {
  const shared: string[] = [];
  const extra: Pick<MemoryRecommendCliOptions, 'evidence' | 'candidate' | 'emitReviewInput'> = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const [flag, inline, ...rest] = args[index].split('=');
    if (['--evidence', '--candidate', '--emit-review-input'].includes(flag)) {
      if (rest.length) throw new Error(`Unknown memory recommend argument: ${args[index]}`);
      if (seen.has(flag)) throw new Error(`Duplicate memory recommend option: ${flag}`);
      seen.add(flag);
      if (flag === '--emit-review-input') {
        if (inline !== undefined) throw new Error(`${flag} takes no value`);
        extra.emitReviewInput = true;
      } else {
        const value = inline ?? args[++index];
        if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
        if (flag === '--evidence') extra.evidence = value;
        else extra.candidate = value;
      }
    } else {
      if (['--demote', '--startup-measurement'].includes(flag)) throw new Error(`Unknown memory recommend argument: ${args[index]}`);
      shared.push(args[index]);
      if (['--scope', '--provider', '--usage'].includes(flag) && inline === undefined) {
        const value = args[++index];
        if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
        shared.push(value);
      }
    }
  }
  // Reuse the audit/cost strict scope and provider conventions.
  const opts = { ...parseMemoryCostOptions(shared), ...extra };
  if (!opts.help && Boolean(opts.emitReviewInput) !== Boolean(opts.candidate)) throw new Error('--candidate and --emit-review-input must be selected together');
  return opts;
}

export async function runMemoryRecommendCli(args: string[]): Promise<number | void> {
  const opts = memoryUsage(() => parseMemoryRecommendOptions(args));
  if (opts.help) { console.log(MEMORY_RECOMMEND_USAGE); return; }
  const input = opts.evidence ? await memoryInput(async () => RecommendationInputsSchema.parse(JSON.parse(await readFile(opts.evidence!, 'utf8')))) : {};
  const audit = await auditMemory(opts);
  const report = recommendMemory(audit, input, await memoryInput(() => resolveMemoryCostInputs(opts)));
  if (opts.candidate) {
    const selected = report.candidates.find(c => c.id === opts.candidate);
    if (!selected) throw new Error('Recommendation candidate is missing or changed; rerun recommend');
    if (selected.status !== 'advisory') throw new Error(`Cannot emit review input: candidate is ${selected.status}: ${selected.blockedReasons.join('; ')}`);
    report.candidates = [selected];
  }
  console.log(opts.json || opts.emitReviewInput ? JSON.stringify(report, null, 2) : formatMemoryRecommendations(report));
  return report.candidates.length || audit.findings.length ? 1 : 0;
}
