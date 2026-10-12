#!/usr/bin/env node
// Create (or idempotently reuse) the GitHub Announcements discussion for a stable release, record evidence, and verify it.
//
// This is the executable behind the `create_github_announcement_discussion`
// post-release action in the release config. The release flow must run it and
// treat a non-zero exit as a hard stop; the discussion is not optional prose.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  VERSION_PATTERN,
  fetchAnnouncementDiscussions,
  missingRequiredLinks,
  releaseTitlePattern,
  verifyDiscussion,
} from './verify-github-release-discussion.mjs';

const USAGE = [
  'Usage: publish-github-release-discussion.mjs --version <version> --body <file> [--title <title>]',
  '       [--repo owner/repo] [--category Announcements] [--announcement <path>]',
  '       [--evidence-dir <dir>] [--update] [--dry-run]',
  '',
  '  --body          Markdown file holding the discussion body (companion prose, not the release notes).',
  '  --title         Discussion title; defaults to the H1 of docs/releases/v<version>-announcement.md.',
  '  --announcement  Override the announcement path used for the default title.',
  '  --evidence-dir  Directory that receives preflight/request/result/verification JSON.',
  '  --update        When a discussion for the version already exists, replace its body with --body.',
  '  --dry-run       Run every check and print the planned mutation without calling GitHub mutations.',
].join('\n');

export const AI_ATTRIBUTION_PATTERNS = [
  /co-authored-by:\s*(claude|copilot|codex|cursor|chatgpt|gpt)/i,
  /generated (with|by) \[?(claude|copilot|codex|cursor|chatgpt|gemini)/i,
  /written (with|by) (ai|claude|copilot|codex|cursor|chatgpt)\b/i,
  /claude\.ai\/code\/session_/i,
  /🤖 generated/i,
  /ai-assisted (pull request|content|implementation)/i,
];

export function parseArgs(argv) {
  const options = {
    repo: 'jmagly/aiwg',
    category: 'Announcements',
    update: false,
    dryRun: false,
  };
  const valued = new Set(['--version', '--body', '--title', '--repo', '--category', '--announcement', '--evidence-dir']);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--update') { options.update = true; continue; }
    if (name === '--dry-run') { options.dryRun = true; continue; }
    if (name === '--help' || name === '-h') { options.help = true; continue; }
    if (!valued.has(name) || !argv[index + 1]) throw new Error(USAGE);
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = argv[index + 1];
    index += 1;
  }
  if (options.help) return options;
  if (!VERSION_PATTERN.test(options.version ?? '')) {
    throw new Error('--version must be an AIWG CalVer release such as 2026.9.9');
  }
  if (!/^[^/]+\/[^/]+$/.test(options.repo)) throw new Error('--repo must be owner/repo');
  if (!options.body) throw new Error('--body <file> is required');
  options.version = options.version.replace(/^v/, '');
  options.tag = `v${options.version}`;
  options.announcement ??= `docs/releases/${options.tag}-announcement.md`;
  return options;
}

export function titleFromAnnouncement(markdown) {
  const heading = markdown.split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
  if (!heading) throw new Error('Announcement has no H1 heading to derive the discussion title from; pass --title.');
  return heading.replace(/^#\s+/, '').trim();
}

export function validateTitle(title, version) {
  if (!releaseTitlePattern(version).test(title)) {
    throw new Error(`Discussion title "${title}" must start with "AIWG ${version}" followed by a separator so the verifier can find it.`);
  }
  return title;
}

export function findAttribution(text) {
  return AI_ATTRIBUTION_PATTERNS.filter((pattern) => pattern.test(text)).map(String);
}

export function validateBody(body, { version, repo }) {
  const problems = [];
  if (!body.trim()) problems.push('discussion body is empty');
  const missing = missingRequiredLinks(body, { version, repo });
  if (missing.length) problems.push(`body is missing required links: ${missing.join(', ')}`);
  const attribution = findAttribution(body);
  if (attribution.length) problems.push(`body contains AI attribution (policy no_ai_attribution): ${attribution.join(' ')}`);
  if (problems.length) throw new Error(problems.join('\n'));
  return body;
}

export function findExistingDiscussions(nodes, version) {
  const pattern = releaseTitlePattern(version);
  return nodes.filter(({ title }) => pattern.test(title));
}

/**
 * Decide what mutation (if any) the publish step needs.
 * Returns { action: 'create' | 'reuse' | 'update', existing? }.
 */
export function planAction({ existing, body, update, version, repo }) {
  if (existing.length > 1) {
    throw new Error(`Found ${existing.length} announcement discussions for AIWG ${version}; resolve the duplicates before publishing.`);
  }
  if (existing.length === 0) return { action: 'create' };
  const [discussion] = existing;
  const stale = missingRequiredLinks(discussion.body ?? '', { version, repo }).length > 0;
  if (update || stale) return { action: 'update', existing: discussion, reason: stale ? 'existing body is missing required links' : '--update requested' };
  return { action: 'reuse', existing: discussion };
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input });
}

