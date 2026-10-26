import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostService, type Host } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (event: unknown) => void) {}
  },
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function pluginContext() {
  const root = new Context();
  new HostService(root);
  return {
    root,
    plugin: root.extend({
      pluginOwner: { id: "example.plugin", revision: "abc" },
    }),
  };
}

it("prepares a structured NIP-OA proof with the native identity without a community", async () => {
  const identity = "ab".repeat(32);
  const agentPubkey = "cd".repeat(32);
  const authorization = ["auth", identity, "", "ef".repeat(64)];
  const { plugin } = pluginContext();
  vi.mocked(invoke)
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(authorization);
  expect(
    await plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).toEqual(authorization);
  expect(invoke).toHaveBeenNthCalledWith(1, "identity_restore");
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    "identity_prepare_remote_agent_authorization",
    { owner: identity, agentPubkey },
  );
});

it.each([
  { mode: "browser", tauri: false, live: undefined },
  { mode: "live desktop", tauri: true, live: "1" },
])(
  "uses the dev broker identity for $mode authorization without a selected relay",
  async ({ tauri, live }) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = ["auth", identity, "", "ef".repeat(64)];
    vi.mocked(isTauri).mockReturnValue(tauri);
    vi.stubEnv("VITE_BUZZ_LIVE", live);
    const fetcher = vi.fn(async (_url: string, _input?: RequestInit) =>
      Response.json({ viewer: identity }),
    );
    fetcher
      .mockResolvedValueOnce(Response.json({ viewer: identity }))
      .mockResolvedValueOnce(Response.json(authorization));
    vi.stubGlobal("fetch", fetcher);
    const { plugin } = pluginContext();
    expect(
      await plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).toEqual(authorization);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/relay/identity");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/relay/prepare-remote-agent-authorization",
    );
    const input = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(input.body))).toEqual({
      owner: identity,
      agentPubkey,
    });
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("does not sign invalid, self, missing-identity or pre-canceled requests", async () => {
  const identity = "ab".repeat(32);
  const agentPubkey = "cd".repeat(32);
  const { plugin } = pluginContext();
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.("invalid"),
  ).rejects.toThrow("64 lowercase hex");
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce(identity);
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(identity),
  ).rejects.toThrow("must differ");
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).rejects.toThrow("Set up your identity");
  const cancel = new AbortController();
  cancel.abort();
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey, cancel.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["identity_restore", "identity_prepare_remote_agent_authorization"])(
  "fences cancellation during %s",
  async (command) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = ["auth", identity, "", "ef".repeat(64)];
    let release!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((name) =>
      name === command
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(identity),
    );
    const { plugin } = pluginContext();
    const cancel = new AbortController();
    const pending = plugin.host.prepareRemoteAgentAuthorization?.(
      agentPubkey,
      cancel.signal,
    );
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      cancel.abort();
    } finally {
      release?.(command === "identity_restore" ? identity : authorization);
    }
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledTimes(
      command === "identity_restore" ? 1 : 2,
    );
  },
);

it.each(["different owner", "nonempty conditions", "malformed signature"])(
  "rejects an invalid authorization: %s",
  async (scenario) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = [
      "auth",
      scenario === "different owner" ? agentPubkey : identity,
      scenario === "nonempty conditions" ? "kind=0" : "",
      scenario === "malformed signature" ? "invalid" : "ef".repeat(64),
    ];
    const { plugin } = pluginContext();
    vi.mocked(invoke)
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(authorization);
    await expect(
      plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).rejects.toThrow("Invalid remote agent authorization");
  },
);

it("uses the calling plugin identity and preserves bounded command output", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue("ready \n");
  await expect(plugin.host.runCommand("status")).resolves.toBe("ready \n");
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "status",
  });
});

it("keeps native command failures and browser calls nullable", async () => {
  const { root, plugin } = pluginContext();
  vi.mocked(invoke).mockRejectedValue(new Error("secret stderr"));
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  await expect(root.host.runCommand("status")).resolves.toBeNull();
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("passes review decisions as stdin data while keeping the command fixed", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue('{"accepted":true}');
  const input =
    '{"id":"action-a","choice":"allow_once","text":"$(touch injected)"}';
  await plugin.host.runCommand("review", input);
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "review",
    input,
  });
});

it("routes HTTPS requests with plugin identity and rejects browser requests", async () => {
  const { plugin } = pluginContext();
  const response = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{}",
  };
  vi.mocked(invoke).mockResolvedValue(response);
  const request = {
    url: "https://api.example.com/graphql",
    method: "POST" as const,
    headers: { Authorization: "Bearer token" },
    body: "{}",
  };
  await expect(plugin.host.request(request)).resolves.toEqual(response);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "example.plugin",
    revision: "abc",
    request,
  });
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.request(request)).rejects.toThrow(/desktop plugin/);
});

