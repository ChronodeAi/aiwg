/**
 * D12 live qualification workload (#2686): seeded, labelled, synthetic-only tasks for the
 * three graph patterns, plus the per-task decision definitions both arms ask Jev.
 * Generation is pure and deterministic; the frozen copy is digest-pinned in
 * docs/decision/evidence/dag-live-v1/. No customer or personal data is used.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import { artifactPin, validateDefinition } from './validate.js';
import type { DecisionDefinition } from './types.js';

export type DagLivePattern = 'shortlist-rerank' | 'taxonomy-beam' | 'extractor-verifier-fallback';
export const DAG_LIVE_PATTERNS: readonly DagLivePattern[] = ['shortlist-rerank', 'taxonomy-beam', 'extractor-verifier-fallback'];
export const dagLiveDigest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

export interface DagLiveTask {
  id: string; pattern: DagLivePattern; slice: string; label: string;
  /** Model-visible synthetic subject. The label is never part of it. */
  subject: Record<string, unknown>;
}
export interface DagLiveWorkload {
  schemaVersion: 'dag-live-workload/v1'; issue: '#2686'; syntheticOnly: true;
  generator: 'lcg-1664525-1013904223/v1'; seed: number; tasksPerPattern: number; tasks: DagLiveTask[];
}

// Same deterministic generator as the offline graph benchmark and property suites.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
}
const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
function shuffle<T>(next: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
  return copy;
}

type Item = { id: string; name: string; cues: readonly [string, string] };
/** Fictional office-supply catalog. Each item has two paraphrased needs. */
const CATALOG: Record<string, { name: string; items: readonly Item[] }> = {
  writing: { name: 'Writing instruments', items: [
    { id: 'ballpoint-pen', name: 'Ballpoint pen', cues: ['a cheap pen with quick-drying ink for signing forms', 'something with a rolling ball tip for everyday writing'] },
    { id: 'pencil', name: 'Graphite pencil', cues: ['something whose marks I can erase later', 'a wooden graphite stick for sketching'] },
    { id: 'highlighter', name: 'Highlighter', cues: ['something to mark key sentences in bright translucent yellow', 'a fluorescent marker for emphasising printed text'] },
    { id: 'fountain-pen', name: 'Fountain pen', cues: ['a refillable nib pen for calligraphy practice', 'a pen that draws bottled ink through a nib'] },
    { id: 'permanent-marker', name: 'Permanent marker', cues: ['something to label plastic boxes that will not wash off', 'a thick waterproof marker for cardboard'] },
  ] },
  paper: { name: 'Paper products', items: [
    { id: 'sticky-notes', name: 'Sticky notes', cues: ['small adhesive squares for reminders on a monitor', 'repositionable notes I can move around a whiteboard'] },
    { id: 'legal-pad', name: 'Legal pad', cues: ['a yellow ruled pad for meeting notes', 'a tear-off pad with long ruled sheets'] },
    { id: 'printer-paper', name: 'Printer paper', cues: ['a ream of plain sheets for the office printer', 'blank letter-size sheets for the copier'] },
    { id: 'index-cards', name: 'Index cards', cues: ['small stiff cards for flash cards', 'cards sized for a recipe box'] },
    { id: 'notebook', name: 'Spiral notebook', cues: ['a bound book for daily class notes', 'a wire-bound book of lined pages'] },
  ] },
  desk: { name: 'Desk tools', items: [
    { id: 'stapler', name: 'Stapler', cues: ['something to fasten a stack of pages with metal', 'a device that joins sheets permanently at the corner'] },
    { id: 'tape-dispenser', name: 'Tape dispenser', cues: ['a weighted holder for clear adhesive tape', 'something to tear off tape strips one-handed'] },
    { id: 'scissors', name: 'Scissors', cues: ['a tool with two blades to cut paper shapes', 'something to trim ribbon and string'] },
    { id: 'paper-clips', name: 'Paper clips', cues: ['small wire fasteners that hold sheets without puncturing them', 'reusable bent-wire clips for temporary bundles'] },
    { id: 'hole-punch', name: 'Hole punch', cues: ['a tool that makes holes for a ring binder', 'something to perforate pages before filing them'] },
  ] },
  storage: { name: 'Filing and storage', items: [
    { id: 'ring-binder', name: 'Ring binder', cues: ['a cover with metal rings to hold punched pages', 'a folder that opens rings to insert sheets'] },
    { id: 'file-folder', name: 'File folder', cues: ['a manila sleeve with a tab for a filing cabinet', 'a folded card holder labelled on its tab'] },
    { id: 'archive-box', name: 'Archive box', cues: ['a lidded cardboard box for storing old records', 'a sturdy box to move years of paperwork to the basement'] },
    { id: 'desk-organizer', name: 'Desk organizer', cues: ['a tray with compartments to tidy loose supplies', 'a caddy that keeps pens and clips sorted on the desk'] },
    { id: 'label-maker', name: 'Label maker', cues: ['a handheld device that prints adhesive name strips', 'something to print neat labels for shelves'] },
  ] },
};
const REQUEST_PREFIX = ['I am looking for', 'Please find me', 'Our team needs', 'Can you suggest', 'We want to order'];

