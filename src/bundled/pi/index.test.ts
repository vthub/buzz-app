// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { apply } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

it("shares a Pi agent's provider and model as the pi runtime and imports them back", () => {
  let type: AgentType | undefined;
  apply({
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.pi", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  const shared = type?.exportShared?.({
    provider: "anthropic",
    model: "sonnet",
    workspace: "/private",
  });
  expect(shared).toEqual({
    runtime: "pi",
    provider: "anthropic",
    model: "sonnet",
  });
  expect(type?.importShared?.(shared ?? { model: "" })).toMatchObject({
    provider: "anthropic",
    model: "sonnet",
    workspace: "~/.buzz",
  });
  expect(
    type?.importShared?.({ runtime: "codex", model: "x" }),
  ).toBeUndefined();
});
