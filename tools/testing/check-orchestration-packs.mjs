#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const requiredPacks = [...Array.from({ length: 12 }, (_, i) => i + 1), 14, 15, 16, 17, 18, 19, 20, 23].map(id => `T-OG-${String(id).padStart(2, '0')}`);
export const registryPath = 'test/conformance/orchestration-v1/packs.json';

// A successful fake run proves mechanics, never live qualification. This same
// validator is used for optional, separately authorized qualification reports.
export function qualificationErrors(results) {
  if (!Array.isArray(results)) return ['qualificationResults must be an array'];
  return results.flatMap((row, index) => {
    const label = row?.id ?? `qualification[${index}]`;
    if (!row || !['missing', 'unqualified', 'qualified'].includes(row.qualification)
      || !['passed', 'failed', 'blocked', 'unqualified'].includes(row.result)) return [`${label}: invalid qualification/result`];
    if (row.result !== 'passed') return [];
    if (row.qualification !== 'qualified') return [`${label}: missing qualification cannot be reported as a pass`];
    const evidence = row.evidence;
    if (evidence?.kind !== 'live' || ['version', 'account', 'profile', 'transport', 'reportRef'].some(key => typeof evidence[key] !== 'string' || !evidence[key].trim())) {
      return [`${label}: pass requires version/account/profile/transport scoped live evidence`];
    }
    return [];
  });
}

export function inspectPackRegistry(registry, repositoryRoot = root, additionalQualifications = []) {
  const errors = [];
  if (registry?.revision !== 1) errors.push('Pack registry revision must be 1');
  const packs = registry?.packs ?? {};
  for (const id of requiredPacks) if (!packs[id]) errors.push(`${id}: missing pack`);
  for (const [id, pack] of Object.entries(packs)) {
    if (!requiredPacks.includes(id)) errors.push(`${id}: unexpected pack for this checkpoint`);
    if (!pack || typeof pack !== 'object') { errors.push(`${id}: invalid pack entry`); continue; }
    if (!/^roctinam\/aiwg#\d+$/.test(pack.ownerIssue ?? '')) errors.push(`${id}: owning issue is required`);
    if (!/^S[0-5]$/.test(pack.slice ?? '')) errors.push(`${id}: owning slice must be S0–S5`);
    if (!['planned', 'partial', 'implemented'].includes(pack.status)) errors.push(`${id}: invalid implementation status`);
    if (!Array.isArray(pack.testFiles)) { errors.push(`${id}: testFiles must be an array`); continue; }
    if (pack.status !== 'planned' && !pack.testFiles.length) errors.push(`${id}: ${pack.status} without test files`);
    for (const file of pack.testFiles) {
      if (typeof file !== 'string' || !/^test\/.+\.(test|spec)\.[cm]?[jt]s$/.test(file)
        || file.split('/').includes('..') || !fs.existsSync(path.join(repositoryRoot, file))
        || !fs.statSync(path.join(repositoryRoot, file)).isFile()) errors.push(`${id}: missing or invalid test file ${file}`);
    }
  }
  errors.push(...qualificationErrors(registry?.qualificationResults), ...qualificationErrors(additionalQualifications));
  return {
    revision: 1, checkpoint: 'S0', result: errors.length ? 'failed' : 'wiring-valid',
    releaseQualification: 'unqualified',
    packs, qualificationResults: [...(Array.isArray(registry?.qualificationResults) ? registry.qualificationResults : []), ...(Array.isArray(additionalQualifications) ? additionalQualifications : [])], errors,
  };
}

export function runPackGate({ repositoryRoot = root, qualificationReport } = {}) {
  const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot, registryPath), 'utf8'));
  const additional = qualificationReport ? JSON.parse(fs.readFileSync(qualificationReport, 'utf8')).results : [];
  const report = inspectPackRegistry(registry, repositoryRoot, additional);
  const destination = path.join(repositoryRoot, 'test-results/orchestration-pack-registry.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) {
    console.error(report.errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Orchestration S0 wiring: ${Object.keys(report.packs).length} packs registered; release qualification remains unqualified`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--qualification-report');
  if (args.length && (index !== 0 || args.length !== 2)) throw new Error('Usage: check-orchestration-packs.mjs [--qualification-report FILE]');
  runPackGate({ qualificationReport: index >= 0 ? args[index + 1] : undefined });
}
