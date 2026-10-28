import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// Follow the pinned Codex setup-rusty-v8 action: trust the checked-in manifest
// digest, then verify the sandbox archive and binding against that manifest.
export function prepareCodexV8({ source, target, triple, run }) {
  const lock = readFileSync(join(source, "codex-rs/Cargo.lock"), "utf8");
  const version = lock.match(
    /\[\[package\]\]\s+name = "v8"\s+version = "([^"]+)"/,
  )?.[1];
  if (!version) throw new Error("Pinned Codex lockfile has no V8 version");
  const host = triple ?? run("rustc", ["-vV"]).match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error("Cannot determine protected Codex's V8 target");
  const profile = `ptrcomp_sandbox_release_${host}`;
  const archive = `librusty_v8_${profile}.a.gz`;
  const binding = `src_binding_${profile}.rs`;
  const manifest = `rusty_v8_${profile}.sha256`;
  const trusted = readFileSync(
    join(
      source,
      "third_party/v8",
      `rusty_v8_${version.replaceAll(".", "_")}_release_manifests.sha256`,
    ),
    "utf8",
  );
  const trustedHash = checksums(trusted).get(manifest);
  if (!trustedHash)
    throw new Error(`Pinned Codex has no trusted V8 manifest for ${host}`);
  const directory = join(target, "v8", version, host);
  mkdirSync(directory, { recursive: true });
  const base = `https://github.com/openai/codex/releases/download/rusty-v8-v${version}`;
  const manifestPath = verifiedDownload(manifest, trustedHash);
  const artifacts = checksums(readFileSync(manifestPath, "utf8"));
  if (
    artifacts.size !== 2 ||
    !artifacts.has(archive) ||
    !artifacts.has(binding)
  )
    throw new Error(`Unexpected V8 artifact manifest for ${host}`);
  return {
    V8_FROM_SOURCE: "0",
    RUSTY_V8_ARCHIVE: verifiedDownload(archive, artifacts.get(archive)),
    RUSTY_V8_SRC_BINDING_PATH: verifiedDownload(
      binding,
      artifacts.get(binding),
    ),
  };

  function verifiedDownload(name, expected) {
    const path = join(directory, name);
    if (existsSync(path) && digest(path) === expected) return path;
    run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      `${base}/${name}`,
      "--output",
      `${path}.new`,
    ]);
    if (digest(`${path}.new`) !== expected)
      throw new Error(
        `Checksum mismatch for protected Codex V8 artifact ${name}`,
      );
    renameSync(`${path}.new`, path);
    return path;
  }
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checksums(text) {
  const result = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64}) {2}(\S+)$/);
    if (!match || result.has(match[2]))
      throw new Error("Invalid V8 checksum manifest");
    result.set(match[2], match[1]);
  }
  return result;
}
