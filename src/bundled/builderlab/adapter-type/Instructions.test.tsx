// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { RelayData } from "../../../features/relay/service";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentTabs } from "../../agents/AgentTabs";
import type { Agents, Agent } from "../../../features/agents/service";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { builderlabType } from "./index";

const first = "ab".repeat(32);
const second = "cd".repeat(32);
const agent = (pubkey = first): Agent => ({
  key: pubkey,
  pubkey,
  name: "Helper",
  type: "block.builderlab/builderlab",
  owner: "ef".repeat(32),
  relay: "wss://community.example",
  place: "hosted",
  config: {},
  attention: {},
  skipped: {},
  attentionEnabled: true,
  timers: {},
});
const response = (): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    status: 1,
    agents: [
      {
        agent_id: "one",
        agent_pubkey: first,
        agent_name: "Helper",
        status: 2,
        agent_instructions: "First instructions.",
      },
      {
        agent_id: "two",
        agent_pubkey: second,
        agent_name: "Other",
        status: 2,
        agent_instructions: "Second instructions.",
      },
    ],
  }),
});
beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
function fixture() {
  let subject = "account-a";
  const session = createOAuthSession(async () => ({
    value: "credential",
    account: {
      subject,
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  const request = vi.fn<Host["request"]>(async ({ url }) =>
    url.endsWith("/get-model-catalog")
      ? {
          status: 200,
          headers: {},
          body: JSON.stringify({
            models: [
              {
                id: "one",
                display_name: "Friendly Model",
                supported_reasoning_efforts: ["high"],
              },
            ],
          }),
        }
      : response(),
  );
  const client = createAgentClient({ request, runCommand: vi.fn() }, session);
  const type = {
    ...builderlabType(client, session, {
      snapshot: () => ({ status: "disconnected", generation: 0 }),
      subscribe: () => () => {},
    } as unknown as RelayData),
    key: "block.builderlab/builderlab",
    pluginId: "block.builderlab",
    revision: "test",
  };
  const Tab = type.tabs?.[0]?.component;
  if (!Tab) throw new Error("Missing Builderlab settings");
  return {
    Tab,
    type,
    request,
    changeAccount: () => {
      subject = "account-b";
      session.signOut();
    },
  };
}
it("retries a failed load and refuses to save a draft through another account", async () => {
  const h = fixture();
  const user = userEvent.setup();
  h.request.mockRejectedValueOnce(new Error("offline"));
  render(<h.Tab agent={agent()} save={vi.fn()} />, { wrapper: StrictMode });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  expect(field).toHaveValue("First instructions.");
  await user.type(field, "Changed.");
  await act(async () => h.changeAccount());
  const before = h.request.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Save instructions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "account that loaded these instructions",
  );
  expect(h.request).toHaveBeenCalledTimes(before);
  expect(field).toHaveValue("First instructions.Changed.");
});
it("switching agents hides the old draft and ignores the switched-away read", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const mounted = render(<h.Tab agent={agent()} save={vi.fn()} />, {
    wrapper: StrictMode,
  });
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  await user.type(field, "Unsaved.");
  const delayed = deferred<HostResponse>();
  h.request.mockReturnValueOnce(delayed.promise);
  try {
    mounted.rerender(<h.Tab agent={agent(second)} save={vi.fn()} />);
    await waitFor(() =>
      expect(
        h.request.mock.calls.filter(([request]) =>
          request.url.endsWith("/list-agents"),
        ),
      ).toHaveLength(2),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading instructions",
    );
    expect(
      screen.queryByRole("textbox", { name: "Instructions" }),
    ).not.toBeInTheDocument();
    mounted.rerender(<h.Tab agent={agent()} save={vi.fn()} />);
    expect(
      await screen.findByRole("textbox", { name: "Instructions" }),
    ).toHaveValue("First instructions.");
  } finally {
    await act(async () => {
      delayed.resolve(response());
      await delayed.promise;
    });
  }
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "First instructions.",
  );
});

function renderTabs(h: ReturnType<typeof fixture>) {
  render(
    <AgentTabs
      agents={{ save: vi.fn() } as unknown as Agents}
      agent={agent()}
      type={h.type}
      channels={[]}
      memories={undefined}
      settingsHost={{ typeControl: () => <p>Hosted provider</p> }}
      settingsContent={<p>Agent settings</p>}
    />,
    { wrapper: StrictMode },
  );
}

it("keeps hosted instructions on cancellation and resets a confirmed discard", async () => {
  const h = fixture();
  const user = userEvent.setup();
  renderTabs(h);
  expect(screen.queryByRole("tab", { name: "Instructions" })).toBeNull();
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  expect(screen.getByRole("link", { name: "Builderlab" })).toHaveAttribute(
    "href",
    "https://builderlab.example",
  );
  await user.type(field, " Unsaved.");
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "Discard changes?",
  );
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(field).toHaveValue("First instructions. Unsaved.");
  const save = screen.getByRole("button", { name: "Save instructions" });
  const pending = deferred<HostResponse>();
  h.request.mockReturnValueOnce(pending.promise);
  try {
    await user.click(save);
    expect(field).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBe(field);
  } finally {
    await act(async () => pending.reject(new Error("offline")));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(field).toHaveValue("First instructions. Unsaved.");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  expect(save).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(screen.getByText("Workspace")).toBeVisible();
  expect(screen.getByText("One session per thread")).toBeVisible();
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(await screen.findByRole("combobox", { name: "Model" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  const fresh = await screen.findByRole("textbox", { name: "Instructions" });
  expect(fresh).not.toBe(field);
  expect(fresh).toHaveValue("First instructions.");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
});

it("guards hosted model drafts and a pending model save", async () => {
  const h = fixture();
  const user = userEvent.setup();
  renderTabs(h);
  await screen.findByRole("textbox", { name: "Instructions" });
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(await screen.findByRole("combobox", { name: "Model" }));
  await user.click(
    await screen.findByRole("option", { name: "Friendly Model" }),
  );
  expect(screen.getByRole("button", { name: "Save model" })).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
    "Friendly Model",
  );
  await user.click(screen.getByRole("combobox", { name: "Reasoning effort" }));
  await user.click(await screen.findByRole("option", { name: "high" }));
  const pending = deferred<HostResponse>();
  h.request.mockReturnValueOnce(pending.promise);
  try {
    await user.click(screen.getByRole("button", { name: "Save model" }));
    expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.getByRole("combobox", { name: "Model" })).toBeVisible();
  } finally {
    await act(async () => pending.reject(new Error("offline")));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(
    await screen.findByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("First instructions.");
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(
    await screen.findByRole("combobox", { name: "Model" }),
  ).toHaveTextContent("Choose a model");
  expect(
    screen.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveTextContent("Choose reasoning effort");
  expect(screen.queryByRole("alert")).toBeNull();
});
