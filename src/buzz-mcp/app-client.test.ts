import { expect, it, vi } from "vitest";
import type { AgentHandle } from "../features/agents/service";
import type { AgentProtection } from "../features/agent-protection/service";
import { appClient } from "./app-client";

it("binds shared-tool review to native conversation context and refuses missing context", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const agent = {
    pubkey: "agent",
    protection: { check },
  } as unknown as AgentHandle;
  const options = {
    read: vi.fn(),
    memories: async () => ({ entries: [], partial: false }),
  };
  const action = {
    kind: "tool" as const,
    session: "native-session",
    content: { command: "write", conversation: "untrusted replacement" },
  };
  await expect(appClient(agent, options).protect?.(action)).rejects.toThrow(
    "no native conversation context",
  );
  expect(check).not.toHaveBeenCalled();
  const conversation = [{ role: "user", text: "Only read" }];
  await appClient(agent, {
    ...options,
    protectionContext: async () => conversation,
  }).protect?.(action);
  expect(check.mock.calls[0]?.[0]).toEqual({
    ...action,
    content: { command: "write", conversation },
  });
});

it("carries connection authorities independently of query event authors", async () => {
  const query = vi.fn(async () => []);
  const client = appClient(
    { pubkey: "agent", query } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
      relayAuthor: "trusted-relay",
      signingAuthority: "trusted-workflows",
    },
  );
  expect(client.relayAuthor).toBe("trusted-relay");
  expect(client.signingAuthority).toBe("trusted-workflows");
  await client.query([{ kinds: [39000] }]);
  expect(query).toHaveBeenCalledWith([{ kinds: [39000] }]);
});

it("does not invent authority when a host has none", () => {
  const client = appClient({ pubkey: "agent" } as AgentHandle, {
    read: vi.fn(),
    memories: async () => ({ entries: [], partial: false }),
  });
  expect(client.relayAuthor).toBeUndefined();
  expect(client.signingAuthority).toBeUndefined();
});

it("withholds a query result when the owning turn ends during the read", async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const query = vi.fn(async () => {
    await pending;
    return [];
  });
  const client = appClient(
    { pubkey: "agent", query } as unknown as AgentHandle,
    {
      read: vi.fn(),
      signal: controller.signal,
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  const result = client.query([{ kinds: [9] }]);
  expect(query).toHaveBeenCalledOnce();
  controller.abort(new Error("Owning turn ended"));
  release();
  await expect(result).rejects.toThrow("Owning turn ended");
});

it("refuses creation after the calling turn ends and surfaces native failures", async () => {
  const createAgent = vi.fn(async () => {
    throw new Error("Native creation failed");
  });
  const controller = new AbortController();
  const client = appClient({ createAgent } as unknown as AgentHandle, {
    read: vi.fn(),
    signal: controller.signal,
    memories: async () => ({ entries: [], partial: false }),
  });
  await expect(
    client.createAgent?.({ type: "codex/codex", name: "Child" }),
  ).rejects.toThrow("Native creation failed");
  controller.abort(new Error("Turn ended"));
  await expect(
    client.createAgent?.({ type: "codex/codex", name: "Child" }),
  ).rejects.toThrow("Turn ended");
  expect(createAgent).toHaveBeenCalledOnce();
});
