#!/usr/bin/env node
// Explicit live adapter. Importing it is inert; executing it performs one model call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeInvocation, parseTrace } from './run-rule-probes.mjs';
import { importImpl } from '../_resolve-impl.mjs';
const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

export function claudeAdapter(request, { spawn = boundedSpawnSync, env = process.env, cwd = process.cwd() } = {}) {
  const isJudge = request.protocol === 'aiwg-release-judge/v1';
  if (!isJudge && (request.protocol !== 'aiwg-release-subject/v1' || request.provider !== 'claude')) throw new Error('Claude adapter requires a Claude subject or judge request');
  // Exact snapshots allow result telemetry to establish judge/subject separation.
  if (typeof request.model !== 'string' || !/^claude-[\w.-]+-\d{8}$/.test(request.model)) throw new Error('Use an exact dated Claude model snapshot');
  const prompt = isJudge ? `Judge the following blind pair. Return only the JSON object specified by instructions.\n${JSON.stringify(request)}` : request.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Missing model prompt');
  const invocation = probeInvocation('claude', request.model, prompt);
  if (isJudge) {
    // The judge has no tools and never visits either deployed fixture.
    const tools = invocation.args.indexOf('--tools'); invocation.args.splice(tools, invocation.args.length - tools, '--tools', '');
  }
  const result = spawn(invocation.command, invocation.args, 'long', { cwd, env, encoding: 'utf8',
    timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Claude execution failed: ${result.error?.message ?? result.status}`);
  const trace = parseTrace(result.stdout, 'claude');
  if (!trace.completed || trace.failed) throw new Error('Claude trace has no successful terminal event');
  const models = [...new Set(trace.events.map(event => event.message?.model).filter(Boolean))];
  if (models.length !== 1 || models[0] !== request.model) throw new Error('Observed Claude model differs from the requested snapshot');
  const terminal = trace.events.findLast(event => event.type === 'result');
  const usage = Object.fromEntries(Object.entries(terminal?.usage ?? {}).filter(([, value]) => typeof value === 'number'));
  if (isJudge) {
    const judgment = JSON.parse(trace.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (judgment.model !== request.model) throw new Error('Judge response model mismatch');
    return { ...judgment, usage };
  }
  return { model: models[0], stdout: result.stdout, usage };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(claudeAdapter(JSON.parse(fs.readFileSync(0, 'utf8')))) + '\n'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
