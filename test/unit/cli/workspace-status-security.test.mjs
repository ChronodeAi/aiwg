import { describe, it, expect, vi } from 'vitest';
import { startStatusServer } from '../../../tools/cli/workspace-status.mjs';

describe('workspace status HTTP error boundary', () => {
  it('returns a fixed public error and logs exception details locally', async () => {
    const failure = new Error('private-path-and-secret\n    at internalFunction (/private/status.mjs:42:7)');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = await startStatusServer({
      bind: '127.0.0.1', port: 0,
      get projectRoot() { throw failure; },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/status`);
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: 'status_unavailable', message: 'Workspace status is unavailable.' });
      expect(body).not.toMatch(/stack|private-path|internalFunction|status\.mjs/);
      expect(log).toHaveBeenCalledWith('[workspace-status] status request failed', failure);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      log.mockRestore();
    }
  });
});
