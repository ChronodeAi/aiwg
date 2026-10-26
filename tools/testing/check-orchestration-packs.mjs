#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertedTests, scenarioErrors } from './orchestration-pack-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const requiredPacks = [...Array.from({ length: 13 }, (_, i) => i + 1), 14, 15, 16, 17, 18, 19, 20, 21, 23, 24].map(id => `T-OG-${String(id).padStart(2, '0')}`);
export const registryPath = 'test/conformance/orchestration-v1/packs.json';
export const fragmentsDir = 'test/conformance/orchestration-v1/packs.d';

// Provider profiles register their own test files by adding
// packs.d/<provider>.json; never edit packs.json's testFiles for a provider.
// Each fragment maps an existing pack ID to test files, or to an object with
// testFiles/requirements/scenarios/mechanismOwners. Fragments merge into packs.json in sorted
// fragment-filename order, appended after packs.json's own testFiles. This
// keeps every provider's registration in its own file so two provider PRs
// never touch the same lines of packs.json.
export function loadOrchestrationPackRegistry(repositoryRoot = root) {
  const basePath = path.join(repositoryRoot, registryPath);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  } catch (error) {
    throw new Error(`${registryPath}: invalid JSON (${error.message})`);
  }
  const packs = registry?.packs ?? {};
  const seenFiles = new Map(Object.entries(packs).map(([id, pack]) => [id, new Set(Array.isArray(pack?.testFiles) ? pack.testFiles : [])]));

  const fragmentsPath = path.join(repositoryRoot, fragmentsDir);
  const fragmentFiles = fs.existsSync(fragmentsPath)
    ? fs.readdirSync(fragmentsPath).filter(name => name.endsWith('.json')).sort()
    : [];

  for (const filename of fragmentFiles) {
    const relativePath = `${fragmentsDir}/${filename}`;
    let fragment;
    try {
      fragment = JSON.parse(fs.readFileSync(path.join(fragmentsPath, filename), 'utf8'));
    } catch (error) {
      throw new Error(`${relativePath}: invalid JSON (${error.message})`);
    }
    if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
      throw new Error(`${relativePath}: fragment must be a JSON object mapping pack ID to an array of test files`);
    }
    for (const [id, entry] of Object.entries(fragment)) {
      if (!packs[id]) throw new Error(`${relativePath}: unknown pack ${id}`);
      const files = Array.isArray(entry) ? entry : entry?.testFiles;
      if (!Array.isArray(files)) throw new Error(`${relativePath}: ${id} must map to an array of test files`);
      if (!Array.isArray(entry)) {
        if (Object.keys(entry).some(key => !['testFiles', 'requirements', 'scenarios', 'mechanismOwners'].includes(key))) {
          throw new Error(`${relativePath}: ${id} has unsupported fragment fields`);
        }
        for (const field of ['requirements', 'scenarios', 'mechanismOwners']) {
          if (entry[field] === undefined) continue;
          if (!Array.isArray(entry[field])) throw new Error(`${relativePath}: ${id}.${field} must be an array`);
          const merged = [...(packs[id][field] ?? []), ...entry[field]];
          packs[id][field] = field !== 'scenarios' ? [...new Set(merged)] : merged;
        }
      }
      const existing = seenFiles.get(id);
      for (const file of files) {
        if (existing.has(file)) throw new Error(`${relativePath}: duplicate test file ${file} already registered for ${id}`);
        existing.add(file);
        packs[id].testFiles = [...(packs[id].testFiles ?? []), file];
      }
    }
  }
  return registry;
}

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
  const contents = new Map();
  if (registry?.revision !== 1) errors.push('Pack registry revision must be 1');
  if (typeof registry?.checkpoint !== 'string' || !registry.checkpoint.trim()) errors.push('Pack registry checkpoint is required');
  const packs = registry?.packs ?? {};
  for (const id of requiredPacks) if (!packs[id]) errors.push(`${id}: missing pack`);
  for (const [id, pack] of Object.entries(packs)) {
    if (!requiredPacks.includes(id)) errors.push(`${id}: unexpected pack for this checkpoint`);
    if (!pack || typeof pack !== 'object') { errors.push(`${id}: invalid pack entry`); continue; }
    if (!/^roctinam\/aiwg#\d+$/.test(pack.ownerIssue ?? '')) errors.push(`${id}: owning issue is required`);
    if (!Array.isArray(pack.mechanismOwners) || !pack.mechanismOwners.length
      || pack.mechanismOwners.some(owner => typeof owner !== 'string' || !/^B-OG-\d{2}$/.test(owner))) errors.push(`${id}: mechanism owners are required`);
    if (!/^S[0-5]$/.test(pack.slice ?? '')) errors.push(`${id}: owning slice must be S0–S5`);
    for (const field of ['sharedSlices', 'laterSlices']) {
      if (pack[field] !== undefined && (!Array.isArray(pack[field]) || pack[field].some(slice => !/^S[0-5]$/.test(slice))
        || new Set(pack[field]).size !== pack[field].length || pack[field].includes(pack.slice))) errors.push(`${id}: invalid ${field}`);
    }
    if (!['planned', 'partial', 'implemented'].includes(pack.status)) errors.push(`${id}: invalid implementation status`);
    if (!Array.isArray(pack.testFiles)) { errors.push(`${id}: testFiles must be an array`); continue; }
    if (pack.status !== 'planned' && !pack.testFiles.length) errors.push(`${id}: ${pack.status} without test files`);
    for (const file of pack.testFiles) {
      if (typeof file !== 'string' || !/^test\/.+\.(test|spec)\.[cm]?[jt]s$/.test(file)
        || file.split('/').includes('..') || !fs.existsSync(path.join(repositoryRoot, file))
        || !fs.statSync(path.join(repositoryRoot, file)).isFile()) {
        errors.push(`${id}: missing or invalid test file ${file}`);
        continue;
      }
      if (!contents.has(file)) contents.set(file, assertedTests(fs.readFileSync(path.join(repositoryRoot, file), 'utf8'), file));
      if (!contents.get(file).length) errors.push(`${id}: test file ${file} has no runnable asserted tests`);
    }
    errors.push(...scenarioErrors(id, pack, contents));
  }
  errors.push(...qualificationErrors(registry?.qualificationResults), ...qualificationErrors(additionalQualifications));
  return {
    revision: 1, checkpoint: registry?.checkpoint, result: errors.length ? 'failed' : 'wiring-valid',
    releaseQualification: 'unqualified',
    scopes: scopedVerdicts(packs, errors),
    packs, qualificationResults: [...(Array.isArray(registry?.qualificationResults) ? registry.qualificationResults : []), ...(Array.isArray(additionalQualifications) ? additionalQualifications : [])], errors,
  };
}

