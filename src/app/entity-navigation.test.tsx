// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import {
  parseOpenTarget,
  type OpenTarget,
} from "../features/navigation/targets";
import { bindDeepLinks } from "../features/navigation/deep-links";
import { matchesEvent } from "../features/relay/projection";
import type { ReadFilter } from "../features/relay/events";

vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
    {
      manifest: { id: "buzz.repos", name: "Projects", apiVersion: 1 },
      module: await import("../bundled/repos"),
    },
    {
      manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
      module: await import("../bundled/agents"),
    },
    {
      manifest: { id: "buzz.inbox", name: "Inbox", apiVersion: 1 },
      module: await import("../bundled/inbox"),
    },
    {
      manifest: { id: "buzz.bestie", name: "Bestie", apiVersion: 1 },
      module: await import("../bundled/bestie"),
    },
    {
      // A vended page without the primary flag: listed in search, no sidebar row.
      manifest: { id: "fixture.notes", name: "Notes", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: import("@deepseek-ai/cordis").Context) {
          ctx.pages.register({
            id: "notes",
            title: "Fixture notes",
            component: () => null,
          });
        },
      },
    },
  ],
}));
const key = new Uint8Array(32).fill(6),
  viewer = getPublicKey(key),
  origin = "https://community.example";
const project = finalizeEvent(
  {
    kind: 30617,
    created_at: 1,
    content: "",
    tags: [
      ["d", "project"],
      ["name", "Recovered project"],
      ["description", "Actual recovered destination"],
    ],
  },
  key,
);
// jsdom has no media queries; responsive geometry is covered in browser tests.
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
let stop = () => {};
afterEach(async () => {
  cleanup();
  stop();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
it("keeps an OS entity intent through real community selection and Retry in App", async () => {
  // jsdom has no layout observer; App now keeps its real sidebar mounted here.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: null,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        return Response.json(
          [project].filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  const queue = [`buzz://repo?owner=${viewer}&d=project`];
  let ping = () => {};
  stop = bindDeepLinks(current.navigationHost, current.communities, {
    take: async () => queue.splice(0),
    watch(listener) {
      ping = listener;
      return () => {};
    },
  });
  render(<App services={current} />);
  await screen.findByRole("button", { name: "Retry navigation" });
  expect(current.navigation.snapshot()).toMatchObject({
    ingress: true,
    retryable: true,
  });
  await userEvent.click(
    screen.getByRole("button", { name: /^Community switcher:/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Switch to Fixture community" }),
  );
  expect(current.navigation.snapshot().ingress).toBe(true);
  await waitFor(() => expect(current.relay.snapshot().status).toBe("ready"));
  await userEvent.click(
    screen.getByRole("button", { name: "Retry navigation" }),
  );
  await screen.findByText("Actual recovered destination");
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: {
      target: {
        kind: "page",
        pluginId: "buzz.repos",
        route: { params: { type: "repo", dtag: "project" } },
      },
    },
  });
  await act(async () => {
    queue.push("buzz://unsupported");
    ping();
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "invalid or unsupported",
  );
  expect(
    screen.queryByRole("button", { name: "Retry navigation" }),
  ).not.toBeInTheDocument();
});

it("lists active primary pages in their sidebar and header placements", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom lacks scrollIntoView; the search palette scrolls its selection.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  // Personal space with a saved community, not the first-run join screen.
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: null,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  render(<App services={current} />);
  const pages = await screen.findByRole("navigation", { name: "Pages" });
  await waitFor(() =>
    expect(
      within(pages)
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual(["Inbox", "Watching", "Bestie"]),
  );

  expect(
    screen.queryByRole("tab", { name: "Repository" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument();

  expect(
    screen.queryByRole("tab", { name: "Watching" }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(pages).getByRole("button", { name: "Watching" }),
  );
  expect(
    await screen.findByRole("region", {
      name: "What your agents are watching",
    }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New watch" })).toBeNull();

  // The fixture page is active and searchable but never a sidebar row.
  expect(current.pages.snapshot().map((page) => page.key)).toContain(
    "fixture.notes/notes",
  );

  await act(() => current.plugins.change("disable", "buzz.agents"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("navigation", { name: "Pages" }))
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual(["Inbox", "Bestie"]),
  );

  expect(screen.queryByRole("tab", { name: "Agents" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Search Buzz" }));
  const search = await screen.findByRole("dialog", { name: "Search Buzz" });
  expect(
    within(search).queryByRole("option", { name: "Fixture notes" }),
  ).not.toBeInTheDocument();
  await userEvent.type(
    within(search).getByRole("combobox", { name: "Search Buzz" }),
    "Fixture notes",
  );
  expect(
    within(search).getByRole("option", { name: "Fixture notes" }),
  ).toBeInTheDocument();
  expect(
    within(search).queryByRole("option", { name: "Agents" }),
  ).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  // Every primary page is optional; with none active the landmark goes too.
  for (const id of ["buzz.inbox", "buzz.bestie", "buzz.repos"])
    await act(() => current.plugins.change("disable", id));
  await waitFor(() =>
    expect(
      screen.queryByRole("navigation", { name: "Pages" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("complementary", { name: "Sidebar" }),
  ).toBeInTheDocument();
});

function legacyPageFixture(
  memberships = [{ id: origin, name: "Fixture community" }],
  selected = origin,
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships,
      selected,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return current;
}

it.each(
  ["Inbox", "Bestie"].flatMap((name) => [
    { name, scope: undefined },
    { name, scope: null },
    { name, scope: { viewer, communityOrigin: origin } },
  ]),
)(
  "normalizes old $name links in the same visit and caller, retaining $scope scope",
  async ({ name, scope }) => {
    const current = legacyPageFixture();
    await screen.findByRole("navigation", { name: "Pages" });
    const pageId = name.toLowerCase();

    act(() => {
      void current.navigation.open({
        version: 1,
        kind: "settings",
        section: "appearance",
      });
    });
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("opened"),
    );
    const previous = current.navigation.snapshot().entry.id;
    const old: OpenTarget = {
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      route: { version: 1, params: name },
      ...(scope !== undefined ? { scope } : {}),
    };
    const bound = parseOpenTarget(old);
    let visit = "";
    let result!: ReturnType<typeof current.navigation.open>;
    act(() => {
      result = current.navigation.open(bound);
      visit = current.navigation.snapshot().entry.id;
    });
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("opened"),
    );
    expect(await result).toEqual({ status: "opened" });
    expect(current.navigation.snapshot().entry).toEqual({
      id: visit,
      target: {
        version: 1,
        kind: "page",
        pluginId: `buzz.${pageId}`,
        pageId,
        ...(scope !== undefined ? { scope } : {}),
      },
    });
    expect(current.communities.snapshot().selected).toBe(
      scope === null ? null : origin,
    );
    act(() => current.navigation.back());
    await waitFor(() =>
      expect(current.navigation.snapshot().entry.id).toBe(previous),
    );
    act(() => current.navigation.forward());
    await waitFor(() => {
      expect(current.navigation.snapshot().entry.id).toBe(visit);
      expect(current.navigation.snapshot().status).toBe("opened");
    });
  },
);

// Reminder notifications without an openable message send a page target scoped
// to the reminder's community; it must win over the community selected at click.
it("opens a community-scoped page from another community, but not after leaving it", async () => {
  const other = "https://other.example";
  const target = parseOpenTarget({
    version: 1,
    kind: "page",
    pluginId: "fixture.notes",
    pageId: "notes",
    scope: { viewer, communityOrigin: origin },
  });
  const member = legacyPageFixture(
    [
      { id: origin, name: "Fixture community" },
      { id: other, name: "Other community" },
    ],
    other,
  );
  await screen.findByRole("navigation", { name: "Pages" });
  let result!: ReturnType<typeof member.navigation.open>;
  act(() => {
    result = member.navigation.open(target);
  });
  expect(await result).toEqual({ status: "opened" });
  expect(member.communities.snapshot().selected).toBe(origin);
  expect(member.navigation.snapshot().entry.target).toEqual(target);
  cleanup();
  await services?.dispose();
  localStorage.clear();

  const left = legacyPageFixture(
    [{ id: other, name: "Other community" }],
    other,
  );
  await screen.findByRole("navigation", { name: "Pages" });
  act(() => {
    result = left.navigation.open(target);
  });
  expect(await result).toEqual({ status: "failed", reason: "denied" });
  expect(left.communities.snapshot().selected).toBe(other);
});

it("restores legacy placeholder history but does not normalize unknown versions or bypass access and plugin gates", async () => {
  const old: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    route: { version: 1, params: "Inbox" },
  };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(old))}`,
  );
  const current = legacyPageFixture();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(current.navigation.snapshot().entry.target).toMatchObject({
    pluginId: "buzz.inbox",
    pageId: "inbox",
  });
  for (const target of [
    { ...old, route: { version: 2, params: "Inbox" } },
    { ...old, route: { version: 1, params: "Unknown" } },
    { ...old, scope: { viewer: "ab".repeat(32), communityOrigin: origin } },
  ]) {
    let result!: ReturnType<typeof current.navigation.open>;
    act(() => {
      result = current.navigation.open(target);
    });
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("failed"),
    );
    expect(await result).toMatchObject({ status: "failed" });
  }
  await act(() => current.plugins.change("disable", "buzz.inbox"));
  let result!: ReturnType<typeof current.navigation.open>;
  act(() => {
    result = current.navigation.open(old);
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("failed"),
  );
  expect(await result).toEqual({ status: "failed", reason: "unavailable" });
});

it("cold Settings Close uses required Messages when Inbox is disabled", async () => {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "settings",
        section: "appearance",
      }),
    )}`,
  );
  const current = legacyPageFixture();
  const back = await screen.findByRole("button", { name: "Close Settings" });
  await act(() => current.plugins.change("disable", "buzz.inbox"));
  expect(
    current.pages.snapshot().some((page) => page.key === "buzz.inbox/inbox"),
  ).toBe(false);
  await userEvent.click(back);
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: {
        target: { kind: "page", pluginId: "buzz.channels", pageId: "channels" },
      },
    }),
  );
  expect(
    screen.queryByText("This destination couldn’t open"),
  ).not.toBeInTheDocument();
});

it("Close returns to the immediately preceding failed destination, not an older retained workspace", async () => {
  const current = legacyPageFixture();
  await screen.findByRole("navigation", { name: "Pages" });
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "fixture.notes",
      pageId: "notes",
    });
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  const failed: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "fixture.missing",
    pageId: "missing",
  };
  await act(async () => {
    void current.navigation.open(failed);
  });
  await screen.findByText("This destination couldn’t open");
  const visit = current.navigation.snapshot().entry.id;
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(current.navigation.snapshot().entry).toEqual({
      id: visit,
      target: failed,
    }),
  );
});
