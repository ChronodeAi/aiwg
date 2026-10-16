/** Only source-defined codes cross the CLI boundary; raw exception messages and values never do. */
const codes = new Set(`
approval-call-budget approval-pins approved-calibration artifact-file artifact-symlink attempt-membership
baseline-changed baseline-mismatch baseline-path baseline-study budget-changed budget-exceeded bundle-fields
calibration-artifact calibration-context calibration-expired calibration-input calibration-metrics-unknown
calibration-phase-access calibration-phase-approval calibration-phase-binding calibration-phase-empty
calibration-phase-lineage calibration-phase-order calibration-phase-row calibration-phase-seal
calibration-profile calibration-registered-mismatch calibration-review calibration-samples calibration-scope
calibration-set calibration-support calibration-unqualified changed-preregistration collection-clock config
corpus-provenance credential-material credential-scope credential-shape development-gold-invalid
development-review development-review-incomplete development-review-material development-review-not-bound
development-review-time dispatch-locked duplicate-reservation evidence-pin free-output-required frozen-inputs
frozen-pins frozen-run frozen-study-mismatch generator-output injected-prior input-bound input-pins
integrity-invalid journal-chain journal-pins journal-run live-gate mapping-pin mapping-schema membership
native-distribution offline-options paid-generator payload-bound prior-evidence prior-run prior-stop
public-demo-corpus public-demo-seed public-seed receipt-digest receipt-missing recorded-evidence request-bound
reservation-refund resolver-pin run-path schema schema-unavailable scoring-clock scoring-pins seed-invalid
seed-reused seed-too-long source-pin-mismatch spend-counter-operator-repair-required staged-scope
test-review-before-test-phase tls trace-digest truncated-journal uncalibrated-report unreserved-result usage
`.trim().split(/\s+/));
const messages = new Map([
  ['usage', 'usage'], ['config', 'config'], ['gate', 'live-gate'], ['module-pins', 'source-pin-mismatch'],
  ['D17-MF prepared study mismatch', 'frozen-study-mismatch'],
  ['D17 sealed source', 'source-pin-mismatch'],
  ['D17 sealed source is not a git work tree', 'source-pin-mismatch'],
  ['D17 sealed source commit mismatch', 'source-pin-mismatch'],
  ['D17 sealed source has local changes under pinned paths', 'source-pin-mismatch'],
  ['D17-MF source links are not accepted', 'source-pin-mismatch'],
  ['D17-MF plan exceeds the approval allowance', 'budget-exceeded'],
  ['D17 calibration context', 'calibration-context'],
  ['D17-MF calibration binding', 'calibration-set'],
  ['D17-MF calibrator expiry does not match the pinned dispatch bound', 'calibration-expired'],
  ['D17-MF approval must bind the registered D17 calibration set (artifact mode)', 'approved-calibration'],
  ['D17-MF oracle disagreement', 'oracle-disagreement'], ['D17-MF shortcut audit', 'shortcut-audit'],
  ['D17 seed reused: this corpus already has observations under another preregistration', 'changed-preregistration'],
  ['TV-12 requires clean exact source commit', 'source-pin-mismatch'],
  ['Canonical artifact root unavailable', 'artifact-root'],
  ['TV-12 evidence must use the canonical artifact root', 'artifact-root'],
  ['scoring clock', 'scoring-clock'],
]);
export function decisionRefusalCode(error) {
  for (const code of [error?.category, error?.reason]) if (codes.has(code)) return code;
  return messages.get(error?.message) ?? 'check-failed';
}
