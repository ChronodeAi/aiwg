/**
 * Evaluator immutability meta-check: a change may not loosen, remove, suppress or edit the
 * evaluator that judges it. Evaluator changes are human governance work: their own commit,
 * citing an ADR already on the base branch.
 */

import { spawnSync } from 'node:child_process';
import { GATE_CONFIG_PATH, defaultGateConfig, globToRegExp, loadGateConfig, matchesAny, parseGateConfig } from './config.mjs';
import { diffAgainstBase, git, gitLines, readFileAtRef } from './git.mjs';
import { hasLizardExtension } from './lizard.mjs';

export const EVALUATOR_MESSAGE = 'Evaluator surfaces changed. Evaluator changes are human governance work: land them in '
  + 'their own commit citing an ADR already on the base branch, reviewed by someone other than the author. '
  + 'Do not edit these files to pass this check.';

const TRAILER_RE = /^\s*Evaluator-Change:\s*ADR-([A-Za-z0-9._-]+)\s*$/m;
const SUPPRESSION_OK_RE = /\bAIWG-allow:suppression\b(.*)$/;

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function surfacesOf(cfg) {
  const surfaces = [...cfg.evaluator_surfaces];
  if (cfg.contracts.frozen_edges_file) surfaces.push(cfg.contracts.frozen_edges_file);
  return surfaces;
}

/**
 * Pure per-commit evaluator rule.
 * commit: {sha, message, paths}; baseAdrPaths: string[] of files tracked at base.
 * Returns {touchesSurface, accepted, adr, surfacePaths}.
 */
export function judgeEvaluatorCommit(commit, surfaces, baseAdrPaths) {
  const surfacePaths = commit.paths.filter((p) => matchesAny(p, surfaces));
  if (surfacePaths.length === 0) return { touchesSurface: false, accepted: true, surfacePaths };
  const onlySurfaces = surfacePaths.length === commit.paths.length;
  const trailer = TRAILER_RE.exec(commit.message);
  let adrOnBase = false;
  if (trailer) {
    const adrRe = new RegExp(`^\\.aiwg/architecture/(?:.*/)?ADR-${escapeRe(trailer[1])}[^/]*\\.md$`);
    adrOnBase = baseAdrPaths.some((p) => adrRe.test(p));
  }
  return {
    touchesSurface: true,
    accepted: onlySurfaces && adrOnBase,
    adr: trailer ? `ADR-${trailer[1]}` : null,
    surfacePaths,
    reason: !onlySurfaces ? 'commit mixes evaluator and non-evaluator paths'
      : !trailer ? 'missing Evaluator-Change: ADR-<id> trailer'
        : !adrOnBase ? `ADR-${trailer[1]} not found under .aiwg/architecture/ on the base branch` : null,
  };
}

function isNonIncreasingBand(base, head) {
  return ['p70', 'p80', 'p90'].every((k) => (head?.[k] ?? 0) <= (base?.[k] ?? 0));
}

function isSuperset(baseList, headList) {
  return baseList.every((item) => headList.includes(item));
}

/** Pure: list the ways cfgHead is looser than (or different from) cfgBase. Calibration metadata is free. */
export function configLoosenings(cfgBase, cfgHead) {
  const issues = [];
  const bandKeys = new Set([...Object.keys(cfgBase.bands), ...Object.keys(cfgHead.bands)]);
  for (const key of bandKeys) {
    if (!isNonIncreasingBand(cfgBase.bands[key], cfgHead.bands[key])) issues.push(`bands.${key} raised`);
  }
  if (!isSuperset(cfgBase.evaluator_surfaces, cfgHead.evaluator_surfaces)) issues.push('evaluator_surfaces reduced');
  if (!isSuperset(cfgBase.suppressions.patterns, cfgHead.suppressions.patterns)) issues.push('suppressions.patterns reduced');
  if (!isSuperset(cfgBase.quality_commands, cfgHead.quality_commands)) issues.push('quality_commands reduced');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of ['version', 'include', 'exclude', 'benchmark', 'contracts', 'history']) {
    if (!same(cfgBase[key], cfgHead[key])) issues.push(`${key} changed`);
  }
  if (cfgBase.suppressions.unused_command !== cfgHead.suppressions.unused_command) {
    issues.push('suppressions.unused_command changed');
  }
  return issues;
}

