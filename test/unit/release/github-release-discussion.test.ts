import { describe, expect, it } from 'vitest';

import {
  missingRequiredLinks,
  parseArgs as parseVerifyArgs,
  releaseTitlePattern,
  requiredLinks,
  verifyDiscussion,
} from '../../../tools/release/verify-github-release-discussion.mjs';
import {
  findAttribution,
  findExistingDiscussions,
  parseArgs as parsePublishArgs,
  planAction,
  titleFromAnnouncement,
  validateBody,
  validateTitle,
} from '../../../tools/release/publish-github-release-discussion.mjs';

const version = '2026.9.9';
const repo = 'jmagly/aiwg';
const links = requiredLinks({ version, repo });
const goodBody = `Impact prose.\n\n${Object.values(links).map((link) => `[link](${link})`).join(' ')}\n\nQuestions?`;

describe('verify-github-release-discussion', () => {
  it('derives the four required release surfaces from version and repo', () => {
    expect(links).toEqual({
      github_release: 'https://github.com/jmagly/aiwg/releases/tag/v2026.9.9',
      npm_version: 'https://www.npmjs.com/package/aiwg/v/2026.9.9',
      release_notes: 'https://github.com/jmagly/aiwg/blob/v2026.9.9/docs/releases/v2026.9.9-announcement.md',
      changelog: 'https://github.com/jmagly/aiwg/blob/v2026.9.9/CHANGELOG.md',
    });
  });

  it('accepts a changelog link that carries a section anchor', () => {
    const body = goodBody.replace(links.changelog, `${links.changelog}#202699---2026-09-13--say-what-is-actually-there`);
    expect(missingRequiredLinks(body, { version, repo })).toEqual([]);
  });

  it('matches release titles with any of the accepted separators and no others', () => {
    const pattern = releaseTitlePattern('2026.9.9');
    for (const title of ['AIWG 2026.9.9 — Say it', 'AIWG 2026.9.9: Say it', 'AIWG 2026.9.9 - Say it', 'AIWG 2026.9.9 – Say it']) {
      expect(pattern.test(title)).toBe(true);
    }
    expect(pattern.test('AIWG 2026.9.90 — other')).toBe(false);
    expect(pattern.test('AIWG 2026.9.8 — other')).toBe(false);
  });

  it('requires exactly one matching discussion with every link', () => {
    const node = { title: 'AIWG 2026.9.9 — Say it', body: goodBody, url: 'https://github.com/jmagly/aiwg/discussions/199' };
    expect(verifyDiscussion([node, { title: 'AIWG 2026.9.7 — other', body: '', url: 'x' }], { version, repo })).toBe(node);
    expect(() => verifyDiscussion([], { version, repo })).toThrow(/found 0/);
    expect(() => verifyDiscussion([node, { ...node, url: 'dup' }], { version, repo })).toThrow(/found 2/);
    expect(() => verifyDiscussion([{ ...node, body: 'no links' }], { version, repo })).toThrow(/missing required links/);
  });

  it('parses and normalizes the verifier arguments', () => {
    expect(parseVerifyArgs(['--version', 'v2026.9.9'])).toEqual({ repo, category: 'Announcements', version });
    expect(() => parseVerifyArgs(['--version', '1.2'])).toThrow(/CalVer/);
    expect(() => parseVerifyArgs(['--bogus', 'x'])).toThrow(/Usage/);
  });
});

describe('publish-github-release-discussion', () => {
  it('parses publisher arguments with defaults derived from the version', () => {
    const options = parsePublishArgs(['--version', version, '--body', 'draft.md', '--evidence-dir', '/tmp/e', '--dry-run']);
    expect(options).toMatchObject({
      version,
      tag: 'v2026.9.9',
      body: 'draft.md',
      evidenceDir: '/tmp/e',
      dryRun: true,
      update: false,
      repo,
      category: 'Announcements',
      announcement: 'docs/releases/v2026.9.9-announcement.md',
    });
    expect(() => parsePublishArgs(['--version', version])).toThrow(/--body/);
    expect(() => parsePublishArgs(['--body', 'x'])).toThrow(/CalVer/);
  });

  it('derives and validates the discussion title from the announcement H1', () => {
    const title = titleFromAnnouncement('# AIWG 2026.9.9 — Say what is actually there\n\n**Release date:** 2026-09-13\n');
    expect(validateTitle(title, version)).toBe('AIWG 2026.9.9 — Say what is actually there');
    expect(() => titleFromAnnouncement('no heading')).toThrow(/H1/);
    expect(() => validateTitle('Release 2026.9.9', version)).toThrow(/must start with "AIWG 2026.9.9"/);
  });

  it('rejects bodies that miss required links or carry AI attribution', () => {
    expect(validateBody(goodBody, { version, repo })).toBe(goodBody);
    expect(() => validateBody('just prose', { version, repo })).toThrow(/missing required links/);
    expect(() => validateBody(`${goodBody}\n\n🤖 Generated with Claude Code`, { version, repo })).toThrow(/AI attribution/);
    expect(findAttribution('Co-Authored-By: Claude <noreply@anthropic.com>')).toHaveLength(1);
    expect(findAttribution('The claude provider tree is regenerated.')).toEqual([]);
  });

  it('plans create, reuse, or update idempotently from existing discussions', () => {
    const existing = { id: 'D_1', title: 'AIWG 2026.9.9 — Say it', body: goodBody, url: 'u' };
    expect(planAction({ existing: [], body: goodBody, update: false, version, repo })).toEqual({ action: 'create' });
    expect(planAction({ existing: [existing], body: goodBody, update: false, version, repo })).toEqual({ action: 'reuse', existing });
    expect(planAction({ existing: [existing], body: goodBody, update: true, version, repo })).toMatchObject({ action: 'update', existing });
    expect(planAction({ existing: [{ ...existing, body: 'stale' }], body: goodBody, update: false, version, repo }))
      .toMatchObject({ action: 'update', reason: /missing required links/ });
    expect(() => planAction({ existing: [existing, existing], body: goodBody, update: false, version, repo })).toThrow(/duplicates/);
  });

  it('filters existing discussions to the requested version only', () => {
    const nodes = [
      { title: 'AIWG 2026.9.9 — Say it' },
      { title: 'AIWG 2026.9.7 — Only what the run owns' },
      { title: 'Tip: Name MCP servers' },
    ];
    expect(findExistingDiscussions(nodes, version).map(({ title }) => title)).toEqual(['AIWG 2026.9.9 — Say it']);
  });
});
