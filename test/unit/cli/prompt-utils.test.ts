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
import readline from 'readline';
import { EventEmitter } from 'node:events';
import type { Interface as ReadlineInterface } from 'readline';
import {
  createSecretPromptInterface,
  askMultilineSecret,
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
  it('settles immediately on EOF and removes its timer and close listener', async () => {
    const mock = makeMockInterface();
    const promise = askString(mock.iface, 'Hidden value? ', '');
    mock.emitClose();
    await expect(promise).resolves.toBe('');
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.iface.listenerCount('close')).toBe(0);
  });

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

describe('askMultilineSecret', () => {
  it('collects every line of a synchronous paste through an empty line', async () => {
    const mock = makeMockInterface();
    const promise = askMultilineSecret(mock.iface);
    for (const line of ['-----BEGIN PRIVATE KEY-----', 'synthetic-private-body', '-----END PRIVATE KEY-----', '']) {
      mock.iface.emit('line', line);
    }
    await expect(promise).resolves.toBe('-----BEGIN PRIVATE KEY-----\nsynthetic-private-body\n-----END PRIVATE KEY-----');
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.iface.listenerCount('line')).toBe(0);
    expect(mock.iface.listenerCount('close')).toBe(0);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('uses one deadline and discards partial material without printing it', async () => {
    process.env['AIWG_PROMPT_TIMEOUT_MS'] = '1000';
    const mock = makeMockInterface();
    const promise = askMultilineSecret(mock.iface);
    vi.advanceTimersByTime(700);
    mock.iface.emit('line', 'synthetic-partial-private-material');
    vi.advanceTimersByTime(300);
    await expect(promise).resolves.toBe('');
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.iface.listenerCount('line')).toBe(0);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls) + JSON.stringify(vi.mocked(console.error).mock.calls))
      .not.toContain('synthetic-partial-private-material');
  });

  it('discards partial material when the terminal closes', async () => {
    const mock = makeMockInterface();
    const promise = askMultilineSecret(mock.iface);
    mock.iface.emit('line', 'partial-private-material');
    mock.emitClose();
    await expect(promise).resolves.toBe('');
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.iface.listenerCount('line')).toBe(0);
  });

  it.each([false, true])('honors cancellation (already aborted: %s) and cleans all listeners', async preAborted => {
    const mock = makeMockInterface();
    const controller = new AbortController();
    if (preAborted) controller.abort('cancelled');
    const promise = askMultilineSecret(mock.iface, controller.signal);
    promise.catch(() => {});
    if (!preAborted) { mock.iface.emit('line', 'partial-private-material'); controller.abort('cancelled'); }
    await expect(promise).rejects.toBe('cancelled');
    expect(mock.closeSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.iface.listenerCount('line')).toBe(0);
    expect(mock.iface.listenerCount('close')).toBe(0);
  });

  it('rejects an oversized paste without including its contents in the error', async () => {
    const mock = makeMockInterface();
    const promise = askMultilineSecret(mock.iface);
    mock.iface.emit('line', 'private-material-'.repeat(1100));
    await expect(promise).rejects.toThrow('Sensitive input exceeds 16384 characters.');
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.iface.listenerCount('line')).toBe(0);
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

describe('secret input terminal echo', () => {
  it('discards readline echo and destroys its output on close', () => {
    const rl = new EventEmitter();
    const create = vi.spyOn(readline, 'createInterface').mockReturnValue(rl as never);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(createSecretPromptInterface()).toBe(rl);
      const options = create.mock.calls[0][0] as readline.ReadLineOptions;
      expect(options.terminal).toBe(true);
      options.output!.write('synthetic-secret-echo');
      expect(stdout).not.toHaveBeenCalled();
      rl.emit('close');
      expect(options.output!.destroyed).toBe(true);
    } finally { create.mockRestore(); stdout.mockRestore(); }
  });
});
