// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { readView, writeView } from "../../shared/view-state";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";

import { fixture, owners, id, viewer, scope } from "./sidebar-testing";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";
import { createSoloRegionFixture } from "../../features/channel-navigation/solo-navigation-testing";
import { PrimarySidebar } from "./PrimarySidebar";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { SOLO_LABEL } from "../../features/solo/labels";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

it("double-clicks a Solo row to edit its selected name, retaining a failed save for retry", async () => {
  const user = userEvent.setup();
  const f = fixture();
  const base: ChannelDetails = {
    channelId: id,
    name: "Planning",
    description: "",
    visibility: "private",
    labels: [SOLO_LABEL],
    version: "original",
    canEdit: true,
  };
  const save = vi.fn(async () => {});
  save.mockRejectedValueOnce(new Error("Couldn’t save the name. Try again."));
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(async () => base),
      save,
    },
  });
  f.navigate(soloDraftTarget(scope));
  const row = screen.getByRole("button", { name: /^Planning/ });
  await user.click(row);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  f.open.mockClear();
  await user.dblClick(row);
  expect(f.open).toHaveBeenCalledTimes(1);
  const name = await screen.findByRole("textbox", { name: "Chat name" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(name).toHaveFocus());
  expect(name).toHaveValue("Planning");
  expect((name as HTMLInputElement).selectionStart).toBe(0);
  expect((name as HTMLInputElement).selectionEnd).toBe(8);
  await user.keyboard("New plan");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t save the name",
  );
  expect(name).toHaveValue("New plan");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(save).toHaveBeenLastCalledWith(
    base,
    expect.objectContaining({ name: "New plan", labels: [SOLO_LABEL] }),
    expect.any(AbortSignal),
  );
  await user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  await screen.findByRole("textbox", { name: "Chat name" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(save).toHaveBeenCalledTimes(2);
});

it("does not open renaming when Solo details are unavailable", async () => {
  const user = userEvent.setup();
  const f = fixture();
  await user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

function delayedRename() {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const save: ChannelDetailsCapability["save"] = vi.fn(
    async (_base, _draft, active) => {
      signal = active;
      await gate;
    },
  );
  const f = fixture();
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(
        async (channelId: string): Promise<ChannelDetails> => ({
          channelId,
          name: channelId === id ? "Planning" : "Other",
          description: "",
          visibility: "private",
          labels: [SOLO_LABEL],
          version: "one",
          canEdit: true,
        }),
      ),
      save,
    },
  });
  f.navigate(soloDraftTarget(scope));
  return {
    user: userEvent.setup(),
    save,
    signal: () => signal,
    finish: async () => {
      await act(async () => {
        finish();
        await gate;
      });
    },
  };
}

it("keeps a click-away save alive when another row is double-clicked", async () => {
  const f = delayedRename();
  await f.user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  const input = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(input).toHaveFocus());
  await f.user.keyboard("First renamed");
  try {
    await f.user.dblClick(screen.getByRole("button", { name: /^Other/ }));
    await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    expect(input).toHaveValue("First renamed");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(f.signal()?.aborted).toBe(false);
  } finally {
    await f.finish();
  }
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  const destination = screen.getByRole("button", { name: /^Other/ });
  expect(destination).toHaveFocus();
  await f.user.dblClick(destination);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
      "Other",
    ),
  );
  await f.user.keyboard("{Escape}");
});

