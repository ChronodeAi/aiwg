/**
 * Shared strict CLI flag/value parsing (#3062 review item 11, and the
 * second-round review's finding 4).
 *
 * Several handlers (`init`, `setup`, `session`, `setup-run`) each grew
 * their own small `flagValue(args, name)` helper, and every one of them
 * treated a flag that is present but missing its value the same as a flag
 * that was never given at all — `--prompt` as the very last token, or
 * immediately followed by another flag, silently resolved to `undefined`
 * instead of erroring. At a terminal that let the handler fall through
 * into an interactive prompt instead of reporting the mistake; without one
 * it could proceed on a silently-wrong default.
 *
 * The first-round shared parser fixed that but introduced its own gaps,
 * found by the second review:
 *
 *   - It validated only the *first* occurrence of a repeated single-value
 *     flag, so `--provider claude --provider` (a malformed second
 *     occurrence) silently passed.
 *   - It always resolved a repeated flag to its first occurrence, which
 *     silently changed `aiwg session`'s pre-existing last-occurrence-wins
 *     precedence for `--provider`/`--profile` to first-wins — a real
 *     behavior regression, not just a new validation gap.
 *   - `--flag=value` was never recognized at all.
 *   - Scanning never stopped at a bare `--` terminator.
 *   - An empty-string value (`--prompt ''`) was accepted as a valid value
 *     for flags where that is never meaningful.
 *
 * {@link scanFlagOccurrences} is the single-pass tokenizer every other
 * helper here is built on: it finds *every* occurrence of the named
 * flag(s), in one scan, validating each one independently, and stops
 * recognizing flags entirely once it sees a bare `--` token (everything
 * after that point is positional, per POSIX convention). `--flag value`
 * and `--flag=value` are both accepted; in the space-separated form a
 * value that itself looks like another flag (starts with `--`) is treated
 * as a missing value — pass it via the `=` form instead
 * (`--flag=--literal`) when a value must start with `--`. A value starting
 * with a single `-` is always accepted in either form.
 *
 * Callers choose `precedence: 'first' | 'last'` to match whatever
 * precedence the command already had before this module existed — see
 * each call site's own comment for which one applies and why. Callers
 * MUST catch {@link MissingFlagValueError} (or let it propagate to a
 * handler-level catch) and report it before any preflight check, spawn,
 * or write — never after.
 */

/** Thrown when a recognized flag is present but has no usable value following it. */
export class MissingFlagValueError extends Error {
  /** The exact flag token that was missing its value (e.g. `--prompt`). */
  readonly flagName: string;

  constructor(flagName: string) {
    super(`${flagName} requires a value`);
    this.name = 'MissingFlagValueError';
    this.flagName = flagName;
  }
}

/** One validated occurrence of a value-taking flag found by {@link scanFlagOccurrences}. */
export interface FlagOccurrence {
  /** Index of the flag token itself in the original `args` array. */
  index: number;
  /** The exact flag name matched (e.g. `--prompt`, not `--prompt=x`). */
  flag: string;
  /** The resolved value — never `undefined`; an occurrence with no usable value throws instead of being recorded. */
  value: string;
}

export interface FlagValueOptions {
  /**
   * Reject an empty-string value (default: `false` — most flags treat an
   * empty string as a legitimate, if unusual, value). Set `true` for
   * flags where an empty string can never be meaningful and silently
   * accepting one would let a mistake reach interactive/default behavior
   * instead of erroring — e.g. `--prompt ''`, `--prompt-file ''`,
   * `--api-key-env ''`, `--worker-dispatch ''`.
   */
  rejectEmpty?: boolean;
}

function splitEquals(token: string): [name: string, value: string] | null {
  const eq = token.indexOf('=');
  if (eq === -1) return null;
  return [token.slice(0, eq), token.slice(eq + 1)];
}

/**
 * Single-pass scan for every occurrence of any of `names` in `args`. See
 * the module doc comment for the full set of semantics this implements.
 *
 * Throws {@link MissingFlagValueError} on the *first* occurrence (in
 * left-to-right order) that has no usable value or an empty one (when
 * `options.rejectEmpty`) — every occurrence is checked, not just the
 * first one found overall, so a malformed *later* occurrence is still an
 * error even when an earlier one was valid.
 */
export function scanFlagOccurrences(
  args: readonly string[],
  names: readonly string[],
  options: FlagValueOptions = {},
): FlagOccurrence[] {
  const occurrences: FlagOccurrence[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token === '--') break; // bare terminator — stop recognizing flags entirely

    if (token.startsWith('--')) {
      const eqSplit = splitEquals(token);
      if (eqSplit && names.includes(eqSplit[0])) {
        const [flag, value] = eqSplit;
        if (options.rejectEmpty && value === '') throw new MissingFlagValueError(flag);
        occurrences.push({ index: i, flag, value });
        continue;
      }
    }

    if (names.includes(token)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new MissingFlagValueError(token);
      }
      if (options.rejectEmpty && next === '') {
        throw new MissingFlagValueError(token);
      }
      occurrences.push({ index: i, flag: token, value: next });
      i += 1; // skip the consumed value token
    }
  }
  return occurrences;
}

/**
 * Look up the value of a (possibly repeated) single-value flag.
 *
 * - None of `names` appear at all → `undefined` (the flag was never
 *   given; not an error).
 * - `names` appear once or more, every occurrence validated → the first
 *   or last occurrence's value, per `options.precedence` (default
 *   `'first'`). Pass `'last'` only for a command whose pre-existing
 *   behavior (before this module existed) already let a later occurrence
 *   override an earlier one — see the call site's comment.
 */
export function requireFlagValue(
  args: readonly string[],
  options: FlagValueOptions & { precedence?: 'first' | 'last' },
  ...names: string[]
): string | undefined {
  const occurrences = scanFlagOccurrences(args, names, options);
  if (occurrences.length === 0) return undefined;
  return options.precedence === 'last'
    ? occurrences[occurrences.length - 1]!.value
    : occurrences[0]!.value;
}

/**
 * Same validation contract as {@link requireFlagValue}, but collects the
 * value of *every* occurrence in left-to-right order — for repeatable
 * flags such as `--param`/`--script`. Returns `[]` when the flag never
 * appears.
 */
export function collectFlagValues(
  args: readonly string[],
  options: FlagValueOptions,
  ...names: string[]
): string[] {
  return scanFlagOccurrences(args, names, options).map((occurrence) => occurrence.value);
}

/**
 * Parse a strict `true`/`false` flag value. `undefined` in means the flag
 * was not given (not an error, and not a default — callers decide the
 * default). Anything other than exactly `true`/`false` throws, naming
 * `flagName` in the message.
 */
export function parseBooleanFlagValue(value: string | undefined, flagName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${flagName} must be true or false (got '${value}')`);
}

/**
 * Parse a comma-separated list flag value, trimming whitespace and
 * dropping empty entries. Returns `undefined` when `raw` is `undefined`
 * (flag not given); returns `[]` only if every entry was empty.
 */
export function parseListFlagValue(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Split one repeatable `<name>=<value>` entry (as used by `--script`,
 * `--param`) into its parts. Throws, naming `flagName`, when `entry` has
 * no `=`, an empty name, or an empty value.
 */
export function parseKeyValueEntry(entry: string, flagName: string): [name: string, value: string] {
  const eq = entry.indexOf('=');
  if (eq <= 0 || eq === entry.length - 1) {
    throw new Error(`${flagName} requires the form <name>=<value> (got '${entry}')`);
  }
  return [entry.slice(0, eq).trim(), entry.slice(eq + 1).trim()];
}
