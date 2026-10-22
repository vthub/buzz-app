// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createAgentClient } from "./client";
import { RemoteAgents } from "./RemoteAgents";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const row = {
  agent_id: "one",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: 2,
};
const response = (agents: unknown[], status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify({ status: 1, agents }),
});
async function fixture() {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: {
      subject: "user",
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  await session.signIn();
  const request = vi.fn(async (_input: HostRequest) => response([row]));
  const client = createAgentClient({ request, runCommand: vi.fn() }, session);
  return { session, client, request };
}
it("loads automatically, refreshes and hides account data on sign-out", async () => {
  const h = await fixture();
  render(<RemoteAgents {...h} active={() => true} />);
  expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
  expect(screen.getByText(row.agent_pubkey)).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("secret");
  h.request.mockResolvedValue(response([]));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Refresh agents" }));
  expect(await screen.findByText("No remote agents yet.")).toBeInTheDocument();
  act(() => h.session.signOut());
  expect(
    screen.queryByRole("region", { name: "Remote agents" }),
  ).not.toBeInTheDocument();
});
it("shows a held loading state and retries a failed read", async () => {
  const h = await fixture();
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  render(<RemoteAgents {...h} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading remote agents");
  expect(
    screen.getByRole("button", { name: "Refresh agents" }),
  ).toHaveAttribute("aria-disabled", "true");
  await act(async () => held.resolve(response([], 503)));
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503");
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each(["sign-out", "unmount"])(
  "ignores held reads after %s",
  async (action) => {
    const h = await fixture();
    const held = deferred<HostResponse>();
    h.request.mockReturnValue(held.promise);
    const mounted = render(<RemoteAgents {...h} active={() => true} />);
    if (action === "sign-out") act(() => h.session.signOut());
    else mounted.unmount();
    await act(async () => held.resolve(response([row])));
    expect(screen.queryByText("Helper · Active")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);
