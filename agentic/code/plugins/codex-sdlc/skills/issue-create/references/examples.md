# Issue creation examples

## Examples

### Example 1: Create Feature Request (Gitea)

**Request**:
```bash
Create a high-priority feature issue titled "Add dark mode" with body "Implement theme toggle for light/dark mode preferences" and labels "feature,ui".
```

**Config** (`.aiwg/config.yaml`):
```yaml
ticketing:
  provider: gitea
  url: https://git.integrolabs.net
  owner: roctinam
  repo: ai-writing-guide
```

**Output**:
```
✅ Issue created: ISSUE-42

View at: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42

**Title**: Add dark mode
**Status**: open
**Priority**: high
**Labels**: feature, ui
**Assignee**: unassigned

## Next Steps

- View ticket: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42
- Update status by loading `issue-update` for ISSUE-42.
- Add comments through `issue-update`.
- List feature tickets by loading `issue-list`.
```

### Example 2: Create Bug Report with Regression Check (Local)

**Request**:
```bash
Create a critical bug issue titled "Login broken after deployment" with body "Users unable to authenticate since v2.1.4 deployment" and run the regression check.
```

**Output**:
```
⏳ Running regression check...
✓ Regression analysis complete: 2 critical regressions detected

✅ Issue created: ISSUE-003

File: .aiwg/issues/ISSUE-003.md

**Title**: Login broken after deployment
**Status**: open
**Priority**: critical
**Labels**: bug, critical, regression-confirmed
**Assignee**: unassigned

⚠️ **Regression Detected**: 2 critical regressions found
   - Authentication validation failing at token refresh
   - Session state not persisting across requests

**Regression Report**: .aiwg/issues/ISSUE-003-regression-report.md

## Next Steps

- View ticket: cat .aiwg/issues/ISSUE-003.md
- View regression details: cat .aiwg/issues/ISSUE-003-regression-report.md
- Update status by loading `issue-update` for ISSUE-003.
- Run regression analysis through the regression-check capability.
- List regression issues by loading `issue-list`.
```

### Example 3: Create Task with Assignee (GitHub)

**Request**:
```bash
Create an issue titled "Security audit" with body "Run penetration test on authentication endpoints", assign security-team, add labels "security,high-priority", and set milestone "Q1-2026".
```

**Config** (`CLAUDE.md`):
```markdown
## Issueing Configuration

- **Provider**: github
- **Owner**: jmagly
- **Repo**: ai-writing-guide
```

**Output**:
```
✅ Issue created: #128

View at: https://github.com/jmagly/aiwg/issues/128

**Title**: Security audit
**Status**: open
**Priority**: medium (default)
**Labels**: security, high-priority
**Assignee**: @security-team
**Milestone**: Q1-2026

## Next Steps

- View ticket: gh issue view 128
- Update status by loading `issue-update` for #128.
- Add comments through `issue-update`.
- List security tickets by loading `issue-list`.
```

### Example 4: Bug Report with Auto-Detected Regression Check

**Request**:
```bash
Create a payments bug issue titled "Payment calculation incorrect" with body "Discount not applying for orders > $1000".
```

**Output**:
```
ℹ️ Bug report detected, running automatic regression check...
⏳ Running regression check against baseline main...
✓ Regression confirmed: Introduced in commit abc1234

✅ Issue created: ISSUE-025

**Title**: Payment calculation incorrect
**Status**: open
**Priority**: critical (escalated due to regression)
**Labels**: bug, payments, regression-confirmed
**Assignee**: unassigned

⚠️ **Regression Confirmed**:
   - Introduced in: commit abc1234 (2026-01-15)
   - Root cause: Integer division in discount calculation
   - Blast radius: 12 unit tests, 3 integration tests affected

**Actions**:
   - Priority escalated to CRITICAL
   - Regression analyst assigned
   - Full report attached

**Regression Report**: .aiwg/issues/ISSUE-025-regression-report.md

## Next Steps

- View regression analysis: cat .aiwg/issues/ISSUE-025-regression-report.md
- Assign to developer: `/issue-update ISSUE-025 --assignee developer-name`
- Review introducing commit: git show abc1234
- Run targeted regression tests: npm test -- --grep "discount calculation"
```