function parseKeyValue(text) {
  const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(text);
  if (!m) return null;
  let value = m[2].replace(/\s+#.*$/, '').trim();
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  return { key: m[1], value };
}

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === '' || line.trim().startsWith('#');

/**
 * Line-wise workflow scanner: returns [{job, jobProps, props, run}] for every step.
 * Handles `run: |`/`run: >` block scalars; ignores anchors and flow syntax.
 */
export function scanWorkflowSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  let job = null;
  let jobIndent = -1;
  let propIndent = -1;
  let stepIndent = -1;
  let step = null;
  let blockKey = null;
  let blockIndent = -1;
  let inJobs = false;
  let jobsIndent = -1;

  for (const line of lines) {
    if (isBlank(line)) {
      if (blockKey && step) step.props[blockKey] += '\n';
      continue;
    }
    const indent = indentOf(line);
    const trimmed = line.trim();
    if (blockKey) {
      if (indent > blockIndent) {
        step.props[blockKey] += `${trimmed}\n`;
        continue;
      }
      blockKey = null;
    }
    if (!inJobs) {
      if (/^jobs:\s*$/.test(trimmed)) {
        inJobs = true;
        jobsIndent = indent;
      }
      continue;
    }
    if (indent <= jobsIndent) {
      inJobs = /^jobs:\s*$/.test(trimmed);
      job = null;
      continue;
    }
    if (jobIndent < 0) jobIndent = indent;
    if (indent === jobIndent) {
      job = { name: trimmed.replace(/:.*$/, ''), props: {} };
      propIndent = -1;
      stepIndent = -1;
      step = null;
      continue;
    }
    if (!job) continue;
    if (propIndent < 0) propIndent = indent;
    if (stepIndent >= 0 && indent >= stepIndent) {
      let content = null;
      if (indent === stepIndent && trimmed.startsWith('-')) {
        step = { job: job.name, jobProps: job.props, props: {} };
        steps.push(step);
        content = trimmed.replace(/^-\s*/, '');
        if (!content) continue;
      } else if (step) {
        content = trimmed;
      }
      if (!step || content === null) continue;
      const kv = parseKeyValue(content);
      if (!kv) continue;
      if (/^[|>][+-]?\d*$/.test(kv.value)) {
        step.props[kv.key] = '';
        blockKey = kv.key;
        blockIndent = indent === stepIndent ? stepIndent + 1 : indent;
      } else {
        step.props[kv.key] = kv.value;
      }
      continue;
    }
    if (indent === propIndent) {
      stepIndent = -1;
      step = null;
      const kv = parseKeyValue(trimmed);
      if (!kv) continue;
      if (kv.key === 'steps') {
        stepIndent = -2;
      } else {
        job.props[kv.key] = kv.value;
      }
      continue;
    }
    if (stepIndent === -2 && trimmed.startsWith('-')) {
      stepIndent = indent;
      step = { job: job.name, jobProps: job.props, props: {} };
      steps.push(step);
      const kv = parseKeyValue(trimmed.replace(/^-\s*/, ''));
      if (kv) {
        if (/^[|>][+-]?\d*$/.test(kv.value)) {
          step.props[kv.key] = '';
          blockKey = kv.key;
          blockIndent = indent + 1;
        } else {
          step.props[kv.key] = kv.value;
        }
      }
    }
  }
  return steps.map((s) => ({ job: s.job, jobProps: s.jobProps, props: s.props, run: s.props.run ?? '' }));
}

const DISABLED_IF_RE = /^\s*(false|\$\{\{\s*false\s*\}\})\s*$/;
const SWALLOW_RE = /\|\|\s*(true|:|exit 0)|set \+e/;

/** Pure: quality steps and their suppressions in one workflow text. */
export function qualitySteps(text, qualityCommands) {
  const regexes = qualityCommands.map((c) => new RegExp(c));
  return scanWorkflowSteps(text)
    .filter((step) => regexes.some((re) => re.test(step.run)))
    .map((step) => {
      const problems = [];
      for (const [scope, props] of [['step', step.props], ['job', step.jobProps]]) {
        const coe = props['continue-on-error'];
        if (coe !== undefined && coe !== 'false') problems.push(`${scope} continue-on-error: ${coe}`);
        if (props.if !== undefined && DISABLED_IF_RE.test(props.if)) problems.push(`${scope} if: ${props.if}`);
      }
      if (SWALLOW_RE.test(step.run)) problems.push('run swallows failure');
      return { job: step.job, name: step.props.name ?? null, run: step.run.trim(), problems };
    });
}

