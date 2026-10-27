// The real codex.sh switching releases in a throwaway home, as Buzz builds
// sharing one folder do.
import { execFile, spawn } from "node:child_process";
import { watch } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import script from "./codex.sh?raw";

const run = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

/** Buzz's codex folder in a new home, holding fake `releases` with `current`. */
async function disk(releases: readonly string[], current?: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "buzz-codex-")));
  homes.push(home);
  const dir =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/codex")
      : join(home, ".local/share/buzz/codex");
  for (const version of releases) {
    const binary = join(dir, version, "bin/codex");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, `#!/bin/sh\necho "codex-cli ${version}"\n`);
    await chmod(binary, 0o755);
  }
  if (current) await writeFile(join(dir, "current"), current);
  const step = (...args: string[]) =>
    run("bash", ["-c", script, "codex.sh", ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
  return {
    home,
    dir,
    step,
    /** Leaves no doubt the release `current` names still runs. */
    selected: async () => (await step("run", "--version")).stdout.trim(),
    folders: async () =>
      (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
  };
}

// Builds that fetched 0.2.0 and 0.3.0 switch in either order, or at once;
// none prunes what another made current.
it("keeps the newer release when it switches first", async () => {
  const first = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await first.step("use", "0.2.0");
  await first.step("use", "0.3.0");
  expect(await first.selected()).toBe("codex-cli 0.3.0");
});

it("keeps the newer release when an older one switches after it", async () => {
  const second = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await second.step("use", "0.3.0");
  await expect(second.step("use", "0.2.0")).rejects.toThrow();
  expect(await second.selected()).toBe("codex-cli 0.3.0");
});

it("keeps the release in use when builds switch at once", async () => {
  const both = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await Promise.allSettled([
    both.step("use", "0.2.0"),
    both.step("use", "0.3.0"),
  ]);
  const current = await readFile(join(both.dir, "current"), "utf8");
  expect(await both.selected()).toBe(`codex-cli ${current}`);
});

it("prunes older releases but keeps a newer one another build may be testing", async () => {
  const { step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0", "0.10.0"],
    "0.2.0",
  );
  await step("use", "0.3.0");
  expect(await folders()).toEqual(["0.10.0", "0.2.0", "0.3.0"]);
});

/** Holds the lock file `lock`, as another build's codex.sh does, until killed. */
async function hold(lock: string) {
  const holder = spawn("perl", [
    "-MFcntl=:flock",
    "-e",
    'open(my $l, ">>", $ARGV[0]) or die; flock($l, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 60',
    lock,
  ]);
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  return holder;
}
/** Resolves once the codex.sh with process `pid` is waiting for a lock. */
const waiting = (pid: number | undefined) =>
  expect
    .poll(() =>
      run("pgrep", ["-P", String(pid), "-x", "flock|perl"]).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);

it("waits for a switch in progress, and goes on once its holder is killed", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.1.0");
  const holder = await hold(join(dir, ".lock"));
  const switching = step("use", "0.2.0");
  await waiting(switching.child.pid);
  expect(await selected()).toBe("codex-cli 0.1.0");
  holder.kill("SIGKILL");
  await switching;
  expect(await selected()).toBe("codex-cli 0.2.0");
});

it("leaves the release in use when its switch's release is pruned while it waits", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.2.0");
  const holder = await hold(join(dir, ".lock"));
  const switching = step("use", "0.1.0");
  await waiting(switching.child.pid);
  // The holder's own prune removes the older release this switch named.
  await rm(join(dir, "0.1.0"), { recursive: true });
  holder.kill("SIGKILL");
  await expect(switching).rejects.toThrow("0.1.0 is no longer downloaded");
  expect(await selected()).toBe("codex-cli 0.2.0");
});

