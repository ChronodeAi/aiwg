// Keep the CLI dispatch pending for the lifetime of its stdio MCP transport.
export async function serveStdioUntilClosed(server, transport, { input = process.stdin, signals = process } = {}) {
  let finish;
  let fail;
  const closed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const previousClose = server.server.onclose;
  const onClose = () => {
    try { previousClose?.(); } finally { finish(); }
  };
  const shutdown = () => { Promise.resolve().then(() => server.close()).catch(fail); };
  server.server.onclose = onClose;
  input.once('end', shutdown);
  signals.once('SIGINT', shutdown);
  signals.once('SIGTERM', shutdown);
  try {
    console.error('[AIWG MCP] Starting server...');
    await server.connect(transport);
    console.error('[AIWG MCP] Server connected via stdio transport');
    if (input.readableEnded) shutdown();
    await closed;
  } finally {
    input.removeListener('end', shutdown);
    signals.removeListener('SIGINT', shutdown);
    signals.removeListener('SIGTERM', shutdown);
    if (server.server.onclose === onClose) server.server.onclose = previousClose;
  }
}
