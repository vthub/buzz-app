import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads the broker's Vite config without native-compatibility warnings", () => {
  // A fresh Node process exercises real config imports, not Vitest's resolver.
  // Loading config creates the plugin but never invokes configureServer, so it
  // cannot read the Keychain, open a server, or contact a relay.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
          import assert from 'node:assert/strict';
          import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
          import { tmpdir } from 'node:os';
          import { join } from 'node:path';
          import { loadConfigFromFile } from 'vite';
          const configFile = join(process.cwd(), 'vite.config.ts');
          // Load the real config with isolated .env files, never personal settings.
          const directory = mkdtempSync(join(tmpdir(), 'buzz-vite-config-'));
          const cwd = process.cwd();
          try {
            process.chdir(directory);
            const loaded = await loadConfigFromFile(
              { command: 'serve', mode: 'development' }, configFile,
            );
            assert(loaded?.config.plugins.some(p => p?.name === 'buzz-relay-broker'));
            assert.equal(loaded.config.define['import.meta.env.VITE_BUZZ_LIVE'], '"1"');
            for (const command of ['serve', 'build']) {
              for (const setting of [undefined, '', '0', '1', 'true', 'invalid']) {
                if (setting === undefined) delete process.env.BUZZ_DEV_NOTIFICATIONS;
                else process.env.BUZZ_DEV_NOTIFICATIONS = setting;
                const result = await loadConfigFromFile(
                  { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
                );
                assert.equal(
                  result.config.plugins.some(p => p?.name === 'buzz-relay-broker'),
                  command === 'serve',
                );
                assert.equal(
                  result.config.define['import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED'],
                  JSON.stringify(command === 'serve' && setting === '0' ? '1' : '0'),
                );
              }
            }
            delete process.env.BUZZ_DEV_NOTIFICATIONS;
            writeFileSync('.env.local', 'BUZZ_DEV_NOTIFICATIONS=0');
            for (const command of ['serve', 'build']) {
              const result = await loadConfigFromFile(
                { command, mode: 'development' }, configFile,
              );
              assert.equal(
                result.config.define['import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED'],
                JSON.stringify(command === 'serve' ? '1' : '0'),
              );
            }
            // BUZZ_DEV_OPEN_RELAY exposes the canonical default relay to a live dev
            // server only when set to exactly "1"; builds and other values see "".
            process.env.BUZZ_RELAY_URL = 'wss://Relay.example.com/';
            for (const command of ['serve', 'build']) {
              for (const setting of [undefined, '', '0', '1', 'true']) {
                if (setting === undefined) delete process.env.BUZZ_DEV_OPEN_RELAY;
                else process.env.BUZZ_DEV_OPEN_RELAY = setting;
                const result = await loadConfigFromFile(
                  { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
                );
                assert.equal(
                  result.config.define['import.meta.env.VITE_BUZZ_OPEN_RELAY'],
                  JSON.stringify(
                    command === 'serve' && setting === '1' ? 'https://relay.example.com' : '',
                  ),
                );
              }
            }
            // OG build alias is presence-only, including empty/false/0. An explicit
            // development setting overrides it. Exercise the real dotenv + Vite boundary.
            delete process.env.BUZZ_DEV_OPEN_RELAY;
            for (const alias of ['', '0', 'false', '1']) {
              writeFileSync('.env.local', 'BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=' + alias);
              for (const command of ['serve', 'build']) {
                for (const override of [undefined, '0', '1']) {
                  if (override === undefined) delete process.env.BUZZ_DEV_OPEN_RELAY;
                  else process.env.BUZZ_DEV_OPEN_RELAY = override;
                  const result = await loadConfigFromFile(
                    { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
                  );
                  assert.equal(result.config.define['import.meta.env.VITE_BUZZ_OPEN_RELAY'],
                    JSON.stringify(command === 'serve' && override !== '0' ? 'https://relay.example.com' : ''));
                }
              }
            }
            // Packaged defaults are independent of dev relay/auto-open settings.
            writeFileSync('.env.local', 'BUZZ_DEFAULT_COMMUNITY_URL=wss://Packaged.example.com/');
            process.env.BUZZ_DEV_OPEN_RELAY = '0';
            for (const [command, override, expected] of [
              ['build', undefined, 'https://packaged.example.com'],
              ['build', 'https://other.example:8443/', 'https://other.example:8443'],
              ['build', '', ''],
              ['serve', undefined, ''],
            ]) {
              if (override === undefined) delete process.env.BUZZ_DEFAULT_COMMUNITY_URL;
              else process.env.BUZZ_DEFAULT_COMMUNITY_URL = override;
              const result = await loadConfigFromFile(
                { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
              );
              assert.equal(result.config.define['import.meta.env.VITE_BUZZ_OPEN_RELAY'], JSON.stringify(expected));
            }
            // Invalid packaged inputs fail the build without echoing credentials.
            for (const invalid of ['http://insecure.example', 'wss://user:secret@relay.example', 'https://relay.example/path']) {
              process.env.BUZZ_DEFAULT_COMMUNITY_URL = invalid;
              await assert.rejects(
                loadConfigFromFile({ command: 'build', mode: 'production' }, configFile),
                error => !String(error).includes('secret') && /relay URL/.test(String(error)),
              );
            }
            delete process.env.BUZZ_DEFAULT_COMMUNITY_URL;
            // A packaged Databricks workspace reaches goose verbatim; invalid hosts
            // fail the build without echoing credentials.
            for (const [command, host, expected] of [
              ['build', 'https://workspace.example.com/', 'https://workspace.example.com/'],
              ['serve', ' https://workspace.example.com ', 'https://workspace.example.com'],
              ['build', '', ''],
              ['build', undefined, ''],
            ]) {
              if (host === undefined) delete process.env.BUZZ_DATABRICKS_HOST;
              else process.env.BUZZ_DATABRICKS_HOST = host;
              const result = await loadConfigFromFile(
                { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
              );
              assert.equal(result.config.define['import.meta.env.VITE_BUZZ_DATABRICKS_HOST'], JSON.stringify(expected));
            }
            for (const invalid of ['http://workspace.example', 'https://user:secret@workspace.example', 'workspace.example']) {
              process.env.BUZZ_DATABRICKS_HOST = invalid;
              await assert.rejects(
                loadConfigFromFile({ command: 'build', mode: 'production' }, configFile),
                error => !String(error).includes('secret') && /BUZZ_DATABRICKS_HOST/.test(String(error)),
              );
            }
            delete process.env.BUZZ_DATABRICKS_HOST;
            // Desktop shares .env.local/process inputs with the native build.
            // An explicit empty process value clears the frontend URL too.
            writeFileSync('.env.local', 'BUZZ_BUILDERLAB_URL=https://app.builderlab.xyz/');
            for (const [command, override, expected] of [
              ['serve', undefined, 'https://app.builderlab.xyz/'],
              ['build', 'https://login.example:8443/deployment/', 'https://login.example:8443/deployment/'],
              ['build', '', ''],
            ]) {
              if (override === undefined) delete process.env.BUZZ_BUILDERLAB_URL;
              else process.env.BUZZ_BUILDERLAB_URL = override;
              const result = await loadConfigFromFile(
                { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
              );
              assert.equal(result.config.define['import.meta.env.VITE_BUZZ_BUILDERLAB_URL'], JSON.stringify(expected));
            }
            // The tenant table is passed through verbatim once it parses, and
            // a malformed table fails at configuration time without being echoed.
            const tenants = '[{"relayHost":"communities.buzz.xyz","loginOrigin":"https://app.builderlab.xyz"}]';
            writeFileSync('.env.local', "BUZZ_BUILDERLAB_TENANTS='" + tenants + "'");
            delete process.env.BUZZ_BUILDERLAB_TENANTS;
            const tenantTable = await loadConfigFromFile(
              { command: 'build', mode: 'production' }, configFile,
            );
            assert.equal(tenantTable.config.define['import.meta.env.VITE_BUZZ_BUILDERLAB_TENANTS'], JSON.stringify(tenants));
            process.env.BUZZ_BUILDERLAB_TENANTS = '[{"relayHost":"a.example","loginOrigin":"http://secret.example"}]';
            await assert.rejects(
              loadConfigFromFile({ command: 'build', mode: 'production' }, configFile),
              (error) => /BUZZ_BUILDERLAB_TENANTS must be/.test(error.message) && !error.message.includes('secret'),
            );
            process.env.BUZZ_BUILDERLAB_TENANTS = '';
            // The first-run account seed reaches only a dev server, and a
            // malformed value fails at configuration time without being echoed.
            for (const command of ['serve', 'build']) {
              process.env.BUZZ_DEV_FIRST_RUN_ACCOUNT = 'unlinked';
              const seeded = await loadConfigFromFile(
                { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
              );
              assert.equal(
                seeded.config.define['import.meta.env.VITE_BUZZ_FIRST_RUN_ACCOUNT'],
                JSON.stringify(command === 'serve' ? 'unlinked' : ''),
              );
            }
            // A backup kind resolves against the failure table, and backups
            // and a recovery key decode, through the native loader.
            const failingSeed = JSON.stringify({
              backup: 'unreachable',
              known: ['design.example.com'],
              backups: ['npub1424242424242424242424242424242424242424242424242424qamrcaj'],
              recovery: 'nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw',
            });
            process.env.BUZZ_DEV_FIRST_RUN_ACCOUNT = failingSeed;
            const failing = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile);
            assert.equal(
              failing.config.define['import.meta.env.VITE_BUZZ_FIRST_RUN_ACCOUNT'],
              JSON.stringify(failingSeed),
            );
            for (const seed of [
              '{"npub":"s3cret"}',
              '{"backup":"s3cret"}',
              '{"backups":["s3cret"]}',
              '{"recovery":"nsec1s3cret"}',
              '{"known":["http://s3cret.example"]}',
            ]) {
              process.env.BUZZ_DEV_FIRST_RUN_ACCOUNT = seed;
              await assert.rejects(
                loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile),
                (error) => /BUZZ_DEV_FIRST_RUN_ACCOUNT must be/.test(error.message) && !error.message.includes('s3cret'),
              );
            }
            delete process.env.BUZZ_DEV_FIRST_RUN_ACCOUNT;
            // Without a viewer pin nothing consumes the seed, so it is neither exposed nor required.
            process.env.BUZZ_DEV_OPEN_RELAY = '1';
            process.env.BUZZ_RELAY_URL = '';
            process.env.BUZZ_DEV_VIEWER = '';
            const shell = await loadConfigFromFile(
              { command: 'serve', mode: 'development' }, configFile,
            );
            assert.equal(shell.config.define['import.meta.env.VITE_BUZZ_OPEN_RELAY'], '""');
            // A live server with the flag but no relay URL fails at configuration time.
            process.env.BUZZ_DEV_VIEWER = 'a'.repeat(64);
            await assert.rejects(
              loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile),
              /BUZZ_DEV_OPEN_RELAY=1 requires BUZZ_RELAY_URL/,
            );
          } finally {
            process.chdir(cwd);
            rmSync(directory, { recursive: true, force: true });
          }
        `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        // Keep local Buzz credentials out of the config subprocess.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("BUZZ_"),
          ),
        ),
        BUZZ_DEV_VIEWER: "a".repeat(64),
        BUZZ_RELAY_URL: "",
        BUZZ_COMMUNITY_ALIASES: "",
        BUZZ_BUILDERLAB_TENANTS: "",
        VITE_CONFIG_NATIVE_IGNORE_WARNING: "",
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain("configLoader: 'native'");
}, 35_000);
