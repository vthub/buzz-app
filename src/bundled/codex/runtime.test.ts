import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { apply } from "./index";
import { describe, afterEach, expect, it, vi } from "vitest";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import { localStore } from "../../features/agents/state";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import type { Agent, Delivery } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import type { EventData } from "../../features/relay/events";
import { eventDto } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import type {
  McpHandler,
  HostProcessOptions,
} from "../../features/host/service";
import { BUZZ_PROMPT, TOP_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import { CodexRuntime, codexStep, programs } from "./runtime";
import { config } from "./config";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { wake } from "../../features/agent-harness/wakes";
import type { Wire } from "./rpc";

// The plugin registers only in the Mac/Linux desktop app.
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

const owner = "a".repeat(64);
const pubkey = "b".repeat(64);
const root = "c".repeat(64);
const scope = `https://relay.test:${owner}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const runtimes: CodexRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** External app-server protocol fixture: turns complete only when released by
 * the test. The runtime owns routing, steering, cleanup and publication. */
function fixture(
  remainingTerminals: unknown[] = [],
  termination?: Promise<void>,
  plugin = false,
  configured: {
    model?: string;
    model_reasoning_effort?: string;
    model_reasoning_summary?: string;
    features?: { hooks?: boolean; codex_hooks?: boolean };
  } = {},
  repositories?: (scope: string | undefined) => string,
  hooks?: ConstructorParameters<typeof CodexRuntime>[7],
) {
  let terminals = remainingTerminals;
  let options: HostProcessOptions | undefined;
  let thread = 0;
  let turn = 0;
  const sent: Wire[] = [];
  /** Methods the server answers with a JSON-RPC error instead of a result. */
  const failing = new Set<string>();
  /** Methods the server answers only once their promise settles. */
  const held = new Map<string, Promise<void>>();
  const toolCalls = new Map<
    number | string,
    { threadId: string | undefined; turnId: string; callId: string }
  >();
  const exits = deferred<number | null>();
  const storage = new Map<string, string>();
  const process = {
    write: async (data: string) => {
      const request: Wire = JSON.parse(data);
      sent.push(request);
      if (request.id != null && !request.method) {
        const call = toolCalls.get(request.id);
        if (call)
          emit({
            method: "item/completed",
            params: {
              threadId: call.threadId,
              turnId: call.turnId,
              item: {
                type: "dynamicToolCall",
                id: call.callId,
                success: (request.result as { success?: boolean })?.success,
              },
            },
          });
        return;
      }
      if (request.id == null) return;
      await held.get(request.method ?? "");
      if (request.method && failing.has(request.method)) {
        emit({
          id: request.id,
          error: { message: `${request.method} failed` },
        });
        return;
      }
      const params = request.params as Record<string, unknown>;
      let result: unknown = {};
      if (request.method === "model/list")
        result = {
          data: [
            {
              model: "test-model",
              displayName: "Test Model",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["low", "medium", "high"].map(
                (reasoningEffort) => ({ reasoningEffort, description: "" }),
              ),
            },
            {
              model: "deep-model",
              displayName: "",
              isDefault: false,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: ["high", "xhigh"].map(
                (reasoningEffort) => ({ reasoningEffort, description: "" }),
              ),
            },
          ],
          nextCursor: null,
        };
      if (request.method === "hooks/list")
        result = {
          data: [
            {
              hooks: [
                {
                  key: "dispatcher",
                  currentHash: "fixed",
                  source: "sessionFlags",
                },
              ],
            },
          ],
        };
      if (request.method === "config/read")
        result = {
          config: {
            ...configured,
            mcp_servers: {
              "company.tools": {
                command: "secret-tool",
                enabled: true,
                url: null,
              },
            },
          },
        };
      if (request.method === "thread/start")
        result = { thread: { id: `thread-${++thread}`, cwd: params.cwd } };
      if (request.method === "thread/resume")
        result = { thread: { id: params.threadId, cwd: params.cwd } };
      if (request.method === "turn/start")
        result = { turn: { id: `turn-${++turn}` } };
      if (request.method === "turn/interrupt")
        emit({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { id: params.turnId, status: "interrupted" },
          },
        });
      if (request.method === "thread/backgroundTerminals/list")
        result = { data: terminals, nextCursor: null };
      if (
        request.method === "thread/backgroundTerminals/terminate" &&
        termination
      ) {
        await termination;
        terminals = [];
      }
      emit({ id: request.id, result });
    },
    end: vi.fn(async () => {
      closed = true;
      exits.resolve(0);
    }),
    kill: vi.fn(async () => {
      exits.resolve(null);
    }),
    exited: exits.promise,
  };
  let closed = false;
  let appServerSpawns = 0;
  const fileReads: { cwd?: string; path: string }[] = [];
  const adopted: string[] = [];
  const spawn = vi.fn(async (_id: string, value?: HostProcessOptions) => {
    // The plugin starts the app server as a step of Buzz's `codex.sh`.
    const appServer =
      _id === "app-server" ||
      value?.args?.slice(2, 4).join(" ") === "run app-server";
    if (plugin && appServer && appServerSpawns++ === 0) {
      const catalogExit = deferred<number | null>();
      return {
        write: async (data: string) => {
          const request: Wire = JSON.parse(data);
          if (request.id == null) return;
          const result =
            request.method === "account/read"
              ? { account: { type: "chatgpt" } }
              : request.method === "model/list"
                ? { data: [], nextCursor: null }
                : {};
          value?.onStdout?.(`${JSON.stringify({ id: request.id, result })}\n`);
        },
        end: async () => catalogExit.resolve(0),
        kill: async () => catalogExit.resolve(null),
        exited: catalogExit.promise,
      };
    }
    if (_id === "adopt") {
      adopted.push(value?.args?.[0] ?? "");
      return { ...process, exited: Promise.resolve(0) };
    }
    if (_id === "workspace") {
      value?.onStdout?.("/home/test/.buzz\n");
      return { ...process, exited: Promise.resolve(0) };
    }
    if (_id === "read") {
      fileReads.push({
        ...(value?.cwd ? { cwd: value.cwd } : {}),
        path: value?.args?.[0] ?? "",
      });
      value?.onStdout?.(
        btoa(
          value?.args?.[0] === "attachment.jpg"
            ? "\xff\xd8\xff"
            : "FILE CONTENT",
        ),
      );
      return { ...process, exited: Promise.resolve(0) };
    }
    // The plugin's setup checks find Buzz's copy installed and signed in.
    const step = value?.args?.slice(3).join(" ");
    if (step === "--version" || step === "login status") {
      value?.onStdout?.("codex-cli 0.162.1\n");
      return { ...process, exited: Promise.resolve(0) };
    }
    options = value;
    return process;
  });
  const emit = (value: Wire) =>
    options?.onStdout?.(`${JSON.stringify(value)}\n`);
  const publish = vi.fn(async (event: unknown) => ({
    ...(event as object),
    id: "d".repeat(64),
  }));
  const read = vi.fn(async () => [] as EventData[]);
  const memories: { slug: string; body: string; createdAt: number }[] = [];
  const memoryRead = vi.fn(async () => ({ entries: memories, partial: false }));
  const memoryView = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({
      status: "ready",
      listing: { entries: memories, partial: false },
    }),
    dispose: vi.fn(),
  };
  const memoryOpen = vi.fn(() => memoryView);
  // The owner's view, with no channel an own Solo chat unless a test does so.
  const soloChannels = new Set<string>();
  const snapshot = {
    status: "ready",
    scope: scope as string | undefined,
    viewer: owner,
    session: {
      workflowAuthority: undefined as string | undefined,
      profiles: {
        ensure: vi.fn(async () => {}),
        event: vi.fn(
          (_key: string): ReturnType<typeof eventDto> | undefined => undefined,
        ),
      },
      read,
      agentMemories: { open: memoryOpen, read: memoryRead },
      channels: {
        list: () => ({
          status: "ready",
          channels: [
            {
              id: "channel",
              name: "test",
              channelType: soloChannels.has("channel") ? "solo" : "stream",
            },
          ],
        }),
      },
      channelWrites: { startingCanvas: () => undefined },
      canvas: {
        available: false,
        read: vi.fn(
          async (): Promise<{
            pubkey: string;
            kind: number;
            created_at: number;
            tags: string[][];
            content: string;
          } | null> => null,
        ),
      },
    },
  };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const local = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  } as Storage;
  const store = localStore(local);
  // The host's copy of `core` memory, which needs no relay read.
  const core = vi.fn(
    async (
      _key: string,
      _signal?: AbortSignal,
    ): Promise<string | null | undefined> =>
      memories.find((memory) => memory.slug === "core")?.body ?? null,
  );
  /** The tools plugins add, as the runtime reads them at each use. */
  const added: AddedTool[] = [];
  const runtime = new CodexRuntime(
    spawn,
    (key) => ownerReads(relay, pubkeyOf(key)),
    core,
    store,
    config,
    () => added,
    repositories,
    hooks,
  );
  runtimes.push(runtime);
  const events: EventData[] = [];
  const query = vi.fn(async (filters: readonly Record<string, unknown>[]) =>
    events.filter((event) =>
      filters.some((filter) =>
        Object.entries(filter).every(([key, value]) => {
          if (key === "ids") return (value as string[]).includes(event.id);
          if (key === "kinds") return (value as number[]).includes(event.kind);
          if (key.startsWith("#"))
            return event.tags.some(
              ([name, item]) =>
                name === key.slice(1) &&
                (value as string[]).includes(item ?? ""),
            );
          return true;
        }),
      ),
    ),
  );
  const remember = vi.fn(async (slug: string, body: string, after: number) => {
    const index = memories.findIndex((memory) => memory.slug === slug);
    if (index >= 0) memories.splice(index, 1);
    memories.push({ slug, body, createdAt: after + 1 });
  });
  const upload = vi.fn(async (_data: string, mime: string) => ({
    url: "https://files.test/file",
    sha256: "e".repeat(64),
    size: 12,
    type: mime,
  }));
  const workingUntil = vi.fn<Delivery["workingUntil"]>();
  const media = vi.fn(async () => ({
    path: "/cache/shot.png",
    type: "image/png",
    size: 6,
    data: btoa("\x89PNG\r\n"),
  }));
  /** The owner's attention switch, and the objects the host holds. */
  const attention = { on: false };
  const objects = new Map<string, Record<string, unknown>>();
  const attentionWrite = vi.fn(async (slug: string) => ({
    result: "found",
    object: objects.get(slug) ?? null,
    expected_state: "object-v1:written",
  }));
  const agent = {
    key: pubkey,
    pubkey,
    owner,
    name: "Codex",
    publish,
    query,
    upload,
    media,
    remember,
    attention: {
      enabled: () => attention.on,
      classifier: () => "unavailable" as const,
      show: vi.fn(async (slug: string) => {
        const object = objects.get(slug) ?? null;
        return {
          result: object ? "found" : "not-found",
          object,
          expected_state: "object-v1:test",
        };
      }),
      interests: vi.fn(() =>
        [...objects.keys()].filter((slug) => slug.startsWith("interest/")),
      ),
      watches: vi.fn(() => []),
      write: attentionWrite,
    },
  };
  runtime.sync([{ key: pubkey, pubkey } as Agent]);
  let id = 0;
  const delivery = (content: string, threadRoot = root): Delivery => {
    const result: Delivery = {
      trigger: {
        type: "mention",
        event: {
          id: (++id).toString(16).padStart(64, "0"),
          pubkey: owner,
          kind: 9,
          content,
          created_at: 10,
          tags: [
            ["h", "channel"],
            ["e", threadRoot, "", "reply"],
          ],
        } as Extract<Delivery["trigger"], { type: "mention" }>["event"],
      },
      channelId: "channel",
      agent: agent as unknown as Delivery["agent"],
      config: {
        workspace: "/tmp/codex-test",
        model: "test-model",
        effort: "low",
        instructions: "TEST_INSTRUCTIONS",
      },
      signal: new AbortController().signal,
      workingUntil,
      current: () => true,
    };
    if ("event" in result.trigger)
      events.push(result.trigger.event as EventData);
    return result;
  };
  /** Agents' running agents, whichever community is selected. */
  const running = [{ ...agent, type: "buzz.codex/codex" }];
  const listeners: (() => void)[] = [];
  let runPlugin: (delivery: Delivery) => Promise<void> = (delivery) =>
    runtime.run(delivery);
  let pluginDispose = () => {};
  if (plugin) {
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    apply({
      agentProtection: { registerModels: vi.fn() },
      host: { spawn },
      agents: {
        snapshot: () => ({ status: "ready", agents: [], running }),
        relay: () => relay,
        core,
        tools: () => added,
        subscribe: (listener: () => void) => {
          listeners.push(listener);
          return () => {};
        },
        register: (type: { run: typeof runPlugin }) => {
          runPlugin = type.run;
        },
      },
      effect: (effect: () => () => void) => {
        pluginDispose = effect();
      },
    } as unknown as Parameters<typeof apply>[0]);
  }
  const starts = () => sent.filter((wire) => wire.method === "turn/start");
  const interrupt = () => {
    const index = starts().length - 1;
    const params = starts()[index]?.params as { threadId: string };
    emit({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: `turn-${index + 1}`, status: "interrupted" },
      },
    });
  };
  let toolId = 0;
  const tool = async (
    name: string,
    args: unknown,
    index = starts().length - 1,
    overrides = {},
  ) => {
    const threadId = (
      starts()[index]?.params as { threadId: string } | undefined
    )?.threadId;
    const id = `tool-${++toolId}`;
    toolCalls.set(id, { threadId, turnId: `turn-${index + 1}`, callId: id });
    emit({
      id,
      method: "item/tool/call",
      params: {
        threadId,
        turnId: `turn-${index + 1}`,
        namespace: "buzz",
        callId: id,
        tool: name,
        arguments: args,
        ...overrides,
      },
    });
    await vi.waitFor(
      () =>
        expect(sent.some((wire) => wire.id === id && !wire.method)).toBe(true),
      { interval: vi.isFakeTimers() ? 50 : 1 },
    );
    return sent.find((wire) => wire.id === id && !wire.method);
  };
  const complete = async (index = starts().length - 1, text = "DONE") => {
    if (!closed && text)
      await tool("send", { audience: "everyone", text, final: true }, index);
    const params = starts()[index]?.params as { threadId: string };
    emit({
      method: "item/completed",
      params: {
        threadId: params.threadId,
        item: { type: "agentMessage", text, phase: "final_answer" },
      },
    });
    emit({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: `turn-${index + 1}`, status: "completed" },
      },
    });
  };
  /** Hands over a watch or timer as the agent runner does: a standalone turn
   * in its Interest's lane, which the runner holds. */
  const wakeTurn = (delivery: Delivery) => {
    const { trigger } = delivery;
    if (
      trigger.type === "mention" ||
      trigger.type === "plugin" ||
      trigger.type === "attention"
    )
      throw new Error("Expected a wake");
    delivery.workingUntil(
      wake(
        delivery.agent,
        trigger,
        delivery.current,
        (key, prompt) =>
          runtime.runOnce({ delivery, key, signal: delivery.signal, prompt }),
        "Codex",
      ),
    );
  };
  return {
    runtime,
    added,
    wake: wakeTurn,
    tool,
    attention,
    objects,
    attentionWrite,
    events,
    query,
    fileReads,
    memoryOpen,
    memoryRead,
    core,
    memoryView,
    remember,
    upload,
    running,
    media,
    runPlugin: (delivery: Delivery) => runPlugin(delivery),
    notify: () =>
      listeners.forEach((listener) => {
        listener();
      }),
    pluginDispose: () => pluginDispose(),
    spawn,
    adopted,
    process,
    sent,
    failing,
    held,
    emit,
    publish,
    read,
    storage,
    delivery,
    workingUntil,
    starts,
    complete,
    interrupt,
    snapshot,
    soloChannels,
    exits,
  };
}
it("hands over promptly and runs conversations independently on one server", async () => {
  const f = fixture();
  await f.runtime.run({
    ...f.delivery("@Codex first"),
    team: "<team>\nCrew\n</team>",
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.publish).not.toHaveBeenCalled();
  await f.runtime.run(f.delivery("@Codex independent", "e".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.spawn).toHaveBeenCalledTimes(1);
  f.complete(0, "FIRST");
  f.complete(1, "OTHER");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  const started = f.sent.find((wire) => wire.method === "thread/start")
    ?.params as Record<string, unknown>;
  expect(started).toMatchObject({
    model: "test-model",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  expect(started.baseInstructions).toBeUndefined();
  expect(started.developerInstructions).toContain("coding agent in Buzz");
  expect(started.developerInstructions).toContain(
    "Never publish a bare acknowledgement.",
  );
  expect(started.developerInstructions).toContain(BUZZ_PROMPT);
  expect(f.starts()[0]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        kind: "application",
        value: expect.stringContaining("TEST_INSTRUCTIONS"),
      },
    },
  });
  expect(f.starts()[0]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        value: expect.stringContaining(
          "</agent-instructions>\n\nCurrent team sections replace all prior team sections. None means you are on no team.\n<team>\nCrew\n</team>",
        ),
      },
    },
  });
  expect(f.starts()[1]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        value: expect.not.stringContaining("<team>"),
      },
    },
  });
  // The thread already carries the static prompt; turns carry only what changes.
  expect(f.starts()[1]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        value: expect.not.stringContaining(
          "Your `core` memory is auto-injected into your context every turn",
        ),
      },
    },
  });
  expect((started.config as Record<string, unknown>).mcp_servers).toEqual({
    "company.tools": { enabled: false, command: "secret-tool" },
  });
  expect(started.config).toMatchObject({
    web_search: "disabled",
    mcp_servers: { "company.tools": { enabled: false } },
    "features.apps": false,
    "features.plugins": false,
  });
  expect(f.spawn.mock.calls[0]?.[1]).not.toHaveProperty("agent");
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9,
    content: "FIRST",
    tags: expect.arrayContaining([["e", root, "", "reply"]]),
  });
});
/** A second agent on the same runtime, with its own identity and publisher. */
function second(f: ReturnType<typeof fixture>) {
  const other = "9".repeat(64);
  const base = f.delivery("unused").agent;
  const agent = {
    ...base,
    key: other,
    pubkey: other,
    name: "Other",
    publish: vi.fn(async (event: unknown) => ({
      ...(event as object),
      id: "8".repeat(64),
    })),
  } as unknown as Delivery["agent"];
  f.runtime.sync([
    { key: pubkey, pubkey } as Agent,
    { key: other, pubkey: other } as Agent,
  ]);
  return {
    agent,
    delivery: (content: string) => ({
      ...f.delivery(content, "7".repeat(64)),
      agent,
    }),
  };
}
const contents = (publish: { mock: { calls: unknown[][] } }) =>
  publish.mock.calls.map(([event]) => (event as { content: string }).content);
const servers = (f: ReturnType<typeof fixture>) =>
  f.spawn.mock.calls.filter(([id]) => id === "app-server");
it("serves every agent from one server and routes each tool call to its own agent", async () => {
  const f = fixture();
  const b = second(f);
  await f.runtime.run(f.delivery("@Codex first"));
  await f.runtime.run(b.delivery("@Other second"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(servers(f)).toHaveLength(1);
  expect(f.starts()[1]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": { value: expect.stringContaining("Other") },
    },
  });
  await f.complete(1, "FROM OTHER");
  await f.complete(0, "FROM CODEX");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(1));
  expect(contents(f.publish)).toEqual(["FROM CODEX"]);
  expect(contents(b.agent.publish as never)).toEqual(["FROM OTHER"]);
  expect(f.runtime.sessions("9".repeat(64))[0]?.status).toBe("Idle");
});
it("keeps an agent's two communities' threads apart, each under its membership's key", async () => {
  const f = fixture();
  const elsewhere = `${pubkey}@other.example`;
  const base = f.delivery("unused").agent;
  const agent = { ...base, key: elsewhere } as unknown as Delivery["agent"];
  f.runtime.sync([
    { key: pubkey, pubkey } as Agent,
    { key: elsewhere, pubkey } as Agent,
  ]);
  await f.runtime.run(f.delivery("@Codex here"));
  await f.runtime.run({ ...f.delivery("@Codex there"), agent });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  await f.complete(1, "THERE");
  await f.complete(0, "HERE");
  await vi.waitFor(() => expect(f.runtime.sessions(elsewhere)).toHaveLength(1));
  const saved = (key: string) =>
    f.storage.get(`buzz.codex.sessions.v13:${scope}:${key}`);
  expect(saved(pubkey)).toBeTruthy();
  expect(saved(elsewhere)).toBeTruthy();
  expect(f.runtime.conversations(pubkey)).toHaveLength(1);
  expect(f.runtime.conversations(elsewhere)).toHaveLength(1);
  expect(f.runtime.conversations(pubkey)[0]?.threadId).not.toBe(
    f.runtime.conversations(elsewhere)[0]?.threadId,
  );
  // Leaving one community stops only that membership.
  f.runtime.sync([{ key: pubkey, pubkey } as Agent]);
  expect(f.runtime.sessions(elsewhere)).toEqual([]);
  expect(f.runtime.sessions(pubkey)).toHaveLength(1);
});
it("warms the server before a mention, which then reuses it", async () => {
  const f = fixture();
  f.runtime.warm();
  f.runtime.warm();
  expect(servers(f)).toHaveLength(1);
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(servers(f)).toHaveLength(1);
});
it("stops a removed agent's turn without ending the server the others share", async () => {
  const f = fixture();
  const b = second(f);
  await f.runtime.run(f.delivery("work"));
  await f.runtime.run(b.delivery("other work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const removed = (f.starts()[1]?.params as { threadId: string } | undefined)
    ?.threadId;
  f.runtime.sync([{ key: pubkey, pubkey } as Agent]);
  await vi.waitFor(() =>
    expect(
      f.sent.some(
        (wire) =>
          wire.method === "thread/unsubscribe" &&
          (wire.params as { threadId: string }).threadId === removed,
      ),
    ).toBe(true),
  );
  for (const method of ["turn/interrupt", "thread/backgroundTerminals/clean"])
    expect(f.sent.find((wire) => wire.method === method)?.params).toMatchObject(
      { threadId: removed },
    );
  expect(f.process.end).not.toHaveBeenCalled();
  expect(f.runtime.sessions("9".repeat(64))).toHaveLength(0);
  await f.complete(0, "STILL HERE");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(contents(f.publish)).toEqual(["STILL HERE"]);
  expect(b.agent.publish).not.toHaveBeenCalled();
  f.runtime.sync([]);
  await f.exits.promise;
  expect(f.process.end).toHaveBeenCalled();
});
it("ends a stopped agent's leftover shells and lets it start again only after letting go", async () => {
  const f = fixture();
  const b = second(f);
  await f.runtime.run(f.delivery("work"));
  await f.runtime.run(b.delivery("start a dev server"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const thread = (f.starts()[1]?.params as { threadId: string } | undefined)
    ?.threadId;
  await f.complete(1, "SERVER RUNNING");
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(1));
  await f.runtime.run(b.delivery("busy again"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  const index = (method: string) =>
    f.sent
      .map(
        (wire) =>
          wire.method === method &&
          (wire.params as { threadId: string }).threadId === thread,
      )
      .lastIndexOf(true);
  const before = index("thread/unsubscribe");
  f.runtime.sync([{ key: pubkey, pubkey } as Agent]);
  f.runtime.sync([
    { key: pubkey, pubkey } as Agent,
    { key: "9".repeat(64), pubkey: "9".repeat(64) } as Agent,
  ]);
  await f.runtime.run(b.delivery("back"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(4));
  expect(index("thread/unsubscribe")).toBeGreaterThan(before);
  expect(index("thread/backgroundTerminals/clean")).toBeGreaterThan(
    index("thread/unsubscribe"),
  );
  expect(index("thread/resume")).toBeGreaterThan(
    index("thread/backgroundTerminals/clean"),
  );
  expect(f.process.end).not.toHaveBeenCalled();
  await f.complete(3, "BACK");
  await f.complete(0, "STILL HERE");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(2));
  expect(contents(b.agent.publish as never)).toEqual([
    "SERVER RUNNING",
    "BACK",
  ]);
});
it("logs a failed idle terminal clean without ending the shared server or blocking the agent's return", async () => {
  const f = fixture([{ processId: "dev-server" }]);
  const b = second(f);
  await f.runtime.run(f.delivery("work"));
  await f.runtime.run(b.delivery("start a dev server"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const thread = (f.starts()[1]?.params as { threadId: string } | undefined)
    ?.threadId;
  await f.complete(1, "SERVER RUNNING");
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(1));
  f.failing.add("thread/backgroundTerminals/clean");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  f.runtime.sync([{ key: pubkey, pubkey } as Agent]);
  await vi.waitFor(() =>
    expect(error).toHaveBeenCalledWith(
      "Codex could not clean a stopped agent's terminals",
      new Error("thread/backgroundTerminals/clean failed"),
    ),
  );
  error.mockRestore();
  expect(
    f.sent.find((wire) => wire.method === "thread/backgroundTerminals/clean")
      ?.params,
  ).toMatchObject({ threadId: thread });
  expect(f.process.end).not.toHaveBeenCalled();
  await f.complete(0, "STILL HERE");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(contents(f.publish)).toEqual(["STILL HERE"]);
  f.runtime.sync([
    { key: pubkey, pubkey } as Agent,
    { key: "9".repeat(64), pubkey: "9".repeat(64) } as Agent,
  ]);
  await f.runtime.run(b.delivery("back"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  expect(
    f.sent.find((wire) => wire.method === "thread/resume")?.params,
  ).toMatchObject({ threadId: thread });
  await f.complete(2, "BACK");
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(2));
  expect(contents(b.agent.publish as never)).toEqual([
    "SERVER RUNNING",
    "BACK",
  ]);
});
it("does not clean or log a cleanup error after the last agent closes the server", async () => {
  const f = fixture([{ processId: "dev-server" }]);
  await f.runtime.run(f.delivery("start a dev server"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0, "SERVER RUNNING");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    f.runtime.sync([]);
    await vi.runAllTimersAsync();
    expect(f.process.end).toHaveBeenCalledTimes(1);
    expect(
      f.sent.some((wire) => wire.method === "thread/backgroundTerminals/clean"),
    ).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(f.runtime.sessions(pubkey)).toHaveLength(0);
  } finally {
    vi.useRealTimers();
    error.mockRestore();
  }
});
it("reopens the shared server after it exits", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await f.runtime.run(f.delivery("again"));
  await vi.waitFor(() => expect(servers(f)).toHaveLength(2));
});
it("refuses a synced effort its model lacks, where a local one falls back", async () => {
  const f = fixture();
  const xhigh = (content: string) => {
    const delivery = f.delivery(content);
    return {
      ...delivery,
      config: { ...(delivery.config as object), effort: "xhigh" },
    };
  };
  await f.runtime.run({
    ...xhigh("@Codex synced"),
    synced: { effort: "xhigh" },
  });
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: false,
    error:
      "This agent's synced effort \"xhigh\" isn't offered by Codex's test-model. Change it in Settings.",
  });
  expect(f.starts()).toHaveLength(0);
  await f.runtime.run(xhigh("@Codex local"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.starts()[0]?.params).toMatchObject({ effort: "medium" });
  f.runtime.dispose();
});
it("checks a synced effort again when a saved conversation resumes", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  const second = f.delivery("@Codex second");
  await f.runtime.run({
    ...second,
    config: { ...(second.config as object), effort: "xhigh" },
    synced: { effort: "xhigh" },
  });
  await expect(f.workingUntil.mock.calls[1]?.[0]).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining('synced effort "xhigh"'),
  });
  expect(f.starts()).toHaveLength(1);
  // The refusal cost nothing: the next turn resumes the saved conversation.
  await f.runtime.run(f.delivery("@Codex third"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const thread = (index: number) =>
    (f.starts()[index]?.params as { threadId?: string } | undefined)?.threadId;
  expect(thread(1)).toBe(thread(0));
  await f.complete(1, "THIRD");
  f.runtime.dispose();
});
it("discovers models and efforts before any turn, sharing one read-only lookup", async () => {
  const f = fixture();
  const agent = {
    key: pubkey,
    pubkey,
    config: { workspace: "/tmp/codex-test" },
  } as Agent;
  const one = f.runtime.preview(agent);
  const two = f.runtime.preview(agent);
  f.runtime.sync([agent]);
  expect(one).toBe(two);
  await expect(one).resolves.toEqual({
    current: "test-model",
    sendDefaults: true,
    models: [
      {
        id: "test-model",
        label: "Test Model",
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        effort: "medium",
      },
      {
        id: "deep-model",
        label: "deep-model",
        efforts: [
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" },
        ],
        effort: "high",
      },
    ],
  });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn.mock.calls[0]?.[1]?.cwd).toBe("~/.buzz");
  expect(f.starts()).toEqual([]);
  expect(f.sent.some((wire) => wire.method === "thread/start")).toBe(false);
  expect(f.process.end).not.toHaveBeenCalled();
  expect(f.runtime.preview(agent)).toBe(one);
  f.runtime.sync([]);
  f.spawn.mockRejectedValueOnce(new Error("offline"));
  await expect(f.runtime.preview(agent)).rejects.toThrow("offline");
});
it("refreshes model discovery only when effective model or effort changes", async () => {
  const f = fixture();
  const agent = {
    key: pubkey,
    pubkey,
    config: { workspace: "/tmp/codex-test" },
  } as Agent;
  const one = f.runtime.preview(agent);
  await one;
  expect(
    f.runtime.preview({ ...agent, config: { workspace: "/tmp/other" } }),
  ).toBe(one);
  const two = f.runtime.preview({ ...agent, config: { model: "deep-model" } });
  expect(two).not.toBe(one);
  await expect(two).resolves.toMatchObject({ current: "deep-model" });
  const three = f.runtime.preview({
    ...agent,
    config: { model: "deep-model", effort: "xhigh" },
  });
  expect(three).not.toBe(two);
  await expect(three).resolves.toMatchObject({
    current: "deep-model",
    models: expect.arrayContaining([
      expect.objectContaining({ id: "deep-model", effort: "xhigh" }),
    ]),
  });
  expect(
    f.runtime.preview({
      ...agent,
      config: { model: "deep-model", effort: "xhigh" },
    }),
  ).toBe(three);
  expect(f.sent.filter((wire) => wire.method === "model/list")).toHaveLength(3);
});
it("shares model discovery with active turns and another agent", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const b = second(f);
  await Promise.all([
    f.runtime.preview(f.delivery("unused").agent as unknown as Agent),
    f.runtime.preview(b.agent as unknown as Agent),
  ]);
  expect(servers(f)).toHaveLength(1);
  expect(f.process.end).not.toHaveBeenCalled();
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
});
it("ignores changes to local Codex model preferences in the composer", async () => {
  const configured = { model: "deep-model" };
  const f = fixture([], undefined, false, configured);
  const agent = {
    key: pubkey,
    pubkey,
    config: { workspace: "/tmp/codex-test" },
  } as Agent;
  expect((await f.runtime.preview(agent)).current).toBe("test-model");
  configured.model = "test-model";
  expect((await f.runtime.preview(agent)).current).toBe("test-model");
});
it("still offers the listed models when the configured one is not listed", async () => {
  const f = fixture();
  const agent = {
    key: pubkey,
    pubkey,
    config: { workspace: "/tmp/codex-test", model: "newer-model" },
  } as Agent;
  const { current, models } = await f.runtime.preview(agent);
  expect(current).toBe("newer-model");
  expect(models.map((model) => [model.id, model.efforts.length])).toEqual([
    ["newer-model", 0],
    ["test-model", 3],
    ["deep-model", 2],
  ]);
});
it("previews each model at the configured effort when it has it", async () => {
  const f = fixture();
  const agent = {
    key: pubkey,
    pubkey,
    config: { workspace: "/tmp/codex-test", effort: "low" },
  } as Agent;
  const { models } = await f.runtime.preview(agent);
  expect(models.map((model) => model.effort)).toEqual(["low", "high"]);
});
it.each([
  ["", "", "test-model", "medium"],
  ["test-model", "high", "test-model", "high"],
  ["deep-model", "", "deep-model", "high"],
  ["deep-model", "xhigh", "deep-model", "xhigh"],
])(
  "resolves Buzz model %s and thinking %s independently of local Codex preferences",
  async (model, effort, expected, expectedEffort) => {
    const f = fixture([], undefined, false, {
      model: "deep-model",
      model_reasoning_effort: "xhigh",
    });
    const delivery = {
      ...f.delivery("work"),
      config: { workspace: "/tmp/codex-test", model, effort },
    };
    const preview = await f.runtime.preview({
      key: pubkey,
      pubkey,
      config: delivery.config,
    } as Agent);
    expect(preview.current).toBe(expected);
    expect(preview.models.find((row) => row.id === expected)?.effort).toBe(
      expectedEffort,
    );
    await f.runtime.run(delivery);
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    expect(f.starts()[0]?.params).toMatchObject({
      model: expected,
      effort: expectedEffort,
    });
    expect(
      f.sent.find((wire) => wire.method === "thread/start")?.params,
    ).toMatchObject({ model: expected });
  },
);
it("ends a turn's input with the notes plugins left for it in its channel", async () => {
  const f = fixture();
  const delivery = f.delivery("@Codex go on");
  const notes = vi.fn((at: string) =>
    at === "channel" ? ["(I interrupted your reply)"] : [],
  );
  await f.runtime.run({
    ...delivery,
    agent: { ...delivery.agent, notes },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const params = f.starts()[0]?.params as { input: { text: string }[] };
  expect(params.input[0]?.text).toMatch(
    /<\/buzz-event>\n\n\(I interrupted your reply\)/,
  );
  // Its context names the membership, which its usage is read by.
  expect(params.input[0]?.text).toContain(
    `{"agent":"${delivery.agent.key}","channel_id"`,
  );
  expect(notes).toHaveBeenCalledOnce();
  expect(notes).toHaveBeenCalledWith("channel", root);
});
it("hands a turn the notes plugins left while it was being prepared", async () => {
  const f = fixture();
  const delivery = f.delivery("@Codex go on");
  const pending: Record<string, string[]> = {};
  const notes = vi.fn((at: string) => (pending[at] ?? []).splice(0));
  const reading = deferred<void>();
  f.read.mockImplementationOnce(async () => {
    await reading.promise;
    return [];
  });
  await f.runtime.run({ ...delivery, agent: { ...delivery.agent, notes } });
  await vi.waitFor(() => expect(f.read).toHaveBeenCalled());
  pending.channel = ["(I interrupted your reply)"];
  reading.resolve();
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const params = f.starts()[0]?.params as { input: { text: string }[] };
  expect(params.input[0]?.text).toMatch(
    /<\/buzz-event>\n\n\(I interrupted your reply\)/,
  );
  expect(pending.channel).toEqual([]);
});
it("tells a turn a reload stopped to carry on where it left off", async () => {
  const f = fixture();
  const fresh = f.delivery("@Codex fix the build");
  await f.runtime.run({
    ...fresh,
    trigger: { ...fresh.trigger, resumed: true } as Delivery["trigger"],
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const params = f.starts()[0]?.params as { input: { text: string }[] };
  expect(params.input[0]?.text).toContain("fix the build");
  expect(params.input[0]?.text).toContain(RESUMED_PROMPT);
});
it.each([
  [undefined, "auto"],
  ["detailed", undefined],
  ["none", undefined],
])(
  "asks for reasoning summaries unless the user set %s",
  async (setting, expected) => {
    const f = fixture([], undefined, false, {
      ...(setting ? { model_reasoning_summary: setting } : {}),
    });
    await f.runtime.run(f.delivery("@Codex think"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const [start] = f.starts();
    const params = start?.params as { summary?: string } | undefined;
    expect(params?.summary).toBe(expected);
  },
);
it("asks for reasoning summaries on a resumed turn", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await f.runtime.run(f.delivery("@Codex second"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.sent.some((wire) => wire.method === "thread/resume")).toBe(true);
  expect(f.starts()[1]?.params).toMatchObject({ summary: "auto" });
});
it("asks for reasoning summaries on a standalone watch turn", async () => {
  const f = fixture();
  f.attention.on = true;
  f.objects.set("interest/ops", { type: "interest", instructions: "Watch" });
  const watch = {
    type: "event",
    enabled: true,
    interest_id: "ops",
    since: 0,
    channels: "all",
    kinds: [9],
  } as const;
  f.objects.set("watch/deploys", watch);
  const base = f.delivery("someone else's message");
  if (base.trigger.type !== "mention") throw new Error("Expected mention");
  const event = { ...base.trigger.event, pubkey: "f".repeat(64) };
  f.wake({
    ...base,
    trigger: { type: "watch", event, slug: "watch/deploys", watch },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.starts()[0]?.params).toMatchObject({ summary: "auto" });
  await f.complete(0, "");
});
it("starts a turn at the effort its owner picked when the model supports it", async () => {
  const f = fixture();
  await f.runtime.run({ ...f.delivery("@Codex hard"), effort: "high" });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({
    ...f.delivery("@Codex other", "e".repeat(64)),
    effort: "max",
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(
    f.starts().map((wire) => (wire.params as { effort?: string }).effort),
  ).toEqual(["high", "low"]);
});
it("starts a turn on the model its owner picked, at an effort that model supports", async () => {
  const f = fixture();
  const run = async (
    thread: string,
    pick: { model?: string; effort?: string },
  ) => {
    const before = f.starts().length;
    await f.runtime.run({ ...f.delivery("@Codex", thread), ...pick });
    await vi.waitFor(() => expect(f.starts()).toHaveLength(before + 1));
  };
  await run("a".repeat(64), { model: "deep-model", effort: "xhigh" });
  // The configured `low` is not one of its levels, so it runs at its default.
  await run("b".repeat(64), { model: "deep-model" });
  // A model Codex no longer lists falls back to the agent's own.
  await run("c".repeat(64), { model: "gone-model" });
  expect(
    f.starts().map((wire) => {
      const { model, effort } = wire.params as {
        model: string;
        effort: string;
      };
      return { model, effort };
    }),
  ).toEqual([
    { model: "deep-model", effort: "xhigh" },
    { model: "deep-model", effort: "high" },
    { model: "test-model", effort: "low" },
  ]);
});
it("runs a mid-turn pick that differs from the running turn as the next turn instead of steering", async () => {
  const f = fixture();
  const settings = (wire: Wire) => {
    const { threadId, model, effort } = wire.params as Record<string, string>;
    return { threadId, model, effort };
  };
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({
    ...f.delivery("deeper"),
    model: "deep-model",
    effort: "xhigh",
  });
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  // An effort pick alone queues too, on the agent's own model.
  await f.runtime.run({ ...f.delivery("harder"), effort: "high" });
  await f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(0);
  expect(f.starts().map(settings)).toEqual([
    { threadId: "thread-1", model: "test-model", effort: "low" },
    { threadId: "thread-1", model: "deep-model", effort: "xhigh" },
    { threadId: "thread-1", model: "test-model", effort: "high" },
  ]);
  f.complete(2, "THIRD");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(3));
  expect(
    f.publish.mock.calls.map(([event]) => (event as EventData).content),
  ).toEqual(["FIRST", "SECOND", "THIRD"]);
});
it("keeps a plain follow-up behind a queued differing pick instead of steering past it", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({ ...f.delivery("deeper"), model: "deep-model" });
  await f.runtime.run(f.delivery("plain"));
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  // "plain" is still queued while "deeper" runs, so this cannot steer either.
  await f.runtime.run(f.delivery("later"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  await f.complete(2, "THIRD");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(4));
  expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(0);
  const input = (index: number) => JSON.stringify(f.starts()[index]?.params);
  expect(input(1)).toContain("deeper");
  expect(input(1)).toContain('"model":"deep-model"');
  expect(input(2)).toContain("plain");
  expect(input(2)).toContain('"model":"test-model"');
  expect(input(3)).toContain("later");
  f.complete(3, "FOURTH");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(4));
  expect(
    f.publish.mock.calls.map(([event]) => (event as EventData).content),
  ).toEqual(["FIRST", "SECOND", "THIRD", "FOURTH"]);
});
it("steers a mid-turn message whose pick matches the running turn, or has none", async () => {
  const f = fixture();
  await f.runtime.run({
    ...f.delivery("first"),
    model: "test-model",
    effort: "low",
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({
    ...f.delivery("same"),
    model: "test-model",
    effort: "low",
  });
  await f.runtime.run(f.delivery("plain"));
  await vi.waitFor(() =>
    expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(
      2,
    ),
  );
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.starts()).toHaveLength(1);
});
it("dates a binding by the latest message it took in or turn it ended", async () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture();
  const at = () => f.runtime.conversations(pubkey)[0]?.at;
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(at()).toBe(1_000));
  now = 2_000;
  await f.runtime.run(f.delivery("steered"));
  await vi.waitFor(() => expect(at()).toBe(2_000));
  now = 3_000;
  f.complete();
  await vi.waitFor(() => expect(at()).toBe(3_000));
});
it("serializes owner follow-ups and routes tool replies to the latest accepted request", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const gate = deferred<EventData[]>();
  f.read.mockImplementationOnce(() => gate.promise);
  const a = f.runtime.run(f.delivery("🤖 @Codex FIRST_STEER"));
  const b = f.runtime.run(f.delivery("SECOND_STEER"));
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    gate.resolve([]);
  }
  await Promise.all([a, b]);
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(2),
  );
  // Each mention counts as working until the turn it was steered into answers.
  let settled = 0;
  for (const [done] of f.workingUntil.mock.calls)
    void Promise.resolve(done).then(() => settled++);
  expect(f.workingUntil).toHaveBeenCalledTimes(3);
  // A macrotask lets every pending promise chain finish first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(0);
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(settled).toBe(3));
  const steering = f.sent.filter((wire) => wire.method === "turn/steer");
  expect(JSON.stringify(steering[0]?.params)).toContain("FIRST_STEER");
  expect(JSON.stringify(steering[1]?.params)).toContain("SECOND_STEER");
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    tags: expect.arrayContaining([["e", "c".repeat(64), "", "reply"]]),
  });
});
it("cuts delayed history off before the request, including same-second messages and edits", async () => {
  const f = fixture();
  const first = f.delivery("CURRENT_REQUEST");
  if (!("event" in first.trigger)) throw new Error("Expected a mention");
  first.trigger.event.tags.push(["ms", "300"]);
  const gate = deferred<EventData[]>();
  const previous: EventData = {
    ...first.trigger.event,
    id: "6".repeat(64),
    content: "EARLIER_MESSAGE",
    tags: [
      ...first.trigger.event.tags.filter(([key]) => key !== "ms"),
      ["ms", "100"],
    ],
  };
  const edit = (id: string, ms: string, content: string): EventData => ({
    ...previous,
    id: id.repeat(64),
    kind: 40003,
    content,
    tags: [
      ["h", "channel"],
      ["e", previous.id],
      ["ms", ms],
    ],
  });
  f.read
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValueOnce([
      edit("f", "250", "EARLIER_EDIT"),
      edit("e", "350", "FUTURE_EDIT"),
    ]);
  await f.runtime.run(first);
  const later = f.delivery("LATER_REQUEST");
  if (!("event" in later.trigger)) throw new Error("Expected a mention");
  later.trigger.event.tags.push(["ms", "400"]);
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    await f.runtime.run(later);
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve([
      previous,
      { ...first.trigger.event, id: "0".repeat(64), content: "TIE_BEFORE" },
      first.trigger.event as EventData,
      { ...first.trigger.event, id: "9".repeat(64), content: "TIE_AFTER" },
      later.trigger.event as EventData,
    ]);
  }
  await vi.waitFor(() =>
    expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(
      1,
    ),
  );
  const params = f.starts()[0]?.params as { input: { text: string }[] };
  const history = params.input[0]?.text.match(
    /<thread-context>\n([\s\S]*?)\n<\/thread-context>/,
  )?.[1];
  expect(history).toBeDefined();
  expect(
    JSON.parse(history ?? "{}").messages.map(
      (message: { content: string }) => message.content,
    ),
  ).toEqual(["EARLIER_EDIT", "TIE_BEFORE"]);
  expect(
    JSON.stringify(f.sent.find((wire) => wire.method === "turn/steer")?.params),
  ).toContain("LATER_REQUEST");
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
});

it.each([
  { channelType: "dm", scope: "thread", whole: true },
  { channelType: "stream", scope: "channel", whole: false },
  { channelType: "stream", scope: "thread", whole: false },
])(
  "defaults Buzz reads to the latest conversation in $channelType/$scope",
  async ({ channelType, scope, whole }) => {
    const f = fixture();
    vi.spyOn(f.snapshot.session.channels, "list").mockReturnValue({
      status: "ready",
      channels: [{ id: "channel", name: "test", channelType }],
    });
    const otherRoot = "e".repeat(64);
    f.delivery("OTHER_THREAD_CONTEXT", otherRoot);
    const first = f.delivery("CURRENT_REQUEST");
    await f.runtime.run({
      ...first,
      config: { ...(first.config as object), scope },
    });
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const initial = JSON.stringify((await f.tool("read", {}))?.result);
    expect(initial).toContain("CURRENT_REQUEST");
    expect(initial.includes("OTHER_THREAD_CONTEXT")).toBe(whole);
    const latest = f.delivery(
      "LATEST_REQUEST",
      scope === "thread" && !whole ? root : otherRoot,
    );
    await f.runtime.run({
      ...latest,
      config: { ...(latest.config as object), scope },
    });
    await vi.waitFor(() =>
      expect(
        f.sent.filter((wire) => wire.method === "turn/steer"),
      ).toHaveLength(1),
    );
    const after = JSON.stringify((await f.tool("read", {}))?.result);
    expect(after).toContain("LATEST_REQUEST");
    expect(after.includes("CURRENT_REQUEST")).toBe(whole || scope === "thread");
    expect(after.includes("OTHER_THREAD_CONTEXT")).toBe(
      whole || scope === "channel",
    );
    await f.complete();
    await vi.waitFor(() =>
      expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
    );
  },
);
it("cleans background terminals on server interruption and permits same-thread recovery", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Interrupted"),
  );
  expect(
    f.sent.some((wire) => wire.method === "thread/backgroundTerminals/clean"),
  ).toBe(true);
  expect(f.starts()).toHaveLength(1);
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("turn was interrupted"),
  });
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: false,
    error: "Codex’s turn was interrupted",
  });
  await f.runtime.run(f.delivery("recover"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    1,
  );
});
it("registers a stopper that interrupts the turn it is running", async () => {
  const f = fixture();
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("work"), interruptible });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(interruptible).toHaveBeenCalledTimes(1);
  expect(
    f.sent.filter((wire) => wire.method === "turn/interrupt"),
  ).toHaveLength(0);
  await interruptible.mock.calls[0]?.[0]();
  const sent = f.sent.filter((wire) => wire.method === "turn/interrupt");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.params).toEqual({
    threadId: (f.starts()[0]?.params as { threadId: string } | undefined)
      ?.threadId,
    turnId: "turn-1",
  });
});

it("refuses to stop a request still waiting for its turn, and leaves the running turn alone", async () => {
  const f = fixture();
  const running = vi.fn<NonNullable<Delivery["interruptible"]>>();
  const waiting = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("first"), interruptible: running });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  // Another model cannot be steered in, so it waits for the turn to end.
  await f.runtime.run({
    ...f.delivery("deeper"),
    model: "deep-model",
    interruptible: waiting,
  });
  await expect(waiting.mock.calls[0]?.[0]()).rejects.toThrow(
    "Codex has not started on this message yet",
  );
  expect(
    f.sent.filter((wire) => wire.method === "turn/interrupt"),
  ).toHaveLength(0);
  // The turn it did not stop ends as any other.
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ content: "FIRST" });
  expect(
    f.sent.filter((wire) => wire.method === "turn/interrupt"),
  ).toHaveLength(0);
  f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
});

it("refuses to stop a request queued behind a finished turn that is still cleaning up", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const cleanup = deferred<void>();
  f.held.set("thread/unsubscribe", cleanup.promise);
  await f.complete(0, "FIRST");
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "thread/unsubscribe")).toBe(
      true,
    ),
  );
  const waiting = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("second"), interruptible: waiting });
  await expect(waiting.mock.calls[0]?.[0]()).rejects.toThrow(
    "Codex has not started on this message yet",
  );
  // The request it did not stop runs once the finished turn lets go.
  cleanup.resolve();
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(
    f.sent.filter((wire) => wire.method === "turn/interrupt"),
  ).toHaveLength(0);
  f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
});

it("sends one interrupt for stops pressed together, and settles each with it", async () => {
  const f = fixture();
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("work"), interruptible });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const accepted = deferred<void>();
  f.held.set("turn/interrupt", accepted.promise);
  const stop = interruptible.mock.calls[0]?.[0];
  const first = stop?.();
  const second = stop?.();
  await vi.waitFor(() =>
    expect(
      f.sent.filter((wire) => wire.method === "turn/interrupt"),
    ).toHaveLength(1),
  );
  accepted.resolve();
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  await vi.waitFor(
    () => expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Stopped"),
    { timeout: 3_000 },
  );
  expect(
    f.sent.filter((wire) => wire.method === "turn/interrupt"),
  ).toHaveLength(1);
  expect(f.publish).not.toHaveBeenCalled();
});

it("runs a message sent while a stopped turn is ending as the next turn, not steered into it", async () => {
  const f = fixture();
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("work"), interruptible });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const accepted = deferred<void>();
  f.held.set("turn/interrupt", accepted.promise);
  const stopping = interruptible.mock.calls[0]?.[0]();
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(true),
  );
  await f.runtime.run(f.delivery("after"));
  // It waits for the stopped turn to end, as a turn of its own.
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Starting"),
  );
  accepted.resolve();
  await stopping;
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2), {
    timeout: 3_000,
  });
  expect(f.sent.some((wire) => wire.method === "turn/steer")).toBe(false);
  expect(inputText(f.starts()[1])).toContain("after");
  f.complete(1, "AFTER");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ content: "AFTER" });
});

it("rejects a stop Codex does not take, and still reports the turn's interruption", async () => {
  const f = fixture();
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("work"), interruptible });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.failing.add("turn/interrupt");
  await expect(interruptible.mock.calls[0]?.[0]()).rejects.toThrow(
    "turn/interrupt failed",
  );
  expect(
    f.sent.filter((wire) => wire.method === "turn/interrupt"),
  ).toHaveLength(1);
  // The turn is interrupted anyway, without the owner having stopped it.
  f.interrupt();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Interrupted"),
  );
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("turn was interrupted"),
  });
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: false,
    error: "Codex’s turn was interrupted",
  });
});

it("sends nothing when asked to stop a request whose turn has finished", async () => {
  const f = fixture();
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("work"), interruptible });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0, "DONE");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  await expect(interruptible.mock.calls[0]?.[0]()).resolves.toBeUndefined();
  expect(
    f.sent.filter((wire) => wire.method === "turn/interrupt"),
  ).toHaveLength(0);
});

it("ends a turn the owner stopped as stopped, not as an interruption failure", async () => {
  const f = fixture();
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("work"), interruptible });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await interruptible.mock.calls[0]?.[0]();
  // The stopped turn lets its shells linger a second before it settles.
  await vi.waitFor(
    () => expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Stopped"),
    { timeout: 3_000 },
  );
  for (const method of [
    "thread/backgroundTerminals/clean",
    "thread/backgroundTerminals/list",
  ])
    expect(f.sent.some((wire) => wire.method === method)).toBe(true);
  expect(f.publish).not.toHaveBeenCalled();
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: true,
    stopped: true,
  });
});

it("does not report a stop that Codex's turn finished before taking", async () => {
  const f = fixture();
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("work"), interruptible });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const accepted = deferred<void>();
  f.held.set("turn/interrupt", accepted.promise);
  const stopping = interruptible.mock.calls[0]?.[0]();
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(true),
  );
  // The turn completes on its own before the interrupt lands.
  await f.complete(0, "");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  accepted.resolve();
  await stopping;
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: true,
  });
});

it("keeps looking for shells for a moment after a stopped turn, and ends one that shows up late", async () => {
  const late: unknown[] = [];
  const f = fixture(late, Promise.resolve());
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  await f.runtime.run({ ...f.delivery("work"), interruptible });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await interruptible.mock.calls[0]?.[0]();
  const terminates = () =>
    f.sent.filter(
      (wire) => wire.method === "thread/backgroundTerminals/terminate",
    );
  // Codex hands the shell over only after the turn has ended.
  await vi.waitFor(() =>
    expect(
      f.sent.filter((wire) => wire.method === "thread/backgroundTerminals/list")
        .length,
    ).toBeGreaterThan(0),
  );
  expect(f.runtime.sessions(pubkey)[0]?.status).not.toBe("Stopped");
  late.push({ processId: "77" });
  await vi.waitFor(() => expect(terminates()).toHaveLength(1));
  expect(terminates()[0]?.params).toMatchObject({ processId: "77" });
  // The stopped turn lets its shells linger a second before it settles.
  await vi.waitFor(
    () => expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Stopped"),
    { timeout: 3_000 },
  );
  expect(f.publish).not.toHaveBeenCalled();
});

it("closes a native process returned after runtime disposal", async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  f.spawn.mockImplementationOnce(async (id, options) => {
    await original?.(id, options);
    started.resolve();
    return gate.promise;
  });
  await f.runtime.run(f.delivery("work"));
  await started.promise;
  f.runtime.dispose();
  try {
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve(f.process);
  }
  await f.exits.promise;
  expect(f.starts()).toHaveLength(0);
  expect(f.process.end).toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
it("ignores non-owner messages without spawning", async () => {
  const f = fixture();
  const other = f.delivery("work");
  if ("event" in other.trigger) other.trigger.event.pubkey = "f".repeat(64);
  const ignored = vi.fn();
  await f.runtime.run({ ...other, ignored });
  expect(ignored).toHaveBeenCalledOnce();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
it("runs a verified relay workflow mention for its owner", async () => {
  const f = fixture();
  const relay = keypair();
  f.snapshot.session.workflowAuthority = relay.pubkey;
  const ask = f.delivery("@Codex workflow");
  const event = eventDto(
    signed(relay, {
      kind: 9,
      content: "@Codex workflow",
      tags: [
        ["h", "channel"],
        ["p", pubkey],
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", owner],
        ["buzz:workflow-mention", pubkey],
      ],
    }),
  );
  const ignored = vi.fn();
  await f.runtime.run({ ...ask, trigger: { type: "mention", event }, ignored });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(ignored).not.toHaveBeenCalled();
  await f.complete();
  expect(f.publish).toHaveBeenCalled();
});
it.each([false, true])(
  "handles sibling workflow authorization with cancellation=%s",
  async (cancelled) => {
    const f = fixture();
    const relay = keypair(),
      human = keypair(),
      creator = keypair();
    const attestation = [
      "auth",
      human.pubkey,
      "",
      bytesToHex(
        schnorr.sign(
          createHash("sha256")
            .update(`nostr:agent-auth:${creator.pubkey}:`)
            .digest(),
          human.secret,
        ),
      ),
    ];
    const profile = eventDto(
      signed(creator, { kind: 0, content: "{}", tags: [attestation] }),
    );
    f.snapshot.session.workflowAuthority = relay.pubkey;
    f.snapshot.session.profiles.event.mockReturnValue(profile);
    const gate = deferred<void>();
    const controller = new AbortController();
    f.snapshot.session.profiles.ensure.mockReturnValue(gate.promise);
    const ask = f.delivery("work");
    const event = eventDto(
      signed(relay, {
        kind: 9,
        content: "@Codex workflow",
        tags: [
          ["h", "channel"],
          ["p", pubkey],
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", creator.pubkey],
          ["buzz:workflow-mention", pubkey],
        ],
      }),
    );
    const done = f.runtime.run({
      ...ask,
      signal: controller.signal,
      agent: { ...ask.agent, owner: human.pubkey },
      trigger: { type: "mention", event },
    });
    await vi.waitFor(() =>
      expect(f.snapshot.session.profiles.ensure).toHaveBeenCalledOnce(),
    );
    if (cancelled) {
      f.runtime.sync([]);
      controller.abort();
      gate.resolve();
      await expect(done).rejects.toMatchObject({ name: "AbortError" });
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.workingUntil).not.toHaveBeenCalled();
      expect(f.runtime.sessions(pubkey)).toEqual([]);
      return;
    }
    gate.resolve();
    await done;
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    expect(f.snapshot.session.profiles.ensure).toHaveBeenCalledWith(
      [creator.pubkey],
      "foreground",
    );
    await f.complete();
    expect(f.publish).toHaveBeenCalled();
  },
);
it("starts no work when the agent stops while its channel is read", async () => {
  const f = fixture();
  const relay = { snapshot: () => f.snapshot } as unknown as RelayData;
  const gate = deferred<void>();
  const channel = vi.fn();
  const runtime = new CodexRuntime(
    f.spawn,
    (key) => {
      const reads = ownerReads(relay, key);
      return (
        reads && {
          ...reads,
          channel: async (id: string) => {
            channel(id);
            await gate.promise;
            return reads.channel(id);
          },
        }
      );
    },
    async () => undefined,
    localStore({
      getItem: () => null,
      setItem: () => {},
    } as unknown as Storage),
  );
  runtimes.push(runtime);
  runtime.sync([{ key: pubkey, pubkey } as Agent]);
  const controller = new AbortController();
  const done = runtime.run({
    ...f.delivery("work"),
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(channel).toHaveBeenCalledWith("channel"));
  runtime.sync([]);
  controller.abort();
  gate.resolve();
  await expect(done).rejects.toMatchObject({ name: "AbortError" });
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.workingUntil).not.toHaveBeenCalled();
  expect(runtime.sessions(pubkey)).toEqual([]);
});
it("ignores a relay workflow mention without explicit community authority", async () => {
  const f = fixture();
  const relay = keypair();
  const event = eventDto(
    signed(relay, {
      kind: 9,
      content: "@Codex workflow",
      tags: [
        ["h", "channel"],
        ["p", pubkey],
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", owner],
        ["buzz:workflow-mention", pubkey],
      ],
    }),
  );
  const ignored = vi.fn();
  await f.runtime.run({
    ...f.delivery("work"),
    trigger: { type: "mention", event },
    ignored,
  });
  expect(ignored).toHaveBeenCalledOnce();
  expect(f.spawn).not.toHaveBeenCalled();
});
it("answers another agent its owner attested, telling the owner of failures", async () => {
  const f = fixture();
  const secret = schnorr.utils.randomSecretKey();
  const owner = bytesToHex(schnorr.getPublicKey(secret));
  const sibling = bytesToHex(
    schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
  );
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${sibling}:`)
    .digest();
  const ask = f.delivery("work");
  if ("event" in ask.trigger) {
    ask.trigger.event.pubkey = sibling;
    ask.trigger.event.tags.push([
      "auth",
      owner,
      "",
      bytesToHex(schnorr.sign(digest, secret)),
    ]);
  }
  await f.runtime.run({ ...ask, agent: { ...ask.agent, owner } });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  // A failure tells the owner: tagging the sibling would wake it to fail too.
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  const failure = f.publish.mock.calls[0]?.[0] as { tags: string[][] };
  expect(failure.tags).toContainEqual(["p", owner]);
  expect(failure.tags).not.toContainEqual(["p", sibling]);
});
it("ends a turn without a reply silently, and publishes an unexpected exit", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete(0, "");
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: true,
  });
  await f.runtime.run(f.delivery("next"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("Codex exited"),
  });
  await expect(f.workingUntil.mock.calls[1]?.[0]).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("Codex exited"),
  });
});
/** A plugin's wake; its id is its own, which nothing may publish. */
const WAKE_ID = "8".repeat(64);
const pluginWake = (
  f: ReturnType<typeof fixture>,
  threadRoot?: string,
  ignored?: () => void,
): Delivery => ({
  ...f.delivery("unused"),
  trigger: {
    type: "plugin",
    plugin: "github",
    channel: "channel",
    ...(threadRoot ? { root: threadRoot } : {}),
    text: "CI failed: lint",
    id: WAKE_ID,
    at: 10_500,
  },
  ...(ignored ? { ignored } : {}),
});
it("takes a plugin's wake in its thread's conversation, as the plugin's and not a message", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("@Codex watch my PR"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0);
  await f.runtime.run(pluginWake(f, root));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const [first, next] = f
    .starts()
    .map((wire) => wire.params as { threadId: string });
  expect(next?.threadId).toBe(first?.threadId);
  const input = JSON.stringify(next);
  expect(input).toContain("<plugin-wake plugin=");
  expect(input).toContain("neither your owner nor anyone in the channel");
  expect(input).toContain("CI failed: lint");
  expect(input).not.toContain("<buzz-event");
  expect(input).not.toContain(WAKE_ID);
});
it("reports a failed wake at its thread's root, never at the wake's own id", async () => {
  const f = fixture();
  await f.runtime.run(pluginWake(f, root));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    tags: expect.arrayContaining([["e", root, "", "reply"]]),
  });
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain(WAKE_ID);
});
it("refreshes a queued plugin wake's instructions when its turn starts", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  let instructions = "Original instructions";
  const wakeText = vi.fn(async () => instructions);
  await f.runtime.run({
    ...pluginWake(f, root),
    model: "deep-model",
    wakeText,
  });
  instructions = "Updated instructions";
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const input = JSON.stringify(f.starts()[1]?.params);
  expect(input).toContain("Updated instructions");
  expect(input).not.toContain("Original instructions");
  expect(wakeText).toHaveBeenCalledOnce();
  await f.complete(1, "SECOND");
});
it("takes a wake with no thread only in a Solo chat", async () => {
  const f = fixture();
  const ignored = vi.fn();
  await f.runtime.run(pluginWake(f, undefined, ignored));
  expect(ignored).toHaveBeenCalled();
  expect(f.starts()).toHaveLength(0);
  f.soloChannels.add("channel");
  await f.runtime.run(pluginWake(f));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const input = JSON.stringify(f.starts()[0]?.params);
  expect(input).toContain("<plugin-wake plugin=");
  expect(input).toContain("top-level");
  expect(input).not.toContain(WAKE_ID);
});
it("gives a fresh wake the thread's earlier messages of its same second, and none after", async () => {
  const f = fixture();
  // The wake is at 10.500s, the second the thread's messages share.
  const message = (id: string, content: string, ms: string): EventData => ({
    id: id.repeat(64),
    pubkey: owner,
    kind: 9,
    content,
    created_at: 10,
    tags: [
      ["h", "channel"],
      ...(id === "c" ? [] : [["e", root, "", "reply"]]),
      ["ms", ms],
    ],
  });
  f.read.mockResolvedValueOnce([
    message("c", "ORIGINAL_REQUEST", "100"),
    message("1", "EARLIER_REPLY", "499"),
    message("2", "LATER_REPLY", "501"),
  ]);
  await f.runtime.run(pluginWake(f, root));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const params = f.starts()[0]?.params as { input: { text: string }[] };
  const history = params.input[0]?.text.match(
    /<thread-context>\n([\s\S]*?)\n<\/thread-context>/,
  )?.[1];
  expect(
    JSON.parse(history ?? "{}").messages.map(
      (message: { content: string }) => message.content,
    ),
  ).toEqual(["ORIGINAL_REQUEST", "EARLIER_REPLY"]);
});
it("sets no deadline of its own on a turn", async () => {
  // Any deadline Buzz set would already have passed.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
    AbortSignal.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    ),
  );
  const f = fixture();
  await f.runtime.run(f.delivery("a long job"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ content: "DONE" });
});
it("ends the server when its agent stops running and suppresses a late final answer", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.runtime.sync([]);
  f.complete();
  await f.exits.promise;
  expect(f.process.end).toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it("reports an interruption cleanup failure when Codex reports surviving terminals", async () => {
  const f = fixture([{ processId: "42" }]);
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining(
      "background terminals could not be stopped",
    ),
  });
  expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Needs attention");
  expect(f.process.end).toHaveBeenCalled();
});
it("restores a persisted binding after reload and starts fresh in a different workspace", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete();
  await vi.waitFor(() =>
    expect(f.sent.some((w) => w.method === "thread/unsubscribe")).toBe(true),
  );
  f.runtime.dispose();
  await f.exits.promise;
  const restored = fixture();
  for (const [key, value] of f.storage) restored.storage.set(key, value);
  await restored.runtime.run(restored.delivery("continue"));
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(1));
  expect(
    restored.sent.find((w) => w.method === "thread/resume")?.params,
  ).toMatchObject({ excludeTurns: true });
  restored.complete();
  await vi.waitFor(() =>
    expect(restored.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  const useDefaults = restored.delivery("defaults");
  await restored.runtime.run({
    ...useDefaults,
    config: { workspace: "/tmp/codex-test" },
  });
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(2));
  expect(restored.starts()[1]?.params).toMatchObject({
    model: "test-model",
    effort: "medium",
  });
  restored.complete();
  await vi.waitFor(() => expect(restored.publish).toHaveBeenCalledTimes(2));
  const changed = restored.delivery("new workspace");
  await restored.runtime.run({
    ...changed,
    config: { workspace: "/tmp/different-workspace" },
  });
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(3));
  expect(restored.sent.some((w) => w.method === "thread/start")).toBe(true);
  expect(restored.starts()[2]?.params).toMatchObject({
    model: "test-model",
    effort: "medium",
  });
  restored.complete();
  await vi.waitFor(() => expect(restored.publish).toHaveBeenCalledTimes(3));
});

