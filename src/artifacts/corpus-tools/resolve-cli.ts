// Parse the corpus resolve arguments, emit per-reference results, and preserve semantic exit codes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AiwgError } from '../../cli/errors.js';
import { ResearchError, ResearchErrorCode } from '../../research/types.js';
import { createResolverClients, resolveReference, type ResolutionResult } from './resolve.js';

export const RESOLVE_USAGE = 'aiwg corpus resolve "<title | URL | arXiv ID | DOI | bibliography line>" [--year YYYY] [--json]\naiwg corpus resolve --from-file refs.txt [--year YYYY] [--json]\nExit codes: 0 resolved, 2 ambiguous, 3 unresolved, 4 deferred (incomplete lookup; retry), 1 usage or storage error (batch: worst line).\n';

function usage(message: string): never {
  throw new AiwgError({ code: 'ERR_CORPUS_RESOLVE_USAGE', message, exitCode: 1, hint: RESOLVE_USAGE.trim() });
}

function render(result: ResolutionResult & { line?: number; error?: string }): string {
  const lines = [`${result.line ? `Line ${result.line}: ` : ''}${result.status}: ${result.input}`];
  for (const candidate of result.candidates) lines.push(`  ${candidate.score.toFixed(3)} ${candidate.paper.title} (${candidate.paper.id})`);
  for (const finding of result.findings) lines.push(`  Finding ${finding.type}: supplied "${finding.supplied}"; returned "${finding.returned}"`);
  for (const match of result.corpus_matches) lines.push(`  Already in corpus: ${match.ref} (${match.matched_by.join(', ')})`);
  for (const path of result.paths_tried) lines.push(`  Tried ${path.source}/${path.method}: ${path.query} → ${path.status} (${path.returned.length})${path.error ? `: ${path.error}` : ''}`);
  if (result.incomplete) lines.push(`  Incomplete${result.error ? `: ${result.error}` : ''}`);
  return lines.join('\n') + '\n';
}

export async function resolveCli(args: string[], root: string, cwd: string): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(RESOLVE_USAGE); return; }
  let input: string | undefined;
  let fromFile: string | undefined;
  let year: number | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (seen.has(arg)) usage(`${arg} may only be supplied once`);
      seen.add(arg);
    }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--year' || arg === '--from-file') {
      const value = args[++i];
      if (!value || value.startsWith('--')) usage(`${arg} requires a value`);
      if (arg === '--from-file') {
        if (fromFile) usage('--from-file may only be supplied once');
        fromFile = value;
      } else {
        if (year !== undefined || !/^(?:18|19|20|21)\d{2}$/.test(value)) usage('--year requires one year between 1800 and 2199');
        year = Number(value);
      }
    } else {
      if (arg.startsWith('-')) usage(`Unknown resolve option: ${arg}`);
      if (input !== undefined) usage('Supply one quoted reference');
      input = arg;
    }
  }
  if (input !== undefined && fromFile) usage('A reference and --from-file are mutually exclusive');
  if (!fromFile && !input?.trim()) usage('Supply a reference or --from-file');
  const references = fromFile ? readFileSync(resolve(cwd, fromFile), 'utf8').split(/\r?\n/)
    .flatMap((text, index) => text.trim() ? [{ input: text.trim(), line: index + 1 }] : []) : [{ input: input! }];
  const clients = createResolverClients();
  const results: Array<ResolutionResult & { line?: number; error?: string }> = [];
  for (const reference of references) {
    try {
      results.push({ ...await resolveReference(reference.input, root, year, clients), ...reference });
    } catch (error) {
      // Storage, validation and programming errors keep the corpus error/exit convention.
      if (!(error instanceof ResearchError) || ![
        ResearchErrorCode.RF_103, ResearchErrorCode.RF_104,
        ResearchErrorCode.RF_200, ResearchErrorCode.RF_201, ResearchErrorCode.RF_202,
        ResearchErrorCode.RF_500, ResearchErrorCode.RF_501, ResearchErrorCode.RF_502,
      ].includes(error.code)) throw error;
      results.push({ ...reference, reference: { input: reference.input }, status: 'deferred', incomplete: true,
        error: error instanceof Error ? error.message : String(error), candidates: [], findings: [], paths_tried: [],
        already_in_corpus: false, corpus_matches: [] });
    }
  }
  process.stdout.write(json ? JSON.stringify(fromFile ? results : results[0], null, 2) + '\n' : results.map(render).join('\n'));
  const exitCode = results.reduce((worst, result) => Math.max(worst, { resolved: 0, ambiguous: 2, unresolved: 3, deferred: 4 }[result.status]), 0);
  if (exitCode) throw new AiwgError({ code: 'ERR_CORPUS_RESOLVE_RESULT', message: 'Reference resolution requires review; see results', exitCode });
}