it("starts the release in use when switches prune the one it read", async () => {
  const { home, step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0"],
    "0.1.0",
  );
  // Complete home setup before observing the release-read boundary.
  await step("run", "--version");
  // A `cat` that stops after its first read, of `current`, until `go`.
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "cat"),
    `#!/bin/sh\n/bin/cat "$@"\n[ -e "${bin}/read" ] && exit\n: >"${bin}/read"\nuntil [ -e "${bin}/go" ]; do sleep 0.05; done\n`,
  );
  await chmod(join(bin, "cat"), 0o755);
  let observed!: () => void;
  let failed!: (error: Error) => void;
  const read = new Promise<void>((resolve, reject) => {
    observed = resolve;
    failed = reject;
  });
  const watcher = watch(bin, (_event, name) => {
    if (name === "read") observed();
  });
  watcher.once("error", failed);
  const launching = run(
    "bash",
    ["-c", script, "codex.sh", "run", "--version"],
    {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
    },
  );
  try {
    // Observe the actual read event; process startup is not the behavior under test.
    await Promise.race([
      read,
      launching.then(() => {
        throw new Error("Launcher exited before reading current");
      }),
    ]);
    // Two builds switch past the release the launcher read, pruning it.
    await step("use", "0.2.0");
    await step("use", "0.3.0");
    expect(await folders()).not.toContain("0.1.0");
    await writeFile(join(bin, "go"), "");
    expect((await launching).stdout.trim()).toBe("codex-cli 0.3.0");
  } finally {
    watcher.close();
    await writeFile(join(bin, "go"), "");
    await launching.catch(() => {});
  }
});

// Buzz's own Codex home keeps its conversations out of the user's Codex
// history, linking in only the settings, sign-in and instructions.
const shared = ["config.toml", "auth.json", "AGENTS.md", "rules", "skills"];

/** A release that prints the home and arguments it ran with. */
async function echoing() {
  const f = await disk(["0.1.0", "0.2.0"], "0.1.0");
  await writeFile(
    join(f.dir, "0.1.0/bin/codex"),
    '#!/bin/sh\nprintf "%s\\n" "$CODEX_HOME" "$@"\n',
  );
  return { ...f, own: `${f.dir}-home`, codex: join(f.home, ".codex") };
}

it("runs Codex in Buzz's own home, linked to the shared settings and sign-in", async () => {
  const f = await echoing();
  const { stdout } = await f.step("run", "app-server");
  expect(stdout.trim().split("\n")).toEqual([
    f.own,
    "-c",
    `sqlite_home=${f.own}`,
    "app-server",
  ]);
  for (const name of shared)
    expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
  // A sign-in refresh writes through the link, to the shared file.
  await writeFile(join(f.own, "auth.json"), "refreshed");
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("refreshed");
  await f.step("run", "app-server");
});

it("reuses the original shared home when launched from a Buzz Codex agent", async () => {
  const f = await echoing();
  await f.step("run");
  const { stdout } = await run(
    "bash",
    ["-c", script, "codex.sh", "run", "app-server"],
    {
      env: { PATH: process.env.PATH ?? "", HOME: f.home, CODEX_HOME: f.own },
    },
  );
  expect(stdout.trim().split("\n")).toEqual([
    f.own,
    "-c",
    `sqlite_home=${f.own}`,
    "app-server",
  ]);
  for (const name of shared)
    expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
});

it("refuses an inherited isolated home without its original config link", async () => {
  const f = await echoing();
  await mkdir(f.own, { recursive: true });
  await writeFile(join(f.own, "config.toml"), "keep me");
  await expect(
    run("bash", ["-c", script, "codex.sh", "run"], {
      env: { PATH: process.env.PATH ?? "", HOME: f.home, CODEX_HOME: f.own },
    }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining("must differ") });
  expect(await readFile(join(f.own, "config.toml"), "utf8")).toBe("keep me");
});

it("sets up Buzz's home once when runs start at once", async () => {
  const f = await echoing();
  // A link made meanwhile to a folder must not lead a run to link inside it.
  await mkdir(join(f.codex, "skills"), { recursive: true });
  await mkdir(join(f.codex, "rules"));
  for (let round = 0; round < 3; round++) {
    await rm(f.own, { recursive: true, force: true });
    await Promise.all(Array.from({ length: 6 }, () => f.step("run")));
    for (const name of shared)
      expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
    expect(await readdir(join(f.codex, "skills"))).toEqual([]);
    expect(await readdir(join(f.codex, "rules"))).toEqual([]);
  }
}, 20_000);

