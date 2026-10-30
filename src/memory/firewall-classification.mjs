/** Shared, body-free trust classification for static context inventories. */
export function classifyContextMemory({ digest, managed, manifest, baselineEntry, threat }) {
  const manifestDrift = Boolean(manifest?.hash && manifest.hash !== digest);
  const baselineChanged = Boolean(baselineEntry?.digest && baselineEntry.digest !== digest);
  const findings = [];
  let trust;
  let reviewStatus;
  if (baselineEntry?.trust === 'superseded') {
    trust = 'superseded';
    reviewStatus = 'superseded';
  } else if (threat?.poisoning && !managed) {
    trust = 'quarantined';
    reviewStatus = 'quarantine-review-required';
    findings.push('poisoning-signal');
  } else if (manifestDrift) {
    trust = 'stale';
    reviewStatus = 'deployed-drift';
    findings.push('stale-deployed-bytes');
  } else if (baselineChanged) {
    trust = 'quarantined';
    reviewStatus = 'changed-review-required';
    findings.push('changed-since-review');
  } else if (['user-authored', 'generated', 'external', 'stale', 'quarantined', 'superseded'].includes(baselineEntry?.trust)) {
    trust = baselineEntry.trust;
    reviewStatus = 'reviewed';
  } else {
    trust = managed ? 'generated' : 'user-authored';
    reviewStatus = 'unreviewed';
  }
  if (threat?.signals.length > 0 && (!threat.poisoning || managed)) findings.push('content-review-signal');
  return { trust, reviewStatus, findings, manifestDrift };
}
