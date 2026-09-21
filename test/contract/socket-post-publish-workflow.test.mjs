import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publishWorkflow = readFileSync(
  path.join(ROOT, '.github/workflows/npm-publish.yml'),
  'utf8',
);
const socketWorkflow = readFileSync(
  path.join(ROOT, '.github/workflows/socket-post-publish.yml'),
  'utf8',
);

test('npm publication invokes the release-tag Socket workflow', () => {
  assert.match(
    publishWorkflow,
    /publish-to-npmjs-org:[\s\S]*?outputs:\s*\n\s*version: \$\{\{ steps\.version\.outputs\.version \}\}/,
  );
  assert.match(
    publishWorkflow,
    /socket-post-publish:[\s\S]*?needs: publish-to-npmjs-org[\s\S]*?uses: \.\/\.github\/workflows\/socket-post-publish\.yml/,
  );
  assert.match(
    publishWorkflow,
    /version: \$\{\{ needs\.publish-to-npmjs-org\.outputs\.version \}\}/,
  );
  assert.match(publishWorkflow, /commit: \$\{\{ github\.sha \}\}/);
  assert.match(
    publishWorkflow,
    /SOCKET_API_TOKEN: \$\{\{ secrets\.SOCKET_API_TOKEN \}\}/,
  );
});

test('Socket uses exact call inputs instead of default-branch workflow_run', () => {
  assert.match(socketWorkflow, /workflow_call:/);
  assert.doesNotMatch(socketWorkflow, /workflow_run:/);
  assert.match(socketWorkflow, /workflow_dispatch:/);
  assert.match(socketWorkflow, /ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/);
  assert.match(
    socketWorkflow,
    /if \[ "\$RELEASE_REF" != "refs\/tags\/v\$\{VERSION\}" \]; then/,
  );
  assert.match(
    socketWorkflow,
    /TAG_COMMIT="\$\(git -c safe\.directory="\$GITHUB_WORKSPACE" rev-parse "\$\{RELEASE_REF\}\^\{commit\}"\)"/,
  );
  assert.match(
    socketWorkflow,
    /if \[ "\$TAG_COMMIT" != "\$EXPECTED_COMMIT" \]; then/,
  );
  assert.match(
    socketWorkflow,
    /if \[ "\$ACTUAL_COMMIT" != "\$TAG_COMMIT" \]; then/,
  );
});

test('Socket scanner evidence remains fail closed', () => {
  assert.match(socketWorkflow, /continue-on-error: true/);
  assert.match(socketWorkflow, /if: always\(\)/);
  assert.match(socketWorkflow, /Stage: release-binding/);
  assert.match(socketWorkflow, /Stage: dependency-inventory/);
  assert.match(socketWorkflow, /Stage: socket-audit/);
  assert.match(socketWorkflow, /path: \$\{\{ runner\.temp \}\}\/socket-post-publish\//);
  assert.match(
    socketWorkflow,
    /if \[ "\$AUDIT_OUTCOME" != "success" \]; then[\s\S]*?exit 1/,
  );
});
