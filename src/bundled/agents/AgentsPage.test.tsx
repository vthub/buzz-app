import { ProfilePanel } from "../profiles/ProfilePanel";
import { createRelaySession } from "../../features/relay/session";
import {
  profileActivityViewTarget,
  profileTarget,
} from "../../features/profiles/target";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentProviderSnapshot,
  AgentViewProps,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
  TeamChange,
  FoundAgents,
  TeamPort,
} from "../../features/agents/service";
import type { OldTeam, PortableAgent } from "../../features/agents/native";
import { localStore } from "../../features/agents/state";
import { setDefaultAgent } from "../../features/solo/default-agent";
import { writeView } from "../../shared/view-state";
import type { RelayData } from "../../features/relay/service";
import type { CommunityReader } from "../../features/communities/service";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import { PlugIcon, RobotIcon } from "../../shared/design-system/icons";
import { AgentSettings } from "../../app/AgentSettings";
import { AgentsPage } from "./AgentsPage";

vi.mock("../../features/profiles/avatar-upload", async (actual) => ({
  ...(await actual<typeof import("../../features/profiles/avatar-upload")>()),
  paintEmojiAvatar: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const agent = (name: string, n: number): Agent => ({
  key: String(n).repeat(64),
  pubkey: String(n).repeat(64),
  name,
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: { reply: `${name} says hi` },
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/default": {
      slug: "interest/default",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Help." },
    },
    "watch/hourly": {
      slug: "watch/hourly",
      modifiedAt: 1,
      value: {
        type: "timer",
        interest_id: "default",
        prompt: "Check in",
        enabled: true,
        interval_secs: 3600,
        armed_at: 1,
        max_occurrences: null,
        expires_at: null,
      },
    },
  },
});

const portable: PortableAgent[] = [
  {
    source: "harness",
    pubkey: "a".repeat(64),
    name: "Ada",
    relay: "wss://relay.example",
  },
  {
    source: "installed",
    pubkey: "b".repeat(64),
    name: "Bea",
    picture: "https://old.example/media/b.png",
    relay: "",
  },
];

function provider(
  initial: AgentProviderSnapshot["readiness"],
  DialogBody: (props: { onClose(): void }) => ReactNode = () => (
    <p>Provider controls</p>
  ),
  attentionLabel = "Set up provider",
) {
  let state: AgentProviderSnapshot =
    initial === "attention"
      ? { readiness: initial, attentionLabel }
      : { readiness: initial };
  let attentionAction: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const check = vi.fn(async () => undefined);
  return {
    contribution: {
      snapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      check,
      get attentionAction() {
        return attentionAction;
      },
      DialogBody,
    },
    check,
    set(next: AgentProviderSnapshot) {
      state = next;
      for (const listener of listeners) listener();
    },
    setAttentionAction(next: (() => void) | undefined) {
      attentionAction = next;
    },
  };
}

function setup(
  saved: Agent[],
  {
    shown = true,
    model = false,
    status = "ready" as AgentsSnapshot["status"],
    more = [] as RegisteredAgentType[],
    dirtySettings = false,
    found = portable as readonly PortableAgent[],
    warnings = [] as readonly string[],
    discover = async (): Promise<FoundAgents> => ({
      agents: found,
      teams: [],
      warnings,
      here: [],
    }),
    page = {} as {
      navigation?: PageNavigation;
      navigator?: Navigation;
      communities?: CommunityReader;
    },
  } = {},
) {
  let snapshot: AgentsSnapshot = {
    status,
    classifier: "unavailable",
    agents: saved,
    running: saved,
    interrupted: [],
    teams: [],
  };
  const listeners = new Set<() => void>();
  const echoProvider = provider("ready", ({ onClose }) => (
    <>
      <p>Echo controls</p>
      <button type="button" onClick={onClose}>
        Save defaults
      </button>
    </>
  ));
  const DirtySettings = ({ agent, save, settingsHost }: AgentViewProps) => {
    const [reply, setReply] = useState(
      (agent.config as { reply: string }).reply,
    );
    const [error, setError] = useState("");
    const pendingSave = settingsHost?.pendingSave;
    return settingsHost ? (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void save({ reply }).catch((reason: unknown) =>
            setError(String(reason instanceof Error ? reason.message : reason)),
          );
        }}
      >
        {settingsHost.typeControl?.(true)}
        <p>Provider settings</p>
        <label>
          Reply
          <input
            value={reply}
            onChange={(event) => setReply(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={!pendingSave}>
          Save
        </button>
      </form>
    ) : (
      <p>Provider settings</p>
    );
  };
  const tabs = dirtySettings
    ? [
        {
          id: "settings",
          title: "Settings",
          role: "settings" as const,
          component: DirtySettings,
        },
      ]
    : [{ id: "reply", title: "Reply", component: () => <p>Reply tab</p> }];
  const type = {
    key: "test/echo",
    pluginId: "test",
    revision: "1",
    id: "echo",
    title: "Echo",
    icon: RobotIcon,
    description: "Says its line.",
    migrationWarning: "Anything Echo left running will stop.",
    defaults: () => ({ config: { reply: "" } }),
    summary: (item: Agent) => (item.config as { reply: string }).reply,
    Peek: ({ agent }: { agent: Agent }) => <p>Peek of {agent.name}</p>,
    CreateModel: model
      ? ({
          config,
          onChange,
          disabled,
        }: {
          config: { reply: string };
          onChange(config: { reply: string }): void;
          disabled: boolean;
        }) => (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...config, reply: "New model" })}
          >
            Change model
          </button>
        )
      : undefined,
    provider: echoProvider.contribution,
    tabs,
    Create: ({
      config,
      onChange,
    }: {
      config: { reply: string };
      onChange(config: { reply: string }): void;
    }) => (
      <input
        aria-label="Reply"
        value={config.reply}
        onChange={(event) => onChange({ reply: event.target.value })}
      />
    ),
  } as unknown as RegisteredAgentType;
  const created = agent("Nova", 3);
  const types = [type, ...more];
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    find: (pubkey: string) => snapshot.agents.find((a) => a.pubkey === pubkey),
    relay: () => undefined,
    handle: () => undefined,
    sessionState: () => "unavailable" as const,
    session: vi.fn(async () => {}),
    register: vi.fn(),
    addTool: vi.fn(),
    tools: () => [],
    create: vi.fn(async () => {
      // `shown: false`: it was made for a community no longer selected.
      if (!shown) return created;
      snapshot = { ...snapshot, agents: [...snapshot.agents, created] };
      for (const listener of listeners) listener();
      return created;
    }),
    finish: vi.fn(async (_: string) => created),
    portable: vi.fn(discover),
    port: vi.fn(async () => ({ agent: created, notes: [] })),
    portTeam: vi.fn(
      async (): Promise<TeamPort> => ({
        imported: [],
        failed: [],
        elsewhere: [],
        foreign: [],
      }),
    ),
    save: vi.fn(async () => {}),
    previewRetype: vi.fn(
      () =>
        ({
          config: { endpoint: "wss://relay.example" },
          moved: [],
          dropped: ["workspace"],
          settings: [
            {
              id: "model",
              label: "Model",
              outcome: "reset",
            },
            {
              id: "thinking",
              label: "Thinking",
              outcome: "dropped",
            },
          ],
        }) as const,
    ),
    retype: vi.fn(async (pubkey, typeKey, change) => {
      const changed = snapshot.agents.map((saved) =>
        saved.pubkey === pubkey
          ? { ...saved, type: typeKey, config: change?.config ?? {} }
          : saved,
      );
      snapshot = { ...snapshot, agents: changed, running: changed };
      for (const listener of listeners) listener();
      return ["workspace"] as const;
    }),
    remove: vi.fn(async (_pubkey: string): Promise<void> => {}),
    unarchive: vi.fn(async (): Promise<string | undefined> => undefined),
    interruptible: () => false,
    interrupt: vi.fn(async () => false),
    note: () => false,
    classifier: () => "unavailable",
    saveTeam: vi.fn(async (change: TeamChange) => {
      const team = { ...change, id: change.id ?? "team-1" };
      snapshot = {
        ...snapshot,
        teams: [...snapshot.teams.filter((t) => t.id !== team.id), team],
      };
      for (const listener of listeners) listener();
      return team;
    }),
    core: vi.fn(async () => undefined),
    removeTeam: vi.fn(async (id: string) => {
      snapshot = {
        ...snapshot,
        teams: snapshot.teams.filter((t) => t.id !== id),
      };
      for (const listener of listeners) listener();
    }),
    attentionProviders: () => [],
    presentWatch: () => undefined,
    addAttentionSource: vi.fn(),
    storage: localStore(),
    resumeInterrupted: vi.fn(),
    dismissInterrupted: vi.fn(),
    wake: vi.fn(),
    memberships: vi.fn(
      (_pubkey: string): ReturnType<Agents["memberships"]> => [],
    ),
    forget: vi.fn(),
    joinable: (): readonly Agent[] => [],
    join: vi.fn(),
    leave: vi.fn(),
    creationRequests: () => [],
    dismissCreation: vi.fn(),
    approveCreation: vi.fn(),
    updateRequests: () => [],
    dismissUpdate: vi.fn(),
    approveUpdate: vi.fn(),
    configHistory: () => undefined,
  } satisfies Agents;
  const disconnected = { status: "disconnected", generation: 0 };
  const relay = {
    snapshot: () => disconnected,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const view = render(<AgentsPage agents={agents} relay={relay} {...page} />);
  const show = (next: Agent[]) => {
    snapshot = { ...snapshot, agents: next };
    for (const listener of listeners) listener();
  };
  return { agents, echoProvider, types, show, relay, ...view };
}