export function preflight({ repo, category }) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id hasDiscussionsEnabled discussionCategories(first:25){nodes{id name}}}}';
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`]))?.data?.repository;
  if (!data) throw new Error(`Could not read repository ${repo} through gh; check gh auth status.`);
  if (!data.hasDiscussionsEnabled) throw new Error(`Discussions are disabled on ${repo}; enable them in repository settings before publishing.`);
  const categoryNode = data.discussionCategories.nodes.find((node) => node.name === category);
  if (!categoryNode) {
    const names = data.discussionCategories.nodes.map((node) => node.name).join(', ');
    throw new Error(`Discussion category "${category}" not found on ${repo}; available: ${names}.`);
  }
  return { repositoryId: data.id, categoryId: categoryNode.id, raw: data };
}

export function assertReleasePublished({ repo, tag }) {
  let release;
  try {
    release = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,isPrerelease,url,publishedAt']));
  } catch (error) {
    throw new Error(`GitHub release ${tag} is not visible on ${repo}; publish the release before its discussion. (${error.message.trim()})`);
  }
  if (release.isDraft) throw new Error(`GitHub release ${tag} is still a draft; publish it before its discussion.`);
  if (release.isPrerelease) throw new Error(`GitHub release ${tag} is marked pre-release; announcement discussions are for stable releases only.`);
  return release;
}

function graphqlMutation(query, input) {
  const output = gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables: { input } }));
  const parsed = JSON.parse(output);
  if (parsed.errors?.length) {
    throw new Error(`GitHub GraphQL mutation failed: ${parsed.errors.map((error) => error.message).join('; ')}`);
  }
  return parsed.data;
}

export function createDiscussion({ repositoryId, categoryId, title, body }) {
  const query = 'mutation($input: CreateDiscussionInput!) { createDiscussion(input: $input) { discussion { id number title url category { name } } } }';
  return graphqlMutation(query, { repositoryId, categoryId, title, body }).createDiscussion.discussion;
}

export function updateDiscussion({ discussionId, body }) {
  const query = 'mutation($input: UpdateDiscussionInput!) { updateDiscussion(input: $input) { discussion { id number title url category { name } } } }';
  return graphqlMutation(query, { discussionId, body }).updateDiscussion.discussion;
}

export function fetchDiscussionIds({ repo, category }) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussions(first:100,orderBy:{field:CREATED_AT,direction:DESC}){nodes{id title body url category{name}}}}}';
  const nodes = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`]))?.data?.repository?.discussions?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`Could not read GitHub discussions for ${repo}.`);
  return nodes.filter((node) => node.category?.name === category);
}

function writeEvidence(dir, name, value) {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(`${USAGE}\n`); return; }

  const body = readFileSync(options.body, 'utf8');
  const title = validateTitle(
    options.title ?? titleFromAnnouncement(readFileSync(options.announcement, 'utf8')),
    options.version,
  );
  validateBody(body, options);

  const release = assertReleasePublished(options);
  const pre = preflight(options);
  const existing = findExistingDiscussions(fetchDiscussionIds(options), options.version);
  const plan = planAction({ existing, body, update: options.update, version: options.version, repo: options.repo });

  const evidenceDir = options.evidenceDir;
  writeEvidence(evidenceDir, 'discussion.md', body);
  writeEvidence(evidenceDir, 'discussion-preflight.json', { release, repository: pre.raw, existing: existing.map(({ id, title: t, url }) => ({ id, title: t, url })), plan: { action: plan.action, reason: plan.reason } });

  let discussion;
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, version: options.version, title, plan: plan.action, existing: plan.existing?.url ?? null })}\n`);
    return;
  }
  if (plan.action === 'create') {
    const input = { repositoryId: pre.repositoryId, categoryId: pre.categoryId, title, body };
    writeEvidence(evidenceDir, 'discussion-request.json', { mutation: 'createDiscussion', input: { ...input, body: `<${body.length} chars, see discussion.md>` } });
    discussion = createDiscussion(input);
  } else if (plan.action === 'update') {
    const input = { discussionId: plan.existing.id, body };
    writeEvidence(evidenceDir, 'discussion-request.json', { mutation: 'updateDiscussion', reason: plan.reason, input: { ...input, body: `<${body.length} chars, see discussion.md>` } });
    discussion = updateDiscussion(input);
  } else {
    discussion = plan.existing;
  }

  const verified = verifyDiscussion(fetchAnnouncementDiscussions(options), options);
  const result = { ok: true, version: options.version, action: plan.action, url: verified.url, number: discussion.number ?? null, title: verified.title };
  writeEvidence(evidenceDir, 'discussion-result.json', result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