it("keeps focus on a different chat after an Enter-save finishes", async () => {
  const f = delayedRename();
  await f.user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveFocus(),
  );
  await f.user.keyboard("First renamed{Enter}");
  const destination = screen.getByRole("button", { name: /^Other/ });
  try {
    await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    await f.user.click(destination);
    expect(destination).toHaveFocus();
  } finally {
    await f.finish();
  }
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(destination).toHaveFocus();
});
it("filters the combined sidebar without navigating or resetting Solo sections", async () => {
  const user = userEvent.setup();
  const f = fixture(true);
  const all = screen.getByRole("tab", { name: "All" });
  const solo = screen.getByRole("tab", { name: "Solo" });
  const team = screen.getByRole("tab", { name: "Team" });
  expect(all).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "New" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(
    screen.getAllByRole("separator", { name: "Resize sidebar" }),
  ).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Chats" }));
  await user.click(team);
  expect(
    screen.queryByRole("button", { name: "New chat" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(screen.getByRole("tabpanel", { name: "Team" })).toHaveAttribute(
    "id",
    team.getAttribute("aria-controls"),
  );
  await user.click(solo);
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await user.keyboard("{ArrowRight}");
  expect(team).toHaveFocus();
  expect(solo).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Enter}");
  expect(team).toHaveAttribute("aria-selected", "true");
  await user.click(all);
  expect(f.open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "New" }));
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["New chat", "New workspace", "New DM", "New channel"]);
  await user.click(screen.getByRole("menuitem", { name: "New chat" }));
  expect(f.open).toHaveBeenCalledWith(soloDraftTarget(scope));
  await user.click(solo);
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(await screen.findByRole("menuitem", { name: "New DM" }));
  expect(f.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: { viewer, communityOrigin: "https://relay.test" },
    route: { version: 1, params: "new-message" },
  });
});

it.each([
  ["New workspace", "New workspace", "Cancel"],
  ["New channel", "Create a channel", "Close channel creation"],
])(
  "opens %s from any filter and returns focus to New on cancel",
  async (item, title, close) => {
    const user = userEvent.setup();
    fixture(true, true);
    await user.click(screen.getByRole("tab", { name: "Team" }));
    const trigger = screen.getByRole("button", { name: "New" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: item }));
    const dialog = await screen.findByRole("dialog", { name: title });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("textbox", { name: "Name" }),
      ).toHaveFocus(),
    );
    await user.click(within(dialog).getByRole("button", { name: close }));
    await waitFor(() => expect(trigger).toHaveFocus());
  },
);

it("keeps unavailable creation actions disabled", async () => {
  const user = userEvent.setup();
  fixture(true);
  await user.click(screen.getByRole("button", { name: "New" }));
  expect(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitem", { name: "New channel" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it.each([
  ["New", "New workspace"],
  ["New chat or workspace", "New workspace"],
])(
  "does not navigate to a replaced session after project creation from %s completes",
  async (triggerName, itemName) => {
    const f = fixture(true, true);
    const user = userEvent.setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const create = vi
      .spyOn(f.session.soloPreferences, "createSection")
      .mockReturnValue(pending);
    await user.click(screen.getByRole("button", { name: triggerName }));
    await user.click(await screen.findByRole("menuitem", { name: itemName }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name" }),
      "Planning",
    );
    try {
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      f.replaceSession();
    } finally {
      await act(async () => {
        finish();
        await pending;
      });
    }
    expect(f.open).not.toHaveBeenCalled();
  },
);

it("retains scope across Settings remounts and reveals navigation outside the filter", async () => {
  const f = fixture(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Team" }));
  f.sidebar(false);
  f.sidebar(true);
  expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  f.navigate(soloDraftTarget(scope));
  expect(screen.getByRole("tab", { name: "Solo" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  f.navigate({
    version: 1,
    kind: "conversation",
    channelId: "team-channel",
    scope: { viewer, communityOrigin: "https://relay.test" },
  });
  expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "All" }));
  f.navigate(conversationTarget(scope, id));
  expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it.each([
  ["New workspace", "New workspace"],
  ["New channel", "Create a channel"],
])(
  "retains typed %s input through cached reconnect and session replacement",
  async (item, title) => {
    const f = fixture(true, true);
    const user = userEvent.setup();
    f.connection({ status: "connecting", cached: true });
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
    const input = within(
      await screen.findByRole("dialog", { name: title }),
    ).getByRole("textbox", { name: "Name" });
    await user.type(input, "Keep this draft");
    f.connection({ status: "error" });
    expect(input).toHaveValue("Keep this draft");
    f.replaceSession();
    expect(
      within(screen.getByRole("dialog", { name: title })).getByRole("textbox", {
        name: "Name",
      }),
    ).toHaveValue("Keep this draft");
  },
);

it("keeps navigation scope preferences partitioned by community", async () => {
  const f = fixture(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Team" }));
  const second = `https://second.test:${viewer}`;
  f.connection({ scope: second, session: { ...f.session, scope: second } });
  expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "Solo" }));
  f.connection({ scope, session: f.session });
  expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("header channel creation expands the saved destination without changing other collapsed sections", async () => {
  writeView(scope, "channel-sidebar", {
    collapsed: ["channels", "starred"],
    width: 280,
  });
  const f = fixture(true, true);
  const create = vi
    .spyOn(f.session.channelCreation, "create")
    .mockResolvedValue("new-channel");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "New channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Create a channel",
  });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Planning",
  );
  await user.click(
    within(dialog).getByRole("button", { name: /^Create channel$/ }),
  );
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "conversation",
        channelId: "new-channel",
      }),
    ),
  );
  expect(readView(scope, "channel-sidebar", null)).toMatchObject({
    collapsed: ["starred"],
    width: 280,
  });
});

