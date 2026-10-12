#!/usr/bin/env node
// Line-delimited stdio JSON-RPC/MCP endpoint; the permission fixture probes loopback.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import Ajv from 'ajv';
import { claims, config, fixtureRevision, workerInputSchema, workerOutputSchema, permissionChecks } from './ralph-worker-protocol.mjs';

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
    let inputSchema = workerInputSchema;
    if (settings.scenario === 'schema-change') {
      inputSchema = { ...workerInputSchema, required: [...workerInputSchema.required, 'changed'] };
    } else if (settings.scenario === 'schema-proto-drift') {
      // #2892 F3: a drift that disappears after the SDK's own zod
      // round-trip (`ToolSchema`'s `z.record()` reconstruction of
      // `properties` silently drops a member literally named `__proto__`,
      // since bracket assignment for that key invokes the inherited
      // prototype setter instead of creating an own property) but must
      // still be visible to a comparison against the RAW wire JSON.
      // `Object.defineProperty` (not object-literal syntax, which would
      // set this object's own prototype instead of adding a member) is
      // required to make `__proto__` a genuine, `JSON.stringify`-visible
      // own property here.
      const properties = { ...workerInputSchema.properties };
      Object.defineProperty(properties, '__proto__', { value: { type: 'string' }, enumerable: true, writable: true, configurable: true });
      inputSchema = { ...workerInputSchema, properties };
    }
    // #2892 F3: advertise the qualified output schema by default so every
    // ordinary scenario still matches the fixture's own qualification
    // (buildFixture's `mcpSchemas.output`); 'schema-missing-output'
    // deliberately omits it to exercise "missing equals drift".
    const tool = { name: 'fixture-worker', description: 'Synthetic bounded worker', inputSchema };
    if (settings.scenario !== 'schema-missing-output') tool.outputSchema = workerOutputSchema;
    reply(id, { tools: [tool] });
  } else if (method === 'tools/call') {
    if (params?.name !== 'fixture-worker' || !validate(params.arguments)) { error(id, -32602, 'Invalid typed worker call'); return; }
    const worker = params.arguments;
    const scenario = settings.scenarios?.[worker.invocationId] ?? settings.scenario ?? 'success';
    record({ event: 'call', requestId: id, scenario, worker, envNames: Object.keys(process.env).sort() });
    if (scenario === 'success') complete(id, worker);
    else if (scenario === 'isError') reply(id, { isError: true, content: [{ type: 'text', text: 'Synthetic worker failure' }] });
    else if (scenario === 'truncation') {
      // Deliberately isError:false with NO structuredContent at all — a
      // misbehaving worker that neither sets isError nor supplies the
      // structured companion its own advertised outputSchema promises.
      // test/conformance/orchestration-v1/worker-fixtures.test.ts asserts
      // this exact shape (`structuredContent` undefined) directly against
      // the raw tools/call response, bypassing the real MCP SDK entirely —
      // the real SDK's own Client.callTool() correctly refuses a response
      // shaped like this (outputSchema advertised, isError false, no
      // structuredContent) before ever reaching application-level parsing;
      // see worker-invoke.test.ts's own 'truncation scenario' expectation.
      reply(id, { isError: false, content: [{ type: 'text', text: JSON.stringify(claims(worker)).slice(0, -8) }] });
    }
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
