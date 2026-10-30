import fs from "node:fs/promises";
import { mkdtempSync } from 'node:fs';
import os from "node:os";
import path from "node:path";
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  LinuxSecretServiceStore,
  MacOsKeychainStore,
  WindowsCredentialManagerStore,
  defaultCommandRunner,
  type CommandRunner,
} from "../../../src/auth/credential-store.js";

const credentials = {
  accessToken: "aiwg_at_fixture_access",
  refreshToken: "aiwg_rt_fixture_refresh",
  tokenType: "Bearer" as const,
  scope: ["releases:read"],
  expiresAt: "2030-01-01T00:00:00.000Z",
};
const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true }))));

describe("credential stores", () => {
  it('keeps synthetic values out of helper env, argv and child-process debug output', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-store-child-environment-')); temporary.push(root);
    const runner = path.join(root, 'runner.mjs');
    const helper = path.join(root, 'helper.mjs');
    const marker = 'synthetic-store-child-sensitive-value';
    const moduleUrl = pathToFileURL(path.resolve('dist/src/auth/credential-store.js')).href;
    await fs.writeFile(helper, `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ env: process.env, argv: process.argv, received: input.length > 0 }));
      });
    `);
    await fs.writeFile(runner, `
      import { defaultCommandRunner } from ${JSON.stringify(moduleUrl)};
      const result = await defaultCommandRunner(process.execPath, [${JSON.stringify(helper)}], process.env.SYNTHETIC_AUTH_INPUT);
      process.stdout.write(JSON.stringify(result));
    `);
    const result = spawnSync(process.execPath, [runner], {
      encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: root, NODE_DEBUG: 'child_process', SYNTHETIC_AUTH_INPUT: marker, UNRELATED_SECRET: marker },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(marker);
    expect(result.stderr).not.toContain(marker);
    const commandResult = JSON.parse(result.stdout);
    expect(commandResult.exitCode).toBe(0);
    const observed = JSON.parse(commandResult.stdout);
    expect(observed.received).toBe(true);
    expect(observed.env.SYNTHETIC_AUTH_INPUT).toBeUndefined();
    expect(observed.env.UNRELATED_SECRET).toBeUndefined();
    expect(observed.env.NODE_DEBUG).toBeUndefined();
    expect(observed.argv).toEqual([process.execPath, helper]);
  });

  it("does not surface EPIPE when a credential helper exits before consuming stdin", async () => {
    const result = await defaultCommandRunner(
      process.execPath,
      ["-e", "process.exit(0)"],
      "x".repeat(8 * 1024 * 1024),
    );
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ["macOS", (run: CommandRunner) => new MacOsKeychainStore(run)],
    ["Linux", (run: CommandRunner) => new LinuxSecretServiceStore(run)],
    ["Windows", (run: CommandRunner) => new WindowsCredentialManagerStore(run)],
  ])("passes %s credential payload through stdin, never argv", async (_name, factory) => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await factory(run).save(credentials);
    const [, args, stdin] = run.mock.calls[0];
    expect(args.join(" ")).not.toContain(credentials.accessToken);
    expect(args.join(" ")).not.toContain(credentials.refreshToken);
    expect(stdin).toContain(credentials.accessToken);
  });

  it("requires explicit opt-in and enforces a private regular file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiwg-auth-test-")); temporary.push(root);
    const pathname = path.join(root, "credentials.json");
    await expect(new FileCredentialStore(pathname, false).save(credentials)).rejects.toThrow(/allow-file-store/i);
    const store = new FileCredentialStore(pathname, true);
    await store.save(credentials);
    expect((await fs.stat(pathname)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual(credentials);
    await fs.chmod(pathname, 0o644);
    await expect(store.load()).rejects.toThrow(/0600/);
  });
});
