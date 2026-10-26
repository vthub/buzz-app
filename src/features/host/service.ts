import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../../plugins/api";
import { nativeIdentityEnabled } from "../identity/service";

export type HostRequest = Readonly<{
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** Native deadline in milliseconds, 1–180000. Defaults to 30000. */
  timeoutMs?: number;
}>;
/** A multipart POST of one local `.tar.gz` file in the home directory, with
 * text fields beside it, to an origin the plugin declares. */
export type HostUpload = Readonly<{
  url: string;
  headers?: Readonly<Record<string, string>>;
  fields?: Readonly<Record<string, string>>;
  file: Readonly<{
    /** The form field it is sent as. */
    field: string;
    /** An absolute path. */
    path: string;
    /** The file name the form gives it. */
    name: string;
    contentType: string;
  }>;
}>;
export type HostResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
/** Reusable NIP-OA proof for one agent key; preparing it does not submit it. */
export type NipOaAuthorization = readonly [
  "auth",
  ownerPubkey: string,
  conditions: string,
  signature: string,
];
export type ProcessProtection = Readonly<{
  readOnlyPaths: readonly string[];
  hiddenPaths: readonly string[];
}>;
export type HostProcessOptions = Readonly<{
  /** Follow the arguments the manifest declares. */
  args?: readonly string[];
  /** An absolute directory or one under home written `~/…`; created if missing. */
  cwd?: string;
  /** Added to the app's environment; `null` removes a variable. */
  env?: Readonly<Record<string, string | null>>;
  /** Run with one app-held MCP session and an agent-scoped `buzz` on PATH. */
  mcp?: Pick<HostMcpServer, "url" | "headers">;
  /** Native macOS containment for a protected worker and its descendants. */
  protection?: ProcessProtection;
  onStdout?(data: string): void;
  onStderr?(data: string): void;
}>;
export type HostProcess = Readonly<{
  write(data: string): Promise<void>;
  /** Writes any final `data`, then closes stdin. */
  end(data?: string): Promise<void>;
  /** Asks it to stop, then kills it and its descendants. */
  kill(): Promise<void>;
  /** The exit code once it exits; null when a signal ended it. */
  exited: Promise<number | null>;
}>;
/** UTF-16 units per process write: at most 3 UTF-8 bytes each, so a piece
 * stays under the host's 1 MiB write limit. */
const WRITE_UNITS = 256 * 1024;
type ProcessEvent =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; code: number | null };
/** Answers one JSON-RPC message an agent sent: with the JSON-RPC response,
 * or `undefined` for a notification, which needs none. */
export type McpHandler = (message: unknown) => Promise<unknown>;
/** A loopback MCP server (Streamable HTTP) whose messages the plugin answers.
 * It belongs to the plugin and stops when the plugin unloads. */
export type HostMcpServer = Readonly<{
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  /** What the agent must send with each request, as ACP's `mcpServers` and
   * MCP clients take them. */
  headers: readonly Readonly<{ name: string; value: string }>[];
  close(): Promise<void>;
  /** Resolves once it has stopped. */
  closed: Promise<void>;
}>;
type McpEvent =
  | { type: "message"; request: number; body: string }
  | { type: "closed" };
/** Share one MCP session among cooperating clients holding the token.
 * This permits token reuse after initialization. The handler must bind identity
 * itself and grant every client the same authority. Defaults to false. */
export type HostMcpOptions = Readonly<{ sharedSession?: boolean }>;
export interface Host {
  runCommand(id: string, input?: string): Promise<string | null>;
  /** Starts a process the manifest declares in `host.processes`. It lives until
   * it exits, is killed, or the plugin unloads. Desktop only. */
  spawn?: (id: string, options?: HostProcessOptions) => Promise<HostProcess>;
  /** Starts a loopback MCP server whose messages `handler` answers, for a
   * plugin whose manifest declares `host.mcp`. Desktop only. */
  serveMcp?: (
    handler: McpHandler,
    options?: HostMcpOptions,
  ) => Promise<HostMcpServer>;
  /** Reads a file of at most 50 MB, for a plugin whose manifest declares
   * `host.files`. `path` is absolute, `~/…`, or relative to `cwd`, which is
   * absolute or `~/…`. A missing file rejects with "No such file". Desktop
   * only. */
  readFile?: (
    path: string,
    options?: Readonly<{ cwd?: string }>,
  ) => Promise<Uint8Array>;
  /** `path`, absolute or `~/…`, as an absolute directory without symbolic
   * links, created if missing, for a plugin whose manifest declares
   * `host.files`. Desktop only. */
  resolveDirectory?: (path: string) => Promise<string>;
  request(input: HostRequest): Promise<HostResponse>;
  /** Uploads a file as `request` sends a body. Desktop only. */
  upload?: (input: HostUpload) => Promise<HostResponse>;
  prepareRemoteAgentAuthorization?: (
    agentPubkey: string,
    signal?: AbortSignal,
  ) => Promise<NipOaAuthorization>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    host: Host;
  }
}

