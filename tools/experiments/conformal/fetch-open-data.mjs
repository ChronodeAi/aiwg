import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RAW_FILES,
  buildOpenDataFrozen,
  digest,
  fileSha256,
} from './open-data.mjs';

const args = new Map();
const flags = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    args.set(value, process.argv[index + 1]);
    index += 1;
  } else flags.add(value);
}

const rawDir = args.get('--raw-dir') ?? '/tmp/aiwg-2613-open-data';
const output = args.get('--output') ?? new URL('./frozen.v2.json', import.meta.url).pathname;
const retrievalDate = args.get('--retrieval-date') ?? new Date().toISOString().slice(0, 10);
// --offline re-verifies previously downloaded raw and licence files instead of fetching them again.
const offline = flags.has('--offline');
const preregistration = JSON.parse(readFileSync(new URL('./preregister.v2.json', import.meta.url), 'utf8'));

async function fetchVerified(url, localPath, sha256, id) {
  const target = join(rawDir, localPath);
  if (!offline) {
    mkdirSync(dirname(target), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`download failed for ${id}: ${response.status}`);
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  } else if (!existsSync(target)) throw new Error(`--offline requires ${target}`);
  const actual = fileSha256(target);
  if (actual !== sha256) throw new Error(`sha256 mismatch for ${id}: ${actual}`);
  return target;
}

async function download(file) {
  const target = await fetchVerified(file.url, file.localPath, file.sha256, file.id);
  await fetchVerified(file.licenseUrl, file.licenseLocalPath, file.licenseSha256, `${file.id} licence`);
  return {
    id: file.id,
    dataset: file.dataset,
    url: file.url,
    license: file.license,
    licenseUrl: file.licenseUrl,
    licenseSha256: file.licenseSha256,
    retrievalDate,
    sha256: file.sha256,
    bytes: readFileSync(target).byteLength,
  };
}

const sourceFiles = [];
for (const file of RAW_FILES) sourceFiles.push(await download(file));

const frozen = buildOpenDataFrozen({
  clincJson: readFileSync(join(rawDir, 'clinc/data_full.json'), 'utf8'),
  bankingTrainCsv: readFileSync(join(rawDir, 'banking/train.csv'), 'utf8'),
  bankingTestCsv: readFileSync(join(rawDir, 'banking/test.csv'), 'utf8'),
  sourceFiles,
  preregistration,
  retrievalDate,
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(frozen)}\n`);
console.log(JSON.stringify({
  output,
  preregistrationHash: digest(preregistration),
  sampleDigest: frozen.sampleDigest,
  splitHashes: frozen.splitHashes,
  liveSubsetHashes: frozen.liveSubsets.hashes,
  rows: Object.fromEntries(Object.entries(frozen.splits).map(([name, rows]) => [name, rows.length])),
}, null, 2));
