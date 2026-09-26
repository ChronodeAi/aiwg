#!/usr/bin/env node
/**
 * Validate and render Kairos framework records.
 *
 *   validate <file...>        schema + semantic checks; kind detected from the `schema` field
 *                             (review packet, finding, connection record, edge proposal)
 *   fingerprint <finding>     print the dedupe fingerprint a finding must carry
 *   fileable <finding>        exit 0 only when the finding may be filed as a Kairos issue
 *   render-packet <packet>    Markdown render of a review packet
 *   issue-body <finding>      Markdown issue body in the ChronodeAi/kairos bug-report layout
 *   sha256 <file...>          sha256 of each file's bytes
 *   status <workspace>        gate CG/MB state, latest gate decisions, packets, findings, review effort
 *
 * The checks read recorded data only. They cannot prove that a command was
 * actually run, that a reviewer is who they claim, or that Kairos behaved as
 * recorded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

/** True when run as a script; realpath handles symlinked paths such as macOS /tmp. */
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const schemaFile = (name) => JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const VALIDATORS = {
  'kairos_review_packet/v1': ajv.compile(schemaFile('review-packet')),
  'kairos_finding/v1': ajv.compile(schemaFile('finding')),
  'kairos_connection_record/v1': ajv.compile(schemaFile('connection-record')),
  'kairos_edge_proposal/v1': ajv.compile(schemaFile('edge-proposal')),
};

export const KAIROS_REPO = 'ChronodeAi/kairos';

/** Credential shapes that must never appear in a recorded artifact. */
const SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'a JWT'],
  [/Bearer\s+(?!\$)[A-Za-z0-9._~+/-]{16,}/, 'a literal bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API secret key'],
  [/"(?:X-Admin-Key|x-admin-key|password|client_secret)"\s*:\s*"[^"$][^"]*"/, 'an admin key or password value'],
];

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function findSecrets(text) {
  return SECRET_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Pre-image and fingerprint as documented in finding.schema.json. */
export function fingerprintOf(finding) {
  const discriminator = Array.isArray(finding.assertion_signatures) && finding.assertion_signatures.length > 0
    ? [...finding.assertion_signatures].sort().join(';')
    : collapse(finding.expected);
  const citation = finding.doc_citation ?? {};
  const basis = `kairos_finding/v1|${finding.claim_id ?? '-'}|${finding.surface}|${citation.file}:${citation.line_start}|${discriminator}`;
  return { basis, fingerprint: sha256(basis) };
}

function semanticErrors(kind, doc, text) {
  const errors = [];
  if (kind in VALIDATORS) {
    for (const label of findSecrets(text)) errors.push(`contains ${label}; replace it with the environment variable name`);
  }
  if (kind === 'kairos_finding/v1') {
    const { fingerprint } = fingerprintOf(doc);
    if (doc.fingerprint !== fingerprint) errors.push(`fingerprint ${doc.fingerprint} does not match the recomputed ${fingerprint}`);
    if (doc.issue && doc.issue.url && !doc.issue.url.endsWith(`/issues/${doc.issue.number}`)) errors.push('issue.url does not end with issue.number');
  }
  if (kind === 'kairos_review_packet/v1') {
    const ids = (doc.gates ?? []).map((g) => g.id);
    if (new Set(ids).size !== ids.length) errors.push('gate ids must be unique');
    const gates = doc.gates ?? [];
    if (doc.status === 'PASS' && gates.some((g) => g.pass === false)) errors.push('status PASS with a failing gate');
    if (doc.status === 'FAIL' && !gates.some((g) => g.pass === false)) errors.push('status FAIL without a failing gate');
    for (const g of gates) {
      if (g.pass === null && g.status !== 'not_available') errors.push(`gate ${g.id}: pass null is allowed only for status not_available`);
    }
    if (doc.decision && doc.decision.outcome === 'approve' && doc.human_go_signoff !== true) errors.push('an approve decision must set human_go_signoff true');
    if (doc.decision && doc.decision.outcome !== 'approve' && doc.human_go_signoff === true) errors.push('human_go_signoff true requires an approve decision');
    if (doc.decision && Date.parse(doc.decision.signed_at) < Date.parse(doc.recorded_at)) errors.push('decision.signed_at precedes the packet recorded_at');
  }
  return errors;
}

/** Validate one record; returns a list of error strings (empty when valid). */
export function validateRecord(doc, text = JSON.stringify(doc)) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['record must be a JSON object'];
  const kind = doc.schema;
  const validate = VALIDATORS[kind];
  if (!validate) return [`unknown schema ${JSON.stringify(kind)}; expected one of ${Object.keys(VALIDATORS).join(', ')}`];
  const errors = [];
  if (!validate(doc)) {
    for (const e of validate.errors ?? []) errors.push(`schema: ${e.instancePath || '/'} ${e.message}`);
  }
  return [...errors, ...semanticErrors(kind, doc, text)];
}

