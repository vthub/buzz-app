// The protected app server is pinned independently of the ordinary Codex updater.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const pin = JSON.parse(
  readFileSync(join(root, "runtime/codex-security.json"), "utf8"),
);
const patch = join(root, "runtime/codex-security.patch");
const profile = process.argv.includes("--dev") ? "dev" : "release";
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || undefined;
// Protected workers currently require the native macOS containment boundary.
if (triple ? !triple.includes("apple-darwin") : process.platform !== "darwin")
  process.exit(0);
const windows = triple
  ? triple.includes("windows")
  : process.platform === "win32";
const suffix = windows ? ".exe" : "";
const source = join(root, "target/codex-protected-src");
const target = join(root, "target/codex-protected-build");
const destination = join(
  root,
  "src-tauri/resources/bin",
  `codex-app-server-protected${suffix}`,
);
const stampPath = join(target, "staged.json");
const stamp = JSON.stringify({
  ...pin,
  patch: createHash("sha256").update(readFileSync(patch)).digest("hex"),
  profile,
  triple,
});
if (existsSync(destination) && read(stampPath) === stamp) process.exit(0);
mkdirSync(source, { recursive: true });
run("git", ["init", "--quiet"]);
if (
  spawnSync("git", ["cat-file", "-e", `${pin.revision}^{commit}`], {
    cwd: source,
    stdio: "ignore",
  }).status !== 0
)
  run("git", [
    "fetch",
    "--quiet",
    "--depth",
    "1",
    pin.repository,
    pin.revision,
  ]);
run("git", ["checkout", "--quiet", "--force", "--detach", pin.revision]);
rmSync(join(source, "codex-rs/core/src/buzz_security.rs"), { force: true });
run("git", ["apply", "--check", patch]);
run("git", ["apply", patch]);
run(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    "codex-rs/Cargo.toml",
    "-p",
    "codex-app-server",
    "--profile",
    profile,
    ...(triple ? ["--target", triple] : []),
  ],
  { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_DEV_DEBUG: "0" },
);
const built = join(
  target,
  triple ?? "",
  profile === "dev" ? "debug" : profile,
  `codex-app-server${suffix}`,
);
if (process.platform === "darwin" && (!triple || triple.includes("apple"))) {
  for (const line of run("otool", ["-L", built]).split("\n").slice(1)) {
    const library = line.trim().split(" (compatibility version")[0];
    if (
      library &&
      !library.startsWith("/usr/lib/") &&
      !library.startsWith("/System/Library/")
    )
      throw new Error(
        `Protected Codex links a library Macs do not ship: ${library}`,
      );
  }
}
mkdirSync(join(root, "src-tauri/resources/bin"), { recursive: true });
copyFileSync(built, `${destination}.new`);
chmodSync(`${destination}.new`, 0o755);
renameSync(`${destination}.new`, destination);
for (const name of ["LICENSE", "NOTICE"]) {
  const path = join(source, name);
  if (existsSync(path))
    copyFileSync(path, join(root, "src-tauri/resources/bin", `codex-${name}`));
}
writeFileSync(stampPath, stamp);
function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: source,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} failed (${result.status})`);
  return result.stdout;
}
