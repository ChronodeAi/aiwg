/**
 * Shared strict CLI flag/value parsing (#3062 review item 11).
 *
 * Several handlers (`init`, `setup`, `session`) each grew their own small
 * `flagValue(args, name)` helper, and every one of them treated a flag that
 * is present but missing its value the same as a flag that was never given
 * at all — `--prompt` as the very last token, or immediately followed by
 * another flag, silently resolved to `undefined` instead of erroring. At a
 * terminal that let the handler fall through into an interactive prompt
 * instead of reporting the mistake; without one it could proceed on a
 * silently-wrong default.
 *
 * Every helper here instead raises {@link MissingFlagValueError} the moment
 * a flag is found with no usable value following it. Callers MUST catch
 * this (or let it propagate to a handler-level catch) and report it before
 * any preflight check, spawn, or write — never after.
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

/**
 * Look up the value following the first occurrence of any of `names` in
 * `args`.
 *
 * - None of `names` appear at all → `undefined` (the flag was never given;
 *   not an error).
 * - A matching flag is the last token, or is immediately followed by
 *   another `--`-prefixed token → throws {@link MissingFlagValueError}
 *   naming the matched flag.
 * - Otherwise → the next token, verbatim.
 */
export function requireFlagValue(args: readonly string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current !== undefined && names.includes(current)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new MissingFlagValueError(current);
      }
      return value;
    }
  }
  return undefined;
}

/**
 * Same contract as {@link requireFlagValue}, but collects the value of
 * *every* occurrence — for repeatable flags such as `--param`/`--script`.
 * Returns `[]` when the flag never appears.
 */
export function collectFlagValues(args: readonly string[], ...names: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current !== undefined && names.includes(current)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new MissingFlagValueError(current);
      }
      values.push(value);
      i += 1;
    }
  }
  return values;
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
