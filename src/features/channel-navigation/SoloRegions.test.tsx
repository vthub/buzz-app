// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { SoloRegions } from "./SoloRegions";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { SoloHeading } from "../../bundled/channels/SoloHeading";
import { WorkspaceControl } from "../solo/WorkspaceControl";
import type { OpenTarget } from "../navigation/targets";
import { createSoloRegionFixture } from "./solo-navigation-testing";
import type {
  SoloRegionAction,
  SoloRegionProps,
} from "./solo-navigation-contract";
import type { Navigation } from "../navigation/controller";
import { useSidebarView } from "../../bundled/channels/useSidebarView";
import { writeView } from "../../shared/view-state";
import destinationStyles from "./SoloDestination.module.css";

const disposals: (() => unknown)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const h = createSoloRegionFixture();
  disposals.push(h.dispose);
  return h;
}
function mount(
  h: ReturnType<typeof fixture>,
  target: OpenTarget = { version: 1, kind: "home" },
) {
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const retryReveal = vi.fn();
  const revealAgain = vi.fn();
  const navigator = { open } as unknown as Navigation;
  function View() {
    const [collapsed, setCollapsed] = useState<string[]>([]);
    const [order, setOrder] = useState<string[]>([]);
    const list = useRef<HTMLElement>(null);
    const toggle = useCallback((key: string, expanded: boolean) => {
      setCollapsed((keys) =>
        keys.includes(key) === !expanded
          ? keys
          : expanded
            ? keys.filter((item) => item !== key)
            : [...keys, key],
      );
    }, []);
    return (
      <SoloRegions
        session={h.session}
        scope={h.scope}
        target={target}
        navigator={navigator}
        sidebar={{
          list,
          collapsed,
          contributionOrder: order,
          setContributionOrder: (next) => setOrder([...next]),
          toggle,
          retryReveal,
          revealAgain,
          beforeReveal: () => () => {},
        }}
      />
    );
  }
  const mounted = render(
    <ToastProvider>
      <View />
    </ToastProvider>,
  );
  return {
    ...mounted,
    open,
    retryReveal,
    revealAgain,
    navigate(next: OpenTarget) {
      target = next;
      void h.navigate(next);
      mounted.rerender(
        <ToastProvider>
          <View />
        </ToastProvider>,
      );
    },
  };
}
/** A minimal source composition of the host conversation parts. */
function Row({
  ui,
  channelId,
  label,
  supporting,
  menuActions,
  before,
  after,
  rest,
  secondary,
  footer,
  children,
  tone,
  dropTarget,
}: Pick<SoloRegionProps, "ui"> & {
  channelId: string;
  label?: string;
  supporting?: string;
  menuActions?: SoloRegionAction[];
  before?: ReactNode;
  after?: ReactNode;
  rest?: ReactNode;
  secondary?: string;
  footer?: ReactNode;
  children?: ReactNode;
  tone?: "default" | "tonal" | "inset";
  dropTarget?: boolean;
}) {
  return (
    <ui.Conversation
      channelId={channelId}
      {...(menuActions ? { menuActions } : {})}
    >
      {(c) => (
        <ui.Card
          {...(tone ? { tone } : {})}
          {...(dropTarget ? { dropTarget } : {})}
          footer={footer}
          body={children}
        >
          <c.Menu>
            <div>
              {before}
              <c.Link
                label={
                  <>
                    {label ?? c.name}
                    {supporting && " "}
                    {supporting && <span>{supporting}</span>}
                  </>
                }
                trailing={<c.Unread />}
              />
              {after}
              {rest && <c.Reveal on="rest">{rest}</c.Reveal>}
              <c.Actions />
            </div>
            {secondary && (
              <c.Link
                secondary
                aria-label={`Open ${c.name}: ${secondary}`}
                label={secondary}
              />
            )}
          </c.Menu>
        </ui.Card>
      )}
    </ui.Conversation>
  );
}
function Body({ ui }: SoloRegionProps) {
  return (
    <>
      <Row ui={ui} channelId="owned" />
      <Row ui={ui} channelId="chat" label="Must stay outside" />
    </>
  );
}