function shortlistTask(index: number, seed: number): DagLiveTask {
  const next = random(seed + index * 7_919);
  const [first, second, ...others] = shuffle(next, Object.keys(CATALOG));
  const sections = [first!, second!].map((category, s) => {
    const all = CATALOG[category]!.items;
    const dropped = Math.floor(next() * all.length);
    return { category, dropped: all[dropped]!, items: all.filter((_, i) => i !== dropped),
      view: { id: `section-${s + 1}`, name: CATALOG[category]!.name } };
  });
  const none = next() < 0.2;
  let target: Item; let label: string; let slice: string;
  if (none) {
    // Near misses: an item dropped from a shown section, or one from a hidden category.
    target = next() < 0.5 ? pick(next, sections).dropped : pick(next, CATALOG[pick(next, others)]!.items);
    label = 'none'; slice = 'no-match';
  } else {
    const section = pick(next, sections);
    target = pick(next, section.items); label = target.id; slice = 'match';
  }
  const request = `${pick(next, REQUEST_PREFIX)} ${target.cues[next() < 0.5 ? 0 : 1]}.`;
  return { id: `sr-${String(index + 1).padStart(3, '0')}`, pattern: 'shortlist-rerank', slice, label,
    subject: { request, sections: sections.map(s => ({ ...s.view, items: s.items.map(item => ({ id: item.id, name: item.name })) })) } };
}

type Leaf = { id: string; name: string; cues: readonly string[] };
/** Fixed two-level support taxonomy: two branches of five leaves each. */
export const DAG_LIVE_TAXONOMY: Readonly<Record<'branch-a' | 'branch-b', { name: string; leaves: readonly Leaf[] }>> = {
  'branch-a': { name: 'Billing and account', leaves: [
    { id: 'refund-request', name: 'Refund request', cues: ['wants their money back for an order they cancelled', 'asks to reverse a charge for an unused subscription month', 'requests reimbursement after returning a damaged item'] },
    { id: 'invoice-copy', name: 'Invoice copy', cues: ['needs a PDF copy of last month\'s invoice for accounting', 'asks for the billing statement to be re-sent with a VAT number', 'wants an itemised receipt for an expense report'] },
    { id: 'payment-failure', name: 'Payment failure', cues: ['reports that their card was declined at checkout', 'says the automatic renewal payment did not go through', 'sees a payment error when paying the latest bill'] },
    { id: 'plan-upgrade', name: 'Plan upgrade', cues: ['wants to move from the basic plan to the team plan', 'asks how to add more seats to the subscription', 'would like the premium tier with more storage'] },
    { id: 'account-closure', name: 'Account closure', cues: ['wants to permanently delete their account', 'asks to cancel everything and close the profile', 'requests that the organisation account be shut down'] },
  ] },
  'branch-b': { name: 'Technical support', leaves: [
    { id: 'login-problem', name: 'Login problem', cues: ['cannot sign in even after resetting the password', 'is locked out after too many sign-in attempts', 'never receives the two-factor code when logging in'] },
    { id: 'data-export', name: 'Data export', cues: ['wants to download all project data as CSV', 'asks how to export their records to a spreadsheet', 'needs a full backup file of the workspace'] },
    { id: 'performance-slowness', name: 'Performance slowness', cues: ['says the dashboard takes a minute to load', 'reports that searches have become very slow', 'notices pages freezing when opening large reports'] },
    { id: 'integration-error', name: 'Integration error', cues: ['sees webhook deliveries failing with errors', 'reports that the calendar sync stopped working', 'gets an API authentication error from their connector'] },
    { id: 'mobile-app-crash', name: 'Mobile app crash', cues: ['says the phone app closes immediately on launch', 'reports the tablet app crashing when uploading a photo', 'finds the mobile app quits when opening notifications'] },
  ] },
};
type Branch = keyof typeof DAG_LIVE_TAXONOMY;
const PRODUCTS = ['Planner Pro', 'TaskBoard', 'Ledgerly', 'NoteNest', 'ShipTrack'];
const OPENERS = ['Hello team,', 'Hi support,', 'Good morning,', 'Hey there,'];
// Neutral context sentences that mention another topic without being the request.
const ASIDES = ['Earlier this year I also updated my billing address, which went fine.', 'The mobile app has been working well otherwise.',
  'We exported a report last week without trouble.', 'My colleague upgraded their own plan and had no issues.'];