it("reveals Solo when New chat reopens the same destination after filtering it out", async () => {
  const f = fixture(true);
  const user = userEvent.setup();
  f.navigate(soloDraftTarget(scope));
  await user.click(screen.getByRole("tab", { name: "Team" }));
  expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
  expect(screen.getByRole("tab", { name: "Solo" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

const soloFailure = vi.hoisted(() => ({ active: false }));
vi.mock("../../features/channel-navigation/SoloInventory", async (original) => {
  const actual =
    await original<
      typeof import("../../features/channel-navigation/SoloInventory")
    >();
  return {
    ...actual,
    SoloInventory: (props: Parameters<typeof actual.SoloInventory>[0]) => {
      if (soloFailure.active) throw new Error("Solo inventory failed");
      return <actual.SoloInventory {...props} />;
    },
  };
});

it("contains a Solo render failure without rendering the failed inventory in its fallback", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  soloFailure.active = true;
  try {
    fixture(true);
    expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversations couldn’t open.",
    );
    soloFailure.active = false;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry sidebar" }));
    expect(
      await screen.findByRole("navigation", { name: "Solo conversations" }),
    ).toBeVisible();
  } finally {
    soloFailure.active = false;
    consoleError.mockRestore();
  }
});

it("does not reveal or open a channel when its creation completes in a replaced session", async () => {
  writeView(scope, "channel-sidebar", {
    collapsed: ["channels", "starred"],
    width: 280,
  });
  const f = fixture(true, true);
  let finish!: (id: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const create = vi
    .spyOn(f.session.channelCreation, "create")
    .mockReturnValue(pending);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "New channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Create a channel",
  });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Planning",
  );
  try {
    await user.click(
      within(dialog).getByRole("button", { name: /^Create channel$/ }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    f.replaceSession();
  } finally {
    await act(async () => {
      finish("new-channel");
      await pending;
    });
  }
  expect(f.open).not.toHaveBeenCalled();
  expect(readView(scope, "channel-sidebar", null)).toMatchObject({
    collapsed: ["channels", "starred"],
    width: 280,
  });
});

it.each(["empty", "chats", "projects", "both"])(
  "keeps Solo creation available with %s, including the Solo filter",
  async (inventory) => {
    const user = userEvent.setup();
    const f = fixture(true, true);
    const channels = f.session.channels.list();
    const preferences = f.session.soloPreferences.snapshot();
    vi.spyOn(f.session.channels, "list").mockReturnValue({
      ...channels,
      channels:
        inventory === "empty" || inventory === "projects"
          ? []
          : channels.channels,
    });
    vi.spyOn(f.session.soloPreferences, "snapshot").mockReturnValue({
      ...preferences,
      data: {
        sections:
          inventory === "projects" || inventory === "both"
            ? [{ id: "project", name: "Work", order: 0 }]
            : [],
        assignments: {},
        starred: [],
        muted: [],
      },
    });
    f.connection({});
    const nav = screen.getByRole("navigation", { name: "Solo conversations" });
    if (inventory === "empty") {
      await user.click(within(nav).getByRole("button", { name: "New chat" }));
      expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
    }
    await user.click(screen.getByRole("tab", { name: "Solo" }));
    const trigger = within(nav).getByRole("button", {
      name: "New chat or workspace",
    });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
    expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "New workspace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  },
);

it("keeps new Solo chats available when project creation is unavailable", async () => {
  const user = userEvent.setup();
  const f = fixture(true);
  await user.click(
    screen.getByRole("button", { name: "New chat or workspace" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("menuitem", { name: "New chat" }));
  expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
});

it("changes Team to Solo only for a live explicit chip intent and does not replay it after navigation and remount", async () => {
  const h = createSoloRegionFixture(viewer);
  const current = conversationTarget(h.scope, "owned");
  let target = current;
  const tree = () => (
    <ToastProvider>
      <PrimarySidebar relay={h.relay} navigator={h.navigator} target={target}>
        {null}
      </PrimarySidebar>
    </ToastProvider>
  );
  const view = render(tree());
  try {
    await act(() => h.navigate(current));
    await userEvent.setup().click(screen.getByRole("tab", { name: "Team" }));
    act(() => h.service.reveal("owned"));
    expect(screen.getByRole("tab", { name: "Solo" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    target = conversationTarget(h.scope, "team");
    await act(() => h.navigate(target));
    view.rerender(tree());
    await userEvent.setup().click(screen.getByRole("tab", { name: "Team" }));
    act(() => h.roster([...h.session.channels.list().channels]));
    view.rerender(<div />);
    view.rerender(tree());
    expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("uses one contributed heading and the prior All Team Nexus order without losing chat creation", async () => {
  const h = createSoloRegionFixture(viewer);
  await h.register({ title: "Nexus", component: () => null });
  const target = conversationTarget(h.scope, "owned");
  const view = render(
    <ToastProvider>
      <PrimarySidebar relay={h.relay} navigator={h.navigator} target={target}>
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "All",
      "Team",
      "Nexus",
    ]);
    expect(screen.queryByText("Solo")).not.toBeInTheDocument();
    expect(screen.getAllByText("Nexus")).toHaveLength(2);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByRole("menuitem", { name: "New chat" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "New workspace" }),
    ).toBeVisible();
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("merged Create keeps workspace creation and return focus when a plugin menu fails", async () => {
  const h = createSoloRegionFixture(viewer);
  const create = vi.fn(async (_section: { id: string; name: string }) => {});
  Object.assign(h.session, {
    soloPreferences: {
      ...h.session.soloPreferences,
      sectionCreationWritable: true,
      createSection: create,
    },
  });
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = { ...h.navigator, open };
  await h.register({
    title: "Nexus",
    component: () => null,
    actions: () => [
      {
        id: "create",
        label: "Create",
        icon: "plus",
        onSelect() {},
        menu() {
          throw new Error("Broken contribution");
        },
      },
    ],
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={navigator}
        target={conversationTarget(h.scope, "owned")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  try {
    const trigger = screen.getByRole("button", { name: "Create" });
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "New workspace" }),
    );
    await screen.findByRole("dialog", { name: "New workspace" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "New workspace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name" }),
      "Planning",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const project = create.mock.calls[0]?.[0] as unknown as { id: string };
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        soloDraftTarget(h.scope, { project: project.id }),
      ),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("collapsing the contributed task section keeps ordinary chats visible", async () => {
  const h = createSoloRegionFixture(viewer);
  await h.register({
    title: "Nexus",
    component: ({ ui }) => (
      <ui.Conversation channelId="owned">
        {(c) => <c.Link label={c.name} />}
      </ui.Conversation>
    ),
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    const heading = view.container.querySelector(
      "[data-sidebar-section] summary",
    );
    expect(heading).not.toBeNull();
    await userEvent.setup().click(heading as HTMLElement);
    await waitFor(() =>
      expect(heading?.closest("details")).not.toHaveAttribute("open"),
    );
    expect(screen.getByRole("button", { name: /^Chat$/ })).toBeVisible();
  } finally {
    view.unmount();
    await h.dispose();
  }
});