/** A finding is fileable only when it validates, is still open, and carries every evidence field. */
export function fileableErrors(finding, text = JSON.stringify(finding)) {
  const errors = validateRecord(finding, text);
  if (finding?.schema !== 'kairos_finding/v1') return errors.length ? errors : ['not a kairos_finding/v1 record'];
  if (finding.status !== 'open') errors.push(`status is ${finding.status}; only open findings are filed`);
  if (!/\S/.test(finding.command ?? '')) errors.push('command is empty');
  if (!/\S/.test(finding.output?.excerpt ?? '')) errors.push('output.excerpt is empty');
  if (!finding.doc_citation?.file || !Number.isInteger(finding.doc_citation?.line_start)) errors.push('doc_citation needs file and line_start');
  if (collapse(finding.expected) === collapse(finding.observed)) errors.push('expected and observed are identical; there is nothing to report');
  return errors;
}

const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderPacket(p) {
  const lines = [
    `# Review packet ${p.packet_id}`,
    '',
    `Gate **${p.gate}** · status **${p.status}** · recommendation **${p.recommendation}** · human sign-off **${p.human_go_signoff ? 'yes' : 'no'}**`,
    '',
    `Recorded ${p.recorded_at} against node ${p.kairos.node_url} (Kairos ${p.kairos.version}). Contract \`${p.contract}\` sha256 \`${p.contract_sha256}\`.`,
    '',
    '## Subject',
    '',
    `\`${p.subject.source.namespace}/${p.subject.source.name}\` → \`${p.subject.target.namespace}/${p.subject.target.name}\` (${p.subject.vector_type}, sign ${p.subject.sign ?? 'unknown'}): ${p.subject.current_status ?? 'none'} → ${p.subject.proposed_status}`,
  ];
  if (p.escalation_reasons?.length) lines.push('', `Escalated because: ${p.escalation_reasons.join(', ')}.`);
  lines.push('', '## Gates', '', '| Gate | Status | Value | Threshold | Detail |', '|---|---|---|---|---|');
  for (const g of p.gates) lines.push(`| ${g.id} ${g.name ?? ''} | ${g.status ?? (g.pass ? 'pass' : 'fail')} | ${cell(g.value)} | ${cell(g.threshold)} | ${cell(g.detail)} |`);
  lines.push('', '## Proposers', '', '| Proposer | Family | Kind | Sign | Proposal sha256 |', '|---|---|---|---|---|');
  for (const pr of p.proposers) lines.push(`| ${cell(pr.id)} | ${cell(pr.family)} | ${pr.kind} | ${pr.sign ?? ''} | \`${pr.proposal_sha256}\` |`);
  lines.push('', '## Evidence', '', `Data snapshot as of ${p.data_snapshot.as_of}, sha256 \`${p.data_snapshot.sha256}\`.`, '');
  for (const s of p.sources) lines.push(`- \`${s.ref}\` sha256 \`${s.sha256}\``);
  lines.push('', '## Change', '', '```json', JSON.stringify(p.diff, null, 2), '```', '', '## Impact', '', p.impact.summary);
  if (p.recommendation_basis) lines.push('', `Recommendation basis: ${p.recommendation_basis}`);
  const storeRevision = p.kairos.store_revision.absent ? `absent (${p.kairos.store_revision.absent})` : `${p.kairos.store_revision.instance_id}#${p.kairos.store_revision.recorded_seq}`;
  lines.push('', `Store revision: ${storeRevision}.`, '', '## Decision', '');
  if (p.decision) {
    lines.push(`**${p.decision.outcome}** (${p.decision.reason_code}) by ${p.decision.reviewer} at ${p.decision.signed_at}${p.decision.review_minutes !== undefined ? `, ${p.decision.review_minutes} review minute(s)` : ''}.`);
    if (p.decision.note) lines.push('', p.decision.note);
  } else {
    lines.push('Pending. Record approve, reject or defer with a reason code; the decision becomes a calibration label.');
  }
  return `${lines.join('\n')}\n`;
}