it("opens settings for a selected agent beside the grid and follows the arrow keys", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)]);
  const grid = screen.getByRole("grid", { name: "Agents" });
  expect(within(grid).getByText("Ada says hi")).toBeInTheDocument();
  expect(screen.queryByText("Peek of Ada")).not.toBeInTheDocument();

  await user.click(within(grid).getByText("Ada"));
  expect(screen.getByRole("gridcell", { name: /Ada/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
  const profilePane = screen.getByRole("region", { name: "Agent profile" });
  expect(screen.getByRole("region", { name: "Agents" })).not.toContainElement(
    profilePane,
  );
  expect(
    within(profilePane).getByRole("tablist", { name: "Panel tabs" }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Wakes on")).not.toBeInTheDocument();

  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("heading", { name: "Bo" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: /Bo/ })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("tab", { name: "Identity" }),
  ).not.toBeInTheDocument();
  expect(grid).toBeInTheDocument();
});

it("opens the side panel with the type's tabs and the app's Settings and Memory tabs", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  expect(screen.getByRole("grid")).toBeInTheDocument();
  const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
  expect(tabs).toEqual([
    "Agents",
    "Your agents",
    "Your teams",
    "Marketplace",
    "AAda",
    "Identity",
    "Reply",
    "Memory",
    "Settings",
  ]);
  expect(
    within(
      screen.getByRole("complementary", { name: "Ada identity" }),
    ).queryByText("Type"),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Reply" }));
  expect(screen.getByText("Reply tab")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(
    screen.getByRole("switch", { name: "Attention on this device" }),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(screen.getByRole("gridcell", { name: /Ada/ })).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

it("checks providers in Agent setup and opens their host-owned dialogs", async () => {
  const user = userEvent.setup();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const relay = {
    key: "test/relay",
    pluginId: "test",
    revision: "1",
    id: "relay",
    title: "Relay",
    icon: PlugIcon,
    defaults: () => ({ config: {} }),
  } as unknown as RegisteredAgentType;
  const brokenProvider = provider(
    "attention",
    () => {
      throw new Error("Broken controls");
    },
    "Repair Broken",
  );
  brokenProvider.contribution.check = vi.fn(() => {
    throw new Error("Broken check");
  });
  const broken = {
    ...relay,
    key: "test/broken",
    id: "broken",
    title: "Broken",
    provider: brokenProvider.contribution,
  } as unknown as RegisteredAgentType;
  const checkingProvider = provider("checking");
  const checking = {
    ...relay,
    key: "test/checking",
    id: "checking",
    title: "Checking",
    provider: checkingProvider.contribution,
  } as unknown as RegisteredAgentType;
  try {
    const { echoProvider, agents } = setup([agent("Ada", 1)], {
      more: [
        relay,
        broken,
        checking,
        {
          ...relay,
          key: "test/crashed",
          id: "crashed",
          title: "Crashed",
          provider: {
            ...checkingProvider.contribution,
            snapshot: () => {
              throw new Error("Snapshot crashed");
            },
          },
        },
      ],
    });
    expect(
      screen.queryByRole("button", { name: "More agent actions" }),
    ).toBeNull();
    const defaults = render(<AgentSettings agents={agents} active={false} />);
    expect(echoProvider.check).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Harness defaults" }),
    ).toBeNull();
    defaults.rerender(<AgentSettings agents={agents} />);
    expect(screen.getByRole("heading", { name: "Agent setup" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Harness defaults" }),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Remember mentioned agents" }),
    ).toBeVisible();
    const menu = defaults.container;
    const echo = within(menu).getByRole("button", {
      name: "Echo, ready",
    });
    expect(
      within(menu).queryByRole("button", {
        name: "Relay, unavailable",
      }),
    ).toBeNull();
    expect(
      within(menu).getByRole("button", {
        name: "Repair Broken, attention",
      }),
    ).toBeEnabled();
    expect(
      within(menu).getByRole("button", { name: "Crashed, unavailable" }),
    ).toBeDisabled();
    const checkingRow = within(menu).getByRole("button", {
      name: "Checking, checking",
    });
    expect(checkingRow).toBeDisabled();
    expect(checkingRow).toHaveAttribute("aria-busy", "true");
    expect(
      checkingRow.querySelector(".motion-safe\\:animate-spin"),
    ).toBeVisible();
    expect(checkingProvider.check).toHaveBeenCalled();

    fireEvent.click(echo);
    const dialog = await screen.findByRole("dialog", { name: "Echo" });
    expect(within(dialog).getByText("Echo controls")).toBeVisible();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(
      within(dialog.querySelector("header") as HTMLElement).getAllByRole(
        "button",
      ),
    ).toEqual([close]);
    await user.click(
      within(dialog).getByRole("button", { name: "Save defaults" }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Echo, ready" }));
    const reopenedDialog = await screen.findByRole("dialog", { name: "Echo" });
    act(() => echoProvider.set({ readiness: "attention" }));
    expect(
      within(reopenedDialog).queryByRole("button", { name: "Check again" }),
    ).toBeNull();
    act(() => echoProvider.set({ readiness: "ready", blocking: true }));
    await user.keyboard("{Escape}");
    expect(reopenedDialog).toBeInTheDocument();
    expect(
      within(reopenedDialog).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    act(() => echoProvider.set({ readiness: "ready" }));
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const attentionAction = vi.fn();
    echoProvider.setAttentionAction(attentionAction);
    act(() =>
      echoProvider.set({
        readiness: "attention",
        attentionLabel: "Log in to Echo",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Log in to Echo, attention" }),
    );
    expect(attentionAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Echo" })).toBeNull();

    const brokenTrigger = screen.getByRole("button", {
      name: "Repair Broken, attention",
    });
    await user.click(brokenTrigger);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider controls are unavailable.",
    );
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(brokenTrigger).toHaveFocus());
  } finally {
    errors.mockRestore();
  }
});

it("restores legacy provider links and writes close visits", async () => {
  const user = userEvent.setup();
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const routed = {
    ...base,
    route: { version: 1, params: { provider: "test/echo" } },
  } as const;
  let current: { id: string; target: OpenTarget } = {
    id: "base",
    target: base,
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = {
    snapshot: () => ({ entry: current }),
    open,
  } as unknown as Navigation;
  const request = (): PageNavigation => {
    const navigation = {
      entryId: current.id,
      target: current.target,
      signal: new AbortController().signal,
      focus: "content" as const,
      forSession: () => navigation,
      resolve: () => true,
      complete: () => true,
    };
    return navigation;
  };
  const pageView = (agents: Agents, relay: RelayData) => (
    <AgentsPage
      agents={agents}
      relay={relay}
      navigator={navigator}
      navigation={request()}
    />
  );
  const page = { navigator, navigation: request() };
  const view = setup([agent("Ada", 1)], { page });

  current = { id: "provider", target: routed };
  view.unmount();
  const restored = render(pageView(view.agents, view.relay));
  expect(await screen.findByRole("dialog", { name: "Echo" })).toBeVisible();

  current = { id: "base", target: base };
  restored.rerender(pageView(view.agents, view.relay));
  expect(screen.queryByRole("dialog", { name: "Echo" })).toBeNull();

  current = { id: "provider", target: routed };
  restored.rerender(pageView(view.agents, view.relay));
  await user.click(await screen.findByRole("button", { name: "Close" }));
  await vi.waitFor(() =>
    expect(open).toHaveBeenLastCalledWith(base, { replace: true }),
  );
});

it("shows an agent's picture in the grid and side panel", async () => {
  const user = userEvent.setup();
  const picture = "https://old.example/media/a.png";
  setup([{ ...agent("Ada", 1), picture }]);
  const pictures = () =>
    document.querySelectorAll(`img[src="${picture}"]`).length;
  expect(pictures()).toBe(1);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  expect(pictures()).toBe(3);
  await user.keyboard("{Enter}");
  expect(screen.getByRole("grid")).toBeInTheDocument();
  expect(pictures()).toBe(3);
});

it("keeps name edits inline and lets a failed save retry", async () => {
  const user = userEvent.setup();
  const picture = "https://old.example/media/a.png";
  const { agents } = setup([{ ...agent("Ada", 1), picture }]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  agents.save.mockRejectedValueOnce(new Error("Could not save"));
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change name" }),
  );
  const field = screen.getByRole("textbox", { name: "Agent name" });
  expect(field).toHaveAttribute("data-appearance", "heading");
  await waitFor(() => expect(field).toHaveFocus());
  expect((field as HTMLInputElement).selectionStart).toBe(3);
  expect((field as HTMLInputElement).selectionEnd).toBe(3);
  await user.clear(field);
  await user.type(field, "Updated");
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(agents.save).toHaveBeenCalledWith("1".repeat(64), {
    name: "Updated",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  // An empty name replaces the failed save's error with the name prompt.
  Element.prototype.animate = vi.fn();
  try {
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add a name to save your agent",
    );
  } finally {
    Reflect.deleteProperty(Element.prototype, "animate");
  }
  await user.type(field, "Updated");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(field).not.toHaveAttribute("aria-invalid");
  expect(agents.save).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Agent name" }),
    ).not.toBeInTheDocument(),
  );
});

it("saves a reviewed provider change with the destination settings", async () => {
  const user = userEvent.setup();
  const RelaySettings = ({
    agent,
    save,
    settingsHost,
  }: AgentViewProps<{ endpoint: string }>) => {
    const [endpoint, setEndpoint] = useState(agent.config.endpoint);
    const [error, setError] = useState("");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void save({ endpoint }).catch((reason: unknown) =>
            setError(String(reason instanceof Error ? reason.message : reason)),
          );
        }}
      >
        {settingsHost?.typeControl?.(false)}
        <label>
          Endpoint
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit">Save</button>
      </form>
    );
  };
  const relay = {
    key: "test/relay",
    pluginId: "test",
    revision: "1",
    id: "relay",
    title: "Relay",
    icon: PlugIcon,
    defaults: () => ({ config: { endpoint: "wss://relay.example" } }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: RelaySettings,
      },
    ],
  } as unknown as RegisteredAgentType;
  const { agents } = setup([agent("Ada", 1)], {
    more: [relay],
    dirtySettings: true,
  });
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  const rail = screen.getByRole("complementary", { name: "Ada identity" });
  expect(
    within(rail).queryByRole("button", { name: "Change harness from Echo" }),
  ).not.toBeInTheDocument();
  agents.retype.mockRejectedValueOnce(new Error("Ada is answering"));
  const typeTrigger = screen.getByRole("button", {
    name: "Change harness from Echo",
  });
  expect(typeTrigger.querySelectorAll("svg")).toHaveLength(2);
  await user.click(typeTrigger);
  const providerMenu = await screen.findByRole("menu");
  const currentChoice = within(providerMenu).getByRole("menuitemradio", {
    name: "Echo",
  });
  const relayChoice = within(providerMenu).getByRole("menuitemradio", {
    name: "Relay",
  });
  expect(currentChoice).toBeChecked();
  expect(relayChoice).not.toBeChecked();
  expect(relayChoice.querySelector("svg")).toBeInTheDocument();
  await user.click(relayChoice);
  const dialog = await screen.findByRole("dialog", {
    name: "Move Ada to Relay?",
  });
  expect(
    screen.queryByRole("dialog", { name: "Change provider" }),
  ).not.toBeInTheDocument();
  expect(agents.retype).not.toHaveBeenCalled();
  expect(within(dialog).queryByText("Instructions")).toBeNull();
  expect(within(dialog).getByText("Workspace").parentElement).toHaveTextContent(
    "WorkspaceDropped",
  );
  expect(within(dialog).getByText("Model").parentElement).toHaveTextContent(
    "ModelResets",
  );
  expect(within(dialog).getByText("Thinking").parentElement).toHaveTextContent(
    "ThinkingDropped",
  );
  expect(dialog).toHaveTextContent(
    "Your agent will continue the conversation in Buzz.",
  );
  expect(dialog).toHaveTextContent("Anything Echo left running will stop.");
  expect(dialog).toHaveTextContent(
    "Unsaved Settings changes will be discarded when you continue.",
  );
  expect(dialog).toHaveTextContent(
    "The provider changes when you save settings.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(agents.retype).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Change harness from Relay" }),
  ).toBeVisible();
  expect(screen.queryByText("Provider settings")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Reply" }),
  ).not.toBeInTheDocument();
  const endpoint = screen.getByRole("textbox", { name: "Endpoint" });
  expect(endpoint).toHaveValue("wss://relay.example");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeEnabled();
  await user.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Ada is answering",
  );
  expect(agents.retype).toHaveBeenCalledOnce();
  expect(agents.retype).toHaveBeenLastCalledWith("1".repeat(64), "test/relay", {
    config: { endpoint: "wss://relay.example" },
  });
  await user.clear(endpoint);
  await user.type(endpoint, "wss://custom.example");
  await user.click(save);
  expect(agents.retype).toHaveBeenLastCalledWith("1".repeat(64), "test/relay", {
    config: { endpoint: "wss://custom.example" },
  });
  expect(
    screen.getByRole("button", { name: "Change harness from Relay" }),
  ).toBeVisible();
});

it("makes a new agent in the create dialog and goes straight to building it", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new agent" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toHaveTextContent("Echo");
  await user.type(within(dialog).getByLabelText("Reply"), "Hi there");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(agents.create).toHaveBeenCalledWith({
    type: "test/echo",
    name: "Nova",
    picture: expect.stringMatching(/^https:\/\//),
    config: { reply: "Hi there" },
  });
  expect(await screen.findByRole("tab", { name: "Settings" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Nova" })).toBeInTheDocument();
});

it("stays on the grid when the new agent belongs to a community no longer shown", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { shown: false });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new agent" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalled());
  expect(
    await screen.findByRole("grid", { name: "Agents" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "New agent" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Attention" })).toBeNull();
});

it("cancels inline name edits and flags an empty name on Save", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  const edit = async () => {
    await user.click(
      screen.getByRole("button", { name: "Agent profile actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Change name" }),
    );
  };
  await edit();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Message" }),
  ).not.toBeInTheDocument();
  const field = screen.getByRole("textbox", { name: "Agent name" });
  await user.clear(field);
  // jsdom lacks the Web Animations API the shake uses.
  const animate = vi.fn();
  Element.prototype.animate = animate;
  try {
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add a name to save your agent",
    );
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Add a name to save your agent");
    expect(animate).toHaveBeenCalledOnce();
    await user.keyboard("{Enter}");
    expect(animate).toHaveBeenCalledTimes(2);
    expect(agents.save).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(Element.prototype, "animate");
  }
  // Cancelling while flagged starts the next edit clean.
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await edit();
  const reopened = screen.getByRole("textbox", { name: "Agent name" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(reopened).not.toHaveAttribute("aria-invalid");
  await user.clear(reopened);
  await user.type(reopened, "Discarded");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(agents.save).not.toHaveBeenCalled();
  await edit();
  expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue(
    "Ada",
  );
});

it("imports an earlier agent as the chosen type and shows it in Your agents", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const list = await screen.findByRole("region", { name: "Agents to import" });
  // Names are unique here, so each card shows only where it comes from.
  expect(within(list).getAllByText("Buzz (Legacy)")).toHaveLength(2);
  expect(within(list).queryByText(/npub/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Import as Echo, Bea" }));
  expect(agents.port).toHaveBeenCalledWith({
    source: "installed",
    pubkey: "b".repeat(64),
    type: "test/echo",
  });
  // The dialog stays open so another can be imported; closing it is the owner's.
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(
    await within(dialog).findByRole("button", { name: "Bea imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    within(dialog).getByRole("button", { name: "Import as Echo, Ada" }),
  ).toBeEnabled();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.getByRole("tab", { name: "Your agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("imports an agent from another community as the same agent, keeping its key", async () => {
  const user = userEvent.setup();
  const { agents, show } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  agents.joinable = () => [bea];
  agents.join.mockImplementation(async () => {
    const added = { ...bea, relay: "wss://relay.example" };
    show([agent("Ada", 1), added]);
    return { agent: added, notes: [] };
  });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const list = await screen.findByRole("region", { name: "Agents to import" });
  // It keeps its type, so it offers no choice of one.
  expect(
    within(list).queryByRole("button", { name: /Choose a type for Bea/ }),
  ).not.toBeInTheDocument();
  await user.click(
    within(list).getByRole("button", {
      name: "Import, Bea from other.example",
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Import Bea",
  });
  expect(agents.join).not.toHaveBeenCalled();
  expect(confirmation).not.toHaveAccessibleDescription();
  expect(within(confirmation).getByText("One setup, everywhere")).toBeVisible();
  expect(
    within(confirmation).getByText("Memories stay in each community"),
  ).toBeVisible();
  await user.click(
    within(confirmation).getByRole("button", { name: "Import" }),
  );
  expect(agents.join).toHaveBeenCalledWith(bea.key);
  expect(
    await within(list).findByRole("button", { name: "Bea imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(
    within(screen.getByRole("grid", { name: "Agents" })).getByText("Bea"),
  ).toBeInTheDocument();
});

it("cancels cross-community consent and discards it when the destination changes", async () => {
  const user = userEvent.setup();
  const { agents, relay, rerender } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  agents.joinable = () => [bea];
  let connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    scope: "https://destination.example:owner",
    viewer: "owner",
  };
  relay.snapshot = () => connection;
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const trigger = await screen.findByRole("button", {
    name: "Import, Bea from other.example",
  });
  const open = async () => {
    await user.click(trigger);
    return screen.findByRole("dialog", {
      name: "Import Bea",
    });
  };
  let dialog = await open();
  expect(dialog).not.toHaveAccessibleDescription();
  const reminder = () =>
    within(dialog).getByRole("checkbox", { name: "Don’t remind me again" });
  expect(reminder()).not.toBeChecked();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  await user.click(reminder());
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  dialog = await open();
  expect(reminder()).not.toBeChecked();
  await user.click(reminder());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  dialog = await open();
  expect(reminder()).not.toBeChecked();
  await user.click(reminder());
  connection = {
    ...connection,
    origin: "https://different.example",
    scope: "https://different.example:owner",
  };
  rerender(<AgentsPage agents={agents} relay={relay} />);
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(agents.join).not.toHaveBeenCalled();
});

it("remembers the import reminder on confirmation across communities, only for this account", async () => {
  const user = userEvent.setup();
  const { agents, relay, rerender } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  const cy = { ...agent("Cy", 3), relay: "wss://other.example" };
  agents.joinable = () => [bea, cy];
  let connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    scope: "https://destination.example:owner",
    viewer: "owner",
  };
  relay.snapshot = () => connection;
  agents.join.mockResolvedValue({ agent: bea, notes: [] });
  const open = async () => {
    await user.click(screen.getByRole("button", { name: "New agent" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Import an agent" }),
    );
    return screen.findByRole("button", {
      name: "Import, Bea from other.example",
    });
  };
  await user.click(await open());
  const dialog = await screen.findByRole("dialog", { name: "Import Bea" });
  await user.click(
    within(dialog).getByRole("checkbox", { name: "Don’t remind me again" }),
  );
  expect(agents.join).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(
    await screen.findByRole("button", { name: "Bea imported" }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Import, Cy from other.example" }),
  );
  expect(
    await screen.findByRole("button", { name: "Cy imported" }),
  ).toBeVisible();
  expect(agents.join).toHaveBeenLastCalledWith(cy.key);
  expect(
    screen.queryByRole("dialog", { name: "Import Cy" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  // Reopening in another community retains the account's local preference.
  connection = {
    ...connection,
    origin: "https://different.example",
    scope: "https://different.example:owner",
  };
  rerender(<AgentsPage agents={agents} relay={relay} />);
  await user.click(await open());
  expect(
    await screen.findByRole("button", { name: "Bea imported" }),
  ).toBeVisible();
  expect(agents.join).toHaveBeenCalledTimes(3);
  await user.click(screen.getByRole("button", { name: "Close" }));
  connection = {
    ...connection,
    viewer: "another-owner",
    scope: "https://different.example:another-owner",
  };
  rerender(<AgentsPage agents={agents} relay={relay} />);
  await user.click(await open());
  expect(
    await screen.findByRole("dialog", { name: "Import Bea" }),
  ).toBeVisible();
  expect(agents.join).toHaveBeenCalledTimes(3);
});

it("still explains imports with corrupt or unavailable reminder storage", async () => {
  const user = userEvent.setup();
  const { agents, relay } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  agents.joinable = () => [bea];
  agents.join.mockResolvedValue({ agent: bea, notes: [] });
  const connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    scope: "https://destination.example:owner",
    viewer: "owner",
  };
  relay.snapshot = () => connection;
  writeView("owner", "agent-community-import:dismissed", "true");
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Import, Bea from other.example",
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Import Bea" });
  await user.click(
    within(dialog).getByRole("checkbox", { name: "Don’t remind me again" }),
  );
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(
      await screen.findByRole("button", { name: "Bea imported" }),
    ).toBeVisible();
    expect(agents.join).toHaveBeenCalledWith(bea.key);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "New agent" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Import an agent" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Import, Bea from other.example",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Import Bea" }),
    ).toBeVisible();
    expect(agents.join).toHaveBeenCalledOnce();
  } finally {
    save.mockRestore();
  }
});

it("keeps a cross-community import error on its card and confirms a retry", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  agents.joinable = () => [bea];
  agents.join.mockRejectedValueOnce(
    new Error("Community could not be reached"),
  );
  agents.join.mockResolvedValue({ agent: bea, notes: [] });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const confirm = async () => {
    await user.click(
      await screen.findByRole("button", {
        name: "Import, Bea from other.example",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Import Bea",
    });
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
  };
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Bea wasn't imported. Community could not be reached.",
  );
  await confirm();
  expect(
    await screen.findByRole("button", { name: "Bea imported" }),
  ).toBeInTheDocument();
  expect(agents.join).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("shows the matching community images and follows their presentation updates", async () => {
  const user = userEvent.setup();
  let state = {
    memberships: [
      {
        id: "https://other.example",
        name: "Block",
        icon: "https://images.example/bee.png",
      },
      {
        id: "https://destination.example",
        name: "Feedback",
        icon: "https://images.example/pollen.png",
      },
    ],
  };
  const listeners = new Set<() => void>();
  const communities = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as CommunityReader;
  const { agents, relay } = setup([agent("Ada", 1)], {
    found: [],
    page: { communities },
  });
  const connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    scope: "https://destination.example:owner",
  };
  relay.snapshot = () => connection;
  agents.joinable = () => [
    { ...agent("Bea", 2), relay: "wss://other.example" },
  ];
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Import, Bea from other.example",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Import Bea",
  });
  const from = within(dialog).getByRole("figure", { name: "From Block" });
  const to = within(dialog).getByRole("figure", { name: "To Feedback" });
  expect(from.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/bee.png",
  );
  expect(to.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/pollen.png",
  );
  expect(from).toHaveTextContent("other.example");
  expect(to).toHaveTextContent("destination.example");
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  await user.hover(from);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "From: Block · other.example",
  );
  await user.unhover(from);
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  // Return through Close to the destination illustration using the keyboard.
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  expect(to).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "To: Feedback · destination.example",
  );
  await act(async () => {
    state = {
      memberships: state.memberships.map((item) =>
        item.name === "Feedback"
          ? { ...item, icon: "javascript:alert(1)" }
          : item,
      ),
    };
    for (const listener of listeners) listener();
  });
  // An unavailable or unsafe image keeps its named community, never another logo.
  expect(to.querySelector("img")).toBeNull();
  expect(to).toHaveTextContent("Feedback");
  expect(from.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/bee.png",
  );
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(listeners.size).toBe(0));
  expect(agents.join).not.toHaveBeenCalled();
});

it("imports an exported agent file as a new agent of the type that runs it", async () => {
  const user = userEvent.setup();
  const scout = {
    key: "test/scout",
    title: "Scout",
    defaults: () => ({ config: { model: "" } }),
    importShared: (source: { runtime?: string; model: string }) =>
      source.runtime === "scout" ? { model: source.model } : undefined,
  } as unknown as RegisteredAgentType;
  const { agents } = setup([agent("Ada", 1)], { more: [scout] });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  const file = (text: string) =>
    new File([text], "Scout.agent.json", { type: "application/json" });
  await user.upload(within(dialog).getByLabelText("Choose file"), file("{"));
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Failed to read agent snapshot file. Invalid snapshot JSON.",
  );
  await user.upload(
    within(dialog).getByLabelText("Choose file"),
    file(
      JSON.stringify({
        format: "buzz-agent-snapshot",
        version: 1,
        definition: {
          name: "Scout",
          systemPrompt: "Scout ahead.",
          runtime: "scout",
          model: "scout-1",
        },
        profile: { displayName: "Scout" },
        memory: { level: "none", entries: [] },
      }),
    ),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Import Scout",
  });
  // What the new agent will follow is shown before it is accepted.
  expect(
    within(confirmation).getByRole("region", { name: "Agent instructions" }),
  ).toHaveTextContent("Scout ahead.");
  await user.click(
    within(confirmation).getByRole("button", { name: "Import" }),
  );
  expect(agents.port).toHaveBeenCalledWith({
    source: "shared",
    type: "test/scout",
    name: "Scout",
    instructions: "Scout ahead.",
    config: { model: "scout-1" },
  });
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Import Scout" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("dialog", { name: "Import an agent" }),
  ).toBeInTheDocument();
});

it("queues several imports in a row and keeps the dialog open until they finish", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  let finish = () => {};
  agents.port.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ agent: agent("Ada", 1), notes: [] });
      }),
  );
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  await user.click(
    await within(dialog).findByRole("button", { name: "Import as Echo, Ada" }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  );
  // Bea waits for Ada; neither can be chosen twice, and the dialog stays open.
  expect(agents.port).toHaveBeenCalledTimes(1);
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  );
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Import an agent" })).toBeVisible();
  finish();
  expect(
    await within(dialog).findByRole("button", { name: "Bea imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    within(dialog).getByRole("button", { name: "Ada imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(agents.port).toHaveBeenCalledTimes(2);
  expect(agents.port).toHaveBeenLastCalledWith({
    source: "installed",
    pubkey: "b".repeat(64),
    type: "test/echo",
  });
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    screen.queryByRole("dialog", { name: "Import an agent" }),
  ).not.toBeInTheDocument();
});

it("keeps keyboard focus on an import when it finishes", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  let finish = () => {};
  agents.port.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ agent: agent("Ada", 1), notes: [] });
      }),
  );
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  const ada = await within(dialog).findByRole("button", {
    name: "Import as Echo, Ada",
  });
  ada.focus();
  await user.keyboard("{Enter}");
  finish();
  const done = await within(dialog).findByRole("button", {
    name: "Ada imported",
  });
  expect(done).toHaveFocus();
  // The next import is one Tab away.
  await user.tab();
  expect(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  ).toHaveFocus();
});

