#!/usr/bin/env node
// Acquire the Actions signing identity explicitly so transient token failures can recover.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { importImpl } from '../_resolve-impl.mjs';
const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

export async function acquireSigningIdentity({ env = process.env, fetchImpl = globalThis.fetch, sleep = delay } = {}) {
  let url;
  try { url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); } catch { throw new Error('Actions OIDC request URL is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('Actions OIDC request credentials are required');
  url.searchParams.set('audience', 'sigstore');
  let diagnostic;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let status = 'unavailable', length = 0;
    try {
      const response = await fetchImpl(url.href, {
        headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      status = response.status;
      const body = await response.text();
      length = Buffer.byteLength(body);
      if (response.ok) {
        const data = JSON.parse(body);
        if (typeof data?.value === 'string' && data.value.trim()) return data.value;
      }
    } catch {
      // Fetch and parse exceptions may contain the URL, bearer token or response body.
    }
    diagnostic = `HTTP ${status}; body length ${length} bytes`;
    if (attempt < 3) await sleep(attempt * 1000);
  }
  throw new Error(`Actions OIDC token acquisition failed after 3 attempts (${diagnostic})`);
}

export async function signBlob({ file, bundle, env = process.env, fetchImpl = globalThis.fetch, sleep = delay, spawn = boundedSpawnSync } = {}) {
  if (!file || !bundle) throw new Error('Signing file and bundle are required');
  const identity = await acquireSigningIdentity({ env, fetchImpl, sleep });
  // Cosign v2.6.1's envvar provider reads SIGSTORE_ID_TOKEN. Selecting it explicitly
  // bypasses the GitHub provider's single ambient fetch and keeps tokens out of argv.
  const childEnv = { ...env, SIGSTORE_ID_TOKEN: identity };
  delete childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete childEnv.ACTIONS_ID_TOKEN_REQUEST_URL;
  let result;
  try {
    result = spawn('cosign', ['sign-blob', '--yes', '--oidc-provider', 'envvar', '--bundle', bundle, file], 'long', {
      env: childEnv, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
  } catch { throw new Error('cosign sign-blob failed'); }
  // Do not forward signer output or its errors: either could contain credentials.
  if (result.error || result.status !== 0) throw new Error(`cosign sign-blob failed (exit ${Number.isInteger(result.status) ? result.status : 'unavailable'})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { file: { type: 'string' }, bundle: { type: 'string' } } });
    await signBlob(values);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