it("paints the shared card tone and accepted drag target the source chooses", async () => {
  const h = fixture();
  await h.register({
    component: ({ ui }) => (
      <>
        <Row ui={ui} channelId="owned" tone="inset" dropTarget />
        <Row ui={ui} channelId="shared" tone="tonal" />
      </>
    ),
  });
  mount(h);
  expect(
    screen
      .getByRole("button", { name: "Owned" })
      .closest("[data-navigation-card]"),
  ).toHaveAttribute("data-tone", "inset");
  expect(
    screen
      .getByRole("button", { name: "Owned" })
      .closest("[data-navigation-card]"),
  ).toHaveAttribute("data-drop-target");
  expect(
    screen
      .getByRole("button", { name: "Shared" })
      .closest("[data-navigation-card]"),
  ).not.toHaveAttribute("data-drop-target");
  expect(
    screen
      .getByRole("button", { name: "Shared" })
      .closest("[data-navigation-card]"),
  ).toHaveAttribute("data-tone", "tonal");
});

it("keeps header actions and every owned channel reachable through body failure and retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = fixture();
  let broken = true;
  const choose = vi.fn();
  await h.register({
    component: (props) => {
      if (broken) throw new Error("broken body");
      return <Body {...props} />;
    },
    actions: () => [
      { id: "choose", label: "Choose view", icon: <span />, onSelect: choose },
    ],
  });
  const view = mount(h);
  expect(screen.getByText("Work could not load")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Choose view" }));
  expect(choose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Owned" }));
  expect(view.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "owned" }),
  );
  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.queryByText("Work could not load")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Owned" })).toBeVisible();
  expect(screen.queryByText("Must stay outside")).not.toBeInTheDocument();
});

it("retains accepted presentation state across unmount, disposal and re-registration and refuses stale or failed writes", async () => {
  const h = fixture();
  let props: SoloRegionProps | undefined;
  const source = await h.register({
    component: (value) => {
      props = value;
      return <Body {...value} />;
    },
  });
  const view = mount(h);
  expect(props).toBeDefined();
  const old = props?.state;
  expect(old?.set({ pins: ["owned"] })).toBe(true);
  view.unmount();
  await act(() => source.fiber.dispose());
  expect(old?.set({ pins: [] })).toBe(false);
  await act(async () => {
    await h.register({
      component: (value) => {
        props = value;
        return <Body {...value} />;
      },
    });
  });
  mount(h);
  expect(props?.state.get()).toEqual({ pins: ["owned"] });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  expect(props?.state.set({ pins: [] })).toBe(false);
  expect(props?.state.get()).toEqual({ pins: ["owned"] });
  expect(props?.state.set({ huge: "x".repeat(16 * 1024) })).toBe(false);
  expect(props?.state.get()).toEqual({ pins: ["owned"] });
});

it("reads newer presentation state from another host before returning cached accepted state", async () => {
  const a = fixture();
  const b = fixture();
  const sourceA = await a.register();
  const sourceB = await b.register();
  const registeredA = a.service.sources()[0],
    registeredB = b.service.sources()[0];
  assert(registeredA && registeredB);
  const stateA = a.service.presentation(registeredA, sourceA.binding()).state;
  const stateB = b.service.presentation(registeredB, sourceB.binding()).state;
  expect(stateA.set({ v: 1, views: { projects: { closed: true } } })).toBe(
    true,
  );
  expect(stateB.get()).toEqual({ v: 1, views: { projects: { closed: true } } });
  expect(
    stateB.set({
      v: 1,
      pins: ["shared"],
      views: { projects: { closed: true } },
    }),
  ).toBe(true);
  expect(stateA.get()).toEqual(stateB.get());
  expect(stateB.set({ v: 2, pins: ["future"] })).toBe(true);
  expect(stateA.get()).toEqual({ v: 2, pins: ["future"] });
});