it.each(["request", "upload"] as const)(
  "normalizes native %s string failures and preserves existing Errors",
  async (operation) => {
    const { plugin } = pluginContext();
    const input = { url: "https://api.example.com/" };
    const call = () =>
      operation === "request"
        ? plugin.host.request(input)
        : plugin.host.upload?.({
            ...input,
            file: {
              field: "artifact",
              path: "/home/me/artifact.tar.gz",
              name: "artifact.tar.gz",
              contentType: "application/gzip",
            },
          });
    const message =
      operation === "request"
        ? "Host request timed out"
        : "Files are not declared";
    vi.mocked(invoke).mockRejectedValueOnce(message);
    await expect(call()).rejects.toEqual(new Error(message));
    const error = new Error("Native failure");
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(call()).rejects.toBe(error);
  },
);

it("reads files and resolves directories as the calling plugin", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke)
    .mockResolvedValueOnce(new Uint8Array([0, 255]).buffer)
    .mockResolvedValueOnce("/home/me/.buzz")
    .mockRejectedValueOnce("notes.md: No such file");
  await expect(
    plugin.host.readFile?.("./a.png", { cwd: "~/.buzz" }),
  ).resolves.toEqual(new Uint8Array([0, 255]));
  expect(invoke).toHaveBeenCalledWith("plugin_host_read_file", {
    id: "example.plugin",
    revision: "abc",
    path: "./a.png",
    cwd: "~/.buzz",
  });
  await expect(plugin.host.resolveDirectory?.("~/.buzz")).resolves.toBe(
    "/home/me/.buzz",
  );
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_resolve_directory", {
    id: "example.plugin",
    revision: "abc",
    path: "~/.buzz",
  });
  // Callers tell a missing file by its message, so it arrives as an Error.
  await expect(plugin.host.readFile?.("/notes.md")).rejects.toThrow(
    /No such file/,
  );
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.readFile?.("/notes.md")).rejects.toThrow(
    /desktop plugin/,
  );
});

it("starts a declared process as the calling plugin and streams it", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const process = await plugin.host.spawn?.("agent", {
    args: ["--print"],
    cwd: "~/.buzz",
    env: { CLAUDECODE: null },
    mcp: {
      url: "http://127.0.0.1:1234/mcp",
      headers: [{ name: "Authorization", value: "Bearer agent" }],
    },
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
  });
  const [, spawn] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_spawn", {
    id: "example.plugin",
    revision: "abc",
    processId: "agent",
    args: ["--print"],
    cwd: "~/.buzz",
    env: { CLAUDECODE: null },
    protection: null,
    onEvent: spawn.onEvent,
    mcp: {
      url: "http://127.0.0.1:1234/mcp",
      headers: [{ name: "Authorization", value: "Bearer agent" }],
    },
  });
  spawn.onEvent.onmessage({ type: "stdout", data: "out" });
  spawn.onEvent.onmessage({ type: "stderr", data: "err" });
  expect(stdout).toEqual(["out"]);
  expect(stderr).toEqual(["err"]);

  vi.mocked(invoke).mockResolvedValue(undefined);
  await process?.write("line\n");
  await process?.end();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_write", {
    id: "example.plugin",
    handle: 7,
    data: "line\n",
    close: false,
  });
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_write", {
    id: "example.plugin",
    handle: 7,
    data: "",
    close: true,
  });
  spawn.onEvent.onmessage({ type: "exit", code: 0 });
  await expect(process?.exited).resolves.toBe(0);
});

it("writes a long input in order, in pieces the host accepts", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent");
  const pieces: string[] = [];
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    pieces.push((args as { data: string }).data);
  });
  // A pair straddles the first boundary.
  const long = `${"a".repeat(256 * 1024 - 1)}😀${"b".repeat(600 * 1024)}`;
  await Promise.all([process?.write(long), process?.write("next\n")]);
  expect(pieces).toHaveLength(5);
  expect(pieces.every((piece) => new Blob([piece]).size <= 1024 * 1024)).toBe(
    true,
  );
  expect(pieces[0]?.endsWith("a")).toBe(true);
  expect(pieces.join("")).toBe(`${long}next\n`);
});

it("keeps delivering process events after an output handler throws", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const process = await plugin.host.spawn?.("agent", {
    onStdout: () => {
      throw new Error("handler bug");
    },
  });
  const [, spawn] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  expect(() =>
    spawn.onEvent.onmessage({ type: "stdout", data: "out" }),
  ).not.toThrow();
  expect(error).toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(undefined);
  spawn.onEvent.onmessage({ type: "exit", code: 1 });
  await expect(process?.exited).resolves.toBe(1);
  error.mockRestore();
});

