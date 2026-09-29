import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const RAW_FILES = [
  {
    id: 'clinc150-data-full',
    dataset: 'CLINC150',
    url: 'https://raw.githubusercontent.com/clinc/oos-eval/master/data/data_full.json',
    localPath: 'clinc/data_full.json',
    license: 'CC-BY-4.0',
    sha256: '36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0',
  },
  {
    id: 'banking77-train',
    dataset: 'Banking77',
    url: 'https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/train.csv',
    localPath: 'banking/train.csv',
    license: 'CC-BY-4.0',
    sha256: 'b06e26ac675513959a63135f11b94ea7786ed02da65db93a5650d8838cbc664b',
  },
  {
    id: 'banking77-test',
    dataset: 'Banking77',
    url: 'https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/test.csv',
    localPath: 'banking/test.csv',
    license: 'CC-BY-4.0',
    sha256: 'd12d6e3bc4c3103966ae786dc435913c0c563dfa328f5a3646d0e62cfeeb474d',
  },
];

export const SAMPLE_POLICY = {
  seed: 'issue-2613-v2-open-data',
  maxItems: 3000,
  clinc: { trainPerIntent: 5, calibrationPerIntent: 3, finalPerIntent: 3, oosShift: 300 },
  banking: { trainPerIntent: 5, calibrationPerIntent: 3, finalPerIntent: 3, sourceShiftPerIntent: 2 },
};

export function canonical(value) {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}

export function digest(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value);
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

export function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export const orderedRows = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
export const rowHash = rows => digest(orderedRows(rows));

function stableHex(seed, ...parts) {
  return createHash('sha256').update([seed, ...parts].join('\0')).digest('hex');
}

function stableUnit(seed, ...parts) {
  return Number.parseInt(stableHex(seed, ...parts).slice(0, 13), 16) / 0x10000000000000;
}

function stableOrder(seed, rows) {
  return [...rows].sort((a, b) => stableHex(seed, a.sourceId).localeCompare(stableHex(seed, b.sourceId))
    || a.sourceId.localeCompare(b.sourceId));
}

function csvRows(text) {
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') {
      row.push(field); rows.push(row); field = ''; row = [];
    } else if (char !== '\r') field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter(values => values.length === header.length && values.some(Boolean))
    .map(values => Object.fromEntries(header.map((name, index) => [name, values[index]])));
}

