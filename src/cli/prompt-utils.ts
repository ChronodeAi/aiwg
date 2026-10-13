/**
 * Shared interactive-prompt utilities.
 *
 * Every readline-based prompt in the CLI MUST go through these helpers so
 * the CLI can never hang indefinitely on a detached or unresponsive terminal.
 * All helpers apply a hard timeout (default 60s, overridable via
 * AIWG_PROMPT_TIMEOUT_MS) after which the prompt resolves to the supplied
 * fallback and a visible warning is emitted.
 *
 * The underlying setTimeout is `.unref()`'d so a user pressing Ctrl-C mid-prompt
 * does not keep the event loop alive for the remaining wait window.
 *
 * Phase 1 of the CLI Stabilization Epic (#918). Phase 3 (#920) will migrate
 * these helpers to @clack/prompts with AbortSignal support; this file is the
 * interim abstraction that makes both call-site cleanup and that future
 * migration mechanical.
 */

import readline from 'readline';
import * as ui from './ui.js';

/**
 * Resolve the prompt timeout from env. Falsy / non-numeric / non-positive
 * values fall back to 60 seconds.
 */
export function promptTimeoutMs(): number {
  const raw = process.env['AIWG_PROMPT_TIMEOUT_MS'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * Create a readline interface bound to process stdio. Callers must always
 * `rl.close()` when done.
 */
export function createPromptInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Ask a single question with a hard timeout. On timeout, resolves to `fallback`
 * and emits a warn-level UI message describing what default was used.
 *
 * The timeout timer is `.unref()`'d so the event loop can exit cleanly when
 * the caller closes the readline interface (e.g. on Ctrl-C).
 *
 * Do NOT call this from multiple sites on the same readline interface
 * concurrently — each readline interface should own exactly one in-flight
 * prompt at a time.
 */
export function askWithTimeout<T>(
  rl: readline.Interface,
  prompt: string,
  parse: (answer: string) => T,
  fallback: T,
  fallbackLabel: string,
  timeoutMs: number = promptTimeoutMs(),
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ui.warn(`  No input within ${Math.round(timeoutMs / 1000)}s — using default: ${fallbackLabel}`);
      cleanup();
      resolve(fallback);
    }, timeoutMs);
    // Ensure the timer does not block the event loop if the readline interface
    // is closed (e.g. user hits Ctrl-C). The callback only fires if the timer
    // is still live and the event loop has other work.
    timer.unref?.();

    // Integrate with the HandlerContext.signal plumbed through in Phase 3
    // (#920). When Ctrl-C aborts the top-level AbortController, the prompt
    // rejects cleanly, closes the readline, and clears the timeout — no
    // orphaned input reader, no pending timer.
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { rl.close(); } catch { /* already closed */ }
      reject(signal!.reason ?? new Error('Aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) {
      // Fire synchronously so the caller's try/catch sees the reject without
      // awaiting a tick.
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    rl.question(prompt, (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(parse(answer));
    });
  });
}

/**
 * Prompt for a trimmed string with timeout and default. Honors `signal` from
 * the HandlerContext (Phase 3 #920) so Ctrl-C cancels the prompt cleanly.
 */
export async function askString(
  rl: readline.Interface,
  prompt: string,
  fallback = '',
  signal?: AbortSignal,
): Promise<string> {
  return askWithTimeout(rl, prompt, (a) => a.trim(), fallback, fallback || '(empty)', promptTimeoutMs(), signal);
}

/**
 * Prompt for a yes/no answer with timeout and default. Answers starting with
 * 'y' (case-insensitive) are considered yes; everything else is no. On
 * timeout, returns `defaultValue`.
 */
export async function askYesNo(
  rl: readline.Interface,
  question: string,
  defaultValue = false,
  signal?: AbortSignal,
): Promise<boolean> {
  return askWithTimeout(
    rl,
    question,
    (a) => a.trim().toLowerCase().startsWith('y'),
    defaultValue,
    defaultValue ? 'yes' : 'no',
    promptTimeoutMs(),
    signal,
  );
}

