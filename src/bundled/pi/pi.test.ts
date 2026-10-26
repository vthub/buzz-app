import { expect, it, vi } from "vitest";
import { AGENT_KEY } from "../../features/agents/membership";
import hostSource from "./host.mjs?raw";
import type { AgentProtection } from "../../features/agent-protection/service";
import { Pi, PiStopped } from "./pi";
import { deferred, fakeHost } from "./pi-testing";

const handlers = () => ({ tool: vi.fn(), event: vi.fn() });

it("starts the host once, with the install script, and pairs each answer with its request", async () => {
  const slow = deferred<object>();
  const host = fakeHost({
    first: () => slow.promise,
    second: (params) => ({ echo: params.value }),
  });
  const pi = new Pi(() => host.spawn, handlers());
  const first = pi.request("first");
  const second = pi.request("second", { value: 2 });
  await expect(second).resolves.toEqual({ echo: 2 });
  slow.resolve({ done: 1 });
  await expect(first).resolves.toEqual({ done: 1 });
  expect(host.processes).toHaveLength(1);
  const [process] = host.processes;
  expect(process?.id).toBe("pi-sh");
  expect(process?.options.cwd).toBe("~");
  expect(process?.options.args?.[1]).toBe("pi.sh");
  expect(process?.options.args?.at(-1)).toContain("BUZZ_PI_HOST");
  // The packages it installs are the ones the lock pins.
  expect(process?.launched?.lock).toContain('"lockfileVersion"');
  expect(process?.launched?.host).toContain("export function serve");
});

it("starts Node itself on Windows, which has no bash", async () => {
  vi.stubGlobal("navigator", { platform: "Win32" });
  try {
    const host = fakeHost({ first: () => ({ ok: true }) });
    const pi = new Pi(() => host.spawn, handlers());
    await expect(pi.request("first")).resolves.toEqual({ ok: true });
    const [process] = host.processes;
    expect(process?.id).toBe("node");
    expect(process?.options.args).toHaveLength(1);
    expect(process?.options.args?.[0]).toContain("BUZZ_PI_HOST");
    expect(process?.launched?.lock).toContain('"lockfileVersion"');
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reads messages split across chunks, and several in one", async () => {
  // Its answer comes from the test, in pieces.
  const host = fakeHost(
    { first: () => new Promise(() => {}) },
    { ready: false },
  );
  const events = handlers();
  const pi = new Pi(() => host.spawn, events);
  const started = pi.request("first");
  await vi.waitFor(() => expect(host.processes).toHaveLength(1));
  const stdout = host.processes[0]?.options.onStdout;
  stdout?.('{"method":"rea');
  stdout?.(
    'dy","params":{}}\n{"method":"event","params":{"agent":"a","conversation":1,"type":"step","tool":"bash"}}\n',
  );
  await vi.waitFor(() => expect(host.requests("first")).toHaveLength(1));
  stdout?.('{"id":1,"result":{"ok":true}}');
  stdout?.("\n");
  await expect(started).resolves.toEqual({ ok: true });
  expect(events.event).toHaveBeenCalledWith({
    agent: "a",
    conversation: 1,
    type: "step",
    tool: "bash",
  });
});

it("says why a host could not start, and starts another for the next request", async () => {
  const host = fakeHost({ ping: () => ({ pong: true }) }, { ready: false });
  const pi = new Pi(() => host.spawn, handlers());
  const failed = pi.request("ping");
  await vi.waitFor(() => expect(host.processes).toHaveLength(1));
  host.processes[0]?.exit(
    127,
    "Installing…\nPi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.\n",
  );
  const error = await failed.catch((reason: unknown) => reason);
  expect(error).not.toBeInstanceOf(PiStopped);
  expect((error as Error).message).toBe(
    "Pi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.",
  );
  const retried = pi.request("ping");
  await vi.waitFor(() => expect(host.processes).toHaveLength(2));
  host.processes[1]?.send({ method: "ready", params: {} });
  await expect(retried).resolves.toEqual({ pong: true });
});

it("fails what a running host had not answered when it stops", async () => {
  const host = fakeHost({ wait: () => new Promise(() => {}) });
  const pi = new Pi(() => host.spawn, handlers());
  const waiting = pi.request("wait");
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  host.processes[0]?.exit(1, "FATAL: out of memory\n");
  const error = await waiting.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PiStopped);
  expect((error as Error).message).toBe("Pi stopped: FATAL: out of memory");
});

it("names Node's error, not its version, when a host crashes", async () => {
  const host = fakeHost({ wait: () => new Promise(() => {}) });
  const pi = new Pi(() => host.spawn, handlers());
  const waiting = pi.request("wait");
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  host.processes[0]?.exit(
    1,
    "file:///host.mjs:9\n  throw new Error(x);\n  ^\n\nTypeError: x is not a function\n    at file:///host.mjs:9:3\n\nNode.js v22.19.0\n",
  );
  const error = await waiting.catch((reason: unknown) => reason);
  expect((error as Error).message).toBe(
    "Pi stopped: TypeError: x is not a function",
  );
});