export function renderIssueBody(f) {
  const { fingerprint } = fingerprintOf(f);
  const cite = `${f.doc_citation.file}:${f.doc_citation.line_start}${f.doc_citation.line_end ? `-${f.doc_citation.line_end}` : ''}${f.doc_citation.ref ? ` (${f.doc_citation.ref})` : ''}`;
  const lines = [
    '### Description',
    '',
    `${f.title}.`,
    '',
    `**Documented:** ${cite}${f.doc_citation.quote ? ` — "${f.doc_citation.quote}"` : ''}`,
    '',
    `**Expected:** ${f.expected}`,
    '',
    `**Observed:** ${f.observed}`,
  ];
  if (f.claim_id) lines.push('', `Claim: \`${f.claim_id}\`${f.known_gap ? ` (reproduces known gap ${f.known_gap})` : ''}.`);
  lines.push(
    '',
    '### Steps to Reproduce',
    '',
    '```sh',
    f.command,
    '```',
    '',
    '### Environment',
    '',
    `Kairos ${f.node.version}, profile ${f.node.profile ?? 'unknown'}${f.node.meta_sha256 ? `, /api/v1/meta sha256 \`${f.node.meta_sha256}\`` : ''}. Node URL withheld unless loopback: ${/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(f.node.url) ? f.node.url : 'non-loopback'}.`,
    '',
    '### Relevant Logs',
    '',
    '```text',
    f.output.excerpt,
    '```',
    '',
    `Output sha256 \`${f.output.sha256}\`${f.output.http_status ? `, HTTP ${f.output.http_status}` : ''}. Recorded ${f.recorded_at}. Severity ${f.severity}, kind ${f.kind}.`,
    '',
    `Finding fingerprint: ${fingerprint}`,
    '',
    `<!-- kairos-finding-fingerprint: ${fingerprint} -->`,
  );
  return `${lines.join('\n')}\n`;
}