it("waits for terminal termination after asynchronous clean acknowledgement before reporting interruption", async () => {
  const gate = deferred<void>();
  const f = fixture([{ processId: "42" }], gate.promise);
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  try {
    await vi.waitFor(() =>
      expect(
        f.sent.some((w) => w.method === "thread/backgroundTerminals/terminate"),
      ).toBe(true),
    );
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("turn was interrupted"),
  });
  expect(f.process.end).not.toHaveBeenCalled();
});

it("publishes workspace errors without starting work", async () => {
  const f = fixture();
  await f.runtime.run({
    ...f.delivery("hello"),
    config: { workspace: "relative" },
  });
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("absolute or ~/… workspace"),
  });
  expect(f.spawn).not.toHaveBeenCalled();
});

it("resolves a workspace under home through the process host", async () => {
  const f = fixture();
  await f.runtime.run({
    ...f.delivery("hello"),
    config: { workspace: "~/code" },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.spawn).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({ cwd: "~/code" }),
  );
  f.runtime.dispose();
});

it.each([{}, { workspace: "" }, { workspace: "  " }])(
  "runs blank workspace settings in the resolved default: %j",
  async (config) => {
    const f = fixture();
    await f.runtime.run({ ...f.delivery("hello"), config });
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    expect(f.spawn).toHaveBeenCalledWith(
      "app-server",
      expect.objectContaining({ cwd: "~/.buzz" }),
    );
    expect(f.spawn).toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({ cwd: "~/.buzz" }),
    );
    for (const method of ["config/read", "thread/start"])
      expect(
        f.sent.find((wire) => wire.method === method)?.params,
      ).toMatchObject({ cwd: "/home/test/.buzz" });
    f.complete(0, "DONE");
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    await f.runtime.run({ ...f.delivery("again"), config });
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    expect(
      f.sent.find((wire) => wire.method === "thread/resume")?.params,
    ).toMatchObject({ cwd: "/home/test/.buzz" });
    f.complete(1, "DONE AGAIN");
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
    f.runtime.dispose();
  },
);

