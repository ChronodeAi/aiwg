#!/usr/bin/env node
/**
 * Synthetic stand-in for the Ollama HTTP API (`POST /api/generate`), used by
 * roctinam/aiwg#2899 tests. Started and stopped by the test itself on an
 * ephemeral loopback port — never the real, shared titan service. Implements
 * only what this profile's adapter calls: `POST /api/generate`. Any other
 * path or method is a 404, matching "unknown signals explicitly degraded"
 * rather than silently accepted.
 *
 * Scenario and record path come from the JSON file named by
 * AIWG_FAKE_WORKER_CONFIG ({ scenario, recordPath }); without it the success
 * scenario runs and nothing is recorded. Response shapes are synthetic but
 * field-shaped to match the real `GenerateResponse` fields observed via
 * `strings` on the installed ollama 0.33.3 binary (model, created_at,
 * response, done, done_reason) — not a pinned upstream contract.
 *
 * Usage: `node fake-ollama-server.mjs <port-file>` — writes the bound port
 * (as text) to <port-file> once listening, so the test can read an
 * OS-assigned ephemeral port without a race.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const config = process.env.AIWG_FAKE_WORKER_CONFIG
  ? JSON.parse(readFileSync(process.env.AIWG_FAKE_WORKER_CONFIG, 'utf8')) : {};
const scenario = config.scenario ?? 'success';
const portFile = process.argv[2];

function record(entry) {
  if (!config.recordPath) return;
  writeFileSync(config.recordPath, JSON.stringify(entry));
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(bodyText); } catch { /* recorded raw below */ }
    record({ method: req.method, path: req.url, headers: { 'content-type': req.headers['content-type'] ?? null },
      bodyText, body });

    if (req.method !== 'POST' || req.url !== '/api/generate') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `404 page not found` }));
      return;
    }

    const model = body?.model;
    const sendJson = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (scenario === 'model-not-found') {
      sendJson(404, { error: `model '${model}' not found, try pulling it first` });
      return;
    }
    if (scenario === 'no-prompt') {
      sendJson(400, { error: 'prompt is required' });
      return;
    }
    if (scenario === 'malformed') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"model":"' + model + '", not valid json');
      return;
    }
    if (scenario === 'error-field') {
      // A 200 that still carries an error object: must fail closed anyway.
      sendJson(200, { model, created_at: '2026-10-11T00:00:00Z', done: true, done_reason: 'stop',
        error: 'synthetic mid-stream error', response: 'should not count' });
      return;
    }
    if (scenario === 'not-done') {
      sendJson(200, { model, created_at: '2026-10-11T00:00:00Z', done: false, response: 'partial' });
      return;
    }
    if (scenario === 'empty-content') {
      sendJson(200, { model, created_at: '2026-10-11T00:00:00Z', done: true, done_reason: 'stop', response: '' });
      return;
    }
    if (scenario === 'hang') {
      // Never respond; the client's own --max-time must be what ends this.
      return;
    }
    // success
    const response = body?.prompt ?? '';
    sendJson(200, { model, created_at: '2026-10-11T00:00:00Z', response,
      done: true, done_reason: 'stop', total_duration: 1, load_duration: 1, prompt_eval_count: 1,
      prompt_eval_duration: 1, eval_count: 1, eval_duration: 1 });
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  if (portFile) writeFileSync(portFile, String(port));
  else process.stdout.write(`${port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
