import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import {
  BellIcon,
  BrowserIcon,
  ChatsCircleIcon,
  EyeIcon,
  RobotIcon,
} from "../../shared/design-system/icons/index";
import {
  headerPageSelection,
  pagePlacement,
  orderPages,
  pagePresentation,
} from "./presentation";

function page(key: string, title: string, icon?: string): RegisteredPage {
  const separator = key.indexOf("/");
  const pluginId = key.slice(0, separator);
  const id = key.slice(separator + 1);
  return {
    key,
    pluginId,
    id,
    title,
    revision: "bundled",
    component: () => null,
    ...(icon === undefined ? {} : { icon }),
  };
}

const messages = page("buzz.channels/channels", "Channels");
const inbox = page("buzz.inbox/inbox", "Inbox");
const bestie = page("buzz.bestie/bestie", "Bestie");
const projects = page("fixture.projects/projects", "Projects");
const attention = page("buzz.agents/attention", "Watching");

test("bundled page order ignores activation order without mutating the registry", () => {
  const input = Object.freeze([attention, projects, bestie, messages, inbox]);
  expect(orderPages(input)).toEqual([
    messages,
    inbox,
    attention,
    bestie,
    projects,
  ]);
  expect(input).toEqual([attention, projects, bestie, messages, inbox]);
  expect(orderPages([messages, projects])).toEqual([messages, projects]);
  expect(orderPages([projects])).toEqual([projects]);
  expect(orderPages([])).toEqual([]);
});

test("other pages sort by label then full key and cannot claim bundled slots", () => {
  const alpha = page("example.alpha/page", "Alpha");
  const alpha2 = page("example.other/page", "Alpha");
  const foreignInbox = page("example.mail/inbox", "Inbox");
  const sameId = page("example.custom/projects", "Projects");
  const zulu = page("example.zulu/page", "Zulu");
  const expected = [
    messages,
    inbox,
    bestie,
    alpha,
    alpha2,
    foreignInbox,
    sameId,
    projects,
    zulu,
  ];
  expect(orderPages([...expected].reverse())).toEqual(expected);
  expect(
    orderPages([
      sameId,
      projects,
      alpha2,
      bestie,
      zulu,
      foreignInbox,
      messages,
      inbox,
      alpha,
    ]),
  ).toEqual(expected);
});

test("bundled pages get their own icons and Bestie's row shows its artwork", () => {
  expect(pagePresentation(inbox).icon).toBe(BellIcon);
  expect(pagePresentation(attention).icon).toBe(EyeIcon);
  expect(pagePresentation(page("buzz.agents/agents", "Agents")).icon).toBe(
    RobotIcon,
  );
  expect(
    renderToStaticMarkup(
      createElement(pagePresentation(bestie).icon, { size: 15 }),
    ),
  ).toContain("/bestie.png");
  expect(pagePresentation(page("example.mail/inbox", "Inbox")).icon).toBe(
    BrowserIcon,
  );
});

describe("page mark precedence", () => {
  const owl = "data:image/svg+xml,%3Csvg%20id%3D%22owl%22%3E%3C%2Fsvg%3E";
  const fox = "data:image/png;base64,iVBORfox";

  test.each([
    [
      "an external page with an icon gets its image beside BrowserIcon",
      page("example.plugin/main", "Example", owl),
      { label: "Example", icon: BrowserIcon, image: owl },
    ],
    [
      "an external page without an icon gets no image key",
      page("example.plugin/main", "Example"),
      { label: "Example", icon: BrowserIcon },
    ],
    [
      "bundled Inbox keeps BellIcon and ignores a declared icon",
      page("buzz.inbox/inbox", "Inbox", owl),
      { label: "Inbox", icon: BellIcon },
    ],
    [
      "bundled channels stays Messages and ignores a declared icon",
      page("buzz.channels/channels", "Channels", owl),
      { label: "Messages", icon: ChatsCircleIcon },
    ],
    [
      "an external page with local id channels keeps its own title and image",
      page("example.chat/channels", "Chat", owl),
      { label: "Chat", icon: BrowserIcon, image: owl },
    ],
  ] as const)("%s", (_name, input, mark) => {
    const { tone: _tone, ...actual } = pagePresentation(input);
    expect(actual).toStrictEqual(mark);
  });

  test("two plugins with local id main each get their own image", () => {
    const one = pagePresentation(page("example.one/main", "One", owl));
    const two = pagePresentation(page("example.two/main", "Two", fox));
    expect(one).toHaveProperty("image", owl);
    expect(two).toHaveProperty("image", fox);
  });
});

describe("header area selection", () => {
  const entries: RegisteredPage[] = [
    { ...messages, primary: true, placement: "topbar" },
    inbox,
    {
      ...page("buzz.reminders/reminders", "Reminders"),
      primary: true,
      placement: "sidebar",
    },
    { ...page("buzz.agents/agents", "Agents"), primary: true },
    { ...page("buzz.workflows/workflows", "Workflows"), primary: true },
    page("example.sidebar/me", "External sidebar"),
    {
      ...page("example.header/main", "External header"),
      primary: true,
      placement: "topbar",
    },
    {
      ...page("example.tools/main", "External toolbar"),
      primary: true,
      placement: "toolbar",
    },
    {
      ...page("example.linked/main", "External linked"),
      primary: false,
      placement: "toolbar",
    },
  ];
  test.each([
    ["buzz.channels/channels", "buzz.channels/channels"],
    ["buzz.inbox/inbox", "buzz.channels/channels"],
    ["buzz.reminders/reminders", "buzz.reminders/reminders"],
    ["buzz.agents/agents", "buzz.agents/agents"],
    ["buzz.workflows/workflows", "buzz.workflows/workflows"],
    ["example.sidebar/me", "buzz.channels/channels"],
    ["settings", "settings"],
    ["example.header/main", "example.header/main"],
    ["example.tools/main", "example.tools/main"],
    ["example.linked/main", "buzz.channels/channels"],
    ["missing/page", "missing/page"],
  ])("%s selects %s without changing the destination", (selected, expected) => {
    expect(headerPageSelection(entries, selected)).toBe(expected);
  });
  test("never borrows an absent or non-primary Messages entry", () => {
    const others = entries.filter((entry) => entry.key !== messages.key);
    for (const registered of [
      others,
      [...others, { ...messages, placement: "topbar" as const }],
    ]) {
      expect(headerPageSelection(registered, inbox.key)).toBe(inbox.key);
    }
  });
});

test.each([undefined, "toolbar"] as const)(
  "uses effective Messages placement for rendering and area selection (registered %s)",
  (placement) => {
    const registered = {
      ...messages,
      primary: true,
      ...(placement ? { placement } : {}),
    };
    expect(pagePlacement(registered)).toBe("topbar");
    expect(headerPageSelection([registered, inbox], inbox.key)).toBe(
      messages.key,
    );
  },
);