it("runs the tools the host calls, and sends back each result or error", async () => {
  const host = fakeHost();
  const tool = vi
    .fn()
    .mockResolvedValueOnce({ content: [{ type: "text", text: "sent" }] })
    .mockRejectedValueOnce(new Error("No such channel"));
  const pi = new Pi(() => host.spawn, { tool, event: vi.fn() });
  await pi.request("open");
  const process = host.processes[0];
  const call = {
    agent: "a",
    conversation: 3,
    context: { channel: "c" },
    name: "send",
    arguments: { text: "hi" },
  };
  await expect(process?.tool(call)).resolves.toMatchObject({
    result: { content: [{ type: "text", text: "sent" }] },
  });
  expect(tool).toHaveBeenCalledWith(call);
  await expect(process?.tool(call)).resolves.toMatchObject({
    error: "No such channel",
  });
});

it("closes the host's stdin to stop it, and refuses requests after", async () => {
  const host = fakeHost();
  const pi = new Pi(() => host.spawn, handlers());
  await pi.request("open");
  const process = host.processes[0];
  const disposed = pi.dispose();
  await vi.waitFor(() => expect(process?.ended).toBe(true));
  process?.exit(0);
  await disposed;
  expect(process?.killed).toBe(false);
  await expect(pi.request("open")).rejects.toThrow("Pi has stopped");
});

it("accepts in the host the membership keys the app names agents with", () => {
  // host.mjs cannot import the app's pattern, so it keeps a copy that names
  // the agent's storage file: it must stay the same, and path-safe.
  const copy = /^const AGENT_KEY = (\/.*\/);$/m.exec(hostSource)?.[1];
  expect(copy).toBe(`/${AGENT_KEY.source}/`);
});

it("isolates protected agents, contains their runtime code and rejects crossed native checks", async () => {
  const entered = deferred();
  let waiting: AbortSignal | undefined;
  const gates = new Map<string, AgentProtection>();
  const make = (key: string): AgentProtection => ({
    key,
    stateKey: key,
    assertAvailable: vi.fn(),
    processProtection: {
      readOnlyPaths: ["/security/provider"],
      hiddenPaths: ["/security/approvals"],
    },
    check: vi.fn(async (_action, signal) => {
      waiting = signal;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    }),
  });
  const a = "a".repeat(64),
    b = "b".repeat(64);
  gates.set(a, make("a:1"));
  gates.set(b, make("b:1"));
  const host = fakeHost(
    {
      runtime: () => ({
        file: "/runtime/deps/version/host.mjs",
        node: "/runtime/node/bin/node",
        codeRoot: "/runtime/deps",
        nodeRoot: "/runtime/node",
        data: "/runtime/state",
        auth: "/runtime/auth",
      }),
    },
    { close: true },
  );
  const pi = new Pi(
    () => host.spawn,
    handlers(),
    (agent) => gates.get(agent),
  );
  try {
    await Promise.all([
      pi.request("open", { agent: a }),
      pi.request("open", { agent: b }),
    ]);
    const protectedHosts = host.processes.filter(
      (process) => process.options.protection,
    );
    expect(protectedHosts).toHaveLength(2);
    const worker = protectedHosts.find((process) =>
      process.options.args?.at(-1)?.includes(a),
    );
    if (!worker) throw new Error("Missing protected worker");
    expect(worker.options.args?.[0]).toContain("--disable-sigusr1");
    expect(worker.options.env).toMatchObject({
      BASH_ENV: null,
      ENV: null,
      NODE_OPTIONS: null,
      NODE_PATH: null,
      DYLD_INSERT_LIBRARIES: null,
    });
    expect(worker.options.protection).toEqual({
      readOnlyPaths: ["/security/provider", "/runtime/deps", "/runtime/node"],
      hiddenPaths: ["/security/approvals"],
    });
    const action = { kind: "tool", session: "1", content: { title: "write" } };
    await expect(
      worker.tool({ agent: b, action }, "security"),
    ).resolves.toMatchObject({ result: false });
    const pending = worker.tool({ agent: a, action }, "security");
    await entered.promise;
    worker.send({ method: "security_cancel", params: { id: "h2" } });
    await expect(pending).resolves.toMatchObject({ result: false });
    expect(waiting?.aborted).toBe(true);
    gates.set(a, make("a:2"));
    await pi.request("open", { agent: a });
    expect(worker.ended).toBe(true);
    expect(
      host.processes.filter((process) => process.options.protection),
    ).toHaveLength(3);
  } finally {
    await pi.dispose();
  }
});
