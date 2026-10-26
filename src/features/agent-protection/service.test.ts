import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { AgentProtectionService, type ProtectionRequest } from "./service";
import type { Agent } from "../agents/service";

const owner = "a".repeat(64),
  pubkey = "b".repeat(64);
const processProtection = {
  readOnlyPaths: ["/provider"],
  hiddenPaths: ["/approval"],
};
const pending: Context[] = [];
afterEach(async () => {
  for (const ctx of pending.splice(0)) ctx.fiber.dispose();
});
async function fixture() {
  const ctx = new Context();
  pending.push(ctx);
  const agent = {
    owner,
    pubkey,
    name: "Worker",
    type: "buzz.claude-code/claude",
    relay: "wss://example.test",
    place: "here",
  } as Agent;
  const update = vi.fn(async () => {});
  const read = vi.fn(async () => ({ revision: 4, defaults: null }));
  const save = vi.fn(async () => {});
  const security = new AgentProtectionService(
    ctx,
    () => ({ owner, agents: [agent] }),
    { read, save, update },
  );
  const plugin = ctx.extend({
    pluginOwner: { id: "security.test", revision: "one" },
  });
  return { ctx, plugin, security, agent, read, save, update };
}
const action = {
  kind: "tool" as const,
  session: "one",
  content: { command: "echo hello" },
};

it("reads defaults afresh and forwards native compare-and-swap rather than caching authority", async () => {
  const f = await fixture();
  await f.plugin.agentProtection.saveDefaults(4, { mode: "human" });
  expect(f.save).toHaveBeenCalledWith(owner, 4, "security.test", {
    mode: "human",
  });
  await f.security.snapshot();
  await f.security.snapshot();
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.security.bind(f.agent)).toBeUndefined();
});
it("keeps per-agent revisions and another provider's ownership in native custody", async () => {
  const f = await fixture();
  await f.plugin.agentProtection.saveAgent(pubkey, 7, { version: 1 });
  expect(f.update).toHaveBeenCalledWith(pubkey, 7, "security.test", {
    version: 1,
  });
  await expect(
    f.plugin.agentProtection.saveAgent("c".repeat(64), 0, {}),
  ).rejects.toThrow("No such local agent");
});
it("binds identity and policy independently of hostile action content", async () => {
  const f = await fixture();
  const check = vi.fn(async (_request: ProtectionRequest) => true);
  f.plugin.agentProtection.register({ processProtection, check });
  const policy = { version: 1 };
  const gate = f.security.bind({
    ...f.agent,
    protection: { provider: "security.test", policy },
    protectionRevision: 3,
  });
  policy.version = 99;
  await gate?.check(
    { ...action, content: { agent: { pubkey: "fake" }, policy: {} } },
    new AbortController().signal,
  );
  expect(check.mock.calls[0]?.[0]).toMatchObject({
    agent: { pubkey, id: pubkey, name: "Worker" },
    policy: { version: 1 },
    relay: f.agent.relay,
  });
});
it("denies a missing, failed or non-boolean checker", async () => {
  const f = await fixture();
  const bound = {
    ...f.agent,
    protection: { provider: "security.test", policy: {} },
  };
  await expect(
    f.security.bind(bound)?.check(action, new AbortController().signal),
  ).rejects.toThrow("unavailable");
  f.plugin.agentProtection.register({
    processProtection,
    check: async () => {
      throw new Error("offline");
    },
  });
  await expect(
    f.security.bind(bound)?.check(action, new AbortController().signal),
  ).rejects.toThrow("denied");
});
it("provider disposal cancels even a checker that ignores its signal, without removing its replacement", async () => {
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const old = f.plugin.agentProtection.register({
    processProtection,
    check: async () => {
      entered();
      return new Promise<boolean>(() => {});
    },
  });
  const bound = {
    ...f.agent,
    protection: { provider: "security.test", policy: {} },
  };
  const gate = f.security.bind(bound);
  if (!gate) throw new Error("Expected protected handle");
  const checking = gate.check(action, new AbortController().signal);
  const denied = expect(checking).rejects.toThrow();
  await started;
  f.plugin.agentProtection.register({
    processProtection,
    check: async () => true,
  });
  old.dispose();
  await denied;
  await expect(
    f.security.bind(bound)?.check(action, new AbortController().signal),
  ).resolves.toBeUndefined();
});
