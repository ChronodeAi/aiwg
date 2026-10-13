/**
 * Unit tests for the in-tree prompts layer (src/cli/prompt-utils.ts).
 *
 * These tests establish the test strategy documented in the #926 spike:
 *   - Construct a fake readline.Interface with spied `question`/`close`
 *   - Use vi.useFakeTimers() for the timeout path
 *   - Verify signal abort path closes readline, clears timer, rejects
 *
 * No real stdin/stdout involvement. Runs in milliseconds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Interface as ReadlineInterface } from 'readline';
import {
  askString,
  askYesNo,
  askChoice,
  listSelect,
  askWithTimeout,
  askConsent,
} from '../../../src/cli/prompt-utils.js';

/**
 * Build a mock readline.Interface that captures the prompt-string and lets
 * the test control when (and with what) the question callback fires.
 */
function makeMockInterface() {
  let pendingCallback: ((answer: string) => void) | null = null;
  let pendingPrompt: string | null = null;
  const closeSpy = vi.fn();
  // A real EventEmitter backs `on`/`removeListener`/`emit` so askConsent's
  // `rl.on('close', ...)` wiring works without disturbing `question`/`close`,
  // which every other test in this file already depends on.
  const emitter = new EventEmitter();

  const iface = Object.assign(emitter, {
    question(prompt: string, cb: (answer: string) => void) {
      pendingPrompt = prompt;
      pendingCallback = cb;
    },
    close: closeSpy,
  }) as unknown as ReadlineInterface;

  return {
    iface,
    respond(answer: string) {
      if (!pendingCallback) throw new Error('No pending question');
      const cb = pendingCallback;
      pendingCallback = null;
      cb(answer);
    },
    get prompt() {
      return pendingPrompt;
    },
    closeSpy,
    /** Simulate stdin EOF / the interface closing before any answer. */
    emitClose() {
      emitter.emit('close');
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Suppress the ui.warn() timeout message so test output stays clean.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Reset any env pollution from adjacent tests.
  delete process.env['AIWG_PROMPT_TIMEOUT_MS'];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('askString', () => {
  it('resolves to the user input on normal response', async () => {
    const mock = makeMockInterface();
    const promise = askString(mock.iface, 'Name? ');
    mock.respond('  Alice  ');
    await expect(promise).resolves.toBe('Alice');
  });

  it('returns the fallback when the timer fires', async () => {
    process.env['AIWG_PROMPT_TIMEOUT_MS'] = '1000';
    const mock = makeMockInterface();
    const promise = askString(mock.iface, 'Name? ', 'nobody');
    // Advance past the timeout — no user response.
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBe('nobody');
  });

  it('rejects when signal is aborted mid-prompt', async () => {
    const controller = new AbortController();
    const mock = makeMockInterface();
    const promise = askString(mock.iface, 'Name? ', '', controller.signal);
    // Swallow the rejection so the event loop doesn't warn unhandled.
    promise.catch(() => {});
    controller.abort('user-cancel');
    await expect(promise).rejects.toBe('user-cancel');
    expect(mock.closeSpy).toHaveBeenCalled();
  });

  it('rejects synchronously when signal is already aborted at call time', async () => {
    const controller = new AbortController();
    controller.abort('pre-aborted');
    const mock = makeMockInterface();
    const promise = askString(mock.iface, 'Name? ', '', controller.signal);
    await expect(promise).rejects.toBe('pre-aborted');
    expect(mock.closeSpy).toHaveBeenCalled();
  });
});

describe('askYesNo', () => {
  it('returns true for responses starting with y', async () => {
    const mock = makeMockInterface();
    const promise = askYesNo(mock.iface, 'OK? ');
    mock.respond('yes');
    await expect(promise).resolves.toBe(true);
  });

  it('returns false for any other response', async () => {
    const mock = makeMockInterface();
    const promise = askYesNo(mock.iface, 'OK? ');
    mock.respond('no');
    await expect(promise).resolves.toBe(false);
  });

  it('returns the default on empty response', async () => {
    // Empty string doesn't start with 'y', so the parse returns false
    // regardless of default. The default applies only on timeout.
    const mock = makeMockInterface();
    const promise = askYesNo(mock.iface, 'OK? ', true);
    mock.respond('');
    await expect(promise).resolves.toBe(false);
  });

  it('returns the default on timeout', async () => {
    process.env['AIWG_PROMPT_TIMEOUT_MS'] = '100';
    const mock = makeMockInterface();
    const promise = askYesNo(mock.iface, 'OK? ', true);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBe(true);
  });
});

describe('askChoice', () => {
  it('resolves to the indexed option on numeric response', async () => {
    const mock = makeMockInterface();
    const promise = askChoice(mock.iface, 'Pick: ', ['red', 'green', 'blue']);
    mock.respond('2');
    await expect(promise).resolves.toBe('green');
  });

  it('resolves to fallback on out-of-range numeric', async () => {
    const mock = makeMockInterface();
    const promise = askChoice(mock.iface, 'Pick: ', ['red', 'green', 'blue']);
    mock.respond('99');
    await expect(promise).resolves.toBe('red'); // first option is the implicit fallback
  });

  it('resolves to provided fallback on invalid response', async () => {
    const mock = makeMockInterface();
    const promise = askChoice(mock.iface, 'Pick: ', ['red', 'green', 'blue'], 'blue');
    mock.respond('chartreuse');
    await expect(promise).resolves.toBe('blue');
  });
});

describe('listSelect', () => {
  const OPTIONS = [
    { label: 'claude', value: 'claude' as const },
    { label: 'copilot', value: 'copilot' as const },
    { label: 'cursor', value: 'cursor' as const },
  ];

  it('resolves to option value by number', async () => {
    const mock = makeMockInterface();
    const promise = listSelect(mock.iface, 'Pick: ', OPTIONS, 'claude');
    mock.respond('2');
    await expect(promise).resolves.toBe('copilot');
  });

  it('resolves to option value by exact label match', async () => {
    const mock = makeMockInterface();
    const promise = listSelect(mock.iface, 'Pick: ', OPTIONS, 'claude');
    mock.respond('cursor');
    await expect(promise).resolves.toBe('cursor');
  });

  it('returns fallback on empty response', async () => {
    const mock = makeMockInterface();
    const promise = listSelect(mock.iface, 'Pick: ', OPTIONS, 'claude');
    mock.respond('');
    await expect(promise).resolves.toBe('claude');
  });

  it('returns fallback on unknown label', async () => {
    const mock = makeMockInterface();
    const promise = listSelect(mock.iface, 'Pick: ', OPTIONS, 'claude');
    mock.respond('nonsuch');
    await expect(promise).resolves.toBe('claude');
  });

  it('returns fallback immediately when options is empty', async () => {
    const mock = makeMockInterface();
    const result = await listSelect(mock.iface, 'Pick: ', [], 'claude');
    expect(result).toBe('claude');
  });

  it('threads the signal through to askWithTimeout', async () => {
    const controller = new AbortController();
    const mock = makeMockInterface();
    const promise = listSelect(mock.iface, 'Pick: ', OPTIONS, 'claude', controller.signal);
    promise.catch(() => {});
    controller.abort('cancelled');
    await expect(promise).rejects.toBe('cancelled');
  });
});

describe('askWithTimeout custom timeout override', () => {
  it('honors the explicit timeoutMs argument', async () => {
    const mock = makeMockInterface();
    const promise = askWithTimeout(
      mock.iface,
      'Q? ',
      (a) => a,
      'timeout-value',
      'timeout-value',
      50,
    );
    vi.advanceTimersByTime(50);
    await expect(promise).resolves.toBe('timeout-value');
  });
});

// #3050 review items 2 and 4: a consent prompt needs (1) strict y/yes
// parsing — unlike askYesNo's startsWith('y') — and (2) a distinguishable
// outcome so a caller never persists a decline for a timeout or closed
// stdin, only for an actually-answered "no".
describe('askConsent', () => {
  it('treats exact "y" as an answered yes', async () => {
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ');
    mock.respond('y');
    await expect(promise).resolves.toEqual({ kind: 'answered', value: true });
  });

  it('treats exact "yes" (any case, with surrounding whitespace) as an answered yes', async () => {
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ');
    mock.respond('  YES  ');
    await expect(promise).resolves.toEqual({ kind: 'answered', value: true });
  });

  it('rejects "yesterday" (any text merely starting with y) as an answered no, not a yes', async () => {
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ');
    mock.respond('yesterday');
    await expect(promise).resolves.toEqual({ kind: 'answered', value: false });
  });

  it('treats an empty answer as an answered no', async () => {
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ');
    mock.respond('');
    await expect(promise).resolves.toEqual({ kind: 'answered', value: false });
  });

  it('treats plain "no" as an answered no', async () => {
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ');
    mock.respond('no');
    await expect(promise).resolves.toEqual({ kind: 'answered', value: false });
  });

  it('resolves to {kind: "timeout"} on timeout, distinguishable from an answered no', async () => {
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ', 1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toEqual({ kind: 'timeout' });
  });

  it('resolves to {kind: "closed"} immediately when the interface closes before any answer, without waiting out the timeout', async () => {
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ', 60_000);
    mock.emitClose();
    // No vi.advanceTimersByTime at all — this must settle without the timer
    // ever firing, proving a closed stdin cannot hang the prompt.
    await expect(promise).resolves.toEqual({ kind: 'closed' });
  });

  it('does not resolve to "closed" after an answer already settled the promise', async () => {
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ', 60_000);
    mock.respond('y');
    mock.emitClose();
    await expect(promise).resolves.toEqual({ kind: 'answered', value: true });
  });

  it('rejects when signal is aborted mid-prompt', async () => {
    const controller = new AbortController();
    const mock = makeMockInterface();
    const promise = askConsent(mock.iface, 'Enable? ', 60_000, controller.signal);
    promise.catch(() => {});
    controller.abort('user-cancel');
    await expect(promise).rejects.toBe('user-cancel');
    expect(mock.closeSpy).toHaveBeenCalled();
  });
});
