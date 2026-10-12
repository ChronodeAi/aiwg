#!/usr/bin/env node
// Fixity manifests and W3C PROV records for archived open-weight model directories (#2554).
//
// Matches the media-curator conventions the archivist agent reuses: the
// self-verifying `CHECKSUMS.sha256` shape from `integrity-verification` /
// `verify-archive`, and the PROV-O + PREMIS `PROVENANCE.jsonld` shape from
// `provenance-tracking`. Shards are hashed as streams; multi-gigabyte
// safetensors never load into memory.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const CHECKSUM_FILE = 'CHECKSUMS.sha256';
export const PROVENANCE_FILE = 'PROVENANCE.jsonld';
export const MANIFEST_HASH_PREFIX = '# MANIFEST_HASH: ';
export const MANIFEST_HEADER_LINES = 3;
const MANIFEST_FILES = new Set([CHECKSUM_FILE, PROVENANCE_FILE]);

/** Required inputs for a model's PROV record; every archived model must supply all of them. */
export const PROVENANCE_REQUIRED_FIELDS = Object.freeze([
  'modelId', 'revision', 'precision', 'parameterCount', 'license', 'sourceUrl', 'archivePath',
]);

function toPosix(path) {
  return path.split(sep).join('/');
}

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Sorted, POSIX-relative paths of every archive file except the manifests themselves. */
export function listArchiveFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !(current === dir && MANIFEST_FILES.has(entry.name))) files.push(toPosix(relative(dir, full)));
    }
  };
  walk(dir);
  return files.sort();
}

export function renderFixityManifest({ entries, manifestHash, generatedAt }) {
  return [
    `${MANIFEST_HASH_PREFIX}${manifestHash}`,
    `# Generated: ${generatedAt}`,
    `# Verify with: tail -n +${MANIFEST_HEADER_LINES + 1} ${CHECKSUM_FILE} | sha256sum`,
    ...entries.map(entry => `${entry.sha256}  ./${entry.path}`),
    '',
  ].join('\n');
}