it("reports a default workspace resolution failure without starting a turn", async () => {
  const f = fixture();
  const spawn = f.spawn.getMockImplementation();
  if (!spawn) throw new Error("Missing spawn fixture");
  f.spawn.mockImplementation(async (id, options) =>
    id === "workspace"
      ? { ...f.process, exited: Promise.resolve(1) }
      : spawn(id, options),
  );
  await f.runtime.run({ ...f.delivery("hello"), config: {} });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining(
      "Could not resolve the Codex workspace ~/.buzz",
    ),
  });
  expect(f.starts()).toHaveLength(0);
});

it("uses the default after changing away from a custom workspace on an existing server", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("custom"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete(0, "CUSTOM");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await f.runtime.run({ ...f.delivery("default"), config: {} });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const threads = f.sent.filter((wire) => wire.method === "thread/start");
  expect(threads.map((wire) => (wire.params as { cwd: string }).cwd)).toEqual([
    "/tmp/codex-test",
    "/home/test/.buzz",
  ]);
  f.complete(1, "DEFAULT");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
});

it("posts tool-sent parts and never duplicates native assistant text", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.tool("send", { audience: "everyone", text: "PART ONE" });
  await f.tool("send", { audience: "everyone", text: "PART TWO" });
  await f.complete(0, "FINAL");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(
    f.publish.mock.calls.map(
      ([event]) => (event as { content: string }).content,
    ),
  ).toEqual(["PART ONE", "PART TWO", "FINAL"]);
  const response = f.sent.findIndex(
    (wire) => wire.id === "tool-3" && !wire.method,
  );
  const interrupt = f.sent.findIndex(
    (wire) => wire.method === "turn/interrupt",
  );
  expect(response).toBeGreaterThan(-1);
  expect(interrupt).toBe(-1);
});
it("delivers a plain follow-up after startup without waiting for the running turn", async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  f.spawn.mockImplementationOnce(async (id, options) => {
    await original?.(id, options);
    started.resolve();
    return gate.promise;
  });
  await f.runtime.run(f.delivery("first"));
  await started.promise;
  try {
    await f.runtime.run(f.delivery("during startup"));
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve(f.process);
  }
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(1),
  );
  expect(f.starts()).toHaveLength(1);
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
});

