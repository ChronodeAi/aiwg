# Forensics Framework

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

You're investigating an incident. You have a compromised host, a cloud account with suspicious activity, or a container that shouldn't be running. You need structured investigation that doesn't miss steps, evidence that's preserved correctly, and a report you can hand to someone else.

The forensics framework covers the DFIR workflow: target profiling, volatile
data capture, evidence acquisition, multi-source analysis, timeline
reconstruction, IOC extraction, and reporting. It is designed to help you keep
evidence handling explicit and reviewable.

Each section below starts with what you can ask your assistant, then gives the command reference. Every command is kept exactly as shipped.

---

## Before You Start

Complete [Install, Connect, and Verify](install-connect-verify.md) first. If
you intentionally run a targeted deployment instead of the complete system,
`aiwg use forensics` remains the manual command for this framework.

The first useful result should be a target profile, triage capture plan,
timeline, IOC register, or report with custody notes and evidence references.

---

## The investigation workflow

```
profile → triage → acquire → analyze → timeline → report
```

Each phase has a dedicated command. You can run the full pipeline or jump to any stage.

---

## Starting an investigation

### Full investigation from scratch

> "Investigate this host from scratch. Preserve evidence with custody notes and save a report I can hand to someone else."

Your assistant profiles the target first, then guides structured analysis through each phase.

> "Scope it to volatile data and logs first. Do not touch disk evidence yet."

Your assistant narrows the run to triage capture and names what still needs review.

#### Command reference — full investigation

```bash
/forensics-investigate ssh://user@host:port --scope full
```

This orchestrates the entire workflow. The agent profiles the target first, then guides structured analysis through each phase.

Where the investigator briefs an analysis agent, the brief names the goal, inputs, boundaries, result, and success check:

**Agent-to-agent brief (example):**

```brief
Goal: capture volatile data from the target host. Inputs: target profile and SSH access. Boundaries: read-only capture; no disk writes. Result: triage bundle with hashes and custody notes. Success check: process list, network state, and memory maps are present with verified hashes.
```

### Quick triage (volatile data first)

> "Triage this host now. Capture volatile data first and tell me what you preserved."

Your assistant captures volatile data before anything else, because it disappears on reboot or shutdown.

RFC 3227 requires capturing volatile data before anything else — running processes, network connections, memory maps — because they disappear on reboot or shutdown.

#### Command reference — triage

```bash
/forensics-triage ssh://user@host:port
```

This captures network state, process list, memory maps, deleted-but-running binaries, and kernel modules before touching disk.

### Just profile a target

> "Profile this target before we investigate. Tell me what is actually on the system."

Your assistant builds a target profile that parameterizes all subsequent analysis.

Before investigating, understand what you're dealing with:

#### Command reference — profile

```bash
/forensics-profile ssh://user@host:port
```

Produces a target profile: OS, services, users, filesystem layout, installed tools available for forensics. This profile parameterizes all subsequent analysis so the framework adapts to what's actually on the system.

---

## Analysis agents

> "Which analysis agent should handle these logs, and what will it return?"

Your assistant matches the evidence to a specialist agent and states what that agent returns.

Each analysis type has a specialist agent:

| Agent | What it does |
|-------|-------------|
| `triage-agent` | Volatile data capture, RFC 3227 ordering |
| `acquisition-agent` | Evidence collection, hash verification, chain of custody |
| `log-analyst` | auth.log, syslog, journal, application log parsing |
| `network-analyst` | Traffic analysis, C2 detection, lateral movement |
| `persistence-hunter` | Cron, systemd, SSH keys, PAM modules, kernel modules |
| `memory-analyst` | Volatility 3: process analysis, rootkit detection, credential extraction |
| `container-analyst` | Docker, containerd, Kubernetes forensics |
| `cloud-analyst` | AWS/Azure/GCP audit logs, IAM review, API anomalies |
| `ioc-analyst` | IOC extraction, enrichment, STIX 2.1 formatting |
| `timeline-builder` | Multi-source event correlation, chronological reconstruction |

---

## Building an event timeline

