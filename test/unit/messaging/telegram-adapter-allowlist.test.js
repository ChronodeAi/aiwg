/**
 * Tests for TelegramAdapter inbound chat allowlisting (security: H-1).
 *
 * The adapter must only process inbound updates (commands, button callbacks)
 * from configured/allowlisted chats. Without this, anyone who discovers the
 * bot username could DM it and run read commands (/status, /ask, ...).
 *
 * These tests drive the public handleUpdate() ingestion seam directly (the
 * same method the polling loop and a future webhook server call), exercising
 * the real allowlist (#isAllowedChat) + command dispatch path.
 *
 * @source @tools/messaging/adapters/telegram.mjs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { TelegramAdapter } = await import(
  '../../../tools/messaging/adapters/telegram.mjs'
);

const ALLOWED_CHAT = '-1004338861599';
const STRANGER_CHAT = '999888777';

/** Minimal valid config: single allowlisted room. */
const CONFIG = {
  botToken: 'test:token',
  rooms: [
    { chat_id: ALLOWED_CHAT, label: 'aiwg-board', is_default: true, purpose: 'notifications' },
  ],
};

/** Build a getUpdates result element: one /status command from `chatId`. */
function statusUpdate(chatId, updateId = 1) {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      chat: { id: Number(chatId), type: 'supergroup' },
      from: { id: 42, username: 'someone', first_name: 'Some' },
      text: '/status',
    },
  };
}

/** Build a callback-query (button press) update from `chatId`. */
function callbackUpdate(chatId, updateId = 2) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'cbq-1',
      data: 'status',
      from: { id: 42, username: 'someone' },
      message: {
        message_id: 200,
        chat: { id: Number(chatId), type: 'supergroup' },
      },
    },
  };
}

describe('TelegramAdapter inbound chat allowlist (H-1)', () => {
  let adapter;
  let seen;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new TelegramAdapter(CONFIG);
    seen = [];
    adapter.onCommand((command, args, context) => {
      seen.push({ command, args, context });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('processes a command from the allowlisted chat', async () => {
    await adapter.handleUpdate(statusUpdate(ALLOWED_CHAT));

    const statusCmds = seen.filter((s) => s.command === 'status');
    expect(statusCmds.length).toBe(1);
    expect(statusCmds[0].context.chatId).toBe(ALLOWED_CHAT);
  });

  it('drops a command from a non-allowlisted (stranger) chat', async () => {
    await adapter.handleUpdate(statusUpdate(STRANGER_CHAT));

    expect(seen.filter((s) => s.command === 'status').length).toBe(0);
  });

  it('drops a button-callback from a non-allowlisted chat', async () => {
    await adapter.handleUpdate(callbackUpdate(STRANGER_CHAT));

    // Callback queries route through _dispatchCommand too; none should fire.
    expect(seen.length).toBe(0);
  });

  it('processes a button-callback from the allowlisted chat', async () => {
    // Stub fetch for the answerCallbackQuery side-effect.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), headers: { get: () => null } }))
    );

    await adapter.handleUpdate(callbackUpdate(ALLOWED_CHAT));

    expect(seen.filter((s) => s.command === 'status').length).toBe(1);
  });

  it('fails closed — drops stranger when configured via defaultChatId only', async () => {
    const onlyDefault = new TelegramAdapter({
      botToken: 'test:token',
      defaultChatId: ALLOWED_CHAT,
    });
    const captured = [];
    onlyDefault.onCommand((command) => captured.push(command));

    await onlyDefault.handleUpdate(statusUpdate(STRANGER_CHAT));
    expect(captured.length).toBe(0);

    await onlyDefault.handleUpdate(statusUpdate(ALLOWED_CHAT));
    expect(captured).toContain('status');
  });
});