it("keeps plugin work alive through relay reconnect and ends it when its agent stops running", async () => {
  const f = fixture([], undefined, true);
  try {
    await f.runPlugin(f.delivery("work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    f.snapshot.status = "connecting";
    f.snapshot.scope = undefined;
    f.notify();
    f.snapshot.status = "ready";
    f.snapshot.scope = scope;
    f.notify();
    f.complete();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    expect(f.process.end).not.toHaveBeenCalled();
    await f.runPlugin(f.delivery("more work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    f.running.length = 0;
    f.notify();
    f.complete();
    await f.exits.promise;
    expect(f.process.end).toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledTimes(1);
  } finally {
    f.pluginDispose();
  }
});

it("starts the next turn when completion races a plain follow-up's history read", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const gate = deferred<EventData[]>();
  f.read.mockImplementationOnce(() => gate.promise);
  await f.runtime.run(f.delivery("follow-up"));
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    await f.complete(0, "FIRST");
  } finally {
    gate.resolve([]);
  }
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(0);
  f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.publish.mock.calls[1]?.[0]).toMatchObject({ content: "SECOND" });
});

it.each(["/queue", "/stop", "/steer", "/reset"])(
  "delivers %s as ordinary steering text",
  async (command) => {
    const f = fixture();
    await f.runtime.run(f.delivery("work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const content = `${command} ordinary text`;
    await f.runtime.run(f.delivery(content));
    await vi.waitFor(() =>
      expect(
        f.sent.filter((wire) => wire.method === "turn/steer"),
      ).toHaveLength(1),
    );
    const steer = f.sent.find((wire) => wire.method === "turn/steer")
      ?.params as { input: { text: string }[] };
    expect(steer.input[0]?.text).toContain(
      `Request: ${JSON.stringify(content)}`,
    );
    expect(f.publish).not.toHaveBeenCalled();
    f.complete();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  },
);
it.each(["v2", "v3", "v5", "v6", "v7"])(
  "starts fresh instead of restoring a %s binding, whose tools are out of date",
  async (version) => {
    const f = fixture();
    f.storage.set(
      `buzz.codex.sessions.${version}:${scope}:${pubkey}`,
      JSON.stringify({
        [JSON.stringify(["channel", root])]: {
          threadId: "legacy-thread",
          workspace: "/tmp/codex-test",
        },
      }),
    );
    await f.runtime.run(f.delivery("new work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    expect(
      f.sent.filter((wire) => wire.method === "thread/resume"),
    ).toHaveLength(0);
    const thread = f.sent.find((wire) => wire.method === "thread/start")
      ?.params as { dynamicTools: { tools: { name: string }[] }[] };
    expect(thread.dynamicTools[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "media_get",
        "notes_get",
        "notes_set",
        "notes_rm",
        "agent_types",
        "agent_create",
        "agent_update",
      ]),
    );
    f.complete();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  },
);

it("leaves a failed first startup unbound so the next mention can start fresh", async () => {
  const f = fixture();
  const reading = deferred<void>();
  const gate = deferred<void>();
  f.read.mockImplementationOnce(async () => {
    reading.resolve();
    await gate.promise;
    throw new Error("Relay history unavailable");
  });
  await f.runtime.run(f.delivery("first"));
  await reading.promise;
  try {
    expect(f.storage.size).toBe(0);
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("Relay history unavailable"),
  });
  await f.runtime.run(f.delivery("retry"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.sent.filter((wire) => wire.method === "thread/start")).toHaveLength(
    2,
  );
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    0,
  );
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(JSON.parse([...f.storage.values()][0] ?? "{}")).toMatchObject({
    [JSON.stringify(["channel", root])]: { threadId: "thread-2" },
  });
});

it("continues a saved thread copied from the user's Codex home", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  const write = f.process.write;
  let resumes = 0;
  vi.spyOn(f.process, "write").mockImplementation(async (data) => {
    const wire: Wire = JSON.parse(data);
    if (wire.method !== "thread/resume" || wire.id == null) return write(data);
    f.sent.push(wire);
    // Missing until Buzz copies it into its own home.
    if (resumes++ === 0 || !f.adopted.includes("thread-1"))
      f.emit({
        id: wire.id,
        error: {
          code: -32600,
          message: "no rollout found for thread id thread-1",
        },
      });
    else
      f.emit({
        id: wire.id,
        result: { thread: { id: "thread-1", cwd: "/home/test/.buzz" } },
      });
  });
  await f.runtime.run(f.delivery("follow-up"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.starts()[1]?.params).toMatchObject({ threadId: "thread-1" });
  expect(f.adopted).toEqual(["thread-1"]);
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    2,
  );
  expect(f.sent.filter((wire) => wire.method === "thread/start")).toHaveLength(
    1,
  );
});

it.each([
  ["no rollout found for thread id thread-1", true],
  ["Permission denied reading saved thread", false],
])("recovers only a missing saved thread: %s", async (error, recover) => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  const write = f.process.write;
  vi.spyOn(f.process, "write").mockImplementation(async (data) => {
    const wire: Wire = JSON.parse(data);
    if (wire.method !== "thread/resume" || wire.id == null) return write(data);
    f.sent.push(wire);
    f.emit({ id: wire.id, error: { code: -32600, message: error } });
  });
  await f.runtime.run(f.delivery("follow-up"));
  if (recover) {
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    expect(f.starts()[1]?.params).toMatchObject({ threadId: "thread-2" });
    f.complete();
  }
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.publish.mock.calls[1]?.[0]).toMatchObject({
    content: recover ? "DONE" : expect.stringContaining(error),
  });
  expect(JSON.parse([...f.storage.values()][0] ?? "{}")).toMatchObject({
    [JSON.stringify(["channel", root])]: {
      threadId: recover ? "thread-2" : "thread-1",
    },
  });
});

