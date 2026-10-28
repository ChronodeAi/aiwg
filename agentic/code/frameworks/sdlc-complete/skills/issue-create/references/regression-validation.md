# Regression detection and configuration validation

### Step 3: Regression Detection (for Bug Reports)

**Trigger conditions**:
- Explicit: `--check-regression` flag provided
- Automatic: `--labels` contains "bug" OR "regression"
- Type: Issue is categorized as bug/defect

**Regression check process**:

```bash
# Detect if regression check should run
if [[ "$LABELS" == *"bug"* ]] || [[ "$LABELS" == *"regression"* ]] || [[ "$CHECK_REGRESSION" == "true" ]]; then
  echo "⏳ Running regression check..."

  # Run regression check against main branch
  /regression-check --baseline main --scope changed-files --format summary > /tmp/regression-results.md

  # Parse results
  REGRESSION_DETECTED=$(grep "REGRESSIONS DETECTED" /tmp/regression-results.md)

  if [ -n "$REGRESSION_DETECTED" ]; then
    # Escalate priority and add labels
    PRIORITY="critical"
    LABELS="${LABELS},regression-confirmed"

    # Extract regression details for issue body
    REGRESSION_SUMMARY=$(sed -n '/### Critical Regressions/,/###/p' /tmp/regression-results.md)

    # Append to description
    DESCRIPTION="${DESCRIPTION}

---

## Regression Analysis

${REGRESSION_SUMMARY}

**Full Report**: See attached regression-results.md"
  else
    # No regression detected
    LABELS="${LABELS},no-regression"
  fi
fi
```

**Impact on issue creation**:

| Regression Status | Priority | Labels | Action |
|-------------------|----------|--------|--------|
| REGRESSION DETECTED | Critical | bug, regression-confirmed | Escalate, include analysis |
| NO REGRESSION | Original | bug, no-regression | Standard bug workflow |
| CHECK FAILED | Original | bug, regression-check-failed | Create issue, note failure |

### Step 4: Validate Configuration

**For each provider, validate required fields**:

**Gitea**:
- [ ] `url` present and valid URL
- [ ] `owner` present
- [ ] `repo` present
- [ ] Token file exists and readable

**GitHub**:
- [ ] `owner` present
- [ ] `repo` present
- [ ] `gh` CLI installed (`which gh`)
- [ ] `gh` authenticated (`gh auth status`)

**Jira**:
- [ ] `url` present and valid URL
- [ ] `owner` (project key) present
- [ ] `JIRA_API_TOKEN` environment variable set

**Linear**:
- [ ] `url` present (default: `https://api.linear.app`)
- [ ] `owner` (team ID) present
- [ ] `LINEAR_API_TOKEN` environment variable set

**Local**:
- [ ] `.aiwg/issues/` directory exists or can be created
- [ ] Directory is writable

**Error handling**:
- If validation fails, report error and suggest fix
- Optionally fall back to `local` provider with warning