// Scope verdicts describe registered coverage, never test execution or release acceptance.
function scopedVerdicts(packs, errors) {
  const rows = [];
  for (const [id, pack] of Object.entries(packs)) {
    if (!pack || typeof pack !== 'object') continue;
    rows.push({ id, slice: pack.slice, relationship: 'owner', status: pack.status });
    for (const field of ['sharedSlices', 'laterSlices']) {
      for (const slice of Array.isArray(pack[field]) ? pack[field] : []) {
        rows.push({ id, slice, relationship: field === 'sharedSlices' ? 'shared' : 'later',
          status: field === 'sharedSlices' ? (pack.status === 'planned' ? 'planned' : 'partial') : 'unverified' });
      }
    }
  }
  const scope = slices => {
    const selected = rows.filter(row => slices.includes(row.slice));
    const scopedErrors = errors.filter(error => !/^T-OG-\d+:/.test(error) || selected.some(row => error.startsWith(`${row.id}:`))
      || !rows.some(row => error.startsWith(`${row.id}:`)));
    return { slices, result: scopedErrors.length ? 'failed' : !selected.length ? 'unverified'
      : selected.every(row => row.status === 'implemented') ? 'implemented'
        : selected.some(row => ['partial', 'implemented'].includes(row.status)) ? 'partial' : 'unverified',
    enforcement: 'registry-wiring', acceptance: 'unverified', packs: selected, errors: scopedErrors };
  };
  return { s1: scope(['S0', 'S1']), managed: scope(['S2', 'S3', 'S4', 'S5']),
    laterSlices: Object.fromEntries(['S2', 'S3', 'S4', 'S5'].map(slice => [slice, scope([slice])])),
    s5Audit: { result: 'unverified', enforcement: 'not-enforced', dependsOn: ['S1', 'S2', 'S3', 'S4'] } };
}

export function runPackGate({ repositoryRoot = root, qualificationReport } = {}) {
  const registry = loadOrchestrationPackRegistry(repositoryRoot);
  const additional = qualificationReport ? JSON.parse(fs.readFileSync(qualificationReport, 'utf8')).results : [];
  const report = inspectPackRegistry(registry, repositoryRoot, additional);
  const destination = path.join(repositoryRoot, 'test-results/orchestration-pack-registry.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) {
    console.error(report.errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Orchestration ${report.checkpoint}: ${Object.keys(report.packs).length} packs registered; S1 ${report.scopes.s1.result}; managed ${report.scopes.managed.result}; release qualification remains unqualified`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--qualification-report');
  if (args.length && (index !== 0 || args.length !== 2)) throw new Error('Usage: check-orchestration-packs.mjs [--qualification-report FILE]');
  runPackGate({ qualificationReport: index >= 0 ? args[index + 1] : undefined });
}