it("drops imports still waiting their turn when the page goes away", async () => {
  const user = userEvent.setup();
  const view = setup([]);
  let finish = () => {};
  view.agents.port.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ agent: agent("Ada", 1), notes: [] });
      }),
  );
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  await user.click(
    await within(dialog).findByRole("button", { name: "Import as Echo, Ada" }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  );
  view.unmount();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Bea would otherwise land in whatever community was selected by then.
  expect(view.agents.port).toHaveBeenCalledTimes(1);
});

it("keeps importing the rest after one fails, and clears the failure on a retry", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.port.mockRejectedValueOnce(new Error("Keychain access was denied"));
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  await user.click(
    await within(dialog).findByRole("button", { name: "Import as Echo, Ada" }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  );
  expect(
    await within(dialog).findByRole("button", { name: "Bea imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Ada wasn't imported. Keychain access was denied.",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Echo, Ada" }),
  );
  expect(
    await within(dialog).findByRole("button", { name: "Ada imported" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    screen.queryByRole("dialog", { name: "Import an agent" }),
  ).not.toBeInTheDocument();
});

it("tells same-named agents to import apart by their keys", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: [
      ...portable,
      { source: "development", pubkey: "c".repeat(64), name: "Bea", relay: "" },
    ],
    teams: [],
    warnings: [],
    here: [],
  });
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const list = await screen.findByRole("region", { name: "Agents to import" });
  expect(within(list).getByText("Buzz (Legacy)")).toBeInTheDocument();
  expect(within(list).getAllByText(/^Buzz \(Legacy\) · npub…/)).toHaveLength(2);
});

it("imports agents only as a type that runs here", async () => {
  const user = userEvent.setup();
  const { agents, types } = setup([]);
  types.push({
    ...types[0],
    key: "test/cloud",
    title: "Cloud",
    remote: {},
  } as unknown as RegisteredAgentType);
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const importAda = await screen.findByRole("button", {
    name: "Import as Echo, Ada",
  });
  await user.click(
    screen.getByRole("button", { name: "Choose a type for Ada" }),
  );
  expect(
    await screen.findByRole("menuitemradio", { name: "Echo" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitemradio", { name: "Cloud" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(importAda);
  expect(agents.port).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo" }),
  );
});

it("shows why importing an agent failed and keeps it listed", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.port.mockRejectedValueOnce(new Error("Keychain access was denied"));
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Import as Echo, Ada" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Ada wasn't imported. Keychain access was denied.",
  );
  expect(
    screen.getByRole("button", { name: "Import as Echo, Ada" }),
  ).toBeEnabled();
});

const nightShift: OldTeam = {
  id: "old-night-shift",
  name: "Night Shift",
  instructions: "Ship small.",
  members: [
    { pubkey: "b".repeat(64), name: "Bea", source: "installed" },
    { pubkey: "c".repeat(64), name: "Cy", source: "installed" },
  ],
};
const onImport = () =>
  expect(
    screen.getByRole("dialog", { name: "Import a team" }),
  ).toBeInTheDocument();
async function openImport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import a team" }),
  );
}