it("routes callbacks by thread and turn, rejecting stale, unknown and malformed tools without writes", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await f.runtime.run(f.delivery("other", "e".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  for (const overrides of [
    { turnId: "stale" },
    { threadId: "missing" },
    { namespace: "other" },
    { tool: "unknown" },
    { arguments: [] },
  ]) {
    expect(
      (
        await f.tool(
          "send",
          { audience: "everyone", text: "must not send" },
          0,
          overrides,
        )
      )?.result,
    ).toMatchObject({
      success: false,
      contentItems: [{ type: "inputText", text: expect.any(String) }],
    });
  }
  expect(f.publish).not.toHaveBeenCalled();
  await f.complete(1, "OTHER");
  await f.complete(0, "FIRST");
  await vi.waitFor(() =>
    expect(
      f.runtime.sessions(pubkey).every((view) => view.status === "Idle"),
    ).toBe(true),
  );
  expect(f.publish.mock.calls.map(([event]) => event)).toMatchObject([
    {
      content: "OTHER",
      tags: expect.arrayContaining([["e", "e".repeat(64), "", "reply"]]),
    },
    {
      content: "FIRST",
      tags: expect.arrayContaining([["e", root, "", "reply"]]),
    },
  ]);
  const count = f.publish.mock.calls.length;
  expect(
    (await f.tool("send", { audience: "everyone", text: "late" }, 0))?.result,
  ).toMatchObject({
    success: false,
  });
  expect(f.publish).toHaveBeenCalledTimes(count);
});

it("starts each turn from the host's core memory, reading none from the relay", async () => {
  const f = fixture();
  const instructions = (index: number) =>
    (
      f.starts()[index]?.params as
        | { additionalContext?: Record<string, { value: string }> }
        | undefined
    )?.additionalContext?.["buzz.instructions"]?.value;
  f.core.mockResolvedValueOnce("I am Codex.");
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(instructions(0)).toContain(
    "Current core memory replaces all prior core memory.\n<core-memory>\nI am Codex.\n</core-memory>",
  );
  expect(f.core).toHaveBeenCalledWith(pubkey, expect.any(AbortSignal));
  expect(f.memoryRead).not.toHaveBeenCalled();
  f.complete(0, "FIRST");
  // The host could not read it: the turn goes on without it.
  f.core.mockResolvedValueOnce(undefined);
  await f.runtime.run(f.delivery("@Codex second", "e".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(instructions(1)).toContain("TEST_INSTRUCTIONS");
  expect(instructions(1)).not.toContain("<core-memory>");
  f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
});

it("splits turn context into ordered values that Codex does not truncate", async () => {
  const f = fixture();
  // Codex truncates the middle of any value over 4,000 UTF-8 bytes.
  const instructions = `${Array.from({ length: 400 }, (_, line) => `Rule ${line}.`).join("\n")}\n${"é".repeat(3_000)}`;
  await f.remember("core", `CORE START ${"c".repeat(6_000)} CORE END`, 0);
  await f.runtime.run({
    ...f.delivery("@Codex big"),
    config: {
      workspace: "/tmp/codex-test",
      model: "test-model",
      effort: "low",
      instructions,
    },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const context =
    (
      f.starts()[0]?.params as
        | {
            additionalContext: Record<string, { kind: string; value: string }>;
          }
        | undefined
    )?.additionalContext ?? {};
  const keys = Object.keys(context).sort();
  expect(keys.length).toBeGreaterThan(3);
  expect(keys.slice(0, 2)).toEqual([
    "buzz.instructions",
    "buzz.instructions.001",
  ]);
  for (const key of keys) {
    expect(context[key]?.kind).toBe("application");
    expect(
      new TextEncoder().encode(context[key]?.value).length,
    ).toBeLessThanOrEqual(4_000);
  }
  const text = keys.map((key) => context[key]?.value).join("");
  expect(text).toContain(
    `<agent-instructions>\n${instructions}\n</agent-instructions>`,
  );
  expect(text).toContain(`CORE START ${"c".repeat(6_000)} CORE END`);
  expect(context["buzz.instructions.001"]?.value).toMatch(/^Rule \d+\.\n/);
});

it("gives a resumed conversation the agent's current name", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  const renamed = f.delivery("@Renamed second");
  await f.runtime.run({
    ...renamed,
    agent: { ...renamed.agent, name: "Renamed" },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  // Codex keeps a resumed thread's original developer instructions.
  expect(
    f.sent.find((wire) => wire.method === "thread/resume")?.params,
  ).toMatchObject({
    threadId: (f.starts()[0]?.params as { threadId?: string } | undefined)
      ?.threadId,
  });
  expect(f.starts()[1]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        value: expect.stringMatching(/^You are Renamed \(pubkey /),
      },
    },
  });
});

it("uses the launched workspace for shared file tools and the owner view for encrypted memory", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({
    ...f.delivery("follow-up"),
    config: { workspace: "/tmp/different" },
  });
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "turn/steer")).toBe(true),
  );
  expect(
    (await f.tool("mem_set", { slug: "mem/test", text: "remembered" }))?.result,
  ).toMatchObject({ success: true });
  expect((await f.tool("mem_get", { slug: "mem/test" }))?.result).toMatchObject(
    {
      success: true,
      contentItems: [
        {
          text: expect.stringMatching(/^version: [0-9a-f]{16}\n\nremembered$/),
        },
      ],
    },
  );
  expect(
    (await f.tool("media_get", { url: "shot.png" }))?.result,
  ).toMatchObject({
    success: true,
    contentItems: [
      {
        type: "inputImage",
        imageUrl: `data:image/png;base64,${btoa("\x89PNG\r\n")}`,
      },
      {
        type: "inputText",
        text: "Saved /cache/shot.png (image/png, 6 bytes).",
      },
    ],
  });
  expect(f.media).toHaveBeenCalledWith("shot.png");
  expect(f.remember).toHaveBeenCalledWith("mem/test", "remembered", 0);
  // mem_set's read and a fresh post-write read, each of one entry by its slug;
  // the turn's `core` came from the host.
  expect(
    f.memoryRead.mock.calls.map((call: unknown[]) => [call[0], call[2]]),
  ).toEqual([
    [pubkey, "mem/test"],
    [pubkey, "mem/test"],
  ]);
  expect(
    (
      await f.tool("send", {
        audience: "everyone",
        path: "answer.txt",
        files: ["attachment.jpg"],
        final: true,
      })
    )?.result,
  ).toMatchObject({ success: true });
  f.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    },
  });
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(f.fileReads).toEqual([
    { cwd: "/tmp/codex-test", path: "attachment.jpg" },
    { cwd: "/tmp/codex-test", path: "answer.txt" },
  ]);
  expect(f.upload).toHaveBeenCalledWith(btoa("\xff\xd8\xff"), "image/jpeg");
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("FILE CONTENT"),
    tags: expect.arrayContaining([["e", "c".repeat(64), "", "reply"]]),
  });
});

it("returns a failed send to Codex for correction without ending its turn", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.publish.mockRejectedValueOnce(new Error("Signing rejected"));
  expect(
    (
      await f.tool("send", {
        audience: "everyone",
        text: "answer",
        final: true,
      })
    )?.result,
  ).toMatchObject({
    success: false,
    contentItems: [{ type: "inputText", text: "Signing rejected" }],
  });
  expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(false);
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(f.publish).toHaveBeenCalledTimes(2);
});

it.each(["accepted", "rejected"] as const)(
  "moves same-thread activity only after steering is accepted: %s",
  async (outcome) => {
    const f = fixture();
    const first = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
    const next = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
    await f.runtime.run({ ...f.delivery("first"), ...first });
    await vi.waitFor(() => expect(first.acknowledged).toHaveBeenCalledOnce());
    const started = f.starts()[0];
    if (!started) throw new Error("Expected started turn");
    const threadId = (started.params as { threadId: string }).threadId;
    const step = (command: string) =>
      f.emit({
        method: "item/started",
        params: { threadId, item: { type: "commandExecution", command } },
      });
    step("sleep 20");
    expect(first.step).toHaveBeenLastCalledWith("Shell", "sleep");
    const requested = deferred<void>();
    const response = deferred<void>();
    const write = f.process.write;
    f.process.write = async (data) => {
      const wire: Wire = JSON.parse(data);
      if (wire.method !== "turn/steer") return write(data);
      if (wire.id === undefined) throw new Error("Expected steering RPC id");
      requested.resolve();
      await response.promise;
      if (outcome === "rejected") {
        f.emit({
          id: wire.id,
          error: { code: -32000, message: "Cannot accept follow-up" },
        });
        return;
      }
      await write(data);
    };
    try {
      await f.runtime.run({ ...f.delivery("follow-up"), ...next });
      await requested.promise;
      step("ls");
      expect(first.step).toHaveBeenLastCalledWith("Shell", "ls");
      expect(first.superseded).not.toHaveBeenCalled();
      expect(next.acknowledged).not.toHaveBeenCalled();
      expect(next.step).not.toHaveBeenCalled();
      response.resolve();
      if (outcome === "accepted") {
        await vi.waitFor(() =>
          expect(next.acknowledged).toHaveBeenCalledOnce(),
        );
        expect(first.superseded).toHaveBeenCalledOnce();
        step("pwd");
        expect(next.step).toHaveBeenLastCalledWith("Shell", "pwd");
        expect(first.step).toHaveBeenLastCalledWith("Shell", "ls");
        await f.tool("send", {
          audience: "everyone",
          text: "Updated answer",
          final: true,
        });
        for (const [done] of f.workingUntil.mock.calls)
          await expect(done).resolves.toEqual({ ok: true });
      } else {
        await expect(f.workingUntil.mock.calls[1]?.[0]).resolves.toMatchObject({
          ok: false,
        });
        expect(first.superseded).not.toHaveBeenCalled();
        expect(next.acknowledged).not.toHaveBeenCalled();
        step("pwd");
        expect(first.step).toHaveBeenLastCalledWith("Shell", "pwd");
        await f.tool("send", {
          audience: "everyone",
          text: "Original answer",
          final: true,
        });
        await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
          ok: true,
        });
      }
      await f.complete();
      await vi.waitFor(() =>
        expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
      );
    } finally {
      response.resolve();
    }
  },
);