it("makes the shared skills and rules folders a fresh home lacks", async () => {
  const f = await echoing();
  await f.step("run");
  // Codex fails to set up its skills through a link to nothing.
  for (const name of ["skills", "rules"])
    expect((await stat(join(f.own, name))).isDirectory()).toBe(true);
});

it("still runs Codex when the shared skills or rules can't be folders", async () => {
  const f = await echoing();
  await mkdir(f.codex, { recursive: true });
  await writeFile(join(f.codex, "skills"), "");
  await symlink(join(f.home, "gone"), join(f.codex, "rules"));
  const { stdout } = await f.step("run", "--version");
  expect(stdout.trim().split("\n").at(-1)).toBe("--version");
});

it("stops rather than replace a file in the way of a link", async () => {
  const f = await echoing();
  await mkdir(f.own, { recursive: true });
  await writeFile(join(f.own, "config.toml"), "keep me");
  await expect(f.step("run")).rejects.toMatchObject({
    stderr: expect.stringContaining("setup conflicts"),
  });
  expect(await readFile(join(f.own, "config.toml"), "utf8")).toBe("keep me");
});

/** Signs in as `codex login` does in Buzz's home: it signs out, removing the
 * link, and writes the new sign-in in its place. */
async function signIn(own: string, auth: string) {
  await rm(join(own, "auth.json"));
  await writeFile(join(own, "auth.json"), auth, { mode: 0o600 });
}

