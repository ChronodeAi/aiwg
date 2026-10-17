<!-- PR template — adapted from AIWG conventions. See CONTRIBUTING.md for full policy. -->

## Summary

What changed and why, in one short paragraph.

## Linked issues

- Closes #
- Refs #

## Changes

- Bullet list of meaningful changes (not file count). Reference exact file paths or symbols where helpful.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` passes (or specific suite: …)
- [ ] CI green on this branch / commit
- [ ] Manual verification: <what was checked>

## Risk and rollback

- **Risk**: low / medium / high — and why
- **Rollback**: how to revert (commit revert, env flag, config change)

## Policy reminders

- **Delivery mode**: confirm matches `.aiwg/aiwg.config` `delivery.mode` (direct / feature-branch / pr-required). For `direct`, use `Closes #N` in the commit, not a separate PR.
- **No AI attribution**: no `Co-Authored-By` / "Generated with" lines. The AI is a tool, not an author.
- **Verify locally; CI after merge**: PRs do not run CI. Build and test locally before merging, and confirm the post-merge run on `main` is green; fix failures forward.

## Documentation

- [ ] CHANGELOG updated (if user-visible)
- [ ] Release notes / announcement updated (if releasing)
- [ ] Affected agent/skill/rule docs updated
