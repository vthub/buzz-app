import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "buzz-protected-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["scripts", "runtime", "commands"])
    mkdirSync(join(root, directory));
  copyFileSync(
    new URL("../../scripts/build-codex-protected.mjs", import.meta.url),
    join(root, "scripts/build-codex-protected.mjs"),
  );
  copyFileSync(
    new URL("../../scripts/codex-v8.mjs", import.meta.url),
    join(root, "scripts/codex-v8.mjs"),
  );
  writeFileSync(
    join(root, "runtime/codex-security.json"),
    JSON.stringify({ repository: "unused", revision: "pinned", version: "1" }),
  );
  writeFileSync(join(root, "runtime/codex-security.patch"), "patch");
  const source = join(root, "target/codex-protected-src");
  mkdirSync(join(source, "codex-rs"), { recursive: true });
  mkdirSync(join(source, "third_party/v8"), { recursive: true });
  writeFileSync(
    join(source, "codex-rs/Cargo.lock"),
    '[[package]]\nname = "v8"\nversion = "152.2.0"\n',
  );
  const profile = "ptrcomp_sandbox_release_aarch64-apple-darwin";
  const archive = `librusty_v8_${profile}.a.gz`;
  const binding = `src_binding_${profile}.rs`;
  const manifest = `rusty_v8_${profile}.sha256`;
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  const downloads = {
    [archive]: "sandbox archive",
    [binding]: "sandbox binding",
  };
  downloads[manifest] =
    `${digest(downloads[archive])}  ${archive}\r\n${digest(downloads[binding])}  ${binding}\r\n`;
  writeFileSync(
    join(source, "third_party/v8/rusty_v8_152_2_0_release_manifests.sha256"),
    `${digest(downloads[manifest])}  ${manifest}\n`,
  );
  const stub = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command, args, v8FromSource: process.env.V8_FROM_SOURCE, archive: process.env.RUSTY_V8_ARCHIVE, binding: process.env.RUSTY_V8_SRC_BINDING_PATH }) + '\\n');
if (command === 'curl') {
  const url = args.find(arg => arg.startsWith('https://'));
  const name = basename(url);
  let body = JSON.parse(process.env.DOWNLOADS)[name];
  if (process.env.CORRUPT_ARTIFACT === name) body += 'tampered';
  writeFileSync(args[args.indexOf('--output') + 1], body);
}
if (command === 'cargo') {
  const profile = args[args.indexOf('--profile') + 1];
  const triple = args.includes('--target') ? args[args.indexOf('--target') + 1] : '';
  const output = join(process.env.CARGO_TARGET_DIR, triple, profile === 'dev' ? 'debug' : profile);
  mkdirSync(output, { recursive: true });
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p') writeFileSync(join(output, args[i + 1]), args[i + 1]);
  }
}
if (command === 'otool') {
  console.log(args[1] + ':');
  console.log('    ' + (process.env.BAD_HELPER_LIBRARY && args[1].endsWith('codex-code-mode-host') ? '/opt/homebrew/lib/libbad.dylib' : '/usr/lib/libSystem.B.dylib') + ' (compatibility version 1.0.0)');
}
`;
  for (const name of ["git", "cargo", "otool", "curl"])
    writeFileSync(join(root, "commands", name), stub, { mode: 0o755 });
  const log = join(root, "commands.jsonl");
  return {
    root,
    archive,
    binding,
    manifest,
    staged: (name) => join(root, "src-tauri/resources/bin", name),
    calls: () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
    run(args = [], env = {}) {
      return spawnSync(
        process.execPath,
        [join(root, "scripts/build-codex-protected.mjs"), ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(root, "commands")}:${process.env.PATH}`,
            TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin",
            COMMAND_LOG: log,
            V8_FROM_SOURCE: undefined,
            DOWNLOADS: JSON.stringify(downloads),
            ...env,
          },
        },
      );
    },
  };
}

test("protected Codex stages both pinned executables and rebuilds a missing helper", (t) => {
  const build = fixture(t);
  let result = build.run();
  assert.equal(result.status, 0, result.stderr);
  for (const [staged, built] of [
    ["codex-app-server-protected", "codex-app-server"],
    ["codex-code-mode-host", "codex-code-mode-host"],
  ]) {
    assert.equal(readFileSync(build.staged(staged), "utf8"), built);
    assert.equal(statSync(build.staged(staged)).mode & 0o777, 0o755);
  }
  const firstCalls = build.calls();
  const cargo = firstCalls.find(({ command }) => command === "cargo");
  assert.ok(cargo.args.includes("--locked"));
  assert.ok(cargo.args.includes("codex-app-server"));
  assert.ok(cargo.args.includes("codex-code-mode-host"));
  assert.equal(cargo.v8FromSource, "0");
  assert.ok(cargo.archive.endsWith(build.archive));
  assert.ok(cargo.binding.endsWith(build.binding));
  assert.equal(build.run().status, 0);
  assert.deepEqual(build.calls(), firstCalls);
  rmSync(build.staged("codex-code-mode-host"));
  result = build.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(build.staged("codex-code-mode-host"), "utf8"),
    "codex-code-mode-host",
  );
  assert.equal(
    build.calls().filter(({ command }) => command === "cargo").length,
    2,
  );
  assert.equal(
    build.calls().filter(({ command }) => command === "curl").length,
    3,
  );
});

test("a corrupt V8 cache is re-downloaded and verified before reuse", (t) => {
  const build = fixture(t);
  assert.equal(build.run().status, 0);
  const cached = join(
    build.root,
    "target/codex-protected-build/v8/152.2.0/aarch64-apple-darwin",
  );
  for (const name of [build.manifest, build.archive, build.binding])
    writeFileSync(join(cached, name), "corrupt cache");
  rmSync(build.staged("codex-code-mode-host"));
  const result = build.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    build.calls().filter(({ command }) => command === "curl").length,
    6,
  );
  assert.equal(
    readFileSync(join(cached, build.archive), "utf8"),
    "sandbox archive",
  );
});

for (const artifact of ["manifest", "archive", "binding"]) {
  test(`corrupted V8 ${artifact} fails before compilation or stamping`, (t) => {
    const build = fixture(t);
    const result = build.run([], { CORRUPT_ARTIFACT: build[artifact] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Checksum mismatch/);
    assert.ok(!build.calls().some(({ command }) => command === "cargo"));
    assert.throws(
      () =>
        statSync(join(build.root, "target/codex-protected-build/staged.json")),
      { code: "ENOENT" },
    );
  });
}

test("patch and profile changes invalidate both protected executables' cache", (t) => {
  const build = fixture(t);
  assert.equal(build.run().status, 0);
  writeFileSync(
    join(build.root, "runtime/codex-security.patch"),
    "changed patch",
  );
  assert.equal(build.run().status, 0);
  const result = build.run(["--dev"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    build.calls().filter(({ command }) => command === "cargo").length,
    3,
  );
});

test("a non-system library in the helper prevents staging and stamping", {
  skip: process.platform !== "darwin",
}, (t) => {
  const build = fixture(t);
  const result = build.run([], { BAD_HELPER_LIBRARY: "1" });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /codex-code-mode-host links a library Macs do not ship/,
  );
  assert.throws(() => statSync(build.staged("codex-app-server-protected")), {
    code: "ENOENT",
  });
  assert.throws(
    () =>
      statSync(join(build.root, "target/codex-protected-build/staged.json")),
    { code: "ENOENT" },
  );
});
