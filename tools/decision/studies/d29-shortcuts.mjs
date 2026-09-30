const LIMITS = { injection: 0.75, readiness: 0.75, supports: 0.80, contradicts: 0.80, unclear: 0.80, 'does-not-support': 0.80 };
const tokenize = text => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const compare = (a, b) => b.balancedAccuracy - a.balancedAccuracy || a.target.localeCompare(b.target)
  || a.view.localeCompare(b.view) || a.feature.localeCompare(b.feature);

/** Exhaustive one-feature, both-polarity audit; final-test text is never inspected. */
export function shortcutAudit(corpus, gold) {
  const labels = new Map(gold.rows.map(row => [row.id, row]));
  const rows = corpus.rows.filter(row => row.split === 'tuning' || row.split === 'calibration')
    .map(row => ({ payload: row.input.payload, ...labels.get(row.id) }));
  const targets = [];
  for (const [target, limit] of Object.entries(LIMITS)) {
    const support = !['injection', 'readiness'].includes(target);
    const members = rows.filter(row => !support || row.gold.support !== null);
    const truth = members.map(row => target === 'injection' ? row.world.injected : target === 'readiness' ? row.gold.ready : row.gold.support === target);
    const positives = truth.filter(Boolean).length, negatives = members.length - positives;
    if (!positives || !negatives) throw new Error('shortcut-audit-support');
    const rules = [];
    for (const view of ['passage', 'passage-and-context', 'context']) {
      const texts = members.map(({ payload }) => view === 'context' ? payload.context ?? ''
        : `${payload.source ?? payload.evidence}${view === 'passage-and-context' ? ` ${payload.context ?? ''}` : ''}`);
      const tokens = texts.map(tokenize), vocabulary = new Map();
      for (const entry of tokens) for (const token of entry) vocabulary.set(token, (vocabulary.get(token) ?? 0) + 1);
      const measure = (feature, predictions) => {
        let tp = 0, tn = 0;
        predictions.forEach((prediction, i) => { if (prediction && truth[i]) tp++; if (!prediction && !truth[i]) tn++; });
        const score = (tp / positives + tn / negatives) / 2;
        rules.push({ target, view, feature, polarity: score >= 0.5 ? 'present' : 'absent', balancedAccuracy: Math.max(score, 1 - score) });
      };
      for (const [token, n] of [...vocabulary].sort(([a], [b]) => a.localeCompare(b))) {
        if (n / members.length >= 0.02) measure(`token:${token}`, tokens.map(entry => entry.has(token)));
      }
      for (const [name, pattern] of [['colon', /:/], ['quotes', /['"“”‘’]/], ['brackets', /[\[\](){}<>]/]]) {
        measure(`punctuation:${name}`, texts.map(text => pattern.test(text)));
      }
      const counts = texts.map(text => (text.match(/[.!?](?=\s|$)/g) ?? []).length), lengths = texts.map(text => text.length);
      for (const count of [...new Set(counts)].sort((a, b) => a - b)) {
        measure(`sentences=${count}`, counts.map(value => value === count));
        measure(`sentences<=${count}`, counts.map(value => value <= count));
      }
      for (const length of [...new Set(lengths)].sort((a, b) => a - b)) measure(`characters<=${length}`, lengths.map(value => value <= length));
    }
    rules.sort(compare);
    targets.push({ target, positives, negatives, limit, featureCount: rules.length, maximumBalancedAccuracy: rules[0].balancedAccuracy, topRules: rules.slice(0, 10) });
  }
  return { schemaVersion: 'decision-d29-shortcut-audit/v1', splits: ['tuning', 'calibration'], n: rows.length,
    targets, topRules: targets.flatMap(target => target.topRules).sort(compare).slice(0, 10),
    passed: targets.every(target => target.maximumBalancedAccuracy <= target.limit) };
}