it("keeps each thread's activity in a shared session and does not move it to watches", async () => {
  const f = fixture();
  const first = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  const second = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  const delivery = (text: string, threadRoot: string) => {
    const d = f.delivery(text, threadRoot);
    return { ...d, config: { ...(d.config as object), scope: "channel" } };
  };
  await f.runtime.run({ ...delivery("first thread", root), ...first });
  await vi.waitFor(() => expect(first.acknowledged).toHaveBeenCalledOnce());
  await f.runtime.run({
    ...delivery("second thread", "e".repeat(64)),
    ...second,
  });
  await vi.waitFor(() => expect(second.acknowledged).toHaveBeenCalledOnce());
  expect(first.superseded).not.toHaveBeenCalled();
  const watch = delivery("watched message", root);
  if (watch.trigger.type !== "mention") throw new Error("Expected mention");
  const watched = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  f.wake({
    ...watch,
    ...watched,
    trigger: {
      type: "watch",
      event: watch.trigger.event,
      slug: "watch/test",
      watch: {
        type: "event",
        enabled: true,
        interest_id: "test",
        since: 0,
        channels: "all",
        kinds: [9],
      },
    },
  });
  // The watch runs as a one-off turn of its own, never steered into a
  // conversation; this one has no saved watch, so it does not run at all.
  const wakeDone = f.workingUntil.mock.calls.at(-1)?.[0];
  await expect(wakeDone).resolves.toEqual({ ok: true });
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(1),
  );
  expect(f.sent.filter((w) => w.method === "thread/start")).toHaveLength(1);
  // A tool call waits for the steering chain, establishing that it was taken.
  await f.tool("send", {
    audience: "everyone",
    text: "Progress",
    final: false,
  });
  const started = f.starts()[0];
  if (!started) throw new Error("Expected started turn");
  const threadId = (started.params as { threadId: string }).threadId;
  f.emit({
    method: "item/started",
    params: { threadId, item: { type: "reasoning" } },
  });
  expect(first.step).toHaveBeenLastCalledWith("Thinking", undefined);
  expect(second.step).toHaveBeenLastCalledWith("Thinking", undefined);
  expect(first.superseded).not.toHaveBeenCalled();
  expect(second.superseded).not.toHaveBeenCalled();
  expect(watched.acknowledged).not.toHaveBeenCalled();
  expect(watched.step).not.toHaveBeenCalled();
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
});

it("delivers pending owner steering after a final send and posts its own answer", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const gate = deferred<EventData[]>();
  f.read.mockImplementationOnce(() => gate.promise);
  await f.runtime.run(f.delivery("new request"));
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    await f.tool("send", {
      audience: "everyone",
      text: "prior answer",
      final: true,
    });
    expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(false);
  } finally {
    gate.resolve([]);
  }
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "turn/steer")).toBe(true),
  );
  // The prior answer settles only the first request.
  let steered = false;
  void Promise.resolve(f.workingUntil.mock.calls[1]?.[0]).then(() => {
    steered = true;
  });
  await f.workingUntil.mock.calls[0]?.[0];
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(steered).toBe(false);
  await f.complete(0, "NEW ANSWER");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(
    f.publish.mock.calls.map(
      ([event]) => (event as { content: string }).content,
    ),
  ).toEqual(["prior answer", "NEW ANSWER"]);
});

it("lets go of a rejected steering mention without ending the running turn", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const write = f.process.write;
  vi.spyOn(f.process, "write").mockImplementation(async (data) => {
    const wire: Wire = JSON.parse(data);
    if (wire.method !== "turn/steer" || wire.id == null) return write(data);
    f.sent.push(wire);
    f.emit({ id: wire.id, error: { code: -32600, message: "model busy" } });
  });
  await f.runtime.run(f.delivery("new request"));
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("Steering was not accepted: model busy"),
  });
  // The rejection answers the mention; the turn it could not join works on.
  let working = false;
  let rejected = false;
  void Promise.resolve(f.workingUntil.mock.calls[0]?.[0]).then(() => {
    working = true;
  });
  void Promise.resolve(f.workingUntil.mock.calls[1]?.[0]).then(() => {
    rejected = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.workingUntil).toHaveBeenCalledTimes(2);
  expect(rejected).toBe(true);
  expect(working).toBe(false);
  expect(f.starts()).toHaveLength(1);
  await f.complete(0, "FIRST ANSWER");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(working).toBe(true);
  expect(
    f.publish.mock.calls.map(
      ([event]) => (event as { content: string }).content,
    ),
  ).toEqual([
    expect.stringContaining("Steering was not accepted"),
    "FIRST ANSWER",
  ]);
});

it("keeps a rejected steering mention's notes for the next turn, ahead of newer ones", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const write = f.process.write;
  vi.spyOn(f.process, "write").mockImplementation(async (data) => {
    const wire: Wire = JSON.parse(data);
    if (wire.method !== "turn/steer" || wire.id == null) return write(data);
    pending.channel = [...(pending.channel ?? []), "(newer)"];
    f.emit({ id: wire.id, error: { code: -32600, message: "model busy" } });
  });
  const pending: Record<string, string[]> = {
    channel: ["(I interrupted your reply)"],
  };
  const notes = vi.fn((at: string) => (pending[at] ?? []).splice(0));
  const restoreNotes = vi.fn((at: string, kept: readonly string[]) => {
    pending[at] = [...kept, ...(pending[at] ?? [])];
  });
  const delivery = f.delivery("new request");
  await f.runtime.run({
    ...delivery,
    agent: { ...delivery.agent, notes, restoreNotes },
  });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(pending.channel).toEqual(["(I interrupted your reply)", "(newer)"]);
});

it("keeps the notes of a turn Codex refused to start for the next", async () => {
  const f = fixture();
  const write = f.process.write;
  vi.spyOn(f.process, "write").mockImplementation(async (data) => {
    const wire: Wire = JSON.parse(data);
    if (wire.method !== "turn/start" || wire.id == null) return write(data);
    f.sent.push(wire);
    f.emit({ id: wire.id, error: { code: -32600, message: "model busy" } });
  });
  const pending: Record<string, string[]> = {
    channel: ["(I interrupted your reply)"],
  };
  const notes = vi.fn((at: string) => (pending[at] ?? []).splice(0));
  const restoreNotes = vi.fn((at: string, kept: readonly string[]) => {
    pending[at] = [...kept, ...(pending[at] ?? [])];
  });
  const delivery = f.delivery("work");
  await f.runtime.run({
    ...delivery,
    agent: { ...delivery.agent, notes, restoreNotes },
  });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("model busy"),
  });
  expect(pending.channel).toEqual(["(I interrupted your reply)"]);
});

