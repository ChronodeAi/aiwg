#!/usr/bin/env node
// Explicit live adapter. Importing it is inert; executing it performs one model call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeInvocation, parseTrace } from './run-rule-probes.mjs';
import { importImpl } from '../_resolve-impl.mjs';
const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const OPENROUTER_MODELS = new Set(['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5']);
const CHILD_ENV = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'AIWG_ROOT', 'AIWG_HOME', 'AIWG_CONFIG', 'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'NO_UPDATE_NOTIFIER', 'AIWG_NO_UPDATE_CHECK', 'AIWG_DECISION_ENABLED'];

export function claudeAdapter(request, { spawn = boundedSpawnSync, env = process.env, cwd = process.cwd() } = {}) {
  const isJudge = request.protocol === 'aiwg-release-judge/v1';
  if (!isJudge && (request.protocol !== 'aiwg-release-subject/v1' || request.provider !== 'claude')) throw new Error('Claude adapter requires a Claude subject or judge request');
  const transport = env.AIWG_RELEASE_CLAUDE_TRANSPORT ?? 'anthropic';
  if (!['anthropic', 'openrouter'].includes(transport)) throw new Error('Unknown Claude transport');
  // Router pins are admitted only on the explicitly selected transport.
  if (typeof request.model !== 'string' || !(transport === 'openrouter'
    ? OPENROUTER_MODELS.has(request.model) : /^claude-[\w.-]+-\d{8}$/.test(request.model))) throw new Error('Use an exact dated Claude model snapshot or an allowed OpenRouter pin on openrouter transport');
  let childEnv = env;
  let redact = value => value;
  if (transport === 'openrouter') {
    if (typeof env.OPENROUTER_API_KEY !== 'string' || !env.OPENROUTER_API_KEY.trim()) throw new Error('OpenRouter transport requires OPENROUTER_API_KEY in the environment');
    const key = env.OPENROUTER_API_KEY;
    redact = value => String(value).split(key).join('<redacted>');
    childEnv = Object.fromEntries(CHILD_ENV.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
    Object.assign(childEnv, { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' });
  }
  const prompt = isJudge ? `Judge the following blind pair. Return only the JSON object specified by instructions.\n${JSON.stringify(request)}` : request.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Missing model prompt');
  const invocation = probeInvocation('claude', request.model, prompt);
  if (transport === 'openrouter' && invocation.args.some(arg => redact(arg) !== arg)) throw new Error('Credential-bearing Claude arguments are prohibited');
  if (isJudge) {
    // The judge has no tools and never visits either deployed fixture.
    const tools = invocation.args.indexOf('--tools'); invocation.args.splice(tools, invocation.args.length - tools, '--tools', '');
  }
  let result;
  try {
    result = spawn(invocation.command, invocation.args, 'long', { cwd, env: childEnv, encoding: 'utf8',
      timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) { throw new Error(redact(error.message)); }
  if (result.error || result.status !== 0) throw new Error(redact(`Claude execution failed: ${result.error?.message ?? result.status}`));
  const stdout = redact(result.stdout);
  const trace = parseTrace(stdout, 'claude');
  if (!trace.completed || trace.failed) throw new Error('Claude trace has no successful terminal event');
  const normalize = model => transport === 'openrouter' ? model.replace(/^anthropic\//, '') : model;
  const models = [...new Set(trace.events.map(event => event.message?.model).filter(Boolean).map(normalize))];
  if (models.length !== 1 || models[0] !== normalize(request.model)) throw new Error('Observed Claude model differs from the requested snapshot');
  const terminal = trace.events.findLast(event => event.type === 'result');
  const usage = Object.fromEntries(Object.entries(terminal?.usage ?? {}).filter(([, value]) => typeof value === 'number'));
  const cost = Number.isFinite(terminal?.total_cost_usd) && terminal.total_cost_usd >= 0 ? { cost_usd: terminal.total_cost_usd } : {};
  const accounting = { ...cost, ...(transport === 'openrouter' ? { transport } : {}) };
  if (isJudge) {
    const judgment = JSON.parse(trace.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (judgment.model !== undefined && normalize(judgment.model) !== normalize(request.model)) throw new Error('Judge response model mismatch');
    return { ...judgment, model: request.model, usage, ...accounting };
  }
  return { model: request.model, stdout, usage, ...accounting };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(claudeAdapter(JSON.parse(fs.readFileSync(0, 'utf8')))) + '\n'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
