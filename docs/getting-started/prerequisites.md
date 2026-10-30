# Prerequisites

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

Before installing AIWG, ensure you have the following requirements. Each section starts with what you can ask your assistant, then gives the command reference.

## Required

> "Check whether this computer meets the AIWG prerequisites. Do not change anything yet, just report Node, npm, platform, and Git."

Your assistant checks the installed versions against the requirements below and reports what is missing before changing anything.

### Node.js ≥24

> "Check my Node.js and npm versions against the AIWG floor and tell me the safest next step if they fall short."

Your assistant compares `node --version` and `npm --version` against the Node 24 floor and points to the platform-specific install guide.

AIWG requires Node 24 or newer. Node 24 is the standard runtime for all installs.

Contributor and release workflows have stricter npm requirements:

| Use case | Requirement | Why |
|----------|-------------|-----|
| Install and run AIWG | Node 24+ | Matches the package `engines.node` floor |
| Change dependencies or regenerate lockfiles | npm 11.5+ | Required for the committed `min-release-age=7` gate |
| Publish AIWG releases | Node 24 in the release workflow | Current npm 11.x plus npm trusted-publishing support |

Reuse a healthy Node version manager if one is already installed. Do not stack
`nvm`, `fnm`, `asdf`, `mise`, Volta, or another manager. If no manager exists,
the new-user defaults are `nvm-sh` on macOS, Linux, and WSL, and `nvm-windows`
on native Windows. See [Install Node.js and npm Safely](install-node.md) for
the platform-specific checks and official installation sources.

macOS users should start with the [macOS Install Guide](macos-install.md).
npm's own documentation recommends a Node version manager on macOS to avoid
global-package permission errors such as `EACCES` under `/usr/local/lib/node_modules`.

Refinement prompt:

> "Node and npm come from different installations. Tell me which PATH entries conflict and the safest supported fix."

### Command reference

```bash
node --version  # Should show v24.x.x or higher
npm --version
```

### AI Platform (Choose One or More)

> "I have Node 24. Which AI platform should I use with AIWG, and where do I get it?"

Your assistant matches your tools to a platform below and points to its install source.

| Platform | Best For | Install |
|----------|----------|---------|
| **Claude Code** | Multi-agent orchestration, artifact generation | [claude.ai/code](https://claude.ai/code) |
| **Warp Terminal** | Terminal-native AI, command-line workflows | [warp.dev](https://www.warp.dev/) |
| **Factory AI** | Custom droid workflows | [factory.ai](https://factory.ai/) |
| **Cursor** | IDE-native rules | [cursor.sh](https://cursor.sh/) |
| **GitHub Copilot** | GitHub integration | VS Code extension |

After Node and an AI platform are available, continue with
[Install, Connect, and Verify](install-connect-verify.md). Teams that use more
than one provider can repeat the deployment step for each provider:

### Command reference

```bash
aiwg use all --provider claude
aiwg use all --provider warp
aiwg use all --provider factory
aiwg use all --provider cursor
```

## Provider Deployment Surface

> "Which provider surface does my AI tool use, and what files will AIWG write for it?"

Your assistant names the deployment surface below for your platform and what AIWG connects on `aiwg use`.

| Platform | Notes |
|----------|-------|
| **Claude Code** | Multi-agent orchestration and native plugin paths |
| **GitHub Copilot** | `copilot-instructions.md` and GitHub-facing context |
| **Warp Terminal** | Terminal-native workflows |
| **Factory AI** | Native droid format and `AGENTS.md` |
| **OpenCode** | `AGENTS.md` and OpenCode paths |
| **Cursor** | Native rules format and `AGENTS.md` |
| **OpenAI/Codex** | Native prompts format and `AGENTS.md` |
| **Devin Desktop** | Uses the `.windsurf/` compatibility adapter; select with `devin` |

## Operating Systems

> "Is my operating system supported for AIWG?"

Your assistant confirms support from the matrix below.

| OS | Status |
|----|--------|
| **macOS** (Intel + Apple Silicon) | ✅ Supported |
| **Linux** (Ubuntu, Debian, Fedora, Arch, RHEL) | ✅ Supported |
| **WSL2** (Windows Subsystem for Linux) | ✅ Supported |
| **Native Windows** (PowerShell) | ✅ Supported |

## Optional (Recommended)

### Git

> "Do I need Git for AIWG, and how do I check it?"

Your assistant checks `git --version` and reports whether scaffolding and version control need it.

Required for `aiwg -new` project scaffolding and version control.

### Command reference

```bash
git --version

# Install if needed:
# macOS: brew install git
# Ubuntu: sudo apt-get install git
# Fedora: sudo dnf install git
```

## Quick Compatibility Check

> "Run the AIWG compatibility check and tell me what to install next."

Your assistant runs each check below and names the next install step for anything missing.

### Command reference

```bash
# Check Node.js and npm
node --version && echo "Node.js present" || echo "Node.js missing"
npm --version && echo "npm present" || echo "npm missing"

# Check Claude Code (if using)
claude --version 2>/dev/null && echo "✅ Claude Code" || echo "ℹ️ Claude Code not installed"

# Check Factory AI (if using)
factory --version 2>/dev/null && echo "✅ Factory AI" || echo "ℹ️ Factory AI not installed"

# Check Git (optional)
git --version && echo "✅ Git" || echo "ℹ️ Git optional"
```

**All checks passed?** Continue to [Install, Connect, and Verify](install-connect-verify.md).