it("hands a sign-in made in Buzz's home to the shared one, and links it again", async () => {
  const f = await echoing();
  await mkdir(f.codex, { recursive: true });
  await writeFile(join(f.codex, "auth.json"), "revoked");
  await f.step("run");
  await signIn(f.own, "signed in");
  await f.step("run");
  expect(await readlink(join(f.own, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
});

it("keeps a newer shared sign-in over the one in Buzz's home", async () => {
  const f = await echoing();
  await f.step("run");
  await signIn(f.own, "older");
  await utimes(join(f.own, "auth.json"), 1_000, 1_000);
  await writeFile(join(f.codex, "auth.json"), "signed in");
  await f.step("run");
  expect(await readlink(join(f.own, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
});

it("writes a handed-over sign-in through the user's own link, and privately when new", async () => {
  const f = await echoing();
  await f.step("run");
  await signIn(f.own, "first");
  await f.step("run");
  expect((await stat(join(f.codex, "auth.json"))).mode & 0o777).toBe(0o600);
  // The user keeps their sign-in elsewhere and links it into their Codex home.
  const kept = join(f.home, "dotfiles-auth.json");
  await rm(join(f.codex, "auth.json"));
  await writeFile(kept, "first", { mode: 0o600 });
  await symlink("../dotfiles-auth.json", join(f.codex, "auth.json"));
  await signIn(f.own, "second");
  await f.step("run");
  expect(await readlink(join(f.codex, "auth.json"))).toBe(
    "../dotfiles-auth.json",
  );
  expect(await readFile(kept, "utf8")).toBe("second");
});

it("leaves the shared sign-in alone when another run hands it over while it waits", async () => {
  const f = await echoing();
  await f.step("run");
  await signIn(f.own, "signed in");
  const holder = await hold(`${f.dir}-home.lock`);
  const waiter = f.step("run");
  let handed: number;
  try {
    await waiting(waiter.child.pid);
    // The run holding the lock hands the sign-in over and links it again.
    await writeFile(join(f.codex, "auth.json"), "signed in");
    await rm(join(f.own, "auth.json"));
    await symlink(join(f.codex, "auth.json"), join(f.own, "auth.json"));
    handed = (await stat(join(f.codex, "auth.json"))).ino;
  } finally {
    holder.kill("SIGKILL");
  }
  await waiter;
  // Replacing it again could undo a refresh Codex has written since.
  expect((await stat(join(f.codex, "auth.json"))).ino).toBe(handed);
});

it("leaves a sign-in Codex is still writing in Buzz's home", async () => {
  const f = await echoing();
  await mkdir(f.codex, { recursive: true });
  await writeFile(join(f.codex, "auth.json"), "signed in");
  await f.step("run");
  await signIn(f.own, "");
  await expect(f.step("run")).rejects.toMatchObject({
    stderr: expect.stringContaining("setup conflicts"),
  });
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
  expect(await readFile(join(f.own, "auth.json"), "utf8")).toBe("");
});

it("keeps a sign-in it fails to hand over, and hands it over on the next run", async () => {
  const f = await echoing();
  await f.step("run");
  await writeFile(join(f.codex, "auth.json"), "revoked");
  await utimes(join(f.codex, "auth.json"), 500, 500);
  await signIn(f.own, "signed in");
  await utimes(join(f.own, "auth.json"), 1_000, 1_000);
  // A `cat` that stops partway through writing the sign-in, as on a full disk.
  const bin = join(f.home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "cat"),
    '#!/bin/sh\ncase "$1" in *-home/auth.json) printf partial; exit 1 ;; esac\nexec /bin/cat "$@"\n',
  );
  await chmod(join(bin, "cat"), 0o755);
  await expect(
    run("bash", ["-c", script, "codex.sh", "run"], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: f.home },
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("couldn't save the Codex sign-in"),
  });
  // Left as it was, so not newer than the sign-in still waiting in Buzz's home.
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("revoked");
  expect(await readdir(f.codex)).not.toContain("auth.json.buzz");
  await f.step("run");
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
  expect(await readlink(join(f.own, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
});

it("lets go of the hand-over lock before Codex starts", async () => {
  const f = await echoing();
  const started = join(f.home, "started");
  await writeFile(
    join(f.dir, "0.1.0/bin/codex"),
    `#!/bin/sh\n[ -e "${started}" ] && exit\n: >"${started}"\nexec sleep 60\n`,
  );
  await mkdir(f.own, { recursive: true });
  await writeFile(join(f.own, "auth.json"), "first", { mode: 0o600 });
  let observed!: () => void, failed!: (error: Error) => void;
  const boundary = new Promise<void>((resolve, reject) => {
    observed = resolve;
    failed = reject;
  });
  const watcher = watch(f.home, (_event, name) => {
    if (name === "started") observed();
  });
  watcher.once("error", failed);
  // An app server that stays up, as Buzz's does, must not hold up the next run.
  const first = f.step("run");
  try {
    await Promise.race([
      boundary,
      first.then(() => {
        throw new Error("Codex exited before its startup boundary");
      }),
    ]);
    await signIn(f.own, "second");
    await f.step("run");
    expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("second");
  } finally {
    watcher.close();
    first.child.kill();
    await first.catch(() => {});
  }
});

it("keeps Buzz's conversations when switching releases", async () => {
  const f = await echoing();
  await f.step("run");
  await mkdir(join(f.own, "sessions"));
  await writeFile(join(f.own, "sessions/rollout.jsonl"), "history");
  await f.step("use", "0.2.0");
  expect(await readFile(join(f.own, "sessions/rollout.jsonl"), "utf8")).toBe(
    "history",
  );
  expect(await readlink(join(f.own, "skills"))).toBe(join(f.codex, "skills"));
});

it("copies a saved thread from the user's home once, never over Buzz's copy", async () => {
  const { home, dir, step } = await disk([]);
  const day = "sessions/2026/10/14";
  const name = "rollout-2026-10-14T14-32-19-thread-1.jsonl";
  await mkdir(join(home, ".codex", day), { recursive: true });
  // The Codex app is mid-write: the last line has no end yet.
  await writeFile(join(home, ".codex", day, name), '{"a":1}\n{"b"');
  await step("adopt", "thread-1");
  const copy = join(`${dir}-home`, day, name);
  expect(await readFile(copy, "utf8")).toBe('{"a":1}\n{"b"\n');
  await writeFile(copy, "continued in Buzz\n");
  await step("adopt", "thread-1");
  expect(await readFile(copy, "utf8")).toBe("continued in Buzz\n");
  // Nothing to copy is not an error.
  await step("adopt", "thread-2");
  await expect(step("adopt", "../thread-1")).rejects.toThrow("Invalid thread");
  expect(await readdir(join(`${dir}-home`, day))).toEqual([name]);
});
