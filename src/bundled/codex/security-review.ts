import { AppServer, type Spawn } from "./rpc";

/** Reviews on a separate native worker whose model requests offer no tools and
 * whose dispatcher refuses every tool, including unadvertised calls. */
export async function reviewModel(
  spawn: Spawn,
  model: { provider?: string; id: string },
  prompt: string,
  cancelled: AbortSignal,
) {
  const rpc = new AppServer();
  const signal = AbortSignal.any([cancelled, AbortSignal.timeout(60_000)]);
  const cancel = () => void rpc.close();
  let threadId: string | undefined;
  let reply = "";
  let finish!: () => void, fail!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => undefined);
  const off = rpc.onMessage((wire) => {
    const params = wire.params as
      | {
          threadId?: string;
          item?: { type?: string; text?: string };
          turn?: { status?: string; error?: { message?: string } };
        }
      | undefined;
    if (wire.method === "connection/closed")
      fail(new Error("The security model connection closed"));
    if (!threadId || params?.threadId !== threadId) return;
    if (
      wire.method === "item/completed" &&
      params.item?.type === "agentMessage"
    )
      reply = params.item.text ?? "";
    if (wire.method === "turn/completed") {
      if (params.turn?.status === "completed") finish();
      else
        fail(
          new Error(
            params.turn?.error?.message ??
              "The security model did not complete",
          ),
        );
    }
  });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.open(
      (_id, options) =>
        spawn("protected-app-server", {
          ...options,
          env: { BUZZ_SECURITY_REVIEW_ONLY: "1", BASH_ENV: null, ENV: null },
        }),
      undefined,
      true,
    );
    signal.throwIfAborted();
    const normalized = await rpc.request<{
      config: { mcp_servers?: Record<string, Record<string, unknown>> };
    }>("config/read", {});
    const mcp = Object.fromEntries(
      Object.entries(normalized.config.mcp_servers ?? {}).map(
        ([name, server]) => [
          name,
          {
            ...(typeof server.command === "string"
              ? { command: server.command }
              : { url: server.url }),
            enabled: false,
          },
        ],
      ),
    );
    const started = await rpc.request<{
      thread: { id: string };
      model: string;
    }>("thread/start", {
      ...(model.id ? { model: model.id } : {}),
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        mcp_servers: mcp,
        web_search: "disabled",
        "features.plugins": false,
        "features.apps": false,
        ...(model.provider ? { model_provider: model.provider } : {}),
      },
    });
    threadId = started.thread.id;
    signal.throwIfAborted();
    await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      outputSchema: {
        type: "object",
        properties: {
          blocked: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["blocked", "reason"],
        additionalProperties: false,
      },
    });
    await completed;
    signal.throwIfAborted();
    return {
      text: reply,
      model: {
        ...(model.provider ? { provider: model.provider } : {}),
        id: started.model,
      },
    };
  } finally {
    off();
    signal.removeEventListener("abort", cancel);
    await rpc.close();
  }
}