it("explains shared team members before importing and shares the account reminder preference", async () => {
  const user = userEvent.setup();
  const { agents, relay, rerender } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  const cy = { ...agent("Cy", 3), relay: "wss://third.example" };
  agents.joinable = () => [bea, cy];
  agents.join.mockResolvedValue({ agent: bea, notes: [] });
  let connection = {
    ...relay.snapshot(),
    origin: "https://destination.example",
    viewer: "owner",
    scope: "destination:owner",
  };
  relay.snapshot = () => connection;
  await act(async () => {
    await agents.saveTeam({
      name: "Night Shift",
      instructions: "Help.",
      members: [bea.pubkey, cy.pubkey],
    });
  });
  const open = async () => {
    await user.click(screen.getByRole("tab", { name: "Your teams" }));
    await user.click(screen.getByRole("button", { name: "New team" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Import a team" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Import team Night Shift" }),
    );
    return screen.findByRole("dialog", { name: "Import Night Shift" });
  };
  let confirmation = await open();
  expect(agents.join).not.toHaveBeenCalled();
  expect(within(confirmation).getByText("One setup, everywhere")).toBeVisible();
  expect(
    within(confirmation).getByRole("figure", { name: "From other.example" }),
  ).toBeVisible();
  expect(
    within(confirmation).getByRole("figure", { name: "From third.example" }),
  ).toBeVisible();
  await user.click(
    within(confirmation).getByRole("checkbox", {
      name: "Don’t remind me again",
    }),
  );
  await user.click(
    within(confirmation).getByRole("button", { name: "Cancel" }),
  );
  expect(agents.join).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Import team Night Shift" }),
    ).toHaveFocus(),
  );
  await user.click(
    screen.getByRole("button", { name: "Import team Night Shift" }),
  );
  confirmation = await screen.findByRole("dialog", {
    name: "Import Night Shift",
  });
  expect(
    within(confirmation).getByRole("checkbox", {
      name: "Don’t remind me again",
    }),
  ).not.toBeChecked();
  await user.click(
    within(confirmation).getByRole("checkbox", {
      name: "Don’t remind me again",
    }),
  );
  await user.click(
    within(confirmation).getByRole("button", { name: "Import" }),
  );
  await waitFor(() => expect(agents.join).toHaveBeenCalledTimes(2));
  expect(agents.join).toHaveBeenNthCalledWith(1, bea.key);
  expect(agents.join).toHaveBeenNthCalledWith(2, cy.key);
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Import, Bea from other.example",
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Bea imported" }),
  ).toBeVisible();
  expect(agents.join).toHaveBeenCalledTimes(3);
  expect(
    screen.queryByRole("dialog", { name: "Import Bea" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  writeView("owner", "agent-community-import:dismissed", false);
  confirmation = await open();
  connection = {
    ...connection,
    scope: "different:owner",
    origin: "https://different.example",
  };
  rerender(<AgentsPage agents={agents} relay={relay} />);
  await waitFor(() => expect(confirmation).not.toBeInTheDocument());
  expect(agents.join).toHaveBeenCalledTimes(3);
});

it("stops queued team joins when the destination changes", async () => {
  const user = userEvent.setup();
  const { agents, relay, rerender } = setup([agent("Ada", 1)], { found: [] });
  const bea = { ...agent("Bea", 2), relay: "wss://other.example" };
  const cy = { ...agent("Cy", 3), relay: "wss://other.example" };
  agents.joinable = () => [bea, cy];
  let finish!: (result: { agent: Agent; notes: readonly string[] }) => void;
  const pending = new Promise<{ agent: Agent; notes: readonly string[] }>(
    (resolve) => {
      finish = resolve;
    },
  );
  agents.join.mockImplementation(() => pending);
  let connection = {
    ...relay.snapshot(),
    scope: "first:owner",
    viewer: "owner",
  };
  relay.snapshot = () => connection;
  await act(async () => {
    await agents.saveTeam({
      name: "Night Shift",
      instructions: "Help.",
      members: [bea.pubkey, cy.pubkey],
    });
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import a team" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Import team Night Shift" }),
  );
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Import Night Shift" }),
    ).getByRole("button", { name: "Import" }),
  );
  expect(agents.join).toHaveBeenCalledTimes(1);
  const originalList = screen.getByRole("region", { name: "Teams to import" });
  try {
    connection = { ...connection, scope: "second:owner" };
    rerender(<AgentsPage agents={agents} relay={relay} />);
    expect(originalList).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      finish({ agent: bea, notes: [] });
      await pending;
    });
  }
  expect(agents.join).toHaveBeenCalledTimes(1);
  expect(agents.join).toHaveBeenCalledWith(bea.key);
});

