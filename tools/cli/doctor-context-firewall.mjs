// Run doctor’s provider context check using the firewall’s authoritative layouts.
import { scanContextMemoryFirewall, SUPPORTED_PROVIDERS } from '../security/context-memory-firewall.mjs';

export async function checkContextMemoryFirewall({ rootDir, packageRoot, providers,
  baselinePath, budgetTokens, strictContext = false }, check) {
  try {
    for (const name of providers.filter(name => !SUPPORTED_PROVIDERS.includes(name))) {
      check('Context/memory firewall', 'info', `${name}: not yet supported; skipped`);
    }
    const firewall = await scanContextMemoryFirewall({
      rootDir,
      packageRoot,
      providers,
      baselinePath,
      budgetTokens,
    });
    const stale = firewall.trust.stale;
    const quarantined = firewall.trust.quarantined;
    const external = firewall.trust.external;
    const changed = firewall.records.filter((record) => record.reviewStatus === 'changed-review-required').length;
    const categorySummary = Object.entries(firewall.categories)
      .map(([category, value]) => `${category}=${value.bytes.toLocaleString()}B`)
      .join(', ');
    const summary =
      `${firewall.totals.files} file(s), ~${firewall.totals.approxTokens.toLocaleString()} / `
      + `${firewall.budget.tokens.toLocaleString()} tokens; ${categorySummary}; `
      + `stale=${stale}, quarantined=${quarantined}, external=${external}, changed=${changed}`;
    const baselineMissing = !firewall.baseline.exists;
    const unsafe = firewall.violations.length > 0 || baselineMissing;
    if (unsafe) {
      const status = strictContext ? 'error' : 'warn';
      const baselineMessage = baselineMissing
        ? ` Review baseline missing at ${firewall.baseline.path}; run \`aiwg context-firewall baseline --plan\`, review every record, then use the confirmed write command it prints.`
        : '';
      check('Context/memory firewall', status, `${summary}.${baselineMessage}`);
    } else {
      check('Context/memory firewall', 'ok', `${summary}; reviewed baseline ${firewall.baseline.path}`);
    }
  } catch (error) {
    check('Context/memory firewall', strictContext ? 'error' : 'warn', `scan failed: ${error.message}`);
  }
}