function groupByLabel(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function takeByLabel(rows, count, seed, offset = 0) {
  const selected = [];
  for (const [label, members] of [...groupByLabel(rows)].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = stableOrder(`${seed}:${label}`, members);
    if (ordered.length < offset + count) {
      throw new Error(`not enough rows for label ${label}: need ${offset + count}, found ${ordered.length}`);
    }
    selected.push(...ordered.slice(offset, offset + count));
  }
  return selected;
}

function normalizeClinc(raw) {
  const labels = [...new Set([...raw.train, ...raw.val, ...raw.test].map(([, label]) => label))]
    .filter(label => label !== 'oos').sort((a, b) => a.localeCompare(b));
  const allLabels = [...labels, 'oos'];
  const make = (split, rows) => rows.map(([text, label], index) => ({
    sourceDataset: 'CLINC150',
    canonicalSplit: split,
    sourceId: `${split}:${index}`,
    text,
    label,
    labelIndex: allLabels.indexOf(label),
    task: 'clinc150-intent-choice',
  }));
  return {
    labels: allLabels,
    train: make('train', raw.train),
    calibration: make('val', raw.val),
    final: make('test', raw.test),
    oosShift: make('oos_test', raw.oos_test),
  };
}

function normalizeBanking(trainText, testText) {
  const trainCsv = csvRows(trainText);
  const testCsv = csvRows(testText);
  const labels = [...new Set([...trainCsv, ...testCsv].map(row => row.category))].sort((a, b) => a.localeCompare(b));
  const make = (split, rows) => rows.map((row, index) => ({
    sourceDataset: 'Banking77',
    canonicalSplit: split,
    sourceId: `${split}:${index}`,
    text: row.text,
    label: row.category,
    labelIndex: labels.indexOf(row.category),
    task: 'banking77-intent-choice',
  }));
  return { labels, train: make('train.csv', trainCsv), test: make('test.csv', testCsv) };
}

function sampleRows(rows, split, seed, count, offset = 0) {
  return orderedRows(takeByLabel(rows, count, seed, offset).map(row => ({
    id: `${row.task}/${split}/${row.sourceId}`,
    task: row.task,
    sourceDataset: row.sourceDataset,
    canonicalSplit: row.canonicalSplit,
    sourceId: row.sourceId,
    split,
    text: row.text,
    label: row.label,
    labelIndex: row.labelIndex,
    slice: row.sourceDataset === 'CLINC150' && row.label === 'oos' ? 'controlled-oos'
      : split === 'shift' ? 'source-separated' : 'nominal',
  })));
}

function fixedCount(rows, split, seed, count) {
  return orderedRows(stableOrder(seed, rows).slice(0, count).map(row => ({
    id: `${row.task}/${split}/${row.sourceId}`,
    task: row.task,
    sourceDataset: row.sourceDataset,
    canonicalSplit: row.canonicalSplit,
    sourceId: row.sourceId,
    split,
    text: row.text,
    label: row.label,
    labelIndex: row.labelIndex,
    slice: 'controlled-oos',
  })));
}

export function buildOpenDataFrozen({ clincJson, bankingTrainCsv, bankingTestCsv, sourceFiles, preregistration, retrievalDate }) {
  const clinc = normalizeClinc(JSON.parse(clincJson));
  const banking = normalizeBanking(bankingTrainCsv, bankingTestCsv);
  const splits = {
    train: [
      ...sampleRows(clinc.train, 'train', 'clinc-train', SAMPLE_POLICY.clinc.trainPerIntent),
      ...sampleRows(banking.train, 'train', 'banking-train', SAMPLE_POLICY.banking.trainPerIntent),
    ],
    calibration: [
      ...sampleRows(clinc.calibration, 'calibration', 'clinc-calibration', SAMPLE_POLICY.clinc.calibrationPerIntent),
      ...sampleRows(banking.train, 'calibration', 'banking-train', SAMPLE_POLICY.banking.calibrationPerIntent,
        SAMPLE_POLICY.banking.trainPerIntent),
    ],
    finalTest: [
      ...sampleRows(clinc.final, 'finalTest', 'clinc-final', SAMPLE_POLICY.clinc.finalPerIntent),
      ...sampleRows(banking.test, 'finalTest', 'banking-final', SAMPLE_POLICY.banking.finalPerIntent),
    ],
    shift: [
      ...fixedCount(clinc.oosShift, 'shift', 'clinc-oos-shift', SAMPLE_POLICY.clinc.oosShift),
      ...sampleRows(banking.test, 'shift', 'banking-final', SAMPLE_POLICY.banking.sourceShiftPerIntent,
        SAMPLE_POLICY.banking.finalPerIntent),
    ],
  };
  const allRows = Object.values(splits).flat();
  if (allRows.length > SAMPLE_POLICY.maxItems) throw new Error(`sample exceeds max items ${SAMPLE_POLICY.maxItems}`);
  const ids = new Set();
  for (const row of allRows) {
    const key = `${row.task}/${row.sourceDataset}/${row.sourceId}`;
    if (ids.has(key)) throw new Error(`overlapping source row ${key}`);
    ids.add(key);
  }
  const tasks = {
    'clinc150-intent-choice': {
      primitive: 'choice',
      labels: clinc.labels,
      datasetPopulation: 'CLINC150 in-scope intents plus OOS controlled-shift slice',
      definitionVersion: 'clinc150-intent-choice/v2',
    },
    'banking77-intent-choice': {
      primitive: 'choice',
      labels: banking.labels,
      datasetPopulation: 'Banking77 intent classification with canonical source-separated test file',
      definitionVersion: 'banking77-intent-choice/v2',
    },
  };
  const frozen = {
    schemaVersion: 'conformal-open-data-frozen/v2',
    issue: 2613,
    retrievalDate,
    license: 'CC-BY-4.0',
    preregistrationHash: digest(preregistration),
    samplePolicy: SAMPLE_POLICY,
    sourceFiles,
    tasks,
    splitHashes: Object.fromEntries(Object.entries(splits).map(([name, rows]) => [name, rowHash(rows)])),
    splits: Object.fromEntries(Object.entries(splits).map(([name, rows]) => [name, orderedRows(rows)])),
  };
  return { ...frozen, sampleDigest: digest({ tasks, splitHashes: frozen.splitHashes, splits: frozen.splits }) };
}

export function verifyFrozenOpenData(frozen, preregistration) {
  if (frozen.schemaVersion !== 'conformal-open-data-frozen/v2') throw new Error('wrong frozen schema');
  if (digest(preregistration) !== frozen.preregistrationHash) throw new Error('preregistration changed');
  const seen = new Set();
  for (const [split, rows] of Object.entries(frozen.splits)) {
    if (rowHash(rows) !== frozen.splitHashes[split]) throw new Error(`split hash mismatch: ${split}`);
    for (const row of rows) {
      const task = frozen.tasks[row.task];
      if (!task || task.primitive !== 'choice') throw new Error('unknown task');
      if (task.labels[row.labelIndex] !== row.label) throw new Error('label index mismatch');
      const key = `${row.task}/${row.sourceDataset}/${row.sourceId}`;
      if (seen.has(key)) throw new Error(`overlapping source row ${key}`);
      seen.add(key);
      if (typeof row.text !== 'string' || !row.text.trim()) throw new Error('empty text');
    }
  }
  if (Object.values(frozen.splits).flat().length > frozen.samplePolicy.maxItems) throw new Error('sample exceeds manifest max');
  const { tasks, splitHashes, splits } = frozen;
  if (digest({ tasks, splitHashes, splits }) !== frozen.sampleDigest) throw new Error('sample digest mismatch');
}

export function syntheticChoiceDistribution(row, task) {
  const n = task.labels.length;
  const truth = row.labelIndex;
  const values = Array.from({ length: n }, () => 0);
  const u = stableUnit('synthetic-scores-v2', row.id);
  const wrong = (truth + 1 + Math.floor(stableUnit('synthetic-wrong-v2', row.id) * (n - 1))) % n;
  let trueP;
  if (row.slice === 'controlled-oos') trueP = 0.04;
  else if (row.slice === 'source-separated') trueP = u < 0.55 ? 0.62 : u < 0.85 ? 0.42 : 0.18;
  else trueP = u < 0.72 ? 0.84 : u < 0.92 ? 0.48 : 0.24;
  values[truth] = trueP;
  if (row.slice === 'controlled-oos') values[wrong] = 0.78;
  else if (trueP < 0.5) values[wrong] = Math.min(0.56, 1 - trueP);
  const remaining = 1 - values.reduce((sum, value) => sum + value, 0);
  const recipients = values.map((value, index) => ({ value, index })).filter(item => item.value === 0);
  for (const item of recipients) values[item.index] = remaining / recipients.length;
  const rounded = values.map(value => Number(value.toFixed(8)));
  rounded[rounded.length - 1] = Number((rounded[rounded.length - 1] + (1 - rounded.reduce((sum, value) => sum + value, 0))).toFixed(8));
  return rounded;
}

export function quantile(scores, alpha) {
  if (!(alpha > 0 && alpha < 1) || !scores.length || scores.some(score => !Number.isFinite(score) || score < 0 || score > 1)) {
    throw new Error('invalid calibration scores');
  }
  const rank = Math.ceil((scores.length + 1) * (1 - alpha));
  return rank > scores.length ? Infinity : [...scores].sort((a, b) => a - b)[rank - 1];
}

export const predictionSet = (probabilities, q) => probabilities.flatMap((probability, index) => 1 - probability <= q ? [index] : []);
export const topIndex = probabilities => probabilities.indexOf(Math.max(...probabilities));

export function fitConformalProfile(rows, frozen, taskId, alpha, codeVersion) {
  const task = frozen.tasks[taskId];
  const calibration = rows.map(row => {
    const probabilities = syntheticChoiceDistribution(row, task);
    return 1 - probabilities[row.labelIndex];
  });
  return {
    schemaVersion: 'conformal-derived-profile/v2',
    compatibility: {
      servedModel: 'synthetic-score-stand-in/v2',
      primitive: task.primitive,
      definition: digest({ taskId, task }),
      adapter: 'synthetic-open-data/v2',
      datasetPopulation: task.datasetPopulation,
      method: 'lac-v1',
      calibrationSplit: rowHash(rows),
      codeVersion,
      alpha,
    },
    q: quantile(calibration, alpha),
  };
}

export function wilson(k, n) {
  if (!n) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { lower: c - h, upper: c + h };
}

export function metrics(scored) {
  const n = scored.length;
  const sizes = scored.map(row => row.set.length).sort((a, b) => a - b);
  const covered = scored.filter(row => row.set.includes(row.labelIndex)).length;
  const singletons = scored.filter(row => row.set.length === 1);
  const wrongSingletons = singletons.filter(row => row.set[0] !== row.labelIndex).length;
  return {
    n,
    supported: n >= 50,
    coverage: n ? covered / n : null,
    coverage95: wilson(covered, n),
    meanSetSize: n ? sizes.reduce((sum, size) => sum + size, 0) / n : null,
    p50: n ? sizes[Math.ceil(n * 0.50) - 1] : null,
    p90: n ? sizes[Math.ceil(n * 0.90) - 1] : null,
    p95: n ? sizes[Math.ceil(n * 0.95) - 1] : null,
    reviewRate: n ? 1 - singletons.length / n : null,
    reviewCostUnits: n - singletons.length,
    selectiveRisk: singletons.length ? wrongSingletons / singletons.length : null,
    selectiveRisk95: wilson(wrongSingletons, singletons.length),
    falseAutoRate: n ? wrongSingletons / n : null,
    acceptedN: singletons.length,
  };
}