function workflowFilesAt(root, ref) {
  return gitLines(root, ['ls-tree', '-r', '--name-only', ref, '--', '.github/workflows', '.gitea/workflows'], { allowFail: true })
    .filter((p) => /\.ya?ml$/.test(p));
}

function collectQualitySteps(root, ref, qualityCommands) {
  const steps = [];
  for (const file of workflowFilesAt(root, ref)) {
    const text = readFileAtRef(root, ref, file) ?? '';
    for (const step of qualitySteps(text, qualityCommands)) steps.push({ file, ...step });
  }
  return steps;
}

function stepKey(step) {
  return `${step.file}\u0000${step.job}\u0000${step.run}`;
}

/** Parse `AIWG-allow:suppression owner="…" expires="YYYY-MM-DD" reason="…"`. */
export function parseSuppressionAnnotation(text) {
  const m = SUPPRESSION_OK_RE.exec(text || '');
  if (!m) return null;
  const attrs = {};
  for (const [, key, value] of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[key] = value;
  return attrs;
}

/** Pure: judge one new suppression line given the line above it and today's date (YYYY-MM-DD). */
export function judgeSuppression(lineText, lineAbove, today) {
  const attrs = parseSuppressionAnnotation(lineText) ?? parseSuppressionAnnotation(lineAbove);
  if (!attrs) return 'missing AIWG-allow:suppression annotation';
  if (!attrs.owner || !attrs.reason || !/^\d{4}-\d{2}-\d{2}$/.test(attrs.expires || '')) {
    return 'annotation needs owner="…" expires="YYYY-MM-DD" reason="…"';
  }
  if (attrs.expires < today) return `annotation expired ${attrs.expires}`;
  return null;
}

function checkSuppressions(root, mergeBase, cfg, surfaces) {
  const verdicts = [];
  const patterns = cfg.suppressions.patterns.map((p) => new RegExp(p));
  const today = new Date().toISOString().slice(0, 10);
  for (const file of diffAgainstBase(root, mergeBase)) {
    const target = file.newPath;
    if (!target || !hasLizardExtension(target) || matchesAny(target, surfaces)) continue;
    const removed = new Set(file.hunks.flatMap((h) => h.removed.map((t) => t.trim())));
    let headLines = null;
    for (const hunk of file.hunks) {
      for (const added of hunk.added) {
        if (!patterns.some((re) => re.test(added.text))) continue;
        if (removed.has(added.text.trim())) continue;
        headLines ??= (readFileAtRef(root, 'HEAD', target) ?? '').split('\n');
        const problem = judgeSuppression(added.text, headLines[added.line - 2] ?? '', today);
        if (problem) {
          verdicts.push({
            level: 'FAIL', code: 'suppression-unjustified', file: target, metrics: { line: added.line },
            message: `${target}:${added.line} ${problem}: ${added.text.trim()}`,
          });
        }
      }
    }
  }
  if (cfg.suppressions.unused_command) {
    const result = spawnSync(cfg.suppressions.unused_command, { shell: true, cwd: root, encoding: 'utf8' });
    if ((result.status ?? 1) !== 0) {
      verdicts.push({
        level: 'FAIL', code: 'suppression-unused', file: null, metrics: { exit: result.status },
        message: `${cfg.suppressions.unused_command} exited ${result.status}\n${`${result.stdout}${result.stderr}`.trim()}`,
      });
    }
  }
  return verdicts;
}

function representativePath(glob) {
  return glob.replace(/\*\*/g, 'x').replace(/\*/g, 'x').replace(/\?/g, 'x');
}

/** Pure: CODEOWNERS coverage of evaluator surfaces. */
export function judgeCodeowners(text, surfaces) {
  const entries = [];
  const owners = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...lineOwners] = line.split(/\s+/);
    lineOwners.forEach((o) => owners.add(o));
    entries.push(pattern);
  }
  if (owners.size <= 1) {
    return [{ level: 'WARN', code: 'codeowners', file: null, message: 'single-owner CODEOWNERS: evaluator changes rely on the ADR trailer, not a second reviewer' }];
  }
  const explicit = entries.filter((p) => p !== '*').map((p) => {
    let glob = p.replace(/^\//, '');
    if (glob.endsWith('/')) glob += '**';
    if (!p.includes('/') || (p.endsWith('/') && p.indexOf('/') === p.length - 1 && !p.startsWith('/'))) glob = `**/${glob}`;
    return globToRegExp(glob);
  });
  const missing = surfaces.filter((s) => !explicit.some((re) => re.test(representativePath(s))));
  if (missing.length === 0) return [];
  return [{ level: 'FAIL', code: 'codeowners', file: null, message: `evaluator surfaces without an explicit CODEOWNERS line: ${missing.join(', ')}` }];
}