/** Hash every archive file and write `CHECKSUMS.sha256` beside them. */
export async function buildFixityManifest(dir, { now = new Date() } = {}) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Archive directory not found: ${dir}`);
  const entries = [];
  for (const path of listArchiveFiles(dir)) {
    const full = join(dir, path);
    entries.push({ path, sha256: await hashFile(full), size: statSync(full).size });
  }
  if (entries.length === 0) throw new Error(`Archive directory has no files to hash: ${dir}`);
  const body = `${entries.map(entry => `${entry.sha256}  ./${entry.path}`).join('\n')}\n`;
  const manifest = { entries, manifestHash: hashText(body), generatedAt: now.toISOString() };
  writeFileSync(join(dir, CHECKSUM_FILE), renderFixityManifest(manifest));
  return manifest;
}

export function parseFixityManifest(text) {
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith(MANIFEST_HASH_PREFIX)) throw new Error(`${CHECKSUM_FILE} is missing its MANIFEST_HASH header`);
  const manifestHash = first.slice(MANIFEST_HASH_PREFIX.length).trim();
  const generatedAt = (lines[1] ?? '').replace(/^# Generated:\s*/, '').trim();
  const bodyLines = lines.slice(MANIFEST_HEADER_LINES);
  const body = bodyLines.join('\n');
  const entries = [];
  for (const line of bodyLines) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64})\s{2}\.\/(.+)$/.exec(line);
    if (!match) throw new Error(`Unparseable manifest line: ${line}`);
    entries.push({ sha256: match[1], path: match[2] });
  }
  return { manifestHash, generatedAt, entries, bodyHash: hashText(body) };
}

/**
 * Verify an archive against its manifest. A tampered manifest, a missing
 * shard, or a corrupted shard each fails the pass; files present on disk but
 * absent from the manifest are reported without failing it.
 */
export async function verifyFixityManifest(dir) {
  const result = { ok: false, manifestIntact: false, verified: 0, missing: [], corrupted: [], extra: [], errors: [] };
  const manifestPath = join(dir, CHECKSUM_FILE);
  if (!existsSync(manifestPath)) {
    result.errors.push(`${CHECKSUM_FILE} not found in ${dir}`);
    return result;
  }
  let manifest;
  try {
    manifest = parseFixityManifest(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    result.errors.push(error.message);
    return result;
  }
  result.manifestIntact = manifest.bodyHash === manifest.manifestHash;
  if (!result.manifestIntact) result.errors.push('manifest body hash does not match its MANIFEST_HASH header (manifest edited or truncated)');
  const listed = new Set();
  for (const entry of manifest.entries) {
    listed.add(entry.path);
    const full = join(dir, entry.path);
    if (!existsSync(full)) {
      result.missing.push(entry.path);
      continue;
    }
    const actual = await hashFile(full);
    if (actual === entry.sha256) result.verified += 1;
    else result.corrupted.push({ path: entry.path, expected: entry.sha256, actual });
  }
  result.extra = listArchiveFiles(dir).filter(path => !listed.has(path));
  result.ok = result.manifestIntact && result.missing.length === 0 && result.corrupted.length === 0 && result.errors.length === 0;
  return result;
}

/** Build the PROV-O + PREMIS record for one archived model. */
export function buildProvenanceRecord(spec) {
  const missing = PROVENANCE_REQUIRED_FIELDS.filter(field => spec?.[field] === undefined || spec[field] === null || spec[field] === '');
  if (missing.length) throw new Error(`Provenance record is missing required fields: ${missing.join(', ')}`);
  if (!spec.fixity || !/^[0-9a-f]{64}$/.test(spec.fixity.manifestHash ?? '')) {
    throw new Error('Provenance record requires fixity.manifestHash from buildFixityManifest()');
  }
  const slug = String(spec.modelId).replace(/[^A-Za-z0-9._-]+/g, '_');
  const agentName = spec.agent?.name ?? 'llm-model-archivist';
  const endedAt = spec.endedAt ?? spec.fixity.generatedAt ?? new Date().toISOString();
  return {
    '@context': {
      prov: 'http://www.w3.org/ns/prov#',
      schema: 'http://schema.org/',
      premis: 'http://www.loc.gov/premis/rdf/v3/',
      dc: 'http://purl.org/dc/terms/',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
    },
    '@graph': [
      {
        '@id': `urn:archive:entity:model:${slug}:${spec.revision}`,
        '@type': 'prov:Collection',
        'dc:title': `${spec.modelId} @ ${spec.revision} (${spec.precision})`,
        'dc:license': spec.license,
        'schema:identifier': spec.modelId,
        'schema:version': spec.revision,
        'schema:encodingFormat': spec.precision,
        'schema:size': String(spec.parameterCount),
        'schema:contentLocation': spec.archivePath,
        'prov:generatedAtTime': endedAt,
        'prov:wasDerivedFrom': { '@id': `urn:archive:entity:source:${slug}:${spec.revision}` },
        'premis:hasFixity': {
          '@type': 'premis:Fixity',
          'premis:messageDigestAlgorithm': { '@id': 'http://id.loc.gov/vocabulary/preservation/cryptographicHashFunctions/sha256' },
          'premis:messageDigestOriginator': `${agentName} (tools/media-curator/llm-model-archive.mjs)`,
          'premis:messageDigest': spec.fixity.manifestHash,
          'schema:url': CHECKSUM_FILE,
          'schema:numberOfItems': spec.fixity.fileCount ?? spec.fixity.entries?.length ?? 0,
        },
      },
      {
        '@id': `urn:archive:entity:source:${slug}:${spec.revision}`,
        '@type': 'prov:Entity',
        'schema:url': spec.sourceUrl,
        'schema:identifier': spec.modelId,
        'schema:version': spec.revision,
        ...(spec.downloads ? { 'schema:interactionStatistic': { 'schema:interactionType': 'schema:DownloadAction', 'schema:userInteractionCount': spec.downloads.count, 'schema:observationDate': spec.downloads.capturedAt } } : {}),
      },
      {
        '@id': `urn:archive:activity:archive:${slug}:${spec.revision}`,
        '@type': 'prov:Activity',
        'prov:startedAtTime': spec.startedAt ?? endedAt,
        'prov:endedAtTime': endedAt,
        'prov:used': { '@id': `urn:archive:entity:source:${slug}:${spec.revision}` },
        'prov:generated': { '@id': `urn:archive:entity:model:${slug}:${spec.revision}` },
        'prov:wasAssociatedWith': { '@id': `urn:archive:agent:${agentName}` },
      },
      {
        '@id': `urn:archive:agent:${agentName}`,
        '@type': ['prov:SoftwareAgent', 'prov:Agent'],
        'schema:name': agentName,
        ...(spec.agent?.version ? { 'schema:softwareVersion': spec.agent.version } : {}),
        'schema:description': 'AIWG media-curator LLM model archivist',
      },
    ],
  };
}

export function writeProvenanceRecord(dir, record) {
  const path = join(dir, PROVENANCE_FILE);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function usage() {
  return [
    'Usage:',
    '  llm-model-archive.mjs fixity write <dir>',
    '  llm-model-archive.mjs fixity verify <dir>',
    '  llm-model-archive.mjs provenance write <dir> --spec <spec.json>',
  ].join('\n');
}

export async function runCli(argv = process.argv.slice(2)) {
  const [group, verb, dir, ...rest] = argv;
  if (group === 'fixity' && verb === 'write' && dir) {
    const manifest = await buildFixityManifest(dir);
    console.log(`wrote ${CHECKSUM_FILE}: ${manifest.entries.length} files, manifest hash ${manifest.manifestHash}`);
    return 0;
  }
  if (group === 'fixity' && verb === 'verify' && dir) {
    const result = await verifyFixityManifest(dir);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (group === 'provenance' && verb === 'write' && dir) {
    const specIndex = rest.indexOf('--spec');
    if (specIndex < 0 || !rest[specIndex + 1]) throw new Error('provenance write requires --spec <spec.json>');
    const spec = JSON.parse(readFileSync(rest[specIndex + 1], 'utf8'));
    if (!spec.fixity) spec.fixity = parseFixityManifest(readFileSync(join(dir, CHECKSUM_FILE), 'utf8'));
    if (spec.fixity.fileCount === undefined) spec.fixity.fileCount = spec.fixity.entries?.length ?? 0;
    console.log(`wrote ${writeProvenanceRecord(dir, buildProvenanceRecord(spec))}`);
    return 0;
  }
  console.error(usage());
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then(code => { process.exitCode = code; }, error => { console.error(`llm-model-archive: ${error.message}`); process.exitCode = 1; });
}