> "Build an event timeline from the collected evidence. Show me what happened when and in what order."

Your assistant correlates events from multiple sources into a single chronological timeline with attribution.

> "Rebuild the timeline using only auth logs and syslog, and flag gaps."

Your assistant narrows the sources and marks what is still missing.

After evidence is collected, correlate events from multiple sources:

### Command reference — timeline

```bash
/forensics-timeline .aiwg/forensics/findings/target-2026-03-25/
```

This correlates auth logs, syslog, journal, filesystem timestamps, and application logs into a single chronological timeline with attribution. Essential for establishing what happened when and in what order.

---

## IOC extraction

> "Extract indicators of compromise from the collected evidence. Save a register I can import into my SIEM."

Your assistant extracts indicators from all collected evidence and formats them for threat intel sharing.

> "Limit the register to high-confidence network indicators and exclude file hashes."

Your assistant re-extracts against the narrower evidence set.

Extract indicators of compromise from all collected evidence and format them for threat intel sharing:

### Command reference — IOC extraction

```bash
/forensics-ioc .aiwg/forensics/findings/
```

Produces a STIX 2.1 IOC register with IPs, domains, file hashes, registry keys, and behavioral indicators. Ready to import into your SIEM or share with your team.

---

## Threat hunting

> "Hunt for this threat across the collected logs and show me matching activity."

Your assistant applies Sigma rules against collected logs to surface matching activity.

If you suspect a specific threat but haven't found it yet:

### Command reference — threat hunting

```bash
/forensics-hunt --sigma-rules apt29,cobalt-strike
```

Applies Sigma rules against collected logs to surface matching activity. The `sigma-hunting` skill runs against whatever evidence is in scope.

---

## Generating the report

> "Write the forensic report from this investigation. Include findings, timeline, IOCs, and remediation steps."

Your assistant produces a structured forensic report with executive summary, technical findings, event timeline, IOC register, and remediation recommendations.

> "Also make a short executive version for non-technical stakeholders."

Your assistant renders the same findings in the shorter format.

When the investigation is complete:

### Command reference — reporting

```bash
/forensics-report .aiwg/forensics/ --format full
```

Produces a structured forensic report with executive summary, technical findings, event timeline, IOC register, and remediation recommendations. The `--format executive` flag produces a shortened version for non-technical stakeholders.

---

## Cloud investigations

> "Investigate suspicious IAM activity in this AWS account. Work from the audit logs and flag what needs operator review."

Your assistant covers audit log collection, IAM review, network flow analysis, and API activity anomaly detection across all three major providers.

For AWS, Azure, or GCP incidents:

### Command reference — cloud investigations

```
Investigate suspicious IAM activity in this AWS account
```

```
Review CloudTrail logs for credential theft indicators
```

The `cloud-analyst` agent covers audit log collection, IAM review, network flow analysis, and API activity anomaly detection across all three major providers.

---

## Container investigations

> "Analyze this container for privilege escalation vectors and report what you find."

Your assistant covers Docker and containerd configuration, image layer analysis, volume and network inspection, and Kubernetes API server audit logs.

For compromised containers or Kubernetes clusters:

### Command reference — container investigations

```
Analyze this container for privilege escalation vectors
```

```
Review the Kubernetes cluster for unauthorized workloads
```

The `container-analyst` agent covers Docker and containerd configuration, image layer analysis, volume and network inspection, and Kubernetes API server audit logs.

---

## Evidence handling

> "Show me the custody record for this evidence and verify its integrity."

Your assistant reads the documented chain of custody and runs integrity verification against acquisition records.

All evidence collection follows chain of custody procedures:

- SHA-256 hashes verified at acquisition
- Chain of custody documented in `.aiwg/forensics/custody/`
- Evidence packaged following OAIS standards
- Integrity verification available at any point via `/verify-archive`

---

## Key references

- `/forensics-status` — Current investigation status dashboard
- `/forensics-acquire` — Evidence acquisition with chain of custody
- `/forensics-profile` — Build target system profile
- `@agentic/code/frameworks/forensics-complete/README.md` — Full framework documentation