/** Full meta-check against a base ref. */
export function runMeta(root, { baseRef, mergeBase }) {
  const verdicts = [];
  const exceptions = [];
  const lines = [];
  const cfgBaseRaw = loadGateConfig(root, { ref: baseRef });
  const cfgBase = cfgBaseRaw ?? defaultGateConfig();
  const headText = readFileAtRef(root, 'HEAD', GATE_CONFIG_PATH);
  const cfgHead = headText === null ? null : parseGateConfig(headText);
  const surfaces = surfacesOf(cfgBase);

  if (cfgBaseRaw && !cfgHead) {
    verdicts.push({ level: 'FAIL', code: 'gate-config-removed', file: GATE_CONFIG_PATH, message: `${GATE_CONFIG_PATH} present at base, absent at HEAD. ${EVALUATOR_MESSAGE}` });
  }

  const baseAdrPaths = gitLines(root, ['ls-tree', '-r', '--name-only', baseRef, '--', '.aiwg/architecture'], { allowFail: true });
  let configCommitsAccepted = true;
  for (const sha of gitLines(root, ['rev-list', '--reverse', `${mergeBase}..HEAD`])) {
    const paths = gitLines(root, ['-c', 'core.quotePath=false', 'diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
    const message = git(root, ['log', '-1', '--format=%B', sha]);
    const judgement = judgeEvaluatorCommit({ sha, message, paths }, surfaces, baseAdrPaths);
    if (!judgement.touchesSurface) continue;
    const short = sha.slice(0, 10);
    if (judgement.accepted) {
      exceptions.push({ sha: short, adr: judgement.adr, paths: judgement.surfacePaths });
    } else {
      if (paths.includes(GATE_CONFIG_PATH)) configCommitsAccepted = false;
      verdicts.push({
        level: 'FAIL', code: 'evaluator-surface-changed', file: null, sha: short,
        message: `${short} ${judgement.surfacePaths.join(' ')} (${judgement.reason}). ${EVALUATOR_MESSAGE}`,
      });
    }
  }

  if (cfgBaseRaw && cfgHead) {
    const issues = configLoosenings(cfgBaseRaw, cfgHead);
    if (issues.length && !configCommitsAccepted) {
      verdicts.push({
        level: 'FAIL', code: 'band-loosened', file: GATE_CONFIG_PATH,
        message: `${issues.join('; ')}. ${EVALUATOR_MESSAGE}`,
      });
    }
  } else if (!cfgBaseRaw) {
    lines.push('bootstrap: no gate.json at base; band comparison skipped, default evaluator surfaces applied');
  }

  const baseSteps = collectQualitySteps(root, mergeBase, cfgBase.quality_commands);
  const headSteps = collectQualitySteps(root, 'HEAD', cfgBase.quality_commands);
  const baseProblems = new Set(baseSteps.filter((s) => s.problems.length).map(stepKey));
  for (const step of headSteps) {
    if (step.problems.length && !baseProblems.has(stepKey(step))) {
      verdicts.push({
        level: 'FAIL', code: 'quality-step-suppressed', file: step.file,
        message: `${step.file} job ${step.job} step ${step.name ?? step.run.split('\n')[0]}: ${step.problems.join('; ')}`,
      });
    }
  }
  if (headSteps.length < baseSteps.length) {
    verdicts.push({
      level: 'FAIL', code: 'quality-step-removed', file: null, metrics: { base: baseSteps.length, head: headSteps.length },
      message: `quality steps in workflows fell ${baseSteps.length}→${headSteps.length}`,
    });
  }

  verdicts.push(...checkSuppressions(root, mergeBase, cfgBase, surfaces));

  for (const candidate of ['CODEOWNERS', '.github/CODEOWNERS']) {
    const text = readFileAtRef(root, 'HEAD', candidate);
    if (text !== null) {
      verdicts.push(...judgeCodeowners(text, surfaces));
      break;
    }
  }
  return { verdicts, exceptions, lines };
}