/** The signed-in owner's NIP-OA proof for `agentPubkey`, from native
 * identity or the web relay proxy. */
export async function prepareRemoteAgentAuthorization(
  agentPubkey: string,
  signal?: AbortSignal,
): Promise<NipOaAuthorization> {
  signal?.throwIfAborted();
  if (!/^[0-9a-f]{64}$/.test(agentPubkey))
    throw new Error("Agent pubkey must be 64 lowercase hex characters");
  const native = nativeIdentityEnabled();
  const owner = native
    ? await invoke<string | null>("identity_restore")
    : (
        await (
          await fetch("/api/relay/identity", { signal: signal ?? null })
        ).json()
      ).viewer;
  signal?.throwIfAborted();
  if (typeof owner !== "string" || !/^[0-9a-f]{64}$/.test(owner))
    throw new Error("Set up your identity first");
  if (owner === agentPubkey)
    throw new Error("Owner and agent pubkeys must differ");
  let tag: NipOaAuthorization;
  if (native) {
    try {
      tag = await invoke<NipOaAuthorization>(
        "identity_prepare_remote_agent_authorization",
        { owner, agentPubkey },
      );
    } catch (error) {
      throw typeof error === "string" ? new Error(error) : error;
    }
  } else {
    const response = await fetch(
      "/api/relay/prepare-remote-agent-authorization",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, agentPubkey }),
        signal: signal ?? null,
      },
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "Owner authorization failed");
    tag = result;
  }
  signal?.throwIfAborted();
  if (
    !Array.isArray(tag) ||
    tag.length !== 4 ||
    tag[0] !== "auth" ||
    tag[1] !== owner ||
    tag[2] !== "" ||
    typeof tag[3] !== "string" ||
    !/^[0-9a-f]{128}$/.test(tag[3])
  )
    throw new Error("Invalid remote agent authorization");
  return tag;
}

export class HostService extends Service implements Host {
  constructor(context: Context) {
    super(context, "host");
  }

  prepareRemoteAgentAuthorization(agentPubkey: string, signal?: AbortSignal) {
    return prepareRemoteAgentAuthorization(agentPubkey, signal);
  }

