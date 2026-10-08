#!/usr/bin/env node
// Line-delimited stdio JSON-RPC/MCP endpoint; the permission fixture probes loopback.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import Ajv from 'ajv';
import { claims, config, fixtureRevision, workerInputSchema, permissionChecks } from './ralph-worker-protocol.mjs';

const settings = config();
const validate = new Ajv({ strict: false }).compile(workerInputSchema);
const pending = new Map();
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
const record = event => appendFileSync(settings.recordPath, `${JSON.stringify({ fixtureRevision, ...event })}\n`);
const complete = (id, worker) => reply(id, { content: [{ type: 'text', text: JSON.stringify(claims(worker)) }], structuredContent: claims(worker), isError: false });

createInterface({ input: process.stdin }).on('line', async line => {
  let request;
  try { request = JSON.parse(line); } catch { error(null, -32700, 'Invalid JSON'); return; }
  const { id, method, params } = request;
  if (method === 'initialize') {
    reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-worker', version: '1' } });
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'fixture/permissions' && settings.permissions) {
    reply(id, await permissionChecks(settings.permissions));
  } else if (method === 'tools/list') {
    // schema-change deliberately changes the advertised digest without executing a worker.
    const inputSchema = settings.scenario === 'schema-change'
      ? { ...workerInputSchema, required: [...workerInputSchema.required, 'changed'] }
      : workerInputSchema;
    reply(id, { tools: [{ name: 'fixture-worker', description: 'Synthetic bounded worker', inputSchema }] });
  } else if (method === 'tools/call') {
    if (params?.name !== 'fixture-worker' || !validate(params.arguments)) { error(id, -32602, 'Invalid typed worker call'); return; }
    const worker = params.arguments;
    const scenario = settings.scenarios?.[worker.invocationId] ?? settings.scenario ?? 'success';
    record({ event: 'call', requestId: id, scenario, worker, envNames: Object.keys(process.env).sort() });
    if (scenario === 'success') complete(id, worker);
    else if (scenario === 'isError') reply(id, { isError: true, content: [{ type: 'text', text: 'Synthetic worker failure' }] });
    else if (scenario === 'truncation') reply(id, { isError: false, content: [{ type: 'text', text: JSON.stringify(claims(worker)).slice(0, -8) }] });
    else if (scenario === 'disconnect') process.exit(0);
    else if (scenario === 'stall' || scenario === 'late-completion') pending.set(id, { worker, scenario });
    else error(id, -32602, `Unknown fixture scenario: ${scenario}`);
  } else if (method === 'notifications/cancelled') {
    // Delivery alone is deliberately not stop proof. A late worker can still finish.
    record({ event: 'cancel-delivered', requestId: params.requestId });
  } else if (method === 'fixture/release') {
    const task = pending.get(params.requestId);
    if (task?.scenario === 'late-completion') {
      record({ event: 'late-completion', requestId: params.requestId });
      complete(params.requestId, task.worker);
      pending.delete(params.requestId);
    }
  } else if (id !== undefined) error(id, -32601, 'Method not found');
});
