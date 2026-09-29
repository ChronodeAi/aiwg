import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RAW_FILES,
  buildOpenDataFrozen,
  digest,
  fileSha256,
} from './open-data.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);

const rawDir = args.get('--raw-dir') ?? '/tmp/aiwg-2613-open-data';
const output = args.get('--output') ?? new URL('./frozen.v2.json', import.meta.url).pathname;
const retrievalDate = args.get('--retrieval-date') ?? new Date().toISOString().slice(0, 10);
const preregistration = JSON.parse(readFileSync(new URL('./preregister.v2.json', import.meta.url), 'utf8'));

async function download(file) {
  const target = join(rawDir, file.localPath);
  mkdirSync(dirname(target), { recursive: true });
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`download failed for ${file.id}: ${response.status}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  const actual = fileSha256(target);
  if (actual !== file.sha256) throw new Error(`sha256 mismatch for ${file.id}: ${actual}`);
  return {
    id: file.id,
    dataset: file.dataset,
    url: file.url,
    license: file.license,
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
writeFileSync(output, `${JSON.stringify(frozen, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  preregistrationHash: digest(preregistration),
  sampleDigest: frozen.sampleDigest,
  splitHashes: frozen.splitHashes,
  rows: Object.fromEntries(Object.entries(frozen.splits).map(([name, rows]) => [name, rows.length])),
}, null, 2));
