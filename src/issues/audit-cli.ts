// Wire issue-audit into the existing skill executor and configured tracker/label routing.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { resolveIssueLabels, type AiwgConfig } from '../config/aiwg-config.js';
import { projectAiwgWritePath } from '../config/project-artifacts.js';
import { resolveTrackerAuthority, chooseTrackerAccess } from '../tracker/capability-protocol.js';
import { readConfig, readGitRemoteUrls } from '../tracker/project-inputs.js';
import { cliForgeTransport, httpForgeTransport, forgeEndpointFromRemote } from '../tracker/forge-http.js';
import { createForgeAuditTracker } from '../tracker/issue-pages.js';
import { resolveToken } from './live.js';
import { localIssueRoot } from './local.js';
import { createLocalAuditTracker } from './audit-local.js';
import { runIssueAudit, renderIssueAudit, needsAuditContent } from './audit.js';
import { AuditStop, auditDigest, parseAuditFilter, type AuditTracker } from './audit-contract.js';

interface Dependencies {
  tracker?: AuditTracker;
  config?: AiwgConfig | null;
  remoteUrls?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  output?: (text: string) => void;
}

export async function main(args: string[], cwd = process.cwd(), dependencies: Dependencies = {}): Promise<number> {
  const output = dependencies.output ?? console.log;
  let format = 'markdown';
  try {
    const { values: v } = parseArgs({ args, strict: true, options: {
      filter: { type: 'string' }, guidance: { type: 'string' }, provider: { type: 'string' },
      checkpoint: { type: 'string' }, 'page-size': { type: 'string' }, 'max-items': { type: 'string' }, 'max-pages': { type: 'string' },
      'max-bytes': { type: 'string' }, 'max-context-bytes': { type: 'string' },
      select: { type: 'string' }, format: { type: 'string' }, 'all-open': { type: 'boolean' },
      'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, interactive: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    format = v.format ?? 'markdown';
    if (!['json', 'markdown'].includes(format)) throw new AuditStop('format-invalid');
    if (v.help) {
      output('aiwg run skill issue-audit -- [--filter "status:open label:bug"] [--guidance TEXT] [--provider local|gitea|github]\n'
        + '  [--checkpoint PATH] [--page-size 25] [--max-items 250] [--max-pages 100] [--max-bytes 65536]\n'
        + '  [--max-context-bytes 262144] [--select ID,ID] [--format json|markdown]\n'
        + 'Rerun the same scope/checkpoint to resume. Execution is read-only; cleanup decisions use the instructional workflow.');
      return 0;
    }
    if (v.apply || v.interactive) throw new AuditStop('use-instructional-workflow-for-interactive-or-apply');
    const number = (name: 'page-size' | 'max-items' | 'max-pages' | 'max-bytes' | 'max-context-bytes', fallback: number) => {
      const value = Number(v[name] ?? fallback);
      if (!Number.isSafeInteger(value) || value < 1) throw new AuditStop(`invalid-${name}`);
      return value;
    };
    const pageSize = number('page-size', 25);
    const maxItems = number('max-items', 250);
    const maxPages = number('max-pages', 100);
    const maxBytes = number('max-bytes', 65_536);
    const maxContextBytes = number('max-context-bytes', 262_144);
    if (pageSize > 100) throw new AuditStop('invalid-page-size');
    const config = dependencies.config === undefined ? await readConfig(cwd) : dependencies.config;
    const authority = resolveTrackerAuthority(config, dependencies.remoteUrls ?? await readGitRemoteUrls(cwd));
    const provider = v.provider ?? authority.provider;
    if (provider !== 'local' && provider !== 'gitea' && provider !== 'github') throw new AuditStop('tracker-provider-unresolved');
    const taxonomy = resolveIssueLabels(config?.issues, provider);
    if (taxonomy.diagnostics.some(d => d.severity === 'error')) throw new AuditStop('label-taxonomy-invalid');
    const filter = v.filter ?? 'status:open';
    const parsedFilter = parseAuditFilter(filter);
    const nativeFilter = [`status:${parsedFilter.status}`, ...parsedFilter.labels.map(role =>
      `label:${JSON.stringify(taxonomy.labels[role]?.resolved_name ?? role)}`)].join(' ');
    const selection = v.select === undefined ? null : new Set(v.select.split(',').map(s => s.trim()).filter(Boolean));
    const checkpoint = v.checkpoint ? resolve(cwd, v.checkpoint) : projectAiwgWritePath(cwd, 'working', 'issue-audit', 'checkpoint.json');
    const env = dependencies.env ?? process.env;
    let tracker = dependencies.tracker;
    if (!tracker) {
      if (provider === 'local') tracker = createLocalAuditTracker(localIssueRoot(cwd));
      else {
        const endpoint = forgeEndpointFromRemote(provider, authority.issueTrackerUrl);
        if (!endpoint) throw new AuditStop('tracker-repository-unresolved');
        const token = resolveToken(provider, env);
        const access = chooseTrackerAccess({ ...authority, provider }, [
          { kind: 'http-api', provider, remoteName: authority.issueTrackerRemote, available: !!token, authenticated: !!token },
          { kind: 'cli', provider, remoteName: authority.issueTrackerRemote, available: provider === 'github', cli: 'gh' },
        ]);
        const transport = access.kind === 'http-api' && token
          ? httpForgeTransport({ provider, apiBaseUrl: endpoint.apiBaseUrl, token, maxResponseBytes: maxBytes })
          : access.kind === 'cli' ? cliForgeTransport({ provider, hostname: endpoint.host, maxResponseBytes: maxBytes }) : null;
        if (!transport) throw new AuditStop('tracker-no-access-route');
        tracker = createForgeAuditTracker(provider, endpoint.repository, transport,
          `${provider}:${endpoint.apiBaseUrl}:${endpoint.repository}:${config?.remotes?.tracker_actor?.login ?? ''}`);
      }
    }
    const nativeTracker = tracker;
    const semanticTracker: AuditTracker = { ...nativeTracker,
      async listMetadata(options) {
        const page = await nativeTracker.listMetadata(options);
        return { ...page, items: page.items.map(i => ({ ...i, labels: [...i.labels,
          ...Object.values(taxonomy.labels).filter(l => i.labels.includes(l.resolved_name)).map(l => l.role)] })) };
      },
    };
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try {
      const report = await runIssueAudit(semanticTracker, { checkpoint, pageSize, maxItems, maxPages, maxBytes, maxContextBytes,
        filter: nativeFilter, guidance: v.guidance, signal: controller.signal,
        policyKey: auditDigest([selection ? [...selection].sort() : null, taxonomy.labels]),
        select: i => selection ? selection.has(i.id) : needsAuditContent(i) });
      output(format === 'json' ? JSON.stringify({ ...report, scope: { provider, filter }, diagnostics: taxonomy.diagnostics })
        : `${renderIssueAudit(report)}${taxonomy.diagnostics.map(d => `\n${d.severity}: ${d.message}`).join('')}`);
      return report.coverage.incomplete ? 2 : 0;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  } catch (error) {
    const reason = error instanceof AuditStop ? error.reason : 'audit-error';
    output(format === 'json' ? JSON.stringify({ mode: 'read-only', coverage: {
      totalSeen: 0, totalHydrated: 0, totalCompleted: 0, incomplete: true, reason } }) : `# Issue Audit\n\nCoverage: INCOMPLETE (${reason})`);
    return 2;
  }
}
