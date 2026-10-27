// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { GooseRuntime } from "./runtime";
import { apply } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
afterEach(() => vi.restoreAllMocks());

it("observes saved conversations with the status of open sessions", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  vi.spyOn(GooseRuntime.prototype, "conversations").mockReturnValue([
    { key: "room/r", at: 3 },
    { key: "dm", at: 2 },
    { key: "old", at: 1 },
  ]);
  vi.spyOn(GooseRuntime.prototype, "sessions").mockReturnValue([
    { key: "room/r", busy: true, sessionId: "s1", at: 3 },
    { key: "dm", busy: false, sessionId: "s2", at: 2 },
    // Open, though saving it failed.
    { key: "new", busy: true, sessionId: "s3", at: 4 },
    // A one-off turn joins no conversation.
    { key: "timer/x #1", busy: true },
  ]);
  let type: AgentType | undefined;
  apply({
    pluginOwner: { id: "buzz.goose", revision: "r1" },
    host: { request: vi.fn() },
    agentProtection: { registerModels: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  // A reload stops its turns, so the owner is asked to resume them.
  expect(type?.resumes).toBe(true);
  expect(
    type?.importShared?.({
      runtime: "goose",
      provider: "databricks_v2",
      model: "shared-model",
    }),
  ).toMatchObject({ provider: "databricks_v2", model: "shared-model" });
  expect(
    type?.importShared?.({ runtime: "buzz-agent", model: "shared-model" }),
  ).toBeUndefined();
  expect(
    type?.exportShared?.({ provider: "databricks_v2", model: "shared-model" }),
  ).toEqual({
    runtime: "goose",
    provider: "databricks_v2",
    model: "shared-model",
  });
  expect(type?.sessions?.list("a".repeat(64))).toEqual([
    { channelId: "new", at: 4, status: "Working" },
    { channelId: "room", root: "r", at: 3, status: "Working" },
    { channelId: "dm", at: 2, status: "Idle" },
    // A conversation whose session closed is unobserved, not idle.
    { channelId: "old", at: 1 },
  ]);
});