it("kills a plugin's processes when the plugin unloads", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  vi.mocked(invoke).mockResolvedValue(3);
  await host.spawn?.("agent");
  vi.mocked(invoke).mockClear();
  await fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_kill", {
    id: "example.plugin",
    handle: 3,
  });
});

it("kills a process that started as its plugin unloaded", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  let started!: (handle: number) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_process_spawn"
      ? new Promise((resolve) => {
          started = resolve;
        })
      : Promise.resolve(undefined),
  );
  const spawning = host.spawn?.("agent");
  await fiber.dispose();
  started(4);
  await expect(spawning).rejects.toThrow();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_kill", {
    id: "example.plugin",
    handle: 4,
  });
});

it("refuses processes outside the desktop app", async () => {
  const { root, plugin } = pluginContext();
  await expect(root.host.spawn?.("agent")).rejects.toThrow(
    "installed desktop plugin",
  );
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.spawn?.("agent")).rejects.toThrow(
    "installed desktop plugin",
  );
  expect(invoke).not.toHaveBeenCalled();
});

it.each([false, true])(
  "serves MCP as the calling plugin with sharedSession=%s",
  async (sharedSession) => {
    const { plugin } = pluginContext();
    vi.mocked(invoke).mockResolvedValueOnce({
      handle: 4,
      url: "http://127.0.0.1:5000/mcp",
      token: "secret",
    });
    const handler = vi.fn(async (message: unknown) => {
      const { id } = message as { id?: number };
      return id === undefined ? undefined : { jsonrpc: "2.0", id, result: {} };
    });
    const server = await plugin.host.serveMcp?.(handler, { sharedSession });
    const [, serve] = vi.mocked(invoke).mock.calls[0] as [
      string,
      { onEvent: { onmessage(event: unknown): void } },
    ];
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_serve", {
      id: "example.plugin",
      revision: "abc",
      onEvent: serve.onEvent,
      ...(sharedSession ? { sharedSession: true } : {}),
    });
    expect(server?.url).toBe("http://127.0.0.1:5000/mcp");
    expect(server?.headers).toEqual([
      { name: "Authorization", value: "Bearer secret" },
    ]);

    vi.mocked(invoke).mockResolvedValue(undefined);
    serve.onEvent.onmessage({
      type: "message",
      request: 1,
      body: '{"jsonrpc":"2.0","id":9,"method":"ping"}',
    });
    serve.onEvent.onmessage({
      type: "message",
      request: 2,
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    });
    serve.onEvent.onmessage({ type: "message", request: 3, body: "{" });
    await vi.waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThanOrEqual(4),
    );
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: '{"jsonrpc":"2.0","id":9,"result":{}}',
    });
    // A notification is accepted without a body.
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 2,
      body: null,
    });
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 3,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
    });

    await server?.close();
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_close", {
      id: "example.plugin",
      handle: 4,
    });
    serve.onEvent.onmessage({ type: "closed" });
    await expect(server?.closed).resolves.toBeUndefined();
  },
);

it("answers a failed MCP request with a JSON-RPC error", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 4, url: "u", token: "t" });
  await plugin.host.serveMcp?.(async () => {
    throw new Error("relay down");
  });
  const [, serve] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  vi.mocked(invoke).mockResolvedValue(undefined);
  serve.onEvent.onmessage({
    type: "message",
    request: 1,
    body: '{"jsonrpc":"2.0","id":"a","method":"tools/call"}',
  });
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "a",
        error: { code: -32603, message: "relay down" },
      }),
    }),
  );
});

it("answers with an error when a reply cannot be delivered", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 4, url: "u", token: "t" });
  await plugin.host.serveMcp?.(async (message) => ({
    jsonrpc: "2.0",
    id: (message as { id: unknown }).id,
    result: { count: 1n },
  }));
  const [, serve] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  // A reply the native side refuses as too large takes the same path.
  vi.mocked(invoke).mockResolvedValue(undefined);
  serve.onEvent.onmessage({
    type: "message",
    request: 1,
    body: '{"jsonrpc":"2.0","id":7,"method":"tools/call"}',
  });
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        error: {
          code: -32603,
          message: "Do not know how to serialize a BigInt",
        },
      }),
    }),
  );
});

it("closes a plugin's MCP servers when the plugin unloads", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 6, url: "u", token: "t" });
  await host.serveMcp?.(async () => undefined);
  vi.mocked(invoke).mockResolvedValue(undefined);
  await fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_close", {
    id: "example.plugin",
    handle: 6,
  });
});
