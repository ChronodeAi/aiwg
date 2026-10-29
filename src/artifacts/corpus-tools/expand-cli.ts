// Validate expansion controls and expose the corpus router's JSON and exit-code contract.
import { isRefId } from '../../research/identity.js';
import { AiwgError } from '../../cli/errors.js';
import { expandCorpus, renderExpansion } from './expand.js';

export const EXPAND_USAGE = 'aiwg corpus expand [--seeds REF-0001,REF-0002 | --since YYYY-MM-DD | --all] [--per-seed 20] [--from recent|all-cs] [--min-year 2018] [--reexplore-after 180d] [--max-seeds N] [--overlap] [--write] [--json]\nA scope (--seeds, --since or --all) is required. Default: dry run. --since uses induction/discovery date, then document mtime.\n--overlap checks at most 20 candidates, after convergence and recency.\nExit codes: 0 complete, 3 incomplete/retryable, 1 usage or storage error.\n';

export interface ExpandOptions {
  seeds?: string[];
  since?: number;
  perSeed: number;
  from: 'recent' | 'all-cs';
  minYear: number;
  reexploreMs: number;
  maxSeeds: number;
  overlap: boolean;
  write: boolean;
  json: boolean;
}

function usage(message: string): never {
  throw new AiwgError({ code: 'ERR_CORPUS_EXPAND_USAGE', message, exitCode: 1, hint: EXPAND_USAGE.trim() });
}

function positive(value: string, flag: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    usage(`${flag} requires a positive integer${maximum < Number.MAX_SAFE_INTEGER ? ` up to ${maximum}` : ''}`);
  }
  return Number(value);
}

export async function expandCli(args: string[], root: string, cwd: string): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(EXPAND_USAGE); return; }
  const options: ExpandOptions = { perSeed: 20, from: 'recent', minYear: 2018, reexploreMs: 180 * 86400000,
    maxSeeds: Number.MAX_SAFE_INTEGER, overlap: false, write: false, json: false };
  const seen = new Set<string>();
  let selector: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) usage(`${flag} may only be supplied once`);
    seen.add(flag);
    if (['--seeds', '--since', '--all'].includes(flag)) {
      if (selector) usage('--seeds, --since and --all are mutually exclusive');
      selector = flag;
    }
    if (['--write', '--json', '--overlap', '--all'].includes(flag)) {
      if (flag === '--write') options.write = true;
      if (flag === '--json') options.json = true;
      if (flag === '--overlap') options.overlap = true;
      continue;
    }
    if (!['--seeds', '--since', '--per-seed', '--from', '--min-year', '--reexplore-after', '--max-seeds'].includes(flag)) usage(`Unknown expand option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('-')) usage(`${flag} requires a value`);
    switch (flag) {
      case '--seeds':
        options.seeds = value.split(',').map(ref => ref.trim());
        if (options.seeds.some(ref => !isRefId(ref))) usage('--seeds requires comma-separated REF identifiers');
        options.seeds = [...new Set(options.seeds)];
        break;
      case '--since':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) usage('--since requires a valid YYYY-MM-DD date');
        options.since = Date.parse(value); break;
      case '--per-seed': options.perSeed = positive(value, flag, 500); break;
      case '--max-seeds': options.maxSeeds = positive(value, flag); break;
      case '--min-year':
        if (!/^(?:18|19|20|21)\d{2}$/.test(value)) usage('--min-year requires a year between 1800 and 2199');
        options.minYear = Number(value); break;
      case '--from':
        if (value !== 'recent' && value !== 'all-cs') usage('--from requires recent or all-cs');
        options.from = value; break;
      case '--reexplore-after':
        if (!/^[1-9]\d*d$/.test(value)) usage('--reexplore-after requires a positive duration in days, e.g. 180d');
        options.reexploreMs = positive(value.slice(0, -1), flag, Math.floor(Number.MAX_SAFE_INTEGER / 86400000)) * 86400000;
    }
  }
  // An explicit scope keeps a bare call from scanning the whole corpus (about 1 request per second without a key).
  if (!selector) usage('Choose the seeds: --seeds REF-0001,REF-0002, --since YYYY-MM-DD or --all');
  const result = await expandCorpus(root, cwd, options);
  process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : renderExpansion(result));
  if (result.incomplete) throw new AiwgError({ code: 'ERR_CORPUS_EXPAND_RESULT', message: 'Expansion incomplete; failed lookups will be retried', exitCode: 3 });
}
