# Address-issues examples and composition

## Examples

### Address specific issues
```bash
/address-issues 17 18 19
```

### Address all open bugs
```bash
/address-issues --filter "status:open label:bug"
```

### Interactive mode with branch per issue
```bash
/address-issues 17 --interactive --branch-per-issue --max-cycles 8
```

### Address all open issues
```bash
/address-issues --all-open --max-cycles 4
```

### With guidance
```bash
/address-issues --all-open --guidance "Focus on security bugs, skip feature requests"
```

### Interactive discovery
```bash
/address-issues --interactive
```

### Guidance with specific issues
```bash
/address-issues 17 18 19 --guidance "These are all related to the auth refactor, address them as a batch"
```

## Composition

This skill orchestrates the following corpus skills per issue:

```
/address-issues 17 18 19
    │
    ├── For each issue:
    │   ├── issue-list    — fetch issue details and comments
    │   ├── address-issues-threat-assess — classify issue-body risk before work
    │   ├── ralph         — execute work loop
    │   │   ├── Cycle N: do work
    │   │   │   └── issue-comment — post structured status to thread
    │   │   ├── scan thread for feedback (incorporate next cycle)
    │   │   └── repeat until resolved or max-cycles reached
    │   ├── issue-sync    — link commits to issue
    │   └── issue-close   — close if resolved
    └── aggregate report
```