function taxonomyTask(index: number, seed: number): DagLiveTask {
  const next = random(seed + 104_729 + index * 7_919);
  const branch = pick(next, ['branch-a', 'branch-b'] as Branch[]);
  const leaf = pick(next, DAG_LIVE_TAXONOMY[branch].leaves);
  const aside = next() < 0.3;
  const reference = `${String.fromCharCode(65 + Math.floor(next() * 26))}-${10_000 + Math.floor(next() * 90_000)}`;
  const text = `${pick(next, OPENERS)} the customer on ticket ${reference} using ${pick(next, PRODUCTS)} ${pick(next, leaf.cues)}.`
    + (aside ? ` ${pick(next, ASIDES)}` : '');
  return { id: `tb-${String(index + 1).padStart(3, '0')}`, pattern: 'taxonomy-beam', slice: aside ? `${branch}-aside` : branch,
    label: leaf.id, subject: { ticket: text } };
}

export const DAG_LIVE_STATUSES = [
  { id: 'delivered', name: 'Delivered', cue: 'was handed to the recipient and signed for' },
  { id: 'in-transit', name: 'In transit', cue: 'left the regional hub and is on the way' },
  { id: 'delayed', name: 'Delayed', cue: 'is held up by a missed connection and will arrive later than planned' },
  { id: 'returned', name: 'Returned to sender', cue: 'was refused at the door and is going back to the sender' },
  { id: 'lost', name: 'Lost', cue: 'cannot be located after a warehouse search and has been declared lost' },
  { id: 'awaiting-pickup', name: 'Awaiting pickup', cue: 'is waiting at the parcel locker for the recipient to collect it' },
] as const;

function extractorTask(index: number, seed: number): DagLiveTask {
  const next = random(seed + 1_299_709 + index * 7_919);
  const status = pick(next, DAG_LIVE_STATUSES);
  const parcel = `P-${1_000 + Math.floor(next() * 9_000)}`;
  const kind = next();
  const other = pick(next, DAG_LIVE_STATUSES.filter(item => item.id !== status.id));
  let log: string[]; let slice: string;
  if (kind < 0.55) { log = [`Day 1: Parcel ${parcel} ${status.cue}.`]; slice = 'direct'; }
  else if (kind < 0.8) {
    // An earlier status is superseded by the latest update.
    log = [`Day 1: Parcel ${parcel} ${other.cue}.`, `Day 3: Update: parcel ${parcel} ${status.cue}.`];
    slice = 'superseded';
  } else {
    // A note about a different parcel must not be read as this parcel's status.
    const neighbour = `P-${1_000 + Math.floor(next() * 9_000)}`;
    log = [`Day 2: Parcel ${parcel} ${status.cue}.`, `Note: a different parcel, ${neighbour === parcel ? `${parcel}-B` : neighbour}, ${other.cue}.`];
    slice = 'distractor';
  }
  return { id: `ev-${String(index + 1).padStart(3, '0')}`, pattern: 'extractor-verifier-fallback', slice, label: status.id,
    subject: { parcel, log } };
}