it.each(["agents", "teams"])(
  "warns about duplicate runtimes before Legacy %s imports",
  async (kind) => {
    const user = userEvent.setup();
    const { agents } = setup([agent("Ada", 1)]);
    agents.portable.mockResolvedValue({
      agents: portable,
      teams: [nightShift],
      warnings: [],
      here: [],
    });
    if (kind === "teams")
      await user.click(screen.getByRole("tab", { name: "Your teams" }));
    await user.click(
      screen.getByRole("button", {
        name: kind === "teams" ? "New team" : "New agent",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", {
        name: kind === "teams" ? "Import a team" : "Import an agent",
      }),
    );
    const warning = await screen.findByText(
      /Stop the old runtime before importing, or both may answer/,
    );
    expect(warning).toHaveTextContent(
      "Instructions and workspace come over only if the chosen type supports them",
    );
    expect(warning).toHaveTextContent("provider, model and other settings");
    expect(agents.port).not.toHaveBeenCalled();
    expect(agents.portTeam).not.toHaveBeenCalled();
  },
);

it("offers New team on Your teams with create and import, but no marketplace", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  agents.portable.mockResolvedValue({
    agents: [],
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(
    screen.queryByRole("button", { name: "New agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New team" }));
  expect(
    await screen.findByRole("menuitem", { name: "Import a team" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Browse the marketplace" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "Create a new team" }));
  expect(screen.getByRole("form", { name: "New team" })).toBeInTheDocument();
});

it("hides Import a team when there is nothing to import, and keeps Import an agent for files", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { found: [] });
  await act(async () => {
    await agents.portable.mock.results[0]?.value;
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  expect(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Import a team" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Import an agent" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(within(dialog).getByLabelText("Choose file")).toBeInTheDocument();
});

it("offers a first agent from a file when discovery finds nothing", async () => {
  const user = userEvent.setup();
  const { agents } = setup([], { found: [] });
  await act(async () => {
    await agents.portable.mock.results[0]?.value;
  });
  expect(
    screen.queryByRole("button", { name: /Check for agents to import/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Import from a file" }));
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(within(dialog).getByLabelText("Choose file")).toBeInTheDocument();
});

it.each([
  [
    "Your agents",
    "New agent",
    "Import an agent",
    "No agents found in the sources we could read.",
  ],
  [
    "Your teams",
    "New team",
    "Import a team",
    "No teams found in the sources we could read.",
  ],
])(
  "keeps %s import diagnostics reachable after incomplete discovery",
  async (tab, menu, entry, partialResult) => {
    const user = userEvent.setup();
    const warning = "Couldn't read Buzz (Legacy) agents.";
    const { agents } = setup([agent("Ada", 1)], {
      found: [],
      warnings: [warning],
    });
    await act(async () => {
      await agents.portable.mock.results[0]?.value;
    });
    await user.click(screen.getByRole("tab", { name: tab }));
    await user.click(screen.getByRole("button", { name: menu }));
    await user.click(await screen.findByRole("menuitem", { name: entry }));
    const dialog = screen.getByRole("dialog", { name: entry });
    expect(await within(dialog).findByText(warning)).toBeVisible();
    expect(within(dialog).getByText(partialResult)).toBeVisible();
    expect(agents.port).not.toHaveBeenCalled();
    expect(agents.portTeam).not.toHaveBeenCalled();
  },
);

it("keeps first-run actions stable from pending to empty discovery", async () => {
  let finish!: (found: FoundAgents) => void;
  const discovery = new Promise<FoundAgents>((resolve) => {
    finish = resolve;
  });
  const { agents } = setup([], { discover: () => discovery });
  expect(agents.portable).toHaveBeenCalledTimes(1);
  const create = screen.getByRole("button", {
    name: "Create your first agent",
  });
  const marketplace = screen.getByRole("button", {
    name: "Explore the marketplace",
  });
  const expectPrimaryActions = () => {
    expect(
      screen.queryByRole("button", {
        name: /Check for agents to import|Import them now/,
      }),
    ).not.toBeInTheDocument();
    expect(create).toBeEnabled();
    expect(marketplace).toBeEnabled();
    expect(
      within(create).getByText("Create your first agent"),
    ).not.toHaveAttribute("data-tone", "secondary");
    expect(
      within(marketplace).getByText("Explore the marketplace"),
    ).not.toHaveAttribute("data-tone", "secondary");
  };
  create.focus();
  try {
    expectPrimaryActions();
  } finally {
    await act(async () =>
      finish({ agents: [], teams: [], warnings: [], here: [] }),
    );
  }
  expectPrimaryActions();
  expect(screen.getByRole("button", { name: "Create your first agent" })).toBe(
    create,
  );
  expect(screen.getByRole("button", { name: "Explore the marketplace" })).toBe(
    marketplace,
  );
  expect(create).toHaveFocus();
});

it("offers first-run import diagnostics after discovery fails", async () => {
  const user = userEvent.setup();
  let fail!: (reason: Error) => void;
  const discovery = new Promise<FoundAgents>((_resolve, reject) => {
    fail = reject;
  });
  const { agents } = setup([], { discover: () => discovery });
  expect(agents.portable).toHaveBeenCalledTimes(1);
  try {
    expect(
      screen.queryByRole("button", { name: /Check for agents to import/ }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => fail(new Error("Discovery unavailable")));
  }
  await user.click(
    screen.getByRole("button", { name: /Check for agents to import/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Discovery unavailable",
  );
  expect(agents.port).not.toHaveBeenCalled();
});

it("offers import diagnostics to a first-time owner after warning-only discovery", async () => {
  const user = userEvent.setup();
  const warning = "Couldn't read Buzz (Legacy) agents.";
  const { agents } = setup([], { found: [], warnings: [warning] });
  await act(async () => {
    await agents.portable.mock.results[0]?.value;
  });
  const entry = screen.getByRole("button", {
    name: /Check for agents to import/,
  });
  expect(
    screen.queryByText("You have agents in Buzz (Legacy)."),
  ).not.toBeInTheDocument();
  await user.click(entry);
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(await within(dialog).findByText(warning)).toBeVisible();
  expect(
    within(dialog).getByText("No agents found in the sources we could read."),
  ).toBeVisible();
  expect(agents.port).not.toHaveBeenCalled();
});

it("imports an old Buzz agent as the type chosen on its button", async () => {
  const user = userEvent.setup();
  const { agents, types } = setup([]);
  types.push({
    ...types[0],
    key: "test/other",
    title: "Other",
  } as unknown as RegisteredAgentType);
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import an agent" });
  await user.click(
    await within(dialog).findByRole("button", {
      name: "Choose a type for Ada",
    }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Other" }));
  // Choosing changes the visible label; only pressing it imports.
  expect(
    within(dialog).getByRole("button", { name: "Import as Other, Ada" }),
  ).toHaveTextContent("Other");
  expect(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  ).toHaveTextContent("Echo");
  expect(agents.port).not.toHaveBeenCalled();
  expect(
    within(dialog).getByRole("button", { name: "Import as Echo, Bea" }),
  ).toBeInTheDocument();
  await user.click(
    within(dialog).getByRole("button", { name: "Import as Other, Ada" }),
  );
  expect(agents.port).toHaveBeenCalledWith({
    source: "harness",
    pubkey: "a".repeat(64),
    type: "test/other",
  });
});

it("shows only teams in Import a team and only agents in Import an agent", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  await openImport(user);
  const teamDialog = screen.getByRole("dialog", { name: "Import a team" });
  expect(
    await within(teamDialog).findByRole("region", { name: "Teams to import" }),
  ).toBeInTheDocument();
  expect(
    within(teamDialog).queryByRole("region", { name: "Agents to import" }),
  ).not.toBeInTheDocument();
  await user.click(within(teamDialog).getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  await user.click(
    await screen.findByRole("button", { name: /Import them now/ }),
  );
  const agentDialog = screen.getByRole("dialog", { name: "Import an agent" });
  expect(
    await within(agentDialog).findByRole("region", {
      name: "Agents to import",
    }),
  ).toBeInTheDocument();
  expect(
    within(agentDialog).queryByRole("region", { name: "Teams to import" }),
  ).not.toBeInTheDocument();
});

it("keeps Import a team from closing while a team import is pending", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: [],
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  let finish!: (value: Awaited<ReturnType<typeof agents.portTeam>>) => void;
  agents.portTeam.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await openImport(user);
  await user.click(
    await screen.findByRole("button", {
      name: "Import as Echo, team Night Shift",
    }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import a team" });
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(dialog).toBeInTheDocument();
  await act(async () =>
    finish({
      imported: [],
      failed: [],
      elsewhere: ["Cy"],
      foreign: [],
      teamError: { name: "Night Shift" },
    }),
  );
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("dialog", { name: "Import a team" }),
  ).not.toBeInTheDocument();
});

it("lists old teams with how many members are here, and imports one as a team", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
    here: ["c".repeat(64)],
  });
  await openImport(user);
  const teams = await screen.findByRole("region", { name: "Teams to import" });
  expect(within(teams).getByText("Night Shift")).toBeInTheDocument();
  // Cy is here already; Bea is still listed as an agent.
  expect(
    within(teams).getByText("2 members · 1 already here · Buzz (Legacy)"),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Import as Echo, team Night Shift" }),
  );
  expect(agents.portTeam).toHaveBeenCalledWith({
    id: "old-night-shift",
    type: "test/echo",
  });
  expect(
    screen.queryByRole("dialog", { name: "Import a team" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Your teams" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("counts no member of a team as here when they were imported into another community", async () => {
  const user = userEvent.setup();
  // Bea and Cy were imported into another community; Import there lists none.
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: [],
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  await openImport(user);
  const teams = await screen.findByRole("region", { name: "Teams to import" });
  expect(
    within(teams).getByText("2 members · Buzz (Legacy)"),
  ).toBeInTheDocument();
  expect(within(teams).queryByText(/already here/)).not.toBeInTheDocument();
  expect(
    within(teams).getByRole("button", {
      name: "Import as Echo, team Night Shift",
    }),
  ).toBeEnabled();
});

it("keeps a team whose members are all here importable with no agents to list", async () => {
  const user = userEvent.setup();
  const bea = { ...agent("Bea", 2), pubkey: "b".repeat(64) };
  const cy = { ...agent("Cy", 3), pubkey: "c".repeat(64) };
  const { agents } = setup([bea, cy]);
  agents.portable.mockResolvedValue({
    agents: [],
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  agents.portTeam.mockImplementationOnce(async () => ({
    team: await agents.saveTeam({
      name: "Night Shift",
      instructions: "Ship small.",
      members: [bea.pubkey, cy.pubkey],
    }),
    imported: [],
    failed: [],
    elsewhere: [],
    foreign: [],
  }));
  await openImport(user);
  await user.click(
    await screen.findByRole("button", {
      name: "Import as Echo, team Night Shift",
    }),
  );
  expect(
    screen.queryByRole("region", { name: "Agents to import" }),
  ).not.toBeInTheDocument();
  expect(agents.portTeam).toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Your teams" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.getByRole("button", { name: /Night Shift/ }),
  ).toBeInTheDocument();
});

it("keeps Import open and names each part of a team import that did not come", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  // Renamed in old Buzz since it was listed: messages name what was saved.
  const team = { id: "t", name: "Late Shift", instructions: "", members: [] };
  const bea = { ...agent("Bea", 2), pubkey: "b".repeat(64) };
  agents.portTeam
    .mockResolvedValueOnce({
      team,
      imported: [bea],
      failed: [{ name: "Cy", error: "Keychain access was denied" }],
      elsewhere: [],
      foreign: [],
    })
    .mockResolvedValueOnce({
      imported: [bea],
      failed: [],
      elsewhere: ["Cy"],
      foreign: [],
      teamError: { name: "Late Shift" },
    })
    .mockResolvedValueOnce({
      team,
      imported: [],
      failed: [],
      elsewhere: ["Cy"],
      foreign: [],
    });
  await openImport(user);
  const importTeam = await screen.findByRole("button", {
    name: "Import as Echo, team Night Shift",
  });
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Imported team Late Shift with Bea. Couldn't import Cy: Keychain access was denied.",
  );
  expect(
    screen.getByText("2 members · 1 already here · Buzz (Legacy)"),
  ).toBeInTheDocument();
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn't save team Late Shift. Imported Bea; add them in Teams. Not added: Cy, in your other communities. Use Import an agent to add them here, then import the team again.",
  );
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Imported team Late Shift. Not added: Cy, in your other communities. Use Import an agent to add them here, then import the team again.",
  );
});

it("neither counts nor adds a member another account on this device has", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
    here: [],
  });
  const bea = { ...agent("Bea", 2), pubkey: "b".repeat(64) };
  agents.portTeam.mockResolvedValueOnce({
    team: { id: "t", name: "Night Shift", instructions: "", members: [] },
    imported: [bea],
    failed: [],
    elsewhere: [],
    foreign: ["Cy"],
  });
  await openImport(user);
  const teams = await screen.findByRole("region", { name: "Teams to import" });
  expect(
    within(teams).getByText("2 members · Buzz (Legacy)"),
  ).toBeInTheDocument();
  await user.click(
    within(teams).getByRole("button", {
      name: "Import as Echo, team Night Shift",
    }),
  );
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Imported team Night Shift with Bea. Kept out: Cy, which another account on this device has.",
  );
});

it("makes a team of chosen agents and lists it with its members", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents } = setup([ada, agent("Bo", 2), agent("Cy", 3)]);
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(screen.queryByRole("grid", { name: "Teams" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Create a new team" }),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Ada leads.",
  );
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  await user.click(screen.getByRole("checkbox", { name: "Cy" }));
  await user.click(screen.getByRole("button", { name: "Create team" }));

  expect(agents.saveTeam).toHaveBeenCalledWith({
    draft: expect.any(String),
    name: "Crew",
    instructions: "Ada leads.",
    members: [ada.pubkey, agent("Cy", 3).pubkey],
  });
  const card = within(screen.getByRole("list", { name: "Teams" })).getByRole(
    "button",
    { name: "Crew" },
  );
  expect(card).toHaveTextContent("Ada, Cy");

  await user.click(card);
  expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  expect(agents.removeTeam).toHaveBeenCalledWith("team-1");
  expect(screen.queryByRole("list", { name: "Teams" })).not.toBeInTheDocument();
});

it("closes the team editor when leaving Your teams", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await act(() =>
    agents.saveTeam({ name: "Crew", instructions: "", members: [] }),
  );
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "Crew" }));
  expect(screen.getByRole("form", { name: "Edit Crew" })).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(
    screen.queryByRole("form", { name: "Edit Crew" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Crew" })).toBeInTheDocument();
});

it("offers New team again when the team being edited disappears", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await act(async () => {
    await agents.saveTeam({
      id: "crew",
      name: "Crew",
      instructions: "",
      members: [],
    });
    await agents.saveTeam({
      id: "gone",
      name: "Gone",
      instructions: "",
      members: [],
    });
  });
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  await user.click(screen.getByRole("button", { name: "Gone" }));
  expect(
    screen.queryByRole("button", { name: "New team" }),
  ).not.toBeInTheDocument();
  await act(() => agents.removeTeam("gone"));
  expect(screen.getByRole("button", { name: "Crew" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New team" })).toBeInTheDocument();
});

it("shows an agent on another device read-only, and offers only Finish setup and Delete for an unfinished hosted one", async () => {
  const user = userEvent.setup();
  const far: Agent = {
    ...agent("Far", 3),
    place: "elsewhere",
    attention: {},
  };
  const sky: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    unfinished: true,
    attention: {},
  };
  const { agents } = setup([far, sky]);
  const grid = screen.getByRole("grid", { name: "Agents" });
  expect(within(grid).getByText("On another device")).toBeInTheDocument();
  expect(within(grid).getByText("Setup unfinished")).toBeInTheDocument();

  await user.click(within(grid).getByText("Far"));
  expect(screen.getByText(/another of your devices/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Wakes on")).not.toBeInTheDocument();
  await user.dblClick(within(grid).getByText("Far"));
  expect(screen.getByRole("grid")).toBeInTheDocument();

  await user.click(within(grid).getByText("Sky"));
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Delete agent" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(agents.finish).toHaveBeenCalledWith(sky.pubkey);
  await user.dblClick(within(grid).getByText("Sky"));
  expect(screen.getByRole("grid")).toBeInTheDocument();
});

it("moves focus from Finish setup to Identity once the setup finishes", async () => {
  const user = userEvent.setup();
  const finished: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    attention: {},
  };
  const { agents, show } = setup([{ ...finished, unfinished: true }]);
  agents.finish.mockImplementationOnce(async () => {
    show([finished]);
    return finished;
  });
  await user.click(screen.getByText("Sky"));
  screen.getByRole("button", { name: "Finish setup" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("tab", { name: "Identity" })).toHaveFocus();
});

it("keeps a failed Delete's agent and its warning on screen", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents, show } = setup([ada]);
  const failure = "Ada isn't deleted yet and may still be in some channels.";
  agents.remove.mockImplementationOnce(async () => {
    show([{ ...ada, deleting: true }]);
    throw new Error(failure);
  });
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Delete agent" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(failure);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByText(/Its Delete didn't finish/)).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "Ada" })).toBeInTheDocument();
});

it("keeps a failed Remove from this community open to retry here alone", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents, show } = setup([ada]);
  let leaving = false;
  agents.memberships.mockImplementation(() => [
    {
      key: ada.key,
      origin: "https://relay.example",
      connected: true,
      ...(leaving && { deleting: true as const }),
    },
    {
      key: `${ada.pubkey}@other.example`,
      origin: "https://other.example",
      connected: true,
    },
  ]);
  const failure = "Ada hasn't left relay.example yet.";
  agents.leave.mockImplementationOnce(async () => {
    leaving = true;
    show([{ ...ada, deleting: true }]);
    throw new Error(failure);
  });
  // Ada's card shows her second community once the page next renders, as it
  // does when Import's reads settle; a click mid-render would miss the card.
  await act(async () => {});
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  const remove = () =>
    user.click(
      screen.getByRole("button", { name: "Remove from this community" }),
    );
  await remove();
  let dialog = await screen.findByRole("dialog", {
    name: "Remove Ada from relay.example?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(failure);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByText(/Its Remove didn't finish/)).toBeInTheDocument();
  expect(screen.queryByText(/Its Delete didn't finish/)).toBeNull();
  await remove();
  dialog = await screen.findByRole("dialog", {
    name: "Remove Ada from relay.example?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(agents.leave).toHaveBeenCalledTimes(2);
  expect(agents.leave).toHaveBeenLastCalledWith(ada.key);
  expect(agents.remove).not.toHaveBeenCalled();
});

it.each([
  ["a Delete", true, true],
  ["a Remove from there", false, false],
])(
  "forgets an agent where %s can't reach, and asks to Delete again only after a Delete",
  async (_, deleting, again) => {
    const user = userEvent.setup();
    const ada = agent("Ada", 1);
    const away = `${ada.pubkey}@other.example`;
    const { agents } = setup([deleting ? { ...ada, deleting } : ada]);
    let forgot = false;
    agents.memberships.mockImplementation(() => [
      {
        key: ada.key,
        origin: "https://relay.example",
        connected: true,
        ...(deleting && { deleting: true as const }),
      },
      ...(forgot
        ? []
        : [
            {
              key: away,
              origin: "https://other.example",
              connected: false,
              deleting: true as const,
            },
          ]),
    ]);
    agents.forget.mockImplementationOnce(async () => {
      forgot = true;
    });
    await user.click(screen.getByRole("gridcell", { name: "Ada" }));
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Delete agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Forget it in other.example",
      }),
    );
    expect(agents.forget).toHaveBeenCalledWith(away);
    expect(agents.remove).not.toHaveBeenCalled();
    expect(!!within(dialog).queryByText("Delete again to finish here.")).toBe(
      again,
    );
  },
);

it("opens deletion from the card menu without selecting it and requires confirmation", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "Actions for Ada" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete agent" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
  expect(screen.queryByText("Peek of Ada")).not.toBeInTheDocument();
  expect(agents.remove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(agents.remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Actions for Ada" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Open settings" }),
  );
  expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("saves a card model through its type and keeps failures on the card", async () => {
  const user = userEvent.setup();
  const saved = agent("Ada", 1);
  const { agents } = setup([saved], { model: true });
  agents.save.mockRejectedValueOnce(new Error("Model could not save"));
  await user.click(screen.getByRole("button", { name: "Change model" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Model could not save",
  );
  expect(screen.queryByText("Peek of Ada")).not.toBeInTheDocument();
  expect(agents.save).toHaveBeenCalledWith(saved.pubkey, {
    config: { reply: "New model" },
  });
  await user.click(screen.getByRole("button", { name: "Change model" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(agents.save).toHaveBeenCalledTimes(2);
});

it("opens marketplace beside Your teams without a modal", async () => {
  const user = userEvent.setup();
  setup([]);
  await user.click(screen.getByRole("tab", { name: "Marketplace" }));
  expect(
    screen.getByRole("tabpanel", { name: "Marketplace" }),
  ).toHaveTextContent("Connect to a community to browse shared agents.");
  expect(
    screen.queryByRole("dialog", { name: "Marketplace" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "New agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  expect(
    screen.getByRole("button", { name: "Create your first agent" }),
  ).toBeVisible();
});

it("offers importing first agents only when there are some to import", async () => {
  const user = userEvent.setup();
  setup([]);
  const tile = await screen.findByRole("button", { name: /Import them now/ });
  // Agents show by picture alone; one without a picture shows its initial.
  expect(tile).toHaveTextContent("You have agents in Buzz (Legacy).");
  expect(tile).not.toHaveTextContent("Ada");
  expect(
    tile.querySelectorAll("[data-avatar-stack] > [data-avatar-shape]"),
  ).toHaveLength(2);
  await user.click(
    screen.getByRole("button", { name: "Create your first agent" }),
  );
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
  cleanup();
  setup([], { found: [] });
  expect(
    await screen.findByRole("button", { name: "Create your first agent" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Explore the marketplace" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Import them now/ }),
  ).not.toBeInTheDocument();
});

it("stacks five old agents, pictures first, and counts the rest", async () => {
  setup([], {
    found: ["Ada", "Bea", "Cy", "Di", "Ed", "Flo", "Gus"].map(
      (name, index) => ({
        source: "installed" as const,
        pubkey: String(index).repeat(64),
        name,
        relay: "",
        ...(name === "Gus"
          ? { picture: "https://old.example/media/g.png" }
          : {}),
      }),
    ),
  });
  const tile = await screen.findByRole("button", { name: /Import them now/ });
  const stacked = tile.querySelectorAll(
    "[data-avatar-stack] > [data-avatar-shape]",
  );
  // Five agents, then the count as one more stack item.
  expect(stacked).toHaveLength(6);
  expect(stacked[5]).toHaveTextContent("+2");
  // Gus, the only one with a picture, leads; the rest show initials.
  expect(stacked[1]).toHaveTextContent("A");
  expect(stacked[0]?.querySelector("img")).toHaveAttribute(
    "src",
    "https://old.example/media/g.png",
  );
});

it("offers creating and the marketplace while agents load", () => {
  setup([], { status: "loading" });
  expect(
    screen.getByRole("button", { name: "Create your first agent" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Explore the marketplace" }),
  ).toBeEnabled();
});

it.each(["error", "unavailable"] as const)(
  "keeps import and marketplace reachable while agents are %s",
  async (status) => {
    setup([], { status });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New agent" }));
    expect(
      await screen.findByRole("menuitem", { name: "Create a new agent" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Import an agent" }));
    expect(
      await screen.findByRole("dialog", { name: "Import an agent" }),
    ).toBeVisible();
  },
);

it("keeps the copy and delete rows in Settings, below the agent identity", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  const copy = vi.spyOn(navigator.clipboard, "writeText");
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  const identity = screen.getByRole("complementary", { name: "Ada identity" });
  expect(within(identity).queryByText("Public key")).not.toBeInTheDocument();
  expect(
    within(identity).queryByRole("button", { name: "Delete agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(copy).toHaveBeenCalledWith(expect.stringMatching(/^npub1/));
  expect(
    await screen.findByRole("button", { name: "Copied" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete agent" }));
  const dialog = screen.getByRole("dialog", { name: "Delete Ada?" });
  expect(agents.remove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("tab", { name: "Reply" }));
  expect(
    screen.queryByRole("button", { name: "Delete agent" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  copy.mockRejectedValueOnce(new Error("Clipboard denied"));
  await user.click(
    screen.getByRole("button", { name: /Copied|Copy public key/ }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not copy the public key",
  );
  copy.mockRestore();
});

it("opens provider setup before staging an unready provider, and leaves the switch unsaved", async () => {
  const user = userEvent.setup();
  const install = vi.fn();
  const destination = provider("attention", ({ onClose }) => (
    <>
      <p>Provider installation and sign-in</p>
      <button
        type="button"
        onClick={() => {
          install();
          destination.set({ readiness: "ready" });
          onClose();
        }}
      >
        Install and connect
      </button>
    </>
  ));
  const target = {
    key: "test/destination",
    pluginId: "test",
    revision: "1",
    id: "destination",
    title: "Destination",
    defaults: () => ({ config: {} }),
    provider: destination.contribution,
  } as unknown as RegisteredAgentType;
  const { agents } = setup([agent("Ada", 1)], { more: [target] });
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  const choose = async () => {
    await user.click(
      screen.getByRole("button", { name: "Change harness from Echo" }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Destination" }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    return screen.findByRole("dialog", { name: "Destination" });
  };
  const setupDialog = await choose();
  expect(destination.check).toHaveBeenCalledOnce();
  expect(install).not.toHaveBeenCalled();
  expect(agents.retype).not.toHaveBeenCalled();
  await user.click(within(setupDialog).getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Echo" }),
  ).toBeInTheDocument();
  await choose();
  await user.click(screen.getByRole("button", { name: "Install and connect" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Change harness from Destination" }),
  ).toBeInTheDocument();
  expect(agents.retype).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(agents.retype).toHaveBeenCalledWith("1".repeat(64), target.key, {
    config: expect.anything(),
  });
});

it("opens avatar and name editing from the profile menu", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  const menu = screen.getByRole("button", { name: "Agent profile actions" });
  await user.click(menu);
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Change avatar" });
  expect(dialog).toHaveAttribute("data-height", "stable-tall");
  expect(
    within(dialog).getByRole("button", { name: "Use custom" }),
  ).toBeVisible();
  expect(
    within(dialog).queryByRole("button", { name: "Back" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(menu).toHaveFocus());
  await user.click(menu);
  await user.click(
    await screen.findByRole("menuitem", { name: "Change name" }),
  );
  expect(
    await screen.findByRole("textbox", { name: "Agent name" }),
  ).toHaveValue("Ada");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(agents.save).not.toHaveBeenCalled();
});

it("leaves an open avatar picker by Back, Escape or Cancel without saving", async () => {
  for (const name of ["ResizeObserver", "IntersectionObserver"])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Change avatar" });
  await user.click(within(dialog).getByRole("button", { name: "Use custom" }));
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  // Let Mart finish mounting so it cannot outlive the test.
  await waitFor(() =>
    expect(
      dialog
        .querySelector("em-emoji-picker")
        ?.shadowRoot?.querySelector("input"),
    ).toBeTruthy(),
  );
  await user.click(within(dialog).getByRole("button", { name: "Back" }));
  await user.click(within(dialog).getByRole("button", { name: "Use custom" }));
  await user.keyboard("{Escape}");
  expect(
    await within(dialog).findByRole("button", { name: "Use custom" }),
  ).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Use custom" }));
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(agents.save).not.toHaveBeenCalled();
});

it("shares the editable owner profile with chat profile targets", async () => {
  const ada = agent("Ada", 1);
  const view = setup([ada]);
  const owner = createRelaySession(null);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: ada.owner,
    session: owner.session,
  };
  const relay = { ...view.relay, snapshot: () => snapshot };
  const close = vi.fn();
  try {
    view.rerender(
      <ProfilePanel
        agents={view.agents}
        relay={relay}
        target={profileTarget(ada.pubkey, { agent: true }) ?? ""}
        close={close}
      />,
    );
    expect(screen.getByRole("heading", { name: "Ada" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Identity" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Info" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Agent profile actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Change name" }),
    );
    expect(screen.getByRole("textbox", { name: "Agent name" })).toBeVisible();
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("saves an avatar directly from its choices and cancels a changed draft", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("gridcell", { name: /Ada/ }));
  const open = async () => {
    await user.click(
      screen.getByRole("button", { name: "Agent profile actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Change avatar" }),
    );
    return screen.findByRole("dialog", { name: "Change avatar" });
  };
  let dialog = await open();
  await user.click(within(dialog).getByRole("button", { name: "Gloopies" }));
  await user.click(within(dialog).getByRole("button", { name: "Gloopies 1" }));
  expect(
    within(dialog).getByRole("button", { name: "Gloopies 1" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    within(dialog).queryByRole("textbox", { name: "Agent name" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: "Back" }),
  ).not.toBeInTheDocument();
  expect(agents.save).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(
    within(dialog).getByRole("button", { name: /^Gloopies$/ }),
  ).toBeVisible();
  await user.keyboard("{Escape}");
  expect(dialog).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: /^Gloopies$/ }));
  expect(
    within(dialog).getByRole("button", { name: "Gloopies 1" }),
  ).toHaveAttribute("aria-pressed", "true");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(agents.save).not.toHaveBeenCalled();
  dialog = await open();
  await user.click(within(dialog).getByRole("button", { name: "Gloopies" }));
  await user.click(within(dialog).getByRole("button", { name: "Gloopies 1" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(agents.save).toHaveBeenCalledWith("1".repeat(64), {
    picture: expect.any(String),
  });
});

it("opens the owned agent provider Activity tab for the originating conversation", async () => {
  const ada = agent("Ada", 1);
  const view = setup([ada]);
  const owner = createRelaySession(null);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: ada.owner,
    session: owner.session,
  };
  const relay = { ...view.relay, snapshot: () => snapshot };
  const renderActivity = vi.fn(({ agent, conversation }: AgentViewProps) => (
    <p>
      Transcript: {agent.pubkey} / {conversation?.channelId}
    </p>
  ));
  const originalType = view.agents.types()[0];
  if (!originalType) throw new Error("Missing fixture type");
  const activityType: RegisteredAgentType = {
    ...originalType,
    tabs: [
      ...(originalType.tabs ?? []),
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: renderActivity,
      },
    ],
  };
  const types = [activityType];
  view.agents.types = () => types;
  const context = {
    channelId: "channel-a",
    canOpen: vi.fn(() => true),
    open: vi.fn(() => true),
  };
  const close = vi.fn();
  try {
    view.rerender(
      <ProfilePanel
        agents={view.agents}
        relay={relay}
        target={profileTarget(ada.pubkey) ?? ""}
        context={context}
        close={close}
      />,
    );
    expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    view.rerender(
      <ProfilePanel
        agents={view.agents}
        relay={relay}
        target={profileActivityViewTarget(ada.pubkey) ?? ""}
        context={context}
        close={close}
      />,
    );
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByText(`Transcript: ${ada.pubkey} / channel-a`),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    types[0] = originalType;
    view.rerender(
      <ProfilePanel
        agents={view.agents}
        relay={relay}
        target={profileActivityViewTarget(ada.pubkey) ?? ""}
        context={context}
        close={close}
      />,
    );
    expect(
      screen.queryByRole("tab", { name: "Activity" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("removes an existing avatar through the image editor and explicit Save", async () => {
  const user = userEvent.setup();
  const { agents } = setup([
    { ...agent("Ada", 1), picture: "https://example.com/avatar.png" },
  ]);
  await user.click(screen.getByRole("gridcell", { name: "Ada" }));
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change avatar" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Change avatar" });
  await user.click(within(dialog).getByRole("button", { name: "Use custom" }));
  const url = within(dialog).getByRole("textbox", { name: /url/i });
  await user.clear(url);
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  expect(agents.save).toHaveBeenCalledWith("1".repeat(64), { picture: null });
});

it("retains the selected profile draft while viewing teams", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { dirtySettings: true });
  await user.click(
    within(screen.getByRole("grid", { name: "Agents" })).getByText("Ada"),
  );
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.clear(field);
  await user.type(field, "Unsaved reply");
  await user.click(screen.getByRole("tab", { name: "Your teams" }));
  expect(screen.getByRole("button", { name: "New team" })).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Agent profile" }),
  ).not.toBeInTheDocument();
  expect(field).toBeInTheDocument();
  expect(field).not.toBeVisible();
  expect(agents.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("tab", { name: "Your agents" }));
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(field);
  expect(field).toBeVisible();
  expect(field).toHaveValue("Unsaved reply");
  expect(agents.save).not.toHaveBeenCalled();
});

it("announces the main agent and presents its menu status without a fake toggle", async () => {
  const ada = agent("Ada", 1);
  const view = setup([ada]);
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    selectable: [{ pubkey: ada.pubkey, name: ada.name, managed: true }],
    archives: { status: "unavailable", archived: [] },
  };
  const connection = {
    status: "ready",
    scope: "default-card",
    session: {
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const card = screen.getByRole("gridcell", { name: "Ada, Main agent" });
  expect(within(card).getByRole("img", { name: "Main agent" })).toBeVisible();
  fireEvent.keyDown(card, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  expect(within(menu).getByText("Main agent")).toBeVisible();
  // Right-click carries the same actions as the card's "..." menu.
  expect(
    within(menu).getByRole("menuitem", { name: "Copy public key" }),
  ).toBeVisible();
  expect(within(menu).queryByRole("menuitemcheckbox")).toBeNull();
});

it("offers Make main agent from the card's actions button", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const bea = agent("Bea", 2);
  const view = setup([ada, bea]);
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    selectable: [
      { pubkey: ada.pubkey, name: ada.name, managed: true },
      { pubkey: bea.pubkey, name: bea.name, managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const connection = {
    status: "ready",
    scope: "main-card-button",
    session: {
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  expect(
    screen.getByRole("gridcell", { name: "Ada, Main agent" }),
  ).toBeVisible();
  const card = screen.getByRole("gridcell", { name: "Bea" });
  await user.click(
    within(card).getByRole("button", { name: "Actions for Bea" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Make main agent" }),
  );
  expect(
    await screen.findByRole("gridcell", { name: "Bea, Main agent" }),
  ).toBeVisible();
  expect(screen.getByRole("gridcell", { name: "Ada" })).toBeVisible();
  // Right-click opens the same actions, including the main agent choice.
  fireEvent.contextMenu(screen.getByRole("gridcell", { name: "Ada" }));
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  await user.click(
    within(menu).getByRole("menuitem", { name: "Make main agent" }),
  );
  expect(
    await screen.findByRole("gridcell", { name: "Ada, Main agent" }),
  ).toBeVisible();
  expect(screen.getByRole("gridcell", { name: "Bea" })).toBeVisible();
});

it("opens deletion from the card's right-click menu", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  fireEvent.contextMenu(screen.getByRole("gridcell", { name: "Ada" }));
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  await user.click(
    within(menu).getByRole("menuitem", { name: "Delete agent" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
  expect(agents.remove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(agents.remove).toHaveBeenCalledWith(agent("Ada", 1).pubkey);
});

it("opens a Marketplace tile in the profile pane and returns focus on close and import", async () => {
  const user = userEvent.setup();
  const view = setup([], {
    more: [
      {
        key: "test/shared",
        id: "shared",
        title: "Shared",
        defaults: () => ({ config: {} }),
        importShared: () => ({}),
      } as unknown as RegisteredAgentType,
    ],
  });
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    read: vi.fn().mockResolvedValue([
      {
        id: "ab".repeat(32),
        pubkey: "cd".repeat(32),
        kind: 30175,
        created_at: 1,
        tags: [
          ["d", "helper"],
          ["shared", "true"],
        ],
        content: JSON.stringify({
          display_name: "Marketplace helper",
          system_prompt: "Help with tasks.",
          model: "example-model",
        }),
      },
    ]),
  };
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay = { ...view.relay, snapshot: () => snapshot };
  try {
    view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
    await user.click(screen.getByRole("tab", { name: "Marketplace" }));
    const tile = await screen.findByRole("button", {
      name: "Marketplace helper",
    });
    await user.click(tile);
    expect(tile).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("heading", { name: "Marketplace helper" }),
    ).toBeVisible();
    expect(screen.getByText("Help with tasks.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Close Marketplace helper tab" }),
    );
    expect(tile).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: "Marketplace helper" }),
    ).not.toBeInTheDocument();
    // Importing removes the panel and its trigger, so focus follows the tab.
    await user.click(tile);
    await user.click(screen.getByRole("button", { name: "Import" }));
    const dialog = screen.getByRole("dialog", {
      name: "Import Marketplace helper",
    });
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("tab", { name: "Your agents" })).toHaveFocus(),
    );
    expect(view.agents.port).toHaveBeenCalledWith(
      expect.objectContaining({ type: "test/shared", config: {} }),
    );
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("offers Make main agent on a stand-in for a missing chosen agent", async () => {
  const ada = agent("Ada", 1);
  const view = setup([ada]);
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    selectable: [{ pubkey: ada.pubkey, name: ada.name, managed: true }],
    archives: { status: "unavailable", archived: [] },
  };
  const connection = {
    status: "ready",
    scope: "stand-in",
    session: {
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  // The chosen agent isn't among the choices, and wasn't deleted.
  act(() => {
    setDefaultAgent("stand-in", "d".repeat(64));
  });
  view.rerender(<AgentsPage agents={view.agents} relay={relay} />);
  const card = screen.getByRole("gridcell", { name: "Ada, Main agent" });
  fireEvent.contextMenu(card);
  const menu = await screen.findByRole("menu", { name: "Actions for Ada" });
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Make main agent" }),
  );
  fireEvent.contextMenu(card);
  expect(
    within(
      await screen.findByRole("menu", { name: "Actions for Ada" }),
    ).queryByRole("menuitem", { name: "Make main agent" }),
  ).toBeNull();
});
