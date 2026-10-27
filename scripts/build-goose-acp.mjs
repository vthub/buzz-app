// Builds the goose-acp the app bundles from the pin in runtime/goose-acp.json.
// `--dev` (`just desktop`) uses Cargo's fast dev profile; packaged builds use the
// pin's small one. Tauri names the target it builds for in
// TAURI_ENV_TARGET_TRIPLE; without it, goose-acp is built for this machine.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pin = JSON.parse(
  readFileSync(join(root, "runtime/goose-acp.json"), "utf8"),
);
const profile = process.argv.includes("--dev") ? pin.devProfile : pin.profile;
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || undefined;
const windows = triple
  ? triple.includes("windows")
  : process.platform === "win32";
const name = windows ? "goose-acp.exe" : "goose-acp";
// Tauri ships this directory as the app's `bin` resources.
const destination = join(root, "src-tauri/resources/bin");
const binary = join(destination, name);
const target = join(root, "target/goose-acp-build");
// What the staged binary was built from, kept out of the shipped directory.
const stampPath = join(target, "staged.json");
const patchPath = join(root, "runtime/goose-security.patch");
const protection = createHash("sha256")
  .update(readFileSync(patchPath))
  .digest("hex");
const stamp = `${JSON.stringify({ revision: pin.revision, features: pin.features, profile, triple, protection }, null, 2)}\n`;

if (existsSync(binary) && read(stampPath) === stamp) {
  console.log(`goose-acp ready (${pin.revision.slice(0, 9)}, ${profile})`);
  process.exit(0);
}
console.log(
  `Building goose-acp (${pin.revision.slice(0, 9)}, ${profile}); the first build takes a few minutes.`,
);
// The sources keep one path, so a pin bump recompiles only what changed.
const source = join(root, "target/goose-acp-src");
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
rmSync(join(source, "crates/goose/src/buzz_security.rs"), { force: true });
run("git", ["apply", "--check", patchPath]);
run("git", ["apply", patchPath]);
run(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "goose",
    "--bin",
    "goose-acp",
    "--profile",
    profile,
    "--no-default-features",
    "--features",
    pin.features,
    ...(triple ? ["--target", triple] : []),
  ],
  { ...process.env, CARGO_TARGET_DIR: target },
);
// Cargo names the dev profile's output directory "debug", under the triple
// when one is given.
const built = join(
  target,
  triple ?? "",
  profile === "dev" ? "debug" : profile,
  name,
);
if (process.platform === "darwin" && (!triple || triple.includes("apple"))) {
  // The app must run on Macs without Homebrew's libraries.
  const libraries = run("otool", ["-L", built]).split("\n").slice(1);
  for (const line of libraries) {
    const library = line.trim().split(" (compatibility version")[0];
    if (
      library &&
      !library.startsWith("/usr/lib/") &&
      !library.startsWith("/System/Library/")
    )
      throw new Error(`goose-acp links ${library}, which Macs do not ship`);
  }
}
// Replace the binary whole, then record what it was built from.
mkdirSync(destination, { recursive: true });
copyFileSync(built, `${binary}.new`);
chmodSync(`${binary}.new`, 0o755);
renameSync(`${binary}.new`, binary);
writeFileSync(stampPath, stamp);
console.log(`goose-acp staged at ${binary}`);

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
