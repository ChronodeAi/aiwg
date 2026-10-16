#!/usr/bin/env node
/**
 * #2915 round 8 (D6): minimal stdio MCP worker used ONLY by the
 * "disabled dispatch equals main" equivalence suite's "a response preceded
 * by oversized whitespace" scenario (test/unit/mcp/worker-invoke.test.ts).
 *
 * Replicates `test/fixtures/ralph-worker-mcp.mjs`'s 'success' handshake
 * (same `workerInputSchema`/`workerOutputSchema`, so it satisfies the same
 * qualified-schema digest `buildFixture` records) but, immediately before
 * replying to `tools/call`, writes an unterminated chunk one byte PAST
 * `ChildProcessTransport`'s 10 MiB bound (`MCP_TRANSPORT_MAX_BUFFER_BYTES`
 * in src/mcp/tools/worker-invoke.mjs) with no trailing newline, then the
 * real newline-terminated JSON-RPC response. A gated connection permanently
 * refuses after the oversized chunk (review 5, finding 1c); a disabled
 * connection -- matching origin/main, which never bounded this buffer at
 * all -- drains past it and still completes.
 *
 * NOT production code; not imported by anything outside that one test file.
 */
import { createInterface } from 'node:readline';
import { workerInputSchema, workerOutputSchema, claims } from '../ralph-worker-protocol.mjs';

const OVERSIZED_BYTES = 10 * 1024 * 1024 + 1024; // one bound's worth, plus headroom
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });

createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (method === 'initialize') {
    reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'oversized-whitespace-fixture', version: '1' } });
  } else if (method === 'tools/list') {
    reply(id, { tools: [{ name: 'fixture-worker', description: 'Synthetic oversized-whitespace worker', inputSchema: workerInputSchema, outputSchema: workerOutputSchema }] });
  } else if (method === 'tools/call') {
    // Oversized chunk FIRST, as its own newline-terminated (non-JSON) line
    // -- this is what review 5 (finding 1c) means by "a later, perfectly
    // well-formed newline-terminated frame on the SAME connection still
    // drained and parsed normally afterward": the garbage line fails to
    // parse and reports onerror, but a disabled (unbounded) transport keeps
    // draining past it to the real response line below. A gated transport
    // instead exceeds the byte bound WHILE still accumulating this one
    // line (it has no newline yet at that point) and refuses permanently.
    process.stdout.write(`${'x'.repeat(OVERSIZED_BYTES)}\n`);
    const worker = params?.arguments;
    reply(id, { content: [{ type: 'text', text: JSON.stringify(claims(worker)) }], structuredContent: claims(worker), isError: false });
  }
});