it("contains throwing header actions and reports rejected actions without failing the source body", async () => {
  const h = fixture();
  const source = await h.register({
    component: Body,
    actions: () => [
      {
        id: "broken",
        label: "Fail action",
        icon: <span />,
        onSelect: async () => {
          throw new Error("rejected");
        },
      },
    ],
  });
  mount(h);
  fireEvent.click(screen.getByRole("button", { name: "Fail action" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The action could not run.",
  );
  expect(screen.getByRole("button", { name: "Owned" })).toBeVisible();
  await act(() => source.fiber.dispose());
  await act(async () => {
    await h.register({
      component: Body,
      actions: () => {
        throw new Error("invalid actions");
      },
    });
  });
  expect(screen.getByRole("button", { name: "Owned" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Fail action" }),
  ).not.toBeInTheDocument();
});

it("restores accepted state in a new host service, including JSON null", async () => {
  let props: SoloRegionProps | undefined;
  const component = (value: SoloRegionProps) => {
    props = value;
    return <Body {...value} />;
  };
  const first = fixture();
  await first.register({ component });
  const view = mount(first);
  expect(props?.state.set(null)).toBe(true);
  expect(props?.state.get()).toBeNull();
  view.unmount();
  const restarted = fixture();
  await restarted.register({ component });
  mount(restarted);
  expect(props?.state.get()).toBeNull();
});

it("keeps Destination navigation, unread and local state stable across source updates, with host-only menu actions", async () => {
  const h = fixture();
  const unread = {
    ...h.session.unread.snapshot({ kind: "channel", channelId: "owned" }),
    manual: "local-only" as const,
  };
  Object.assign(h.session, {
    unread: { ...h.session.unread, snapshot: () => unread },
  });
  const custom = vi.fn(async () => {
    throw new Error("rejected");
  });
  const source = await h.register({
    component: ({ ui }) => (
      <>
        <input aria-label="View draft" defaultValue="" />
        <Row
          ui={ui}
          channelId="owned"
          label="My task"
          supporting="Waiting for review"
          footer={<button type="button">Show workers</button>}
          menuActions={[
            {
              id: "custom",
              label: "Pin task",
              icon: <span />,
              onSelect: custom,
            },
          ]}
        />
        <Row ui={ui} channelId="chat" label="Unowned destination" />
      </>
    ),
  });
  const view = mount(h, {
    version: 1,
    kind: "conversation",
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  });
  fireEvent.change(screen.getByRole("textbox", { name: "View draft" }), {
    target: { value: "keep this" },
  });
  const row = screen.getByRole("button", {
    name: /My task Waiting for review/,
  });
  expect(row).toHaveAttribute("data-solo-destination-id", "owned");
  expect(row).toHaveAttribute("aria-current", "page");
  expect(
    screen.getByRole("img", { name: "Marked unread on this device only" }),
  ).toBeInTheDocument();
  fireEvent.click(row);
  expect(view.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "owned" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show workers" }));
  expect(view.open).toHaveBeenCalledTimes(1);
  await act(() =>
    source.update({ status: "ready", binding: source.binding(), revision: 2 }),
  );
  expect(screen.getByRole("textbox", { name: "View draft" })).toHaveValue(
    "keep this",
  );
  expect(
    screen.getByRole("button", { name: /My task Waiting for review/ }),
  ).toBe(row);
  expect(screen.queryByText("Unowned destination")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Actions for Owned" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin task" }));
  expect(custom).toHaveBeenCalledOnce();
  expect(
    await screen.findByText("The action could not run."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Actions for Owned" }));
  expect(
    await screen.findByRole("menuitem", { name: "Chat settings" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Move to" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: /Convert/ }),
  ).not.toBeInTheDocument();
  const stale = screen.getByRole("menuitem", { name: "Pin task" });
  await act(() => h.reconnect());
  expect(stale).not.toBeInTheDocument();
  fireEvent.click(stale);
  expect(custom).toHaveBeenCalledOnce();
});

it("replays only this region's live reveals and ignores old incarnation subscribers", async () => {
  const h = fixture();
  const seen = vi.fn();
  let props: SoloRegionProps | undefined;
  const source = await h.register({
    component: (value) => {
      props = value;
      return <Body {...value} />;
    },
  });
  await h.navigate({
    version: 1,
    kind: "conversation",
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  });
  h.service.reveal("owned");
  mount(h);
  const stop = props?.revealRequests.subscribe(seen);
  expect(seen).toHaveBeenCalledWith("owned");
  h.service.reveal("chat");
  expect(seen).toHaveBeenCalledTimes(1);
  await act(() => h.reconnect());
  h.service.reveal("owned");
  expect(seen).toHaveBeenCalledTimes(1);
  expect(source.signal().aborted).toBe(false);
  stop?.();
});

it("replaces personal filing with a reveal chip and rejects a move selected just after ownership changes", async () => {
  const h = fixture();
  await h.register();
  const channel = h.session.channels
    .list()
    .channels.find((item) => item.id === "owned");
  assert(channel);
  const data = {
    sections: [{ id: "personal", name: "Personal", order: 0 }],
    assignments: { owned: "personal" },
    starred: [],
    muted: [],
  };
  const snapshot = { status: "ready" as const, data };
  const assign = vi.fn(async () => {});
  Object.assign(h.session, {
    soloPreferences: {
      ...h.session.soloPreferences,
      snapshot: () => snapshot,
      assign,
    },
  });
  await h.navigate({
    version: 1,
    kind: "conversation",
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  });
  const reveal = vi.fn();
  const stop = h.service.subscribeReveal(reveal);
  render(
    <ToastProvider>
      <SoloHeading
        session={h.session}
        scope={h.scope}
        channel={channel}
        onConvert={() => {}}
        onLifecycle={() => {}}
        onMove={() => {}}
      >
        <WorkspaceControl session={h.session} channelId="owned" />
      </SoloHeading>
    </ToastProvider>,
  );
  expect(
    screen.queryByRole("button", { name: "Workspace: Personal" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Chat actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Chat settings" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Move to" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: /Convert/ }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Chat settings" }), {
    key: "Escape",
  });
  fireEvent.click(screen.getByRole("button", { name: "In Work" }));
  expect(reveal).toHaveBeenCalledWith("owned", true);
  await act(() => h.roster([{ ...channel, labels: ["buzz.solo"] }]));
  expect(
    screen.queryByRole("button", { name: "In Work" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Workspace: Personal" }));
  const move = await screen.findByRole("menuitemradio", {
    name: "No workspace",
  });
  act(() => {
    h.roster([channel]);
    fireEvent.click(move);
  });
  expect(assign).not.toHaveBeenCalled();
  expect(data.assignments).toEqual({ owned: "personal" });
  expect(screen.getByRole("button", { name: "In Work" })).toBeInTheDocument();
  stop();
});

it.each([
  ["owned", false],
  ["shared", false],
  ["owned", true],
  ["shared", true],
] as const)(
  "moves focus from a removed %s Destination to its neighbor (recovery=%s)",
  async (id, recovery) => {
    const h = fixture();
    if (!recovery)
      await h.register({
        component: ({ ui }) => (
          <>
            <Row ui={ui} channelId="owned" />
            <Row ui={ui} channelId="shared" />
          </>
        ),
      });
    mount(h);
    const remaining = id === "owned" ? "Shared" : "Owned";
    screen
      .getByRole("button", { name: id === "owned" ? "Owned" : "Shared" })
      .focus();
    await act(() =>
      h.roster(
        h.session.channels
          .list()
          .channels.filter((channel) => channel.id !== id),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: remaining })).toHaveFocus(),
    );
  },
);

it("returns focus to the Destination after cancelling the existing rename editor, including a failed details read", async () => {
  const h = fixture();
  Object.assign(h.session, {
    channelDetails: {
      ...h.session.channelDetails,
      available: true,
      load: async () => {
        throw new Error("Offline");
      },
    },
  });
  await h.register({ component: Body });
  mount(h);
  const row = screen.getByRole("button", { name: "Owned" });
  row.focus();
  fireEvent.doubleClick(row);
  const input = screen.getByRole("textbox", { name: "Chat name" });
  expect(input).toHaveFocus();
  expect(await screen.findByText("Offline")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Owned" })).toHaveFocus(),
  );
});

it.each([true, false])(
  "preserves restored collapse but prepares a new destination before revealing (restored=%s)",
  async (restored) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Synthetic layout distinguishes a visible header proxy from the opened offscreen row.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const hidden = !!this.closest("[hidden]");
        const row = this.matches('[aria-current="page"]') && !hidden;
        return {
          top: row ? 200 : 0,
          bottom: row ? 220 : 20,
          height: hidden ? 0 : 20,
        } as DOMRect;
      },
    );
    const h = fixture();
    await h.register({ component: Body });
    const target: OpenTarget = {
      version: 1,
      kind: "conversation",
      channelId: "owned",
      scope: {
        communityOrigin: "https://fixture.invalid",
        viewer: h.session.viewer ?? "",
      },
    };
    await h.navigate(target);
    writeView(h.scope, "channel-sidebar", {
      collapsed: ["solo-region:example/work"],
      location: restored ? "conversation:owned" : "conversation:chat",
    });
    const visibleAtReveal: boolean[] = [];
    function View() {
      const sidebar = useSidebarView(h.scope, true, "conversation:owned");
      return (
        <ToastProvider>
          <nav ref={sidebar.list} data-testid="region-viewport">
            <SoloRegions
              session={h.session}
              scope={h.scope}
              target={target}
              navigator={h.navigator}
              sidebar={{
                ...sidebar,
                revealAgain: () => {
                  visibleAtReveal.push(
                    !screen
                      .getByRole("button", { name: "Owned", hidden: true })
                      .closest("[hidden]"),
                  );
                  sidebar.revealAgain();
                },
              }}
            />
          </nav>
        </ToastProvider>
      );
    }
    render(<View />);
    const heading = screen.getByLabelText("Work");
    expect(screen.getByTestId("region-viewport").scrollTop).toBe(
      restored ? 0 : 160,
    );
    if (restored) expect(heading.parentElement).not.toHaveAttribute("open");
    else expect(heading.parentElement).toHaveAttribute("open");
    if (!restored) fireEvent.click(heading);
    await act(() => h.reconnect());
    expect(screen.getByLabelText("Work").parentElement).not.toHaveAttribute(
      "open",
    );
    act(() => h.service.reveal("owned"));
    expect(visibleAtReveal).toEqual([true]);
    expect(screen.getByLabelText("Work").parentElement).toHaveAttribute("open");
  },
);

it("does not replay host reveals on roster updates or re-arm after navigation leaves, but honors an explicit current reveal", async () => {
  const h = fixture();
  await h.register({ component: Body });
  const target: OpenTarget = {
    version: 1,
    kind: "conversation",
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  };
  await h.navigate(target);
  const view = mount(h, target);
  expect(view.revealAgain).not.toHaveBeenCalled();
  act(() => h.service.reveal("owned"));
  expect(view.revealAgain).toHaveBeenCalledOnce();
  const heading = screen.getByLabelText("Work");
  fireEvent.click(heading);
  expect(heading.parentElement).not.toHaveAttribute("open");
  await act(() => h.roster([...h.session.channels.list().channels]));
  expect(screen.getByLabelText("Work").parentElement).not.toHaveAttribute(
    "open",
  );
  expect(view.revealAgain).toHaveBeenCalledOnce();
  await act(() => view.navigate({ ...target, channelId: "chat" }));
  await act(() => h.roster([...h.session.channels.list().channels]));
  view.unmount();
  const remount = mount(h, { ...target, channelId: "chat" });
  expect(remount.revealAgain).not.toHaveBeenCalled();
  const late = vi.fn();
  const region = h.service.snapshot().regions[0];
  const binding = h.service.snapshot().binding;
  assert(region?.source && binding);
  h.service.presentation(region.source, binding).revealRequests.subscribe(late);
  expect(late).not.toHaveBeenCalled();
});

it.each(["Owned", "Hide tasks", "Open Owned: Supporting"])(
  "restores the surviving destination after reconnect with focus on %s",
  async (focused) => {
    const h = fixture();
    await h.register({
      component: ({ ui }) => (
        <Row
          ui={ui}
          channelId="owned"
          secondary="Supporting"
          after={
            <ui.Disclosure
              label="Hide tasks"
              summary=""
              expanded
              controls="owned-tasks"
              onToggle={() => {}}
            />
          }
        />
      ),
    });
    mount(h);
    screen.getByRole("button", { name: focused }).focus();
    await act(() => h.reconnect());
    expect(screen.getByRole("button", { name: "Owned" })).toHaveFocus();
  },
);

it("keeps reconnect focus on a nested destination instead of its parent", async () => {
  const h = fixture();
  await h.register({
    component: ({ ui }) => (
      <Row ui={ui} channelId="owned">
        <Row ui={ui} channelId="shared" />
      </Row>
    ),
  });
  mount(h);
  screen.getByRole("button", { name: "Shared" }).focus();
  await act(() => h.reconnect());
  expect(screen.getByRole("button", { name: "Shared" })).toHaveFocus();
});

it("moves focus to the region summary after the last row disappears and to Solo after its region disappears", async () => {
  const h = fixture();
  const source = await h.register({ component: Body });
  const solo = document.createElement("button");
  solo.dataset.soloHeading = "";
  solo.textContent = "Solo";
  document.body.append(solo);
  try {
    mount(h);
    screen.getByRole("button", { name: "Owned" }).focus();
    await act(() => h.roster([]));
    await waitFor(() => expect(screen.getByLabelText("Work")).toHaveFocus());
    await act(() => source.fiber.dispose());
    await waitFor(() => expect(solo).toHaveFocus());
  } finally {
    solo.remove();
  }
});

it("keeps recovery chats reachable while distinguishing installed, unknown and not-installed plugin state", async () => {
  const h = fixture();
  mount(h);
  expect(
    screen.getByText("The plugin for these chats is off."),
  ).toBeInTheDocument();
  await act(() => h.plugins({ status: "loading" }));
  expect(screen.getByRole("status")).toHaveTextContent("Loading Plugin chats…");
  await act(() =>
    h.plugins({ status: "recovery", reason: "Unavailable", canReset: false }),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "The plugin for these chats is off.",
  );
  await act(() =>
    h.plugins({
      status: "ready",
      catalog: { profile: "fixture", location: "Fixture", plugins: [] },
      externalPluginsPaused: false,
    }),
  );
  expect(
    screen.getByText("The plugin for these chats is not installed."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Owned" })).toBeInTheDocument();
  expect(screen.queryByText(/buzz\.region:/)).not.toBeInTheDocument();
});

it("uses shared populated menus for header choices and refuses retired menu callbacks", async () => {
  const h = fixture();
  const select = vi.fn();
  const source = await h.register({
    component: Body,
    actions: () => [
      {
        id: "view",
        label: "View and filter",
        icon: "view",
        onSelect() {},
        menu: () => [
          {
            id: "projects",
            label: "Projects",
            group: "View",
            checked: true,
            onSelect: select,
          },
          {
            id: "flat",
            label: "Flat",
            group: "View",
            checked: false,
            onSelect: select,
          },
        ],
      },
    ],
  });
  mount(h);
  fireEvent.click(screen.getByRole("button", { name: "View and filter" }));
  const item = await screen.findByRole("menuitemradio", { name: "Flat" });
  fireEvent.click(item);
  expect(select).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(
      screen.queryByRole("menuitemradio", { name: "Flat" }),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "View and filter" }));
  const stale = await screen.findByRole("menuitemradio", { name: "Flat" });
  await act(() => source.fiber.dispose());
  fireEvent.click(stale);
  expect(select).toHaveBeenCalledOnce();
});

it("contains a throwing contributed menu without losing the source body", async () => {
  const h = fixture();
  await h.register({
    component: Body,
    actions: () => [
      {
        id: "broken",
        label: "Broken menu",
        icon: "view",
        onSelect() {},
        menu() {
          throw new Error("broken menu");
        },
      },
    ],
  });
  mount(h);
  expect(screen.getByRole("button", { name: "Owned" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Broken menu" }),
  ).not.toBeInTheDocument();
});

it("allows an unadorned source heading without a placeholder icon", async () => {
  const h = fixture();
  await h.register({ icon: null, component: Body });
  mount(h);
  expect(screen.getByRole("button", { name: "Owned" })).toBeVisible();
});

it.each(["footer", "row"] as const)(
  "collapsing workers restores focus to a %s disclosure without selecting the destination",
  async (placement) => {
    const h = fixture();
    function Tree({ ui }: SoloRegionProps) {
      const [expanded, setExpanded] = useState(true);
      const disclosure = (
        <ui.Disclosure
          label={`${expanded ? "Hide" : "Show"} 1 worker`}
          summary={placement === "footer" ? "1 waiting" : ""}
          expanded={expanded}
          controls="owned-workers"
          onToggle={() => setExpanded(!expanded)}
        />
      );
      return (
        <Row
          ui={ui}
          channelId="owned"
          {...(placement === "footer"
            ? { footer: disclosure }
            : { before: disclosure })}
        >
          <div id="owned-workers">
            {expanded ? <Row ui={ui} channelId="shared" /> : undefined}
          </div>
        </Row>
      );
    }
    await h.register({ component: Tree });
    const target: OpenTarget = {
      version: 1,
      kind: "conversation",
      channelId: "owned",
      scope: {
        communityOrigin: "https://fixture.invalid",
        viewer: h.session.viewer ?? "",
      },
    };
    await h.navigate(target);
    const view = mount(h, target);
    const worker = screen.getByRole("button", { name: /^Shared/ });
    worker.focus();
    const control = screen.getByRole("button", { name: /^Hide 1 worker/ });
    const primary = screen.getByRole("button", { name: "Owned" });
    expect(primary).not.toContainElement(control);
    expect(
      document.getElementById(control.getAttribute("aria-controls") ?? ""),
    ).toContainElement(worker);
    // WKWebView does not focus a button on a pointer click.
    fireEvent.click(control);
    await waitFor(() => expect(control).toHaveFocus());
    expect(
      screen.queryByRole("button", { name: /^Shared/ }),
    ).not.toBeInTheDocument();
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(view.open).not.toHaveBeenCalled();
    await userEvent.setup().keyboard("{Enter}");
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Shared/ })).toBeVisible();
    expect(view.open).not.toHaveBeenCalled();
    fireEvent.click(primary);
    expect(view.open).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "owned" }),
    );
  },
);

it("opens the conversation from a secondary link without its focus identity, current state or rename", async () => {
  const h = fixture();
  await h.register({
    component: ({ ui }) => (
      <Row ui={ui} channelId="owned" secondary="1 hidden" />
    ),
  });
  const view = mount(h, {
    version: 1,
    kind: "conversation",
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  });
  const primary = screen.getByRole("button", { name: "Owned" });
  const secondary = screen.getByRole("button", {
    name: "Open Owned: 1 hidden",
  });
  expect(primary).toHaveAttribute("aria-current", "page");
  expect(primary).toHaveAttribute("data-solo-destination-id", "owned");
  expect(secondary).not.toHaveAttribute("aria-current");
  expect(secondary).not.toHaveAttribute("data-solo-destination-id");
  fireEvent.doubleClick(secondary);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(secondary);
  expect(view.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "owned" }),
  );
});

