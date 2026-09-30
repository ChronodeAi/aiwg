/**
 * Trusted Jev credential resolver for the D12 live runner (#2686). It obtains a token for
 * the scoped `aiwg-jev-reader` AppRole through the itops OpenBao helper, then reads the Jev
 * key from OpenBao. Secrets never appear on argv, in logs or in error messages; the approval
 * pins this file by SHA-256, so any edit needs a new approval.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Logical binding credentialRef; this resolver alone maps it to the OpenBao KV path. */
export const JEV_SECRET_REFERENCE = 'openbao.typesafe.jev.api-key';
const KV_PATH = 'kv_internal/data/typesafe/jev/api-key';

/** Runs a child with stdin input and returns stdout only; stderr is discarded. */
function runChild(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    const chunks = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', () => { clearTimeout(timer); reject(new Error('credential step failed')); });
    child.on('close', code => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      chunks.forEach(chunk => chunk.fill(0));
      if (code === 0) resolve(output); else { output.fill(0); reject(new Error('credential step failed')); }
    });
    child.stdin.end(input ?? undefined);
  });
}

export function createOpenBaoJevResolver(options = {}) {
  const run = options.run ?? runChild;
  const helper = options.helper ?? join(homedir(), 'dev/itops/scripts/lib/openbao-token.sh');
  const role = options.role ?? 'aiwg-jev-reader';
  const address = options.address ?? process.env.BAO_ADDR ?? 'https://rca-g2.s9.internal:8200';
  const caCert = options.caCert ?? process.env.BAO_CACERT;
  const field = options.field ?? process.env.AIWG_JEV_OPENBAO_FIELD;
  return async function resolveCredential(reference) {
    if (reference !== JEV_SECRET_REFERENCE) throw new Error('Jev credential reference denied');
    if (!/^https:\/\/[^/\s]+$/.test(address)) throw new Error('Jev credential configuration denied');
    let token, header, body;
    try {
      token = await run('bash', [helper, 'approle', role], null, 15_000);
      const text = token.toString('utf8').trim();
      if (!text || /[\s\u0000-\u001f\u007f]/.test(text)) throw new Error('invalid token');
      // The token travels as a header read from stdin, never as an argument.
      header = Buffer.from(`X-Vault-Token: ${text}\n`);
      body = await run('curl', ['-fsS', '--proto', '=https', '--max-time', '10', ...(caCert ? ['--cacert', caCert] : []),
        '-H', '@-', `${address}/v1/${KV_PATH}`], header, 15_000);
      const data = JSON.parse(body.toString('utf8'))?.data?.data;
      const values = data && typeof data === 'object' && !Array.isArray(data) ? (field ? [data[field]] : Object.values(data)) : [];
      if (values.length !== 1 || typeof values[0] !== 'string' || !values[0]) throw new Error('invalid secret shape');
      return new TextEncoder().encode(values[0]);
    } catch {
      // Helper, network and parser messages can contain secret material: discard them.
      throw new Error('Jev credential resolution failed');
    } finally { token?.fill(0); header?.fill(0); body?.fill(0); }
  };
}

export const resolveCredential = createOpenBaoJevResolver();