it.each([
  ["send", {}],
  ["reply_in_subthread", { parent: root }],
])(
  "finishes a final %s normally and preserves the agent's background terminals",
  async (name, extra) => {
    const f = fixture([{ processId: "dev-server" }]);
    await f.runtime.run(f.delivery("start server"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const reply = await f.tool(name, {
      ...extra,
      audience: "everyone",
      text: "http://localhost:3000",
      final: true,
    });
    expect(reply?.result).toMatchObject({ success: true });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Working");
    expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(false);
    // The request is answered, so it stops counting as working before Codex's
    // closing model call ends the turn.
    await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
      ok: true,
    });
    const threadId = (f.starts()[0]?.params as { threadId: string } | undefined)
      ?.threadId;
    f.emit({
      method: "turn/completed",
      params: { threadId, turn: { id: "turn-1", status: "completed" } },
    });
    await vi.waitFor(() =>
      expect(f.sent.some((wire) => wire.method === "thread/unsubscribe")).toBe(
        true,
      ),
    );
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle");
    expect(
      f.sent.some((wire) =>
        wire.method?.startsWith("thread/backgroundTerminals/"),
      ),
    ).toBe(false);
    expect(f.process.end).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  "stops an in-flight file reader at turn end, including late spawn: %s",
  async (late) => {
    const f = fixture();
    await f.runtime.run(f.delivery("work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const exited = deferred<number | null>();
    const started = deferred<void>();
    const gate = deferred<Awaited<ReturnType<typeof f.spawn>>>();
    const kill = vi.fn(async () => {
      exited.resolve(null);
    });
    const child = { ...f.process, kill, exited: exited.promise };
    f.spawn.mockImplementationOnce(async () => {
      started.resolve();
      return late ? gate.promise : child;
    });
    const reading = f.tool("send", {
      audience: "everyone",
      path: "answer.txt",
      final: true,
    });
    await started.promise;
    f.interrupt();
    try {
      await vi.waitFor(() =>
        expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Interrupted"),
      );
    } finally {
      gate.resolve(child);
    }
    expect((await reading)?.result).toMatchObject({ success: false });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("turn was interrupted"),
    });
  },
);

it("lists saved conversations newest first from storage, and moves a started one to the front", async () => {
  const f = fixture();
  const thread = JSON.stringify(["channel", root]);
  const channel = JSON.stringify(["channel", "channel"]);
  const elsewhere = JSON.stringify(["unlisted", root]);
  f.storage.set(
    `buzz.codex.sessions.v13:${scope}:${pubkey}`,
    JSON.stringify({
      [channel]: { threadId: "before-timestamps", workspace: "/w" },
      [thread]: { threadId: "older", workspace: "/w", at: 1 },
      [elsewhere]: { threadId: "newer", workspace: "/w", at: 2 },
      "not a key": { threadId: "ignored", workspace: "/w", at: 3 },
    }),
  );
  expect(f.runtime.conversations(pubkey)).toEqual([
    {
      key: elsewhere,
      channelId: "unlisted",
      root,
      threadId: "newer",
      at: 2,
    },
    {
      key: thread,
      channelId: "channel",
      name: "test",
      root,
      threadId: "older",
      at: 1,
    },
    {
      key: channel,
      channelId: "channel",
      name: "test",
      threadId: "before-timestamps",
    },
  ]);
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const [latest] = f.runtime.conversations(pubkey);
  expect(latest?.at).toBeGreaterThan(2);
  const stored = Object.keys(
    JSON.parse(
      f.storage.get(`buzz.codex.sessions.v13:${scope}:${pubkey}`) ?? "{}",
    ),
  );
  expect(stored.at(-1)).toBe(latest?.key);
  await f.complete();
});

it("always offers the attention tools, on search, keeps the thread when attention goes off, and says so in the turn", async () => {
  const f = fixture();
  f.attention.on = true;
  f.objects.set("interest/ops", {
    type: "interest",
    instructions: "Watch ops",
  });
  await f.runtime.run(f.delivery("@Codex with attention"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const thread = (index: number) =>
    f.sent.filter((wire) => wire.method === "thread/start")[index]?.params as {
      developerInstructions: string;
      dynamicTools: {
        description: string;
        tools: { name: string; deferLoading?: boolean }[];
      }[];
    };
  const names = (index: number) =>
    thread(index)?.dynamicTools[0]?.tools.map((tool) => tool.name) ?? [];
  expect(names(0)).toEqual(expect.arrayContaining(["send", "interest_show"]));
  // The Buzz tools are listed up front, and the attention tools, with their
  // guidance, once the model searches for them.
  const deferred = (name: string) =>
    thread(0)?.dynamicTools[0]?.tools.find((tool) => tool.name === name)
      ?.deferLoading;
  expect(deferred("send")).toBe(undefined);
  expect(deferred("interest_show")).toBe(true);
  expect(thread(0)?.dynamicTools[0]?.description).toContain("attention");
  expect(thread(0)?.developerInstructions).not.toContain("## Attention");
  const start = f.starts()[0]?.params as { input: { text: string }[] };
  expect(start.input[0]?.text).toMatch(
    /<attention>\nHandle the work that caused this turn/,
  );
  // An attention call goes to the agent's attention, through the shared tools.
  const shown = await f.tool("interest_show", { id: "ops" });
  expect(JSON.stringify(shown?.result)).toContain("Watch ops");
  // Turned off mid-turn, the listed tools refuse rather than write.
  f.attention.on = false;
  const refused = await f.tool("interest_remove", {
    id: "ops",
    expected_state: "object-v1:test",
  });
  expect(JSON.stringify(refused?.result)).toContain("Attention is off");
  expect(f.attentionWrite).not.toHaveBeenCalled();
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  // Off, the thread is resumed with the same tools and instructions; only
  // the turn says that attention is off.
  await f.runtime.run(f.delivery("@Codex without attention"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.sent.filter((wire) => wire.method === "thread/start")).toHaveLength(
    1,
  );
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    1,
  );
  const next = f.starts()[1]?.params as { input: { text: string }[] };
  expect(next.input[0]?.text).toMatch(
    /<attention>\nYour owner has attention off/,
  );
  expect(next.input[0]?.text).not.toContain("Handle the work");
  const off = await f.tool("interest_show", { id: "ops" }, 1);
  expect(JSON.stringify(off)).toContain("Attention is off");
  await f.complete(1);
});

it("offers the tools plugins add, runs them as the agent here, and starts a new thread when they change", async () => {
  const f = fixture();
  const call = vi.fn(async () => "created");
  f.added.push({
    name: "tasks_create",
    description: "Create a task.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    call,
  });
  await f.runtime.run(f.delivery("@Codex make a task"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const names = (index: number) =>
    (
      f.sent.filter((wire) => wire.method === "thread/start")[index]?.params as
        | {
            dynamicTools: {
              tools: { name: string; deferLoading?: boolean }[];
            }[];
          }
        | undefined
    )?.dynamicTools[0]?.tools;
  expect(names(0)?.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["send", "tasks_create"]),
  );
  // A plugin's tool loads on search.
  expect(
    names(0)?.find((tool) => tool.name === "tasks_create")?.deferLoading,
  ).toBe(true);
  const reply = await f.tool("tasks_create", { title: "Ship it" });
  expect(JSON.stringify(reply?.result)).toContain("created");
  expect(call).toHaveBeenCalledWith(
    expect.objectContaining({ pubkey }),
    { channel: "channel", root },
    { title: "Ship it" },
  );
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  // Unchanged, the thread resumes with the tools it has.
  await f.runtime.run(f.delivery("@Codex again"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    1,
  );
  const saved = JSON.parse(
    f.storage.get(`buzz.codex.sessions.v13:${scope}:${pubkey}`) ?? "{}",
  );
  expect(Object.values(saved)).toEqual([
    expect.objectContaining({ tools: expect.any(String) }),
  ]);
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  // Removed, resuming would keep the old tool, so a new thread starts.
  f.added.length = 0;
  await f.runtime.run(f.delivery("@Codex once more"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    1,
  );
  expect(names(1)?.map((tool) => tool.name)).not.toContain("tasks_create");
  const gone = await f.tool("tasks_create", { title: "Late" });
  expect(JSON.stringify(gone)).toContain("No active Buzz tool");
  expect(call).toHaveBeenCalledTimes(1);
  await f.complete();
});

it("runs a watch or timer as a one-off ephemeral turn with the attention tools, and saves nothing", async () => {
  const f = fixture();
  f.attention.on = true;
  f.objects.set("interest/ops", {
    type: "interest",
    instructions: "Watch ops",
  });
  const watch = {
    type: "event",
    enabled: true,
    interest_id: "ops",
    since: 0,
    channels: "all",
    kinds: [9],
  } as const;
  f.objects.set("watch/deploys", watch);
  const base = f.delivery("someone else's message");
  if (base.trigger.type !== "mention") throw new Error("Expected mention");
  const event = { ...base.trigger.event, pubkey: "f".repeat(64) };
  const acknowledged = vi.fn();
  f.wake({
    ...base,
    acknowledged,
    trigger: { type: "watch", event, slug: "watch/deploys", watch },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const started = f.sent.find((wire) => wire.method === "thread/start")
    ?.params as {
    ephemeral?: boolean;
    dynamicTools: { tools: { name: string }[] }[];
  };
  expect(started.ephemeral).toBe(true);
  expect(started.dynamicTools[0]?.tools.map((tool) => tool.name)).toContain(
    "watch_update",
  );
  const text = (
    f.starts()[0]?.params as { input: { text: string }[] } | undefined
  )?.input[0]?.text;
  expect(text).toContain(
    '<watch-task>\nThis turn was started by watch "deploys"',
  );
  expect(text).toContain('<interest id="ops">\nWatch ops\n</interest>');
  expect(text).toContain("<observed-message>");
  expect(text).toMatch(/<attention>\nHandle the work/);
  // The observed author is not the owner, and the watch still runs; it
  // answers no one, so `send` has no default destination.
  const send = await f.tool("send", { audience: "everyone", text: "x" });
  expect(send?.result).toMatchObject({
    success: false,
    contentItems: [{ text: "channel is required here." }],
  });
  expect(f.publish).not.toHaveBeenCalled();
  const shown = await f.tool("interest_show", { id: "ops" });
  expect(JSON.stringify(shown?.result)).toContain("Watch ops");
  await f.complete(0, "");
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: true,
  });
  expect(acknowledged).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "thread/unsubscribe")).toBe(
      true,
    ),
  );
  expect(f.runtime.sessions(pubkey)).toEqual([]);
  expect([...f.storage.values()].join()).not.toContain("thread-1");
  // After the turn, its tools no longer answer.
  const late = await f.tool("interest_show", { id: "ops" }, 0);
  expect(JSON.stringify(late)).toContain("No active Buzz tool");
  // A timer runs the same way, on a thread of its own.
  const timer = {
    type: "timer",
    enabled: true,
    interest_id: "ops",
    prompt: "Check the deploys",
  };
  // Timers live with watches, under `watch/`.
  f.objects.set("watch/daily", timer);
  f.wake({
    ...base,
    trigger: {
      type: "timer",
      slug: "watch/daily",
      timer,
      spent: false,
    } as unknown as Delivery["trigger"],
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const timed = (
    f.starts()[1]?.params as { input: { text: string }[] } | undefined
  )?.input[0]?.text;
  expect(timed).toContain("Timer: daily");
  expect(timed).toContain("Prompt: Check the deploys");
  expect(
    (f.starts()[1]?.params as { threadId: string } | undefined)?.threadId,
  ).toBe("thread-2");
  await f.complete(1, "");
  await expect(f.workingUntil.mock.calls[1]?.[0]).resolves.toEqual({
    ok: true,
  });
});

it("drops a wake that is no longer current", async () => {
  const f = fixture();
  f.attention.on = true;
  const watch = {
    type: "event",
    enabled: true,
    interest_id: "ops",
    since: 0,
    channels: "all",
    kinds: [9],
  } as const;
  f.objects.set("interest/ops", {
    type: "interest",
    instructions: "Watch ops",
  });
  f.objects.set("watch/deploys", watch);
  const deliver = (current: () => boolean) => {
    const base = f.delivery("watched");
    if (base.trigger.type !== "mention") throw new Error("Expected mention");
    return f.wake({
      ...base,
      current,
      trigger: {
        type: "watch",
        event: base.trigger.event,
        slug: "watch/deploys",
        watch,
      },
    });
  };
  await deliver(() => true);
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0, "");
  // One whose watch is no longer wanted does not run.
  await deliver(() => false);
  await expect(f.workingUntil.mock.calls[1]?.[0]).resolves.toEqual({
    ok: true,
  });
  expect(f.sent.filter((wire) => wire.method === "thread/start")).toHaveLength(
    1,
  );
  // A watch that was removed does not run either.
  f.objects.delete("watch/deploys");
  await deliver(() => true);
  await expect(f.workingUntil.mock.calls[2]?.[0]).resolves.toEqual({
    ok: true,
  });
  expect(f.sent.filter((wire) => wire.method === "thread/start")).toHaveLength(
    1,
  );
});

const wakeWatch = {
  type: "event",
  enabled: true,
  interest_id: "ops",
  since: 0,
  channels: "all",
  kinds: [9],
} as const;
function watchDelivery(
  f: ReturnType<typeof fixture>,
  extra: Partial<Delivery> = {},
): Delivery {
  f.attention.on = true;
  f.objects.set("interest/ops", { type: "interest", instructions: "Ops" });
  f.objects.set("watch/deploys", wakeWatch);
  const base = f.delivery("watched");
  if (base.trigger.type !== "mention") throw new Error("Expected mention");
  return {
    ...base,
    ...extra,
    trigger: {
      type: "watch",
      event: base.trigger.event,
      slug: "watch/deploys",
      watch: wakeWatch,
    },
  };
}

it("ends a queued mention with the attention note current when it starts", async () => {
  const f = fixture();
  f.attention.on = true;
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  // A different model cannot steer, so this one waits for the first turn.
  await f.runtime.run({ ...f.delivery("@Codex second"), model: "deep-model" });
  f.attention.on = false;
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const text = (
    f.starts()[1]?.params as { input: { text: string }[] } | undefined
  )?.input[0]?.text;
  expect(text).toMatch(/<attention>\nYour owner has attention off/);
  await f.complete(1, "SECOND");
});

it("stops a wake when its turn signal aborts, and lists it as needing attention", async () => {
  const f = fixture();
  const turn = new AbortController();
  f.wake(watchDelivery(f, { signal: turn.signal }));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  turn.abort(new Error("The turn ran past its deadline"));
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: false,
    error: "The turn ran past its deadline",
  });
  expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(true);
  expect(f.runtime.sessions(pubkey)).toEqual([
    {
      key: "watch/deploys",
      status: "Needs attention",
      detail: "The turn ran past its deadline",
    },
  ]);
});

it("ends a removed agent's wake shells before letting go of its thread", async () => {
  const f = fixture();
  const b = second(f);
  f.wake(watchDelivery(f));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const thread = (f.starts()[0]?.params as { threadId: string } | undefined)
    ?.threadId;
  // Removing the agent aborts its wake; the other agent keeps the server.
  f.runtime.sync([{ key: b.agent.key, pubkey: b.agent.pubkey } as Agent]);
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toMatchObject({
    ok: false,
  });
  const methods = f.sent
    .filter(
      (wire) =>
        (wire.params as { threadId?: string } | undefined)?.threadId === thread,
    )
    .map((wire) => wire.method);
  expect(methods).toEqual(
    expect.arrayContaining([
      "turn/interrupt",
      "thread/backgroundTerminals/clean",
      "thread/backgroundTerminals/list",
      "thread/unsubscribe",
    ]),
  );
  expect(methods.indexOf("thread/backgroundTerminals/list")).toBeLessThan(
    methods.indexOf("thread/unsubscribe"),
  );
  expect(f.process.end).not.toHaveBeenCalled();
});

describe("codexStep", () => {
  it("maps started items into the shared step vocabulary", () => {
    expect(codexStep({ type: "commandExecution", command: "ls" })).toEqual({
      tool: "Shell",
      target: "ls",
    });
    expect(
      codexStep({
        type: "commandExecution",
        command: "sed -n 1,40p src/a.ts",
        commandActions: [{ type: "read", name: "a.ts", path: "src/a.ts" }],
      }),
    ).toEqual({ tool: "Read", target: "a.ts" });
    expect(
      codexStep({
        type: "commandExecution",
        command: "rg agent",
        commandActions: [{ type: "search", query: "agent", path: null }],
      }),
    ).toEqual({ tool: "Grep", target: "agent" });
    expect(
      codexStep({ type: "fileChange", changes: [{ path: "/x/notes.md" }] }),
    ).toEqual({ tool: "Edit", target: "notes.md" });
    expect(codexStep({ type: "mcpToolCall", tool: "send_message" })).toEqual({
      tool: "send_message",
    });
    expect(codexStep({ type: "reasoning" })).toEqual({ tool: "Thinking" });
    expect(codexStep({ type: "userMessage" })).toBeUndefined();
    expect(codexStep(undefined)).toBeUndefined();
  });
});

describe("programs", () => {
  it("names the programs a command runs, without the shell wrapper or scripts", () => {
    expect(
      programs(
        `/bin/zsh -lc "mktemp /tmp/activity-test.XXXX | xargs -I'{}' sh -c 'printf hello > \\"$1\\"; printf x' sh '{}'"`,
      ),
    ).toBe("mktemp, xargs");
    expect(programs("which copilot || true")).toBe("which, true");
    expect(programs("FOO=1 /usr/bin/git status && pnpm test")).toBe(
      "git, pnpm",
    );
    expect(programs("a; b; c; d; e")).toBe("a, b, c and 2 more");
    expect(programs("")).toBeUndefined();
  });
});

/** Labels the fixture's channel a Solo chat; deleting it converts the chat. */
function asSoloChat(f: ReturnType<typeof fixture>) {
  f.soloChannels.add("channel");
  return f.soloChannels;
}
const inputText = (wire: Wire | undefined) =>
  JSON.stringify((wire?.params as { input?: unknown } | undefined)?.input);
const tagsOf = (f: ReturnType<typeof fixture>) =>
  f.publish.mock.calls.map(([event]) => (event as EventData).tags);

it("continues an owner's Solo chat as one channel conversation posted at the top level", async () => {
  const f = fixture();
  asSoloChat(f);
  const first = f.delivery("@Codex first", root);
  const activity = {
    step: vi.fn(),
    acknowledged: vi.fn(),
    superseded: vi.fn(),
  };
  await f.runtime.run({ ...first, ...activity });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(inputText(f.starts()[0])).toContain('\\"posting\\":\\"top-level\\"');
  expect(inputText(f.starts()[0])).toContain(
    JSON.stringify(TOP_LEVEL_PROMPT).slice(1, 40),
  );
  expect(inputText(f.starts()[0])).not.toContain("reply_to");
  expect(inputText(f.starts()[0])).toContain("conversation-context");
  // A message in another thread of the chat steers the same turn and takes
  // over its activity, as one conversation.
  const next = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  await f.runtime.run({
    ...f.delivery("@Codex also", "e".repeat(64)),
    ...next,
  });
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(1),
  );
  await vi.waitFor(() => expect(activity.superseded).toHaveBeenCalledOnce());
  await f.tool("send", { audience: "everyone", text: "Progress" });
  if (first.trigger.type !== "mention") throw new Error("Expected mention");
  // A stale reply into the chat is returned for correction, not posted.
  expect(
    (
      await f.tool("send", {
        audience: "everyone",
        text: "threaded",
        reply: first.trigger.event.id,
      })
    )?.result,
  ).toMatchObject({
    success: false,
    contentItems: [
      {
        text: "This chat stays at the top level: send again without reply.",
      },
    ],
  });
  await f.complete(0, "FIRST");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  // A later prompt in a different thread resumes the same Codex thread.
  await f.runtime.run(f.delivery("@Codex later", "7".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(
    f.sent.find((w) => w.method === "thread/resume")?.params,
  ).toMatchObject({ threadId: "thread-1" });
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(3));
  expect(f.publish.mock.calls[2]?.[0]).toMatchObject({
    content: expect.stringContaining("Codex exited"),
  });
  // Progress, final answer and the runtime's own failure notice.
  expect(tagsOf(f)).toEqual([
    [["h", "channel"]],
    [["h", "channel"]],
    [
      ["h", "channel"],
      ["p", owner],
    ],
  ]);
});

it("titles a new Solo chat once, from its first message on an ephemeral read-only thread", async () => {
  const f = fixture();
  asSoloChat(f);
  const named = vi.fn();
  const titling = () =>
    f.sent.filter(
      (wire) =>
        wire.method === "thread/start" &&
        (wire.params as { ephemeral?: boolean }).ephemeral,
    );
  await f.runtime.run({ ...f.delivery("@Codex fix the login bug"), named });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  // Without Codex's title model in the catalog, the chat's own model titles it.
  expect(titling()[0]?.params).toMatchObject({
    model: "test-model",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  expect(f.starts()[1]?.params).toMatchObject({
    threadId: "thread-2",
    model: "test-model",
    effort: "low",
    outputSchema: { required: ["title"] },
  });
  expect(inputText(f.starts()[1])).toContain("fix the login bug");
  f.emit({
    method: "item/completed",
    params: {
      threadId: "thread-2",
      item: { type: "agentMessage", text: '{"title":" Fix login bug "}' },
    },
  });
  f.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-2",
      turn: { id: "turn-2", status: "completed" },
    },
  });
  await vi.waitFor(() => expect(named).toHaveBeenCalledWith("Fix login bug"));
  await vi.waitFor(() =>
    expect(
      f.sent.find((wire) => wire.method === "thread/unsubscribe")?.params,
    ).toEqual({ threadId: "thread-2" }),
  );
  await f.complete(0, "FIRST");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  // A resumed conversation is not new, so it is not titled again.
  await f.runtime.run({ ...f.delivery("@Codex later"), named });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  expect(titling()).toHaveLength(1);
  expect(named).toHaveBeenCalledOnce();
});

it("does not title a conversation outside a Solo chat", async () => {
  const f = fixture();
  const named = vi.fn();
  await f.runtime.run({ ...f.delivery("@Codex fix the login bug"), named });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0, "FIRST");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(f.sent.filter((wire) => wire.method === "thread/start")).toHaveLength(
    1,
  );
  expect(named).not.toHaveBeenCalled();
});

it("finishes a Solo turn under its policy when the chat is converted mid-turn", async () => {
  const f = fixture();
  const soloChannels = asSoloChat(f);
  const channelScope = (delivery: Delivery) => ({
    ...delivery,
    config: { ...(delivery.config as object), scope: "channel" },
  });
  await f.runtime.run(channelScope(f.delivery("@Codex first")));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  soloChannels.delete("channel");
  await f.runtime.run(channelScope(f.delivery("@Codex after share")));
  // The converted chat's request waits for the Solo turn instead of steering in.
  await f.tool("send", { audience: "everyone", text: "Progress" });
  expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(0);
  expect(f.starts()).toHaveLength(1);
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(inputText(f.starts()[1])).toContain("reply_to");
  await f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(3));
  expect(tagsOf(f)).toEqual([
    [["h", "channel"]],
    [["h", "channel"]],
    [
      ["h", "channel"],
      ["e", root, "", "reply"],
    ],
  ]);
});

