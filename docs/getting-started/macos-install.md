# macOS Install Guide

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

Use this guide when installing AIWG on a Mac, especially if `npm install -g aiwg`
fails with `EACCES` under `/usr/local/lib/node_modules`. Each section starts with what you can ask your assistant, then gives the command reference.

For the complete agent/steward setup path after the Mac install succeeds, see
the [Agentic Install Runbook](../agentic-install-runbook.md).

Verified against the npm and Node.js documentation on 2026-06-02:

- npm recommends installing Node.js and npm with a Node version manager such as
  `nvm` because installer-managed global directories can cause permission errors:
  <https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/>
- npm's current `EACCES` recovery guide recommends either using a Node version
  manager or changing npm's global prefix to a user-owned directory:
  <https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/>
- The Node.js download page lists Node 24 as the current LTS line on
  2026-06-02. AIWG requires Node 24 or newer; use Node 24:
  <https://nodejs.org/en/download>

## Recommended Path: nvm

> "Install Node 24 with nvm on this Mac and then install AIWG globally. Stop if anything needs confirmation."

Your assistant installs Node through the version manager to avoid root-owned global directories, then installs and verifies AIWG.

This avoids root-owned global npm directories and works on both Intel and Apple
Silicon Macs.

### Command reference

```bash
# Install nvm. Check https://github.com/nvm-sh/nvm for the newest command.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Load nvm in the current zsh session.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Install current LTS Node.js and AIWG.
nvm install 24
nvm use 24
npm install -g aiwg

# Verify.
node --version
npm --version
aiwg --version
```

```bash
source ~/.zshrc
```

```bash
touch ~/.zshrc
```

If `nvm: command not found` appears after the install script, open a new terminal
or run:

```bash
source ~/.zshrc
```

If `~/.zshrc` does not exist, create it and rerun the nvm installer:

```bash
touch ~/.zshrc
```

Refinement prompt:

> "nvm is still not found after a new terminal. Check my shell startup files and tell me what to source."

Your assistant checks the shell startup files and names the exact source step.

## If Node Is Already Installed and npm Fails With EACCES

> "npm fails with EACCES under /usr/local/lib/node_modules. Fix it without sudo and verify AIWG installs."

Your assistant applies npm's user-prefix recovery and verifies the global install without using sudo.

This error means npm is trying to write global packages into a directory your
user does not own, commonly `/usr/local/lib/node_modules`.

```text
npm ERR! code EACCES
npm ERR! syscall mkdir
npm ERR! path /usr/local/lib/node_modules/aiwg
```

Use npm's current user-prefix recovery:

### Command reference

```bash
npm config set prefix ~/.local
echo 'PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
echo 'source ~/.profile' >> ~/.zprofile
source ~/.profile

npm install -g aiwg
aiwg --version
```

Do not use `sudo npm install -g aiwg` as the default fix. It may install AIWG
once, but it can leave root-owned npm files that cause later upgrades and global
package installs to fail.

## Homebrew Path

> "I already manage tools with Homebrew. Install Node 24 that way and verify AIWG."

Your assistant checks that the Homebrew prefix is user-writable and first in `PATH`, then installs and verifies.

Homebrew is acceptable if the Homebrew prefix is user-writable and first in
`PATH`. It is most useful for users who already manage developer tools with
Homebrew.

### Command reference

```bash
brew install node@24
brew link --overwrite node@24
npm install -g aiwg
aiwg --version
```

If Homebrew Node still sends npm global installs to `/usr/local/lib/node_modules`
and fails with `EACCES`, use the `~/.local` npm prefix recovery above or switch
to `nvm`.

## Optional native features (Xcode Command Line Tools)

> "Do I need Xcode tools for the base AIWG install, and when would I install them?"

Your assistant explains that the base install needs no build tools and names the opt-in features that would require them.

AIWG's **base install never needs build tools** — its native dependencies
(`better-sqlite3`, `node-pty`, `hnswlib-node`) are `optionalDependencies` that
ship prebuilt macOS binaries and are skipped silently if they can't install. The
CLI, `aiwg use`, and all the text-based tooling work without them.

A few **opt-in** features use native modules: the SQLite graph backend
(`better-sqlite3`), semantic search / embeddings (`@xenova/transformers` +
`onnxruntime-node`, installed on demand), and PDF page rasterization for
vision extraction (poppler `pdftoppm`). These normally use prebuilt binaries on
Mac. If one ever fails to build (an unusual Node version, or a module without a
matching prebuilt), install Apple's Command Line Tools and retry:

### Command reference

```bash
xcode-select --install        # one-time; provides the C/C++ toolchain
npm rebuild better-sqlite3     # or re-run the opt-in install that failed
```

For PDF rasterization specifically (`aiwg corpus vision-extract --rasterize`),
install poppler via Homebrew:

```bash
brew install poppler
```

## After AIWG Installs

> "AIWG installed. Deploy it to my project and audit the result."

Your assistant deploys from the project root, runs the index, context, and readiness checks, and points to the explicit audit when recovery is needed.

Deploy AIWG from the project root:

### Command reference

```bash
cd /path/to/your/project
aiwg use all --provider <provider>
```

`aiwg use` performs the index, context, and readiness checks itself. Use
`aiwg status --probe --json` for an explicit audit or `aiwg doctor` when the
result identifies a recovery step.

If `npm install -g aiwg` succeeds but `aiwg` is not found, check npm's global
binary directory:

### Command reference — PATH recovery

```bash
npm config get prefix
echo "$PATH"
```

The `bin` directory under the npm prefix must be in `PATH`. For the `~/.local`
prefix, that means:

```bash
echo 'PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
source ~/.zprofile
```