/**
 * Prompt for a numeric selection from a list. Returns the selected item, or
 * `fallback` on timeout / invalid input. If `fallback` is undefined, returns
 * `options[0]`.
 */
export async function askChoice<T>(
  rl: readline.Interface,
  prompt: string,
  options: T[],
  fallback?: T,
  signal?: AbortSignal,
): Promise<T> {
  const pick = fallback ?? options[0]!;
  const label = fallback !== undefined ? String(fallback) : String(pick);
  return askWithTimeout(
    rl,
    prompt,
    (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < options.length) return options[idx]!;
      return pick;
    },
    pick,
    label,
    promptTimeoutMs(),
    signal,
  );
}

/**
 * Outcome of {@link askConsent}. Only `'answered'` reflects a person's
 * actual input — `'timeout'`, `'closed'` (EOF/stdin closed before any
 * answer), and the signal-abort rejection path must never be treated as an
 * answered "no" by a caller that persists consent decisions.
 */
export type ConsentOutcome =
  | { kind: 'answered'; value: boolean }
  | { kind: 'timeout' }
  | { kind: 'closed' };

/**
 * Prompt for a strict, distinguishable consent answer. Two differences from
 * {@link askYesNo}, both deliberately scoped to this helper so no existing
 * `askYesNo` call site changes behavior:
 *
 * 1. **Strict parsing**: only a trimmed, case-insensitive `y` or `yes`
 *    counts as yes. `askYesNo`'s `startsWith('y')` would also accept
 *    `yesterday` or `yolo` — too loose for an irreversible opt-in.
 * 2. **Answered vs. not-answered**: the caller gets a {@link ConsentOutcome}
 *    instead of a bare boolean, so a timeout or a closed/EOF'd stdin (the
 *    `rl.on('close', ...)` listener settles immediately — it does not wait
 *    out the timeout) is distinguishable from an actual "no" answer. A
 *    caller that records a persistent decline must only do so for
 *    `{ kind: 'answered', value: false }`.
 *
 * Signal abort still rejects (same contract as {@link askWithTimeout}).
 */
export function askConsent(
  rl: readline.Interface,
  question: string,
  timeoutMs: number = promptTimeoutMs(),
  signal?: AbortSignal,
): Promise<ConsentOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      rl.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ui.warn(`  No input within ${Math.round(timeoutMs / 1000)}s — leaving the setting unchanged.`);
      cleanup();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    // See askWithTimeout: unref so a closed event loop never waits on this.
    timer.unref?.();

    // Stdin closing (EOF, piped input exhausted, or the interface being
    // closed elsewhere) must settle immediately, not after the full
    // timeout — a closed stdin must never hang a consent prompt.
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      ui.warn('  Input closed before an answer — leaving the setting unchanged.');
      cleanup();
      resolve({ kind: 'closed' });
    };
    rl.on('close', onClose);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try { rl.close(); } catch { /* already closed */ }
      reject(signal!.reason ?? new Error('Aborted'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    rl.question(question, (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ kind: 'answered', value: ['y', 'yes'].includes(answer.trim().toLowerCase()) });
    });
  });
}

/**
 * Prompt for a labeled selection from a list of options. Renders each option
 * as a numbered line before asking. Users can respond by number (1-based) or
 * by matching the exact `label`. On timeout or invalid input, returns
 * `fallback`.
 *
 * This replaces the hand-rolled number-or-name logic sprinkled across
 * `init.ts` (provider selection) and `use.ts` (topology profile picker).
 * POC for the prompt-library spike (#926).
 */
export async function listSelect<T>(
  rl: readline.Interface,
  prompt: string,
  options: readonly { label: string; value: T }[],
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  if (options.length === 0) return fallback;
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt.label}`));
  return askWithTimeout(
    rl,
    prompt,
    (answer) => {
      const trimmed = answer.trim();
      if (!trimmed) return fallback;
      const idx = parseInt(trimmed, 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < options.length) return options[idx]!.value;
      const match = options.find(o => o.label === trimmed);
      return match?.value ?? fallback;
    },
    fallback,
    String(fallback),
    promptTimeoutMs(),
    signal,
  );
}