  async runCommand(id: string, input?: string): Promise<string | null> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri()) return null;
    try {
      return await invoke<string | null>("plugin_host_run_command", {
        id: owner.id,
        revision: owner.revision,
        commandId: id,
        ...(input === undefined ? {} : { input }),
      });
    } catch {
      return null;
    }
  }

  // A method, not a field: `this.ctx` is then the calling plugin's scope.
  async spawn(
    id: string,
    { onStdout, onStderr, ...options }: HostProcessOptions = {},
  ): Promise<HostProcess> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Processes require an installed desktop plugin");
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    const onEvent = new Channel<ProcessEvent>((event) => {
      if (event.type === "exit") return exit(event.code);
      // A throw here would stall the channel, so no later output or exit
      // would arrive.
      try {
        if (event.type === "stdout") onStdout?.(event.data);
        else onStderr?.(event.data);
      } catch (error) {
        console.error(`Process ${id} output handler failed`, error);
      }
    });
    const handle = await invoke<number>("plugin_host_process_spawn", {
      id: owner.id,
      revision: owner.revision,
      processId: id,
      args: options.args ?? [],
      cwd: options.cwd ?? null,
      env: options.env ?? null,
      mcp: options.mcp ?? null,
      protection: options.protection ?? null,
      onEvent,
    });
    // The host takes at most 1 MiB a write, so a longer one goes in pieces,
    // queued so no other write lands between them.
    let queue: Promise<unknown> = Promise.resolve();
    const write = (data: string, close: boolean) => {
      const written = queue.then(async () => {
        let at = 0;
        do {
          let end = Math.min(data.length, at + WRITE_UNITS);
          // A piece must not split a surrogate pair.
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1] ?? ""))
            end--;
          await invoke<void>("plugin_host_process_write", {
            id: owner.id,
            handle,
            data: data.slice(at, end),
            close: close && end === data.length,
          });
          at = end;
        } while (at < data.length);
      });
      queue = written.catch(() => undefined);
      return written;
    };
    const kill = () =>
      invoke<void>("plugin_host_process_kill", { id: owner.id, handle }).catch(
        // Already gone.
        () => undefined,
      );
    // The plugin's processes end with it, including one that started as it
    // was unloading.
    let release: () => void;
    try {
      release = this.ctx.effect(() => () => void kill(), `process ${id}`);
    } catch (error) {
      void kill();
      throw error;
    }
    void exited.then(() => release());
    return Object.freeze({
      write: (data: string) => write(data, false),
      end: (data = "") => write(data, true),
      kill,
      exited,
    });
  }

  // A method, not a field: `this.ctx` is then the calling plugin's scope.
  async serveMcp(
    handler: McpHandler,
    options?: HostMcpOptions,
  ): Promise<HostMcpServer> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("MCP servers require an installed desktop plugin");
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    let handle: number | undefined;
    const answer = async (request: number, body: string) => {
      const send = (reply: string | null) =>
        invoke<void>("plugin_host_mcp_reply", {
          id: owner.id,
          handle,
          request,
          body: reply,
        });
      const reply = await answerMcp(handler, body);
      try {
        await send(reply === undefined ? null : JSON.stringify(reply));
      } catch (error) {
        // A reply that will not encode or is too large still answers the
        // request, so the agent is not left waiting. When the agent has
        // stopped waiting, this fails too.
        await send(JSON.stringify(mcpError(requestId(body), error))).catch(
          () => undefined,
        );
      }
    };
    const onEvent = new Channel<McpEvent>((event) => {
      if (event.type === "closed") stopped();
      // Only an agent given the token, which `serve` returns, can send one.
      else void answer(event.request, event.body);
    });
    const server = await invoke<{ handle: number; url: string; token: string }>(
      "plugin_host_mcp_serve",
      {
        id: owner.id,
        revision: owner.revision,
        onEvent,
        ...(options?.sharedSession ? { sharedSession: true } : {}),
      },
    );
    handle = server.handle;
    const close = () =>
      invoke<void>("plugin_host_mcp_close", {
        id: owner.id,
        handle: server.handle,
      }).catch(
        // Already stopped.
        () => undefined,
      );
    let release: () => void;
    try {
      release = this.ctx.effect(() => () => void close(), "MCP server");
    } catch (error) {
      void close();
      throw error;
    }
    void closed.then(() => release());
    return Object.freeze({
      url: server.url,
      headers: Object.freeze([
        Object.freeze({
          name: "Authorization",
          value: `Bearer ${server.token}`,
        }),
      ]),
      close,
      closed,
    });
  }

  // Methods, not fields: `this.ctx` is then the calling plugin's scope.
  async readFile(
    path: string,
    { cwd }: Readonly<{ cwd?: string }> = {},
  ): Promise<Uint8Array> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Files require an installed desktop plugin");
    const data = await invoke<ArrayBuffer>("plugin_host_read_file", {
      id: owner.id,
      revision: owner.revision,
      path,
      cwd: cwd ?? null,
    }).catch(rethrow);
    return new Uint8Array(data);
  }

  async resolveDirectory(path: string): Promise<string> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Files require an installed desktop plugin");
    return invoke<string>("plugin_host_resolve_directory", {
      id: owner.id,
      revision: owner.revision,
      path,
    }).catch(rethrow);
  }

  async request(input: HostRequest): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Host requests require an installed desktop plugin");
    return invoke<HostResponse>("plugin_host_request", {
      id: owner.id,
      revision: owner.revision,
      request: input,
    }).catch(rethrow);
  }

  async upload(input: HostUpload): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Host uploads require an installed desktop plugin");
    return invoke<HostResponse>("plugin_host_upload", {
      id: owner.id,
      revision: owner.revision,
      upload: input,
    }).catch(rethrow);
  }
}

/** A native command's failure, which arrives as its message, as an Error. */
function rethrow(error: unknown): never {
  throw typeof error === "string" ? new Error(error) : error;
}

/** The reply to one HTTP body, which carries one message: MCP has no batches
 * since its 2025-06-18 revision. A handler that throws answers a request with
 * an internal error. */
export async function answerMcp(
  handler: McpHandler,
  body: string,
): Promise<unknown> {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
  }
  try {
    return await handler(message);
  } catch (error) {
    const id = (message as { id?: unknown } | null)?.id;
    return id === undefined || id === null ? undefined : mcpError(id, error);
  }
}

/** The id of the request in `body`, or `null` when it has none. */
function requestId(body: string): unknown {
  try {
    return (JSON.parse(body) as { id?: unknown } | null)?.id ?? null;
  } catch {
    return null;
  }
}

function mcpError(id: unknown, error: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