it("fails a mention in a channel it cannot see yet until the channel list loads", async () => {
  const f = fixture();
  const ready = f.snapshot.session.channels.list;
  f.snapshot.session.channels.list = () => ({
    status: "loading",
    channels: [],
  });
  await expect(f.runtime.run(f.delivery("@Codex hi"))).rejects.toThrow(
    "Couldn't read this community's channels to tell where to answer (not loaded). Try again.",
  );
  expect(f.starts()).toEqual([]);
  expect(f.workingUntil).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  f.snapshot.session.channels.list = ready;
  await f.runtime.run(f.delivery("@Codex again"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(inputText(f.starts()[0])).toContain("reply_to");
  await f.complete(0, "DONE");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
  expect(tagsOf(f)[0]).toContainEqual(["e", root, "", "reply"]);
});

it("keeps Messages routing for a channel someone else's Solo chat", async () => {
  const f = fixture();
  asSoloChat(f);
  Object.assign(f.snapshot, { viewer: "9".repeat(64) });
  await f.runtime.run(f.delivery("@Codex hi"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(inputText(f.starts()[0])).toContain("reply_to");
  await f.complete(0, "DONE");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
  expect(tagsOf(f)[0]).toContainEqual(["e", root, "", "reply"]);
});

it("method calls: a thread and a turn make no relay-session call beyond the turn's message-context reads (launch-boundary.test.ts runs the real service path)", async () => {
  const f = fixture();
  const session = f.snapshot.session;
  // Every relay-facing call the runtime can make, by name.
  const requests = {
    "session.read": f.read,
    "agentMemories.read": f.memoryRead,
    "agentMemories.open": f.memoryOpen,
    "memoryView.refresh": f.memoryView.refresh,
    "profiles.ensure": session.profiles.ensure,
    publish: f.publish,
    query: f.query,
    upload: f.upload,
    media: f.media,
    remember: f.remember,
  } as Record<string, { mock: { calls: unknown[][] } }>;
  const made = () =>
    Object.fromEntries(
      Object.entries(requests)
        .map(([name, fn]) => [name, fn.mock.calls.length] as const)
        .filter(([, count]) => count > 0),
    );
  // The core-memory cache is seeded, so starts need no memory read.
  f.core.mockResolvedValue("seeded");
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const started = made();
  expect(f.sent.filter((wire) => wire.method === "thread/start")).toHaveLength(
    1,
  );
  // A thread/start and its first turn: only the deliberate message-context
  // read of the triggering conversation.
  expect(Object.keys(started)).toEqual(
    Object.keys(started).filter((name) => name === "session.read"),
  );
  // Those reads are message history in the triggering channel, nothing else.
  const context = () =>
    (f.read.mock.calls as unknown as [readonly Record<string, unknown>[]][])
      .flatMap(([filters]) => filters)
      .every(
        (filter) =>
          JSON.stringify(filter.kinds) === "[9,40002]" &&
          JSON.stringify(filter["#h"]) === '["channel"]',
      );
  expect(context()).toBe(true);
  // The counter counts: the agent's own read tool during the turn is seen.
  await f.tool("read", {});
  expect(Object.values(made()).reduce((a, b) => a + b, 0)).toBeGreaterThan(
    Object.values(started).reduce((a, b) => a + b, 0),
  );
  await f.complete(0, "FIRST");
  // A second turn on the same thread: again no request but context reads.
  const before = made();
  await f.runtime.run(f.delivery("@Codex again"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const turn = Object.fromEntries(
    Object.entries(made()).map(([name, count]) => [
      name,
      count - (before[name] ?? 0),
    ]),
  );
  expect(
    Object.entries(turn).filter(
      ([name, count]) => count > 0 && name !== "session.read",
    ),
  ).toEqual([]);
  expect(context()).toBe(true);
  expect(f.core).toHaveBeenCalled();
});

it("hands a Solo chat's Canvas to each turn, and a shared channel's to none", async () => {
  const f = fixture();
  f.snapshot.session.canvas.available = true;
  f.snapshot.session.canvas.read.mockResolvedValue(canvasHead("Use tokens."));
  await f.runtime.run(f.delivery("@Codex shared", root));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(inputText(f.starts()[0])).not.toContain("workspace-canvas");
  expect(f.snapshot.session.canvas.read).not.toHaveBeenCalled();
  await f.complete(0, "DONE");

  const solo = fixture();
  asSoloChat(solo);
  solo.snapshot.session.canvas.available = true;
  solo.snapshot.session.canvas.read.mockResolvedValue(
    canvasHead("Use tokens."),
  );
  await solo.runtime.run(solo.delivery("@Codex solo", root));
  await vi.waitFor(() => expect(solo.starts()).toHaveLength(1));
  expect(inputText(solo.starts()[0])).toContain("<workspace-canvas>");
  expect(inputText(solo.starts()[0])).toContain("Use tokens.");
  await solo.complete(0, "DONE");
  await vi.waitFor(() =>
    expect(solo.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  // Someone else's edit replaces it with an explicit "none".
  vi.spyOn(console, "warn").mockImplementation(() => {});
  solo.snapshot.session.canvas.read.mockResolvedValue(
    canvasHead("Steer me", "b".repeat(64)),
  );
  await solo.runtime.run(solo.delivery("@Codex again", root));
  await vi.waitFor(() => expect(solo.starts()).toHaveLength(2));
  expect(inputText(solo.starts()[1])).not.toContain("Steer me");
  expect(inputText(solo.starts()[1])).toContain(
    "Disregard any earlier workspace Canvas",
  );
});

const canvasHead = (content: string, author = owner) => ({
  pubkey: author,
  kind: 40100,
  created_at: 1,
  tags: [],
  content,
});
it.each(["completed", "failed"])(
  "accepts a mention during compaction without blocking another conversation or expiring its handover (%s)",
  async (outcome) => {
    const f = fixture();
    const first = f.delivery("first");
    const agent = { ...first.agent, config: first.config } as unknown as Agent;
    await f.runtime.run(first);
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    await f.complete();
    await vi.waitFor(() =>
      expect(
        f.runtime.sessionState(agent, { channelId: "channel", root }),
      ).toBe("idle"),
    );
    const compacted = f.runtime
      .session(agent, { channelId: "channel", root }, "compact")
      .catch((error) => error);
    await vi.waitFor(() =>
      expect(f.sent.some((w) => w.method === "thread/compact/start")).toBe(
        true,
      ),
    );
    const handover = new AbortController();
    let returned = false;
    const accepted = f.runtime
      .run({ ...f.delivery("queued after compact"), signal: handover.signal })
      .then(() => {
        returned = true;
      });
    try {
      await vi.waitFor(() => expect(returned).toBe(true));
      handover.abort(new Error("Handover expired"));
      await f.runtime.run(f.delivery("another conversation", "d".repeat(64)));
      await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
      expect(inputText(f.starts()[1])).toContain("another conversation");
      await f.complete(1);
    } finally {
      f.emit({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "compact" } },
      });
      f.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "compact",
            status: outcome,
            ...(outcome === "failed"
              ? { error: { message: "Compaction failed" } }
              : {}),
          },
        },
      });
      const result = await compacted;
      if (outcome === "failed") expect(result).toBeInstanceOf(Error);
      else expect(result).toBeUndefined();
      await accepted;
    }
    await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
    expect(inputText(f.starts()[2])).toContain("queued after compact");
    await f.complete(2);
  },
);

describe("session actions", () => {
  const methods = (f: ReturnType<typeof fixture>) =>
    f.sent.flatMap((wire) => (wire.method ? [wire.method] : []));

  it("compacts immediately, and keeps the session active until an early interrupt ends its turn", async () => {
    const f = fixture();
    const delivery = f.delivery("first");
    const agent = {
      ...delivery.agent,
      config: delivery.config,
    } as unknown as Agent;
    const place = { channelId: "channel", root };
    await f.runtime.run(delivery);
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    await expect(f.runtime.session(agent, place, "new")).rejects.toThrow(
      "active turn",
    );
    await f.complete();
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(agent, place)).toBe("idle"),
    );
    const compacted = f.runtime
      .session(agent, place, "compact")
      .catch((error) => error);
    await vi.waitFor(() =>
      expect(methods(f)).toContain("thread/compact/start"),
    );
    expect(f.starts()).toHaveLength(1);
    expect(f.runtime.sessionState(agent, place)).toBe("compacting");
    await f.runtime.session(agent, place, "interrupt");
    expect(f.runtime.sessionState(agent, place)).toBe("compacting");
    const later = f.runtime.run(f.delivery("after interrupt"));
    f.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "compact" } },
    });
    expect(await compacted).toBeInstanceOf(Error);
    await later;
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    expect(
      f.sent.find((wire) => wire.method === "turn/interrupt")?.params,
    ).toEqual({ threadId: "thread-1", turnId: "compact" });
    expect(f.starts()[1]?.params).toMatchObject({ threadId: "thread-1" });
    await f.complete();
  });

  it("resets durably without a message, and preserves the binding if the write fails", async () => {
    const f = fixture();
    const delivery = f.delivery("first");
    const agent = {
      ...delivery.agent,
      config: delivery.config,
    } as unknown as Agent;
    const place = { channelId: "channel", root };
    await f.runtime.run(delivery);
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    await f.complete();
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(agent, place)).toBe("idle"),
    );
    vi.spyOn(f.storage, "set").mockImplementationOnce(() => {
      throw new Error("Disk full");
    });
    await expect(f.runtime.session(agent, place, "new")).rejects.toThrow(
      "Disk full",
    );
    await f.runtime.run(f.delivery("still the old session"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    expect(f.starts()[1]?.params).toMatchObject({ threadId: "thread-1" });
    await f.complete();
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(agent, place)).toBe("idle"),
    );
    await f.runtime.session(agent, place, "new");
    expect(f.starts()).toHaveLength(2);
    expect(
      [...f.storage.values()].some((value) =>
        value.includes('"threadId":"thread-1"'),
      ),
    ).toBe(false);
    await f.runtime.run(f.delivery("new session"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
    expect(f.starts()[2]?.params).toMatchObject({ threadId: "thread-2" });
    await f.complete();
  });
});

it("updates Codex repository context from the agent’s captured community, including default restoration", async () => {
  let folder = "/code/codex";
  const repositories = vi.fn(
    () => `<community-repositories>${folder}</community-repositories>`,
  );
  const f = fixture([], undefined, false, {}, repositories);
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(repositories).toHaveBeenCalledWith(scope);
  expect(
    JSON.stringify(f.sent.filter((wire) => wire.method === "turn/start")),
  ).toContain("/code/codex");
  folder = "REPOS in your own workspace";
  await f.runtime.run(f.delivery("second", "d".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const turns = f.sent.filter((wire) => wire.method === "turn/start");
  expect(JSON.stringify(turns.at(-1))).toContain("REPOS in your own workspace");
  expect(JSON.stringify(turns.at(-1))).not.toContain("/code/codex");
});

it("drops source output invalidated while compaction waits without blocking other work", async () => {
  const f = fixture();
  const first = f.delivery("first");
  const agent = { ...first.agent, config: first.config } as unknown as Agent;
  await f.runtime.run(first);
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessionState(agent, { channelId: "channel", root })).toBe(
      "idle",
    ),
  );
  const compacted = f.runtime.session(
    agent,
    { channelId: "channel", root },
    "compact",
  );
  await vi.waitFor(() =>
    expect(f.sent.some((w) => w.method === "thread/compact/start")).toBe(true),
  );
  let current = true;
  await f.runtime.run({ ...pluginWake(f, root), current: () => current });
  current = false;
  f.emit({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "compact" } },
  });
  f.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "compact", status: "completed" },
    },
  });
  await compacted;
  await f.runtime.run(f.delivery("ordinary message"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(inputText(f.starts()[1])).toContain("ordinary message");
  expect(f.starts().some((w) => inputText(w).includes("CI failed: lint"))).toBe(
    false,
  );
  await f.complete(1);
});

it("queues an ordinary follow-up when a source is cancelled during startup history", async () => {
  const f = fixture();
  const gate = deferred<void>();
  const reading = deferred<void>();
  f.read.mockImplementationOnce(async () => {
    reading.resolve();
    await gate.promise;
    return [];
  });
  let current = true;
  await f.runtime.run({ ...pluginWake(f, root), current: () => current });
  await reading.promise;
  await f.runtime.run(f.delivery("ordinary follow-up"));
  current = false;
  gate.resolve();
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(inputText(f.starts()[0])).toContain("ordinary follow-up");
  expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(0);
  await f.complete(0);
});

it("delivers a rootless subscription to its channel without publishing its anchor", async () => {
  const f = fixture();
  const delivery = pluginWake(f);
  if (delivery.trigger.type !== "plugin")
    throw new Error("Expected plugin wake");
  f.snapshot.session.canvas.available = true;
  f.snapshot.session.canvas.read.mockResolvedValue(
    canvasHead("Only Solo chats supply this"),
  );
  await f.runtime.run({
    ...delivery,
    trigger: { ...delivery.trigger, type: "attention", topLevel: true },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const input = JSON.stringify(f.starts()[0]?.params);
  expect(input).not.toContain("<plugin-wake");
  expect(input).not.toContain("continuous personal chat");
  expect(input).toContain("unless the Interest instructions");
  expect(input).toContain("top-level");
  expect(input).not.toContain(WAKE_ID);
  expect(f.snapshot.session.canvas.read).not.toHaveBeenCalled();
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    tags: expect.not.arrayContaining([expect.arrayContaining(["e"])]),
  });
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain(WAKE_ID);
});

it.each(["v7", "v12"])(
  "does not reuse %s persisted bindings with older built-in tool schemas",
  (version) => {
    const f = fixture();
    f.storage.set(
      `buzz.codex.sessions.${version}:${scope}:${pubkey}`,
      JSON.stringify({
        [JSON.stringify(["channel", root])]: {
          threadId: "old-schema",
          workspace: "/w",
        },
      }),
    );
    expect(f.runtime.conversations(pubkey)).toEqual([]);
    f.runtime.dispose();
  },
);

it("drops standalone output invalidated while core memory loads", async () => {
  const f = fixture();
  let current = true;
  f.core.mockImplementationOnce(async () => {
    current = false;
    return null;
  });
  let finished = false;
  const running = f.runtime
    .runOnce({
      delivery: { ...f.delivery("output"), current: () => current },
      key: "source/check",
      signal: new AbortController().signal,
      prompt: async () => "cancelled output",
    })
    .finally(() => {
      finished = true;
    });
  await vi.waitFor(() => expect(finished || f.starts().length > 0).toBe(true));
  if (f.starts().length) await f.complete(0, "");
  await running;
  expect(f.starts()).toEqual([]);
  f.runtime.dispose();
});

it("allows an addressed channel turn to reply in an existing thread", async () => {
  const f = fixture();
  const delivery = pluginWake(f);
  if (delivery.trigger.type !== "plugin") throw new Error("fixture");
  await f.runtime.run({
    ...delivery,
    trigger: { ...delivery.trigger, type: "attention", topLevel: true },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.query.mockResolvedValue([
    {
      id: root,
      pubkey: owner,
      kind: 9,
      created_at: 1,
      tags: [["h", "channel"]],
      content: "Release thread",
    },
  ]);
  const reply = await f.tool("send", {
    audience: "everyone",
    text: "Release status",
    reply: root,
  });
  expect(reply?.result).toMatchObject({ success: true });
  expect(f.publish).toHaveBeenCalledWith(
    expect.objectContaining({
      tags: expect.arrayContaining([["e", root, "", "reply"]]),
    }),
    expect.any(Function),
  );
  await f.complete(0);
});

it("refuses a handoff from a channel-scoped Codex session to another of its channel's threads", async () => {
  const f = fixture();
  const handoff = vi.fn();
  f.events.push({
    id: "d".repeat(64),
    pubkey: owner,
    kind: 39000,
    content: "",
    created_at: 1,
    tags: [["d", "channel"]],
  } as EventData);
  const other = f.delivery("other thread", "e".repeat(64));
  if (other.trigger.type !== "mention") throw new Error("Expected mention");
  const first = f.delivery("@Codex hi");
  await f.runtime.run({
    ...first,
    agent: { ...first.agent, handoff } as Delivery["agent"],
    config: { ...(first.config as object), scope: "channel" },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const result = await f.tool("self_handoff", {
    channel: "channel",
    thread: other.trigger.event.id,
    text: "carry on",
  });
  expect(JSON.stringify(result?.result)).toContain(
    "That is this conversation.",
  );
  expect(handoff).not.toHaveBeenCalled();
});

it("keeps callbacks live beside terminals and lets a title finish after its admission closes", async () => {
  let handler!: McpHandler;
  let enabled = true;
  const close = vi.fn(async () => {});
  const f = fixture([{}], undefined, false, {}, undefined, {
    serve: async (run) => {
      handler = run;
      return {
        url: "http://127.0.0.1:1/mcp",
        headers: [],
        close,
        closed: new Promise(() => {}),
      };
    },
    run: async () => (enabled ? { decision: "block", reason: "policy" } : {}),
  });
  asSoloChat(f);
  const named = vi.fn();
  await f.runtime.run({ ...f.delivery("@Codex title this"), named });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const title = f.sent.filter((wire) => wire.method === "thread/start")[1];
  expect(title?.params).toMatchObject({
    config: {
      mcp_servers: { buzz_native_hooks: { enabled: false } },
      "hooks.state": { dispatcher: { enabled: false } },
    },
  });
  const call = () =>
    handler({
      id: 1,
      method: "tools/call",
      params: { name: "PreToolUse", arguments: { session_id: "thread-1" } },
    });
  expect(await call()).toMatchObject({
    result: { content: [{ text: '{"decision":"block","reason":"policy"}' }] },
  });
  enabled = false;
  expect(await call()).toMatchObject({ result: { content: [{ text: "{}" }] } });
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(
    f.sent.some(
      (wire) => wire.method === "thread/backgroundTerminals/terminate",
    ),
  ).toBe(false);
  f.emit({
    method: "item/completed",
    params: {
      threadId: "thread-2",
      item: { type: "agentMessage", text: '{"title":"Still running"}' },
    },
  });
  f.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-2",
      turn: { id: "turn-2", status: "completed" },
    },
  });
  await vi.waitFor(() => expect(named).toHaveBeenCalledWith("Still running"));
});

it.each([
  { features: { hooks: false }, disabled: true },
  { features: { codex_hooks: false }, disabled: true },
  { features: { hooks: false, codex_hooks: true }, disabled: true },
  { features: { hooks: true, codex_hooks: false }, disabled: false },
  { features: { codex_hooks: true }, disabled: false },
])(
  "honors native hook flags $features before opening the bridge",
  async ({ features, disabled }) => {
    const serve = vi.fn(async () => ({
      url: "http://127.0.0.1:1/mcp",
      headers: [],
      close: async () => {},
      closed: new Promise<void>(() => {}),
    }));
    const f = fixture([], undefined, false, { features }, undefined, {
      serve,
      run: async () => ({}),
    });
    await f.runtime.run(f.delivery("@Codex hi"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    expect(serve).toHaveBeenCalledTimes(disabled ? 0 : 1);
    const started = f.sent.find((wire) => wire.method === "thread/start");
    if (!started) throw new Error("No thread start");
    const config = (started.params as { config: Record<string, unknown> })
      .config;
    expect(config).not.toHaveProperty("features.hooks");
    expect(
      Object.hasOwn(config.mcp_servers as object, "buzz_native_hooks"),
    ).toBe(!disabled);
    expect(f.sent.some((wire) => wire.method === "hooks/list")).toBe(!disabled);
    await f.complete(0);
    await f.runtime.run(f.delivery("@Codex again"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    const resumed = f.sent.find((wire) => wire.method === "thread/resume")
      ?.params as { config: Record<string, unknown> };
    expect(resumed.config).not.toHaveProperty("features.hooks");
    expect(serve).toHaveBeenCalledTimes(disabled ? 0 : 2);
    await f.complete(1);
  },
);

it("keeps interrupting an idle existing conversation a no-op", async () => {
  const f = fixture();
  const delivery = f.delivery("first");
  const agent = {
    ...delivery.agent,
    config: delivery.config,
  } as unknown as Agent;
  await f.runtime.run(delivery);
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessionState(agent, { channelId: "channel", root })).toBe(
      "idle",
    ),
  );
  await expect(
    f.runtime.session(agent, { channelId: "channel", root }, "interrupt"),
  ).resolves.toBeUndefined();
});
