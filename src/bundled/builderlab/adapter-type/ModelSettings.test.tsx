// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host } from "../../../features/host/service";
import { createAgentClient, type RemoteAgent } from "../agents/client";
import { createOAuthSession } from "../oauth/session";
import { ModelSettings } from "./ModelSettings";
import { ToastProvider } from "../../../shared/design-system/ui/Toast";

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
async function fixture(selection: Partial<RemoteAgent> = {}) {
  let agent: RemoteAgent = {
    id: "agent",
    name: "Helper",
    pubkey: "ab".repeat(32),
    status: "Active",
    modelSelectionStatus: "setup-required",
    ...selection,
  };
  let subject = "account";
  let offline = false;
  const session = createOAuthSession(async () => ({
    value: "credential",
    account: {
      subject,
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  await session.signIn();
  const request = vi.fn<Host["request"]>(async ({ url, body }) => {
    if (offline) throw new Error("offline");
    let result: unknown;
    if (url.endsWith("/get-model-catalog"))
      result = {
        models: [
          {
            id: "model-one",
            display_name: "Friendly One",
            supported_reasoning_efforts: ["low", "high"],
          },
          {
            id: "model-two",
            display_name: "Friendly Two",
            supported_reasoning_efforts: ["none"],
          },
        ],
      };
    else if (url.endsWith("/update-agent")) {
      const update = JSON.parse(body ?? "{}");
      agent = {
        ...agent,
        modelId: update.model_id,
        reasoningEffort: update.reasoning_effort,
        modelSelectionStatus: "valid",
      };
      result = {};
    } else
      result = {
        status: 1,
        agents: [
          {
            agent_id: agent.id,
            agent_name: agent.name,
            agent_pubkey: agent.pubkey,
            status: 2,
            model_id: agent.modelId,
            reasoning_effort: agent.reasoningEffort,
            model_selection_status: 1,
          },
        ],
      };
    return { status: 200, headers: {}, body: JSON.stringify(result) };
  });
  const client = createAgentClient(
    { request, runCommand: vi.fn() },
    session,
    null,
  );
  render(<ModelSettings {...{ client, session, agent }} subject="account" />, {
    wrapper: ({ children }) => (
      <StrictMode>
        <ToastProvider>{children}</ToastProvider>
      </StrictMode>
    ),
  });
  await screen.findByRole("combobox", { name: "Model" });
  return {
    request,
    session,
    offline: (value: boolean) => {
      offline = value;
    },
    changeAccount: async () => {
      subject = "other";
      session.signOut();
      await session.signIn();
    },
  };
}
async function choose(label: string, value: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: value }));
}
it("requires an explicit supported pair, clears effort when the model changes, and reads back server validity", async () => {
  const h = await fixture();
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
    "Choose a model",
  );
  expect(screen.getByRole("button", { name: "Save model" })).toBeDisabled();
  await choose("Model", "Friendly One");
  expect(screen.getByRole("button", { name: "Save model" })).toBeDisabled();
  await choose("Reasoning effort", "high");
  await choose("Model", "Friendly Two");
  expect(
    screen.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveTextContent("Choose reasoning effort");
  expect(screen.getByRole("button", { name: "Save model" })).toBeDisabled();
  await choose("Reasoning effort", "none");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Save model" }));
  expect(
    await screen.findByRole("dialog", { name: "Model preferences saved" }),
  ).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  const updates = h.request.mock.calls.filter(([request]) =>
    request.url.endsWith("/update-agent"),
  );
  expect(updates).toHaveLength(1);
  expect(JSON.parse(updates[0]?.[0].body ?? "{}")).toEqual({
    agent_pubkey: "ab".repeat(32),
    model_id: "model-two",
    reasoning_effort: "none",
  });
  expect(screen.getByRole("button", { name: "Save model" })).toBeDisabled();
});
it("shows no warning or success message when opening valid saved preferences", async () => {
  await fixture({
    modelId: "model-one",
    reasoningEffort: "high",
    modelSelectionStatus: "valid",
  });
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
    "Friendly One",
  );
  expect(
    screen.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveTextContent("high");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Model preferences saved" }),
  ).not.toBeInTheDocument();
});
it.each([
  {
    modelId: "retired",
    reasoningEffort: "high",
    modelSelectionStatus: "model-unavailable" as const,
    status: "no longer available",
  },
  {
    modelId: "model-two",
    reasoningEffort: "high",
    modelSelectionStatus: "effort-unsupported" as const,
    status: "no longer supported",
  },
])(
  "keeps invalid saved selection visible without a fallback: $modelSelectionStatus",
  async ({ status, ...selection }) => {
    await fixture(selection);
    expect(screen.getByRole("status")).toHaveTextContent(status);
    expect(screen.getByRole("status")).toHaveTextContent(
      selection.modelId === "retired" ? "retired" : "Friendly Two",
    );
    expect(
      screen.getByRole("combobox", { name: "Reasoning effort" }),
    ).toHaveTextContent("Choose reasoning effort");
    expect(screen.getByRole("button", { name: "Save model" })).toBeDisabled();
  },
);
it("preserves a failed draft and refuses to save it through a different account", async () => {
  const h = await fixture();
  await choose("Model", "Friendly One");
  await choose("Reasoning effort", "low");
  h.offline(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save model" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  expect(
    screen.queryByRole("dialog", { name: "Model preferences saved" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveTextContent("low");
  h.offline(false);
  await act(async () => h.changeAccount());
  const before = h.request.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Save model" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "account that loaded these model settings",
  );
  expect(h.request).toHaveBeenCalledTimes(before);
});

it("retries a failed catalog refresh without retrying a failed save", async () => {
  const h = await fixture();
  await choose("Model", "Friendly One");
  await choose("Reasoning effort", "low");
  const user = userEvent.setup();
  h.offline(true);
  await user.click(screen.getByRole("button", { name: "Save model" }));
  await user.click(
    await screen.findByRole("button", { name: "Refresh models" }),
  );
  const retry = await screen.findByRole("button", { name: "Retry models" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  h.offline(false);
  await user.click(retry);
  await screen.findByRole("button", { name: "Refresh models" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  expect(
    screen.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveTextContent("low");
  expect(
    h.request.mock.calls.filter(([request]) =>
      request.url.endsWith("/update-agent"),
    ),
  ).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Save model" }));
  expect(
    await screen.findByRole("dialog", { name: "Model preferences saved" }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