export const DAG_LIVE_SEED = 0x2686;
export const DAG_LIVE_TASKS_PER_PATTERN = 100;
/** Pure generator for the preregistered workload. Same seed, same bytes. */
export function generateDagLiveWorkload(seed = DAG_LIVE_SEED, tasksPerPattern = DAG_LIVE_TASKS_PER_PATTERN): DagLiveWorkload {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isSafeInteger(tasksPerPattern) || tasksPerPattern < 2 || tasksPerPattern > 999) {
    throw new Error('invalid DAG live workload parameters');
  }
  const tasks = Array.from({ length: tasksPerPattern }, (_, i) => [shortlistTask(i, seed), taxonomyTask(i, seed), extractorTask(i, seed)]).flat()
    .sort((a, b) => DAG_LIVE_PATTERNS.indexOf(a.pattern) - DAG_LIVE_PATTERNS.indexOf(b.pattern) || a.id.localeCompare(b.id));
  return { schemaVersion: 'dag-live-workload/v1', issue: '#2686', syntheticOnly: true, generator: 'lcg-1664525-1013904223/v1',
    seed, tasksPerPattern, tasks };
}

const inputSchema = { type: 'object' as const, properties: { subject: {}, evidence: {} }, required: ['subject', 'evidence'], additionalProperties: false };
function definition(id: string, question: string, answer: DecisionDefinition['spec']['answer']): DecisionDefinition {
  const value: DecisionDefinition = { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionDefinition',
    metadata: { id, version: '1.0.0', description: 'D12 live qualification synthetic decision (#2686)' },
    spec: { purpose: 'Synthetic D12 paired qualification only; no action is authorized.', inputSchema, question, answer,
      requiredCapabilities: [answer.kind] } };
  validateDefinition(value);
  return value;
}
const choice = (options: Array<[string, string]>) => ({ kind: 'choice' as const, options: options.map(([id, description]) => ({ id, description })) });
const POSITIONS = ['first', 'second', 'third', 'fourth', 'fifth'];

/**
 * Definitions asked by each arm for one task, keyed by node ID. `flat` is the single-call
 * baseline; the other keys are graph nodes. Host-local nodes (taxonomy, select) ask nothing.
 */
export function dagLiveDefinitions(task: DagLiveTask): Record<string, DecisionDefinition> {
  if (task.pattern === 'shortlist-rerank') {
    const sections = task.subject.sections as Array<{ id: string; name: string; items: Array<{ id: string; name: string }> }>;
    return {
      flat: definition('dag-live-sr-flat', 'Choose the catalog item in subject.sections that best satisfies subject.request. Choose none if no listed item satisfies it.',
        choice([...sections.flatMap(section => section.items.map(item => [item.id, item.name] as [string, string])),
          ['none', 'No listed item satisfies the request.']])),
      shortlist: definition('dag-live-sr-shortlist', 'Which section of subject.sections contains an item that satisfies subject.request? Choose none if no listed item satisfies it.',
        choice([...sections.map(section => [section.id, `${section.name}: ${section.items.map(item => item.name).join(', ')}.`] as [string, string]),
          ['none', 'No listed item satisfies the request.']])),
      rerank: definition('dag-live-sr-rerank', 'evidence.candidates.items lists shortlisted items in order. Choose the position of the item that best satisfies subject.request.',
        choice(POSITIONS.slice(0, 4).map((word, i) => [`position-${i + 1}`, `The ${word} item in evidence.candidates.items.`] as [string, string]))),
    };
  }
  if (task.pattern === 'taxonomy-beam') {
    const leaves = Object.values(DAG_LIVE_TAXONOMY).flatMap(branch => branch.leaves);
    const out: Record<string, DecisionDefinition> = {
      flat: definition('dag-live-tb-flat', 'Classify the support request in subject.ticket into exactly one category.',
        choice(leaves.map(leaf => [leaf.id, leaf.name] as [string, string]))),
    };
    for (const [id, branch] of Object.entries(DAG_LIVE_TAXONOMY)) {
      out[id] = definition(`dag-live-tb-${id}`, `How well does the support request in subject.ticket fit the ${branch.name} area (${branch.leaves.map(leaf => leaf.name).join(', ')})?`,
        { kind: 'ordinal-score', levels: ['Does not fit at all.', 'Unlikely to fit.', 'Could fit.', 'Likely fits.', 'Clearly fits.'] });
      out[`detail-${id}`] = definition(`dag-live-tb-detail-${id}`, `Classify the ${branch.name} support request in subject.ticket into exactly one category.`,
        choice(branch.leaves.map(leaf => [leaf.id, leaf.name] as [string, string])));
    }
    return out;
  }
  const statuses = choice(DAG_LIVE_STATUSES.map(status => [status.id, status.name] as [string, string]));
  return {
    flat: definition('dag-live-ev-flat', 'What is the current status of parcel subject.parcel according to subject.log?', statuses),
    extractor: definition('dag-live-ev-extractor', 'What is the current status of parcel subject.parcel according to subject.log?', statuses),
    verifier: definition('dag-live-ev-verifier', 'Does subject.log support that the current status of parcel subject.parcel is evidence.evidence.status? Later updates override earlier ones, and notes about other parcels do not count.',
      choice([['supported', 'The log supports that status as current for this parcel.'], ['not-supported', 'The log does not support that status as current for this parcel.']])),
    fallback: definition('dag-live-ev-fallback', 'A previous extraction was judged unsupported. Read subject.log carefully: later updates override earlier ones and notes about other parcels do not count. What is the current status of parcel subject.parcel?', statuses),
  };
}

