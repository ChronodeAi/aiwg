#!/usr/bin/env node
/**
 * Record the project's declared Kairos node: health, readiness, /meta, MCP
 * initialize and tools/list, and whether the agent auth path works.
 *
 * Usage (from the project root):
 *   node kairos-connect.mjs [--workspace .aiwg/kairos] [--baseline-receipt <path>]
 *
 * Reads the node origin from <workspace>/connection/node.json only
 * (kairos-node-isolation). Reads KAIROS_API_TOKEN from the environment and never
 * writes it. Saves raw public bodies under connection/raw/<stamp>/, copies /meta
 * to connection/meta.json and writes connection/connection-record.json. The
 * /auth/me body holds personal data, so only its sha256 and role are kept.
 * Exit code 0 when gate CG passes, 3 when it does not, 1 on usage errors.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateRecord } from './kairos-records.mjs';

/** True when run as a script; realpath handles symlinked paths such as macOS /tmp. */
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const MCP_PROTOCOL = '2025-11-25';

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

async function request(url, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['MCP-Protocol-Version'] = MCP_PROTOCOL;
  }
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  } catch (error) {
    return { status: 0, text: String(error.cause?.message ?? error.message), json: null };
  }
}

export async function connect({ workspace = '.aiwg/kairos', token = process.env.KAIROS_API_TOKEN, baselineReceipt = null, now = new Date() } = {}) {
  const connectionDir = path.join(workspace, 'connection');
  const nodeFile = path.join(connectionDir, 'node.json');
  const node = JSON.parse(readFileSync(nodeFile, 'utf8'));
  const origin = new URL(node.url);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error(`${nodeFile}: url must be an origin without path, query or credentials`);
  }
  const base = origin.origin;
  const recordedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const stamp = recordedAt.replace(/[-:]/g, '');
  const rawDir = path.join(connectionDir, 'raw', stamp);
  mkdirSync(rawDir, { recursive: true });
  const save = (name, text) => {
    writeFileSync(path.join(rawDir, name), text);
    return sha256(text);
  };

  const health = await request(`${base}/api/v1/health`);
  save('health.json', health.text);
  const ready = await request(`${base}/api/v1/health/ready`);
  const readyHash = save('ready.json', ready.text);
  const meta = await request(`${base}/api/v1/meta`);
  const metaHash = save('meta.json', meta.text);
  if (meta.status === 200) writeFileSync(path.join(connectionDir, 'meta.json'), meta.text);

  const init = await request(`${base}/mcp`, {
    method: 'POST', token,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'aiwg-kairos-connect', version: '1' } } },
  });
  save('mcp-initialize.json', init.text);
  await request(`${base}/mcp`, { method: 'POST', token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  const tools = await request(`${base}/mcp`, { method: 'POST', token, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  save('mcp-tools-list.json', tools.text);

  const m = meta.json ?? {};
  const authEnabled = m.auth?.enabled === true;
  let verified = false;
  let verification;
  let admin = null;
  if (authEnabled) {
    if (!token) {
      verification = 'KAIROS_API_TOKEN not set; authenticated read not attempted';
    } else {
      const me = await request(`${base}/api/v1/auth/me`, { token });
      verified = me.status === 200;
      verification = `GET /api/v1/auth/me -> ${me.status} (body sha256 ${sha256(me.text)}, body not stored)`;
      if (verified && typeof me.json?.role === 'string') admin = me.json.role === 'admin';
    }
  } else {
    verified = init.status === 200 && tools.status === 200;
    verification = `auth off: POST /mcp initialize -> ${init.status}, tools/list -> ${tools.status}`;
    admin = m.auth?.admin_waiver === true ? true : null;
  }

  const toolNames = Array.isArray(tools.json?.result?.tools) ? tools.json.result.tools.map((t) => t.name) : [];
  const record = {
    schema: 'kairos_connection_record/v1',
    recorded_at: recordedAt,
    node: {
      url: base,
      configured_in: nodeFile,
      ...(node.expected_profile ? { expected_profile: node.expected_profile } : {}),
      ...(node.purpose ? { purpose: node.purpose } : {}),
    },
    meta: {
      http_status: meta.status,
      sha256: metaHash,
      snapshot_path: path.join(rawDir, 'meta.json'),
      ...(Number.isInteger(m.schema_version) ? { schema_version: m.schema_version } : {}),
      ...(typeof m.version === 'string' ? { version: m.version } : {}),
      ...(m.store?.backend ? { store_backend: m.store.backend } : {}),
      ...(m.authorization?.profile ? { authorization_profile: m.authorization.profile } : {}),
      ...(typeof m.authorization?.namespace_policy === 'boolean' ? { namespace_policy: m.authorization.namespace_policy } : {}),
      ...(m.capabilities?.neural_fallback ? { neural_fallback: m.capabilities.neural_fallback } : {}),
      ...(Number.isInteger(m.capabilities?.federation_peers) ? { federation_peers: m.capabilities.federation_peers } : {}),
    },
    health: { http_status: health.status, version: String(health.json?.version ?? 'unknown'), ...(health.json?.status ? { status: String(health.json.status) } : {}) },
    ready: { http_status: ready.status, ready: ready.status === 200 && ready.json?.ready !== false, body_sha256: readyHash },
    auth: {
      enabled: authEnabled,
      provider: m.auth?.provider ?? null,
      admin_waiver: m.auth?.admin_waiver === true,
      agent_path: authEnabled ? 'bearer_env' : 'none',
      ...(authEnabled ? { token_env: 'KAIROS_API_TOKEN', token_source: node.token_source ?? 'Privy token from an operator login (see the node operator)' } : {}),
      ...(authEnabled && node.token_lifetime_note ? { token_lifetime_note: node.token_lifetime_note } : {}),
      verified,
      verification,
      admin,
    },
    mcp: {
      protocol_version: String(init.json?.result?.protocolVersion ?? 'unknown'),
      ...(init.json?.result?.serverInfo?.version ? { server_version: String(init.json.result.serverInfo.version) } : {}),
      tools: toolNames,
      ...(typeof m.mcp?.requires_bearer === 'boolean' ? { requires_bearer: m.mcp.requires_bearer } : {}),
      ...(typeof m.mcp?.browser_access === 'boolean' ? { browser_access: m.mcp.browser_access } : {}),
    },
    secrets_recorded: false,
  };

  const unmet = [];
  if (health.status !== 200) unmet.push(`GET /api/v1/health -> ${health.status}`);
  if (!record.ready.ready) unmet.push(`GET /api/v1/health/ready -> ${ready.status}`);
  if (meta.status !== 200) unmet.push(`GET /api/v1/meta -> ${meta.status}`);
  if (record.meta.version && record.health.version !== record.meta.version) unmet.push(`version mismatch: /health ${record.health.version}, /meta ${record.meta.version}`);
  if (node.expected_profile) {
    const expectedBackend = node.expected_profile === 'pg' ? 'postgres' : 'sqlite';
    if (record.meta.store_backend && record.meta.store_backend !== expectedBackend) unmet.push(`expected profile ${node.expected_profile} but /meta store.backend is ${record.meta.store_backend}`);
  }
  if (record.mcp.protocol_version !== MCP_PROTOCOL) unmet.push(`MCP initialize protocolVersion ${record.mcp.protocol_version}`);
  if (!verified) unmet.push(`agent auth path not verified: ${verification}`);
  if (baselineReceipt) {
    const text = readFileSync(baselineReceipt, 'utf8');
    let summary;
    try { summary = JSON.parse(text).summary; } catch { /* receipt summary optional */ }
    record.conformance_baseline = { receipt_path: baselineReceipt, receipt_sha256: sha256(text), ...(summary && typeof summary === 'object' ? { summary } : {}) };
  } else {
    unmet.push('conformance baseline not run (kairos-conformance-probe)');
  }
  record.gate_cg = { status: unmet.length === 0 ? 'PASS' : 'FAIL', ...(unmet.length ? { unmet } : {}) };

  const text = `${JSON.stringify(record, null, 2)}\n`;
  const errors = validateRecord(record, text);
  if (errors.length) throw new Error(`connection record failed validation:\n  - ${errors.join('\n  - ')}`);
  writeFileSync(path.join(connectionDir, 'connection-record.json'), text);
  return record;
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  try {
    const record = await connect({ workspace: arg(argv, '--workspace', '.aiwg/kairos'), baselineReceipt: arg(argv, '--baseline-receipt') });
    process.stdout.write(`${JSON.stringify({ gate_cg: record.gate_cg, version: record.meta.version ?? null, auth: { enabled: record.auth.enabled, agent_path: record.auth.agent_path, verified: record.auth.verified, admin: record.auth.admin } }, null, 2)}\n`);
    process.exitCode = record.gate_cg.status === 'PASS' ? 0 : 3;
  } catch (error) {
    process.stderr.write(`kairos-connect: ${error.message}\n`);
    process.exitCode = 1;
  }
}
