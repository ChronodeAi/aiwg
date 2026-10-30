/**
 * Minimal JSON-RPC 2.0 client for the housekeeper daemon socket
 * (epic #3353 slice B5).
 *
 * Speaks the same newline-delimited JSON framing as
 * `tools/daemon/ipc-server.mjs` without importing `tools/` — `src/` must
 * never import `tools/` (tools import compiled src via `importImpl`).
 */

import net from 'node:net';

export interface IpcRequestOptions {
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

export async function requestDaemon(
  socketPath: string,
  method: string,
  options: IpcRequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch { /* already closed */ }
      reject(error);
    };
    const succeed = (value: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Daemon request timed out: ${method} (${timeoutMs}ms)`));
    }, timeoutMs);
    timer.unref?.();

    let buffer = '';
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method, params: options.params ?? {},
      })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) return;
      clearTimeout(timer);
      let response: { result?: unknown; error?: { message?: string; code?: number } };
      try {
        response = JSON.parse(line) as typeof response;
      } catch {
        fail(new Error(`Daemon returned invalid JSON for ${method}`));
        return;
      }
      if (response.error) {
        fail(new Error(`Daemon error for ${method}: ${response.error.message ?? 'unknown error'}`));
        return;
      }
      succeed(response.result);
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        fail(new Error('Daemon is not running (socket unavailable)'));
        return;
      }
      fail(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`Daemon connection closed during ${method}`));
    });
  });
}