function readJson(file) {
  const text = readFileSync(file, 'utf8');
  return { text, doc: JSON.parse(text) };
}

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'raw') out.push(...jsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

function tryRead(file) {
  try { return readJson(file); } catch { return { text: '', doc: null }; }
}

/** Summarize a .aiwg/kairos workspace: gate CG and MB state, decisions, packets, findings and review effort. */
export function summarizeWorkspace(workspace) {
  const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
  const connection = tryRead(path.join(workspace, 'connection', 'connection-record.json')).doc;

  const proposals = { files: 0, invalid: [], edges: new Set() };
  for (const file of jsonFiles(path.join(workspace, 'proposals'))) {
    const { text, doc } = tryRead(file);
    if (doc?.schema !== 'kairos_edge_proposal/v1') continue;
    proposals.files += 1;
    if (validateRecord(doc, text).length) proposals.invalid.push(file);
    proposals.edges.add(doc.edge_id);
  }

  const latest = new Map();
  let evaluations = 0;
  for (const file of jsonFiles(path.join(workspace, 'evidence'))) {
    const { doc } = tryRead(file);
    if (doc?.schema !== 'kairos_gate_evaluation/v1') continue;
    evaluations += 1;
    for (const e of doc.edges ?? []) {
      const prev = latest.get(e.edge_id);
      if (!prev || prev.at <= doc.recorded_at) latest.set(e.edge_id, { at: doc.recorded_at, decision: e.decision });
    }
  }
  const decisions = {};
  for (const { decision } of latest.values()) count(decisions, decision);

  const packets = { total: 0, pending: [], outcomes: {}, review_minutes: 0 };
  const approvedEdges = new Set();
  for (const file of jsonFiles(path.join(workspace, 'packets'))) {
    const { doc } = tryRead(file);
    if (doc?.schema !== 'kairos_review_packet/v1') continue;
    packets.total += 1;
    if (!doc.decision) {
      if (doc.status === 'ESCALATED') packets.pending.push(doc.packet_id);
      continue;
    }
    count(packets.outcomes, doc.decision.outcome);
    if (typeof doc.decision.review_minutes === 'number') packets.review_minutes += doc.decision.review_minutes;
    if (doc.decision.outcome === 'approve' && doc.gate === 'EA') approvedEdges.add(doc.subject.edge_id);
  }

  const findings = { by_status: {}, not_fileable: [] };
  for (const file of jsonFiles(path.join(workspace, 'findings'))) {
    const { text, doc } = tryRead(file);
    if (doc?.schema !== 'kairos_finding/v1') continue;
    count(findings.by_status, doc.status);
    if (doc.status === 'open' && fileableErrors(doc, text).length) findings.not_fileable.push(file);
  }

  const receipts = { total: 0, live: 0 };
  for (const file of jsonFiles(path.join(workspace, 'decisions'))) {
    const { doc } = tryRead(file);
    if (doc?.schema !== 'kairos_decision_receipt/v1') continue;
    receipts.total += 1;
    if (doc.mode === 'live') receipts.live += 1;
  }

  const autoAdmitted = [...latest.entries()].filter(([, v]) => v.decision === 'auto_promote').map(([id]) => id);
  const admitted = new Set([...autoAdmitted, ...approvedEdges]);
  return {
    workspace,
    node: connection ? { url: connection.node?.url ?? null, version: connection.meta?.version ?? connection.health?.version ?? null } : null,
    gate_cg: connection?.gate_cg ?? { status: 'FAIL', unmet: ['no connection record (kairos-connect)'] },
    gate_mb: {
      status: proposals.files > 0 && proposals.invalid.length === 0 ? 'PASS' : 'FAIL',
      proposals: proposals.files,
      edges: proposals.edges.size,
      invalid: proposals.invalid,
    },
    evidence: { evaluations, latest_decisions: decisions },
    packets: { total: packets.total, pending: packets.pending, outcomes: packets.outcomes },
    human_effort: {
      admitted_edges: admitted.size,
      review_minutes: packets.review_minutes,
      review_minutes_per_admitted_edge: admitted.size ? packets.review_minutes / admitted.size : null,
    },
    decisions: receipts,
    findings,
  };
}

function main(argv) {
  const [command, ...files] = argv.slice(2);
  if (!command || files.length === 0) {
    process.stderr.write('usage: kairos-records.mjs <validate|fingerprint|fileable|render-packet|issue-body|sha256|status> <file...|workspace>\n');
    return 2;
  }
  if (command === 'sha256') {
    for (const f of files) process.stdout.write(`${sha256(readFileSync(f))}  ${f}\n`);
    return 0;
  }
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(summarizeWorkspace(files[0]), null, 2)}\n`);
    return 0;
  }
  let failed = false;
  for (const file of files) {
    const { text, doc } = readJson(file);
    if (command === 'validate' || command === 'fileable') {
      const errors = command === 'validate' ? validateRecord(doc, text) : fileableErrors(doc, text);
      if (errors.length) {
        failed = true;
        process.stdout.write(`FAIL ${file}\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
      } else {
        process.stdout.write(`OK   ${file}\n`);
      }
    } else if (command === 'fingerprint') {
      process.stdout.write(`${fingerprintOf(doc).fingerprint}  ${file}\n`);
    } else if (command === 'render-packet' || command === 'issue-body') {
      const errors = validateRecord(doc, text);
      if (errors.length) {
        failed = true;
        process.stderr.write(`FAIL ${file}\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
        continue;
      }
      process.stdout.write(command === 'render-packet' ? renderPacket(doc) : renderIssueBody(doc));
    } else {
      process.stderr.write(`unknown command ${command}\n`);
      return 2;
    }
  }
  return failed ? 1 : 0;
}

if (isMainModule()) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    process.stderr.write(`kairos-records: ${error.message}\n`);
    process.exitCode = 1;
  }
}