/** Preregistered analysis, economics and stop rules. Changing any value changes the digest. */
export const DAG_LIVE_ANALYSIS = {
  qualityMetric: 'exact-match-accuracy', pairing: 'task-id', armOrder: 'alternating-by-task-index',
  nonInferiority: { method: 'newcombe-10' as const, levelBps: 9000, marginBps: -1000 },
  economics: { maxCallRatio: 3, maxP95LatencyRatio: 4, maxExtraTokensPerTaskUpper: 8000,
    bootstrap: { levelBps: 9000, seed: 0x2686, resamples: 20_000 } },
  /** Call ratios (economics and the stop rule) count first attempts of usable pairs; retries are charged and reported. */
  stopRules: { maxPatternCallRatio: 3, callRatioBasis: 'first-attempt-calls-of-usable-pairs', budgetStopFraction: 0.8, speculativeAction: 'stop-run' },
  /**
   * Jev returns occasional non-success outcomes (about 2-3% invalid output in the #2613 study). A retryable
   * outcome gets at most one retry, reserved and charged like any call; a second failure makes the TASK a
   * measurement failure in both arms, excluded from the paired table. More than the tolerated fraction of a
   * pattern's tasks makes that pattern insufficient evidence (and it is abandoned), not a run stop.
   * Identity, accounting, budget and credential anomalies still stop the run at once.
   */
  providerFailurePolicy: {
    retriesPerCall: 1, retryCharged: true,
    retryableOutcomes: ['provider-invalid-output', 'provider-timeout', 'provider-network-transient', 'provider-rate-limited',
      'provider-overloaded', 'provider-service-error', 'unknown-usage'],
    measurementFailure: 'task-excluded-from-both-arms', maxMeasurementFailureFractionPerPattern: 0.05,
    beyondTolerance: 'pattern-insufficient-evidence',
    immediateStops: ['served-model-mismatch', 'usage-exceeded-reservation', 'missing-request-id', 'budget', 'credential-or-authorization',
      'data-boundary-denied', 'invalid-request', 'adapter-exception', 'any-other-provider-outcome'],
  },
  perCallTokenBound: 4000, concurrency: 1,
} as const;
export interface DagLivePreregistration {
  schemaVersion: 'dag-live-preregistration/v1'; issue: '#2686'; workloadDigest: `sha256:${string}`;
  definitionsDigest: `sha256:${string}`; tasksPerPattern: number;
  arms: { baseline: 'flat-single-call-flowgraph/v1'; candidate: 'decision-graph-template/v1' };
  analysis: typeof DAG_LIVE_ANALYSIS; promotionOwner: string; automaticPromotion: false;
}
export function dagLivePreregistration(workload: DagLiveWorkload, promotionOwner = 'roctinam'): DagLivePreregistration {
  const definitions = workload.tasks.map(task => ({ task: task.id, pins: Object.fromEntries(Object.entries(dagLiveDefinitions(task))
    .map(([node, value]) => [node, artifactPin(value).digest])) }));
  return { schemaVersion: 'dag-live-preregistration/v1', issue: '#2686', workloadDigest: dagLiveDigest(workload),
    definitionsDigest: dagLiveDigest(definitions), tasksPerPattern: workload.tasksPerPattern,
    arms: { baseline: 'flat-single-call-flowgraph/v1', candidate: 'decision-graph-template/v1' },
    analysis: DAG_LIVE_ANALYSIS, promotionOwner, automaticPromotion: false };
}