it("passes the authorized name, preview and selection to the source and honors a rename opt-out", async () => {
  const h = fixture();
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) => ({ ...channel, preview: "A recent message" })),
  );
  const seen: {
    name: string;
    preview?: string | undefined;
    selected: boolean;
  }[] = [];
  await h.register({
    component: ({ ui }) => (
      <>
        <ui.Conversation channelId="owned">
          {(c) => {
            seen.push({
              name: c.name,
              preview: c.preview,
              selected: c.selected,
            });
            return <c.Link label="Project title" rename={false} />;
          }}
        </ui.Conversation>
        <ui.Conversation channelId="chat">
          {() => {
            throw new Error("An unowned conversation must not render.");
          }}
        </ui.Conversation>
      </>
    ),
  });
  mount(h, {
    version: 1,
    kind: "conversation",
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  });
  expect(seen.at(-1)).toEqual({
    name: "Owned",
    preview: "A recent message",
    selected: true,
  });
  fireEvent.doubleClick(screen.getByRole("button", { name: "Project title" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("lets the source place resting content and the overflow menu", async () => {
  const h = fixture();
  await h.register({
    component: ({ ui }) => (
      <Row
        ui={ui}
        channelId="owned"
        rest={<span role="img" aria-label="Waiting" />}
      />
    ),
  });
  mount(h);
  const status = screen.getByRole("img", { name: "Waiting" });
  const action = screen.getByRole("button", { name: "Actions for Owned" });
  expect(status.parentElement?.parentElement).toBe(action.parentElement);
  expect(screen.getByRole("button", { name: "Owned" })).not.toContainElement(
    action,
  );
  expect(status.parentElement).toHaveClass(destinationStyles.rest ?? "rest");
});

it("withholds every chat menu for a cached conversation", async () => {
  const h = fixture();
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) =>
        channel.id === "owned" ? { ...channel, cached: true } : channel,
      ),
  );
  await h.register({ component: Body });
  mount(h);
  const row = screen.getByRole("button", { name: "Owned" });
  expect(
    screen.queryByRole("button", { name: "Actions for Owned" }),
  ).not.toBeInTheDocument();
  fireEvent.contextMenu(row);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it.each(["priority", "activity"] as const)(
  "the Unread part carries %s evidence inside the source's link",
  async (indicator) => {
    const h = fixture();
    const unread = {
      ...h.session.unread.snapshot({ kind: "channel", channelId: "shared" }),
      manual: "none" as const,
      observedCount: 1,
      attentionCount: 1,
    };
    const activity = {
      ...h.session.unread.activity("shared"),
      items:
        indicator === "activity"
          ? [
              {
                channelId: "shared",
                rootId: "thread",
                latestMessageId: "reply",
                authorId: "agent",
                createdAt: 1,
                preview: "Needs review",
                unreadCount: 1,
              },
            ]
          : [],
    };
    Object.assign(h.session, {
      unread: {
        ...h.session.unread,
        snapshot: () => unread,
        activity: () => activity,
      },
    });
    await h.register({
      component: ({ ui }) => <Row ui={ui} channelId="shared" />,
    });
    mount(h);
    const row = screen.getByRole("button", { name: /^Shared/ });
    expect(row).toContainElement(
      screen.getByRole("img", { name: /^1 observed unread messages/ }),
    );
    const dot = row.querySelector(`[data-channel-${indicator}]`);
    expect(dot).toBeInTheDocument();
    if (indicator === "priority")
      expect(dot).toHaveAttribute("aria-hidden", "true");
    else expect(screen.getByRole("img", { name: "1 unread thread" })).toBe(dot);
  },
);

it.each(["before", "after"] as const)(
  "restores the primary destination after closing its menu with a disclosure %s it",
  async (placement) => {
    const h = fixture();
    await h.register({
      component: ({ ui }) => (
        <Row
          ui={ui}
          channelId="owned"
          {...{
            [placement]: (
              <ui.Disclosure
                label="Show tasks"
                summary=""
                expanded={false}
                controls="owned-tasks"
                onToggle={() => {}}
              />
            ),
          }}
        />
      ),
    });
    mount(h);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Owned" }));
    const popup = await screen.findByRole("menu");
    await waitFor(() =>
      expect(popup).toContainElement(document.activeElement as HTMLElement),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Owned",
        }),
      ).toHaveFocus(),
    );
  },
);

it("hands a header menu action the durable trigger as its dialog origin", async () => {
  const h = fixture();
  let origin: Element | null = null;
  const selected = vi.fn(() => {
    origin = document.activeElement;
  });
  await h.register({
    component: Body,
    actions: () => [
      {
        id: "create",
        label: "Create",
        icon: "plus",
        onSelect() {},
        menu: () => [
          {
            id: "container",
            label: "New container…",
            onSelect: selected,
          },
        ],
      },
    ],
  });
  mount(h);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Create" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "New container…" }),
  );
  await waitFor(() => expect(origin).toBe(trigger));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(selected).toHaveBeenCalledOnce();
  await user.click(trigger);
  await waitFor(() =>
    expect(screen.getByRole("menu")).toContainElement(
      document.activeElement as HTMLElement,
    ),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(selected).toHaveBeenCalledOnce();
});
