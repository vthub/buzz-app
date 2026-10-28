// @vitest-environment jsdom
import * as React from "react";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "../../../plugins/author";
import { createPage, describe } from "./Page";

afterEach(cleanup);
const viewer = "f".repeat(64);
const origin = "https://example.com";
const scope = `${origin}:${viewer}`;
const community = { origin, viewer, scope };
const channel = "11111111-1111-1111-1111-111111111111";
it("keeps listening channels distinct from destinations and respects rearmed timer usage", () => {
  expect(
    describe(
      {
        type: "timer",
        interest_id: "once",
        enabled: true,
        prompt: "Check",
        armed_at: 100,
        interval_secs: 60,
        max_occurrences: 1,
        expires_at: null,
      },
      110,
    ).title,
  ).toMatch(/^Once · /);
  expect(
    describe(
      {
        type: "timer",
        interest_id: "task",
        enabled: true,
        prompt: "Check",
        armed_at: 100,
        interval_secs: 60,
        max_occurrences: 2,
        expires_at: null,
      },
      110,
      2,
    ).spent,
  ).toBe(true);
});
it("hides agents without subscriptions, reacts to changes and surfaces save errors", async () => {
  let changed = () => {};
  const enabled = true;
  const record = () => ({
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: enabled,
    attentionHistory: {
      "watch/check": {
        lastWokeAt: Math.floor(Date.now() / 1000) - 180,
        output: "build succeeded",
      },
    },
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Keep releases moving." },
      },
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          interest_id: "task",
          enabled: false,
          provider: "attention/command",
          channel,
          config: { command: ["check"] },
        },
      },
    },
  });
  let snapshot = {
    status: "ready",
    running: [
      record(),
      {
        ...record(),
        name: "Bo",
        key: "membership-b",
        pubkey: "b",
        owner: viewer,
        relay: "wss://example.com",
        attention: {},
      },
    ],
  };
  const disconnected = { status: "disconnected", ...community };
  const save = vi.fn(async () => {
    throw new Error("Save failed");
  });
  const ctx = {
    react: React,
    agents: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
      save,
    },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  const Page = createPage(ctx);
  render(React.createElement(Page));
  expect(screen.queryByRole("region", { name: "Bo" })).toBeNull();
  const ada = screen.getByRole("region", { name: "Ada" });
  expect(within(ada).getByRole("heading", { name: "task" })).toBeTruthy();
  expect(within(ada).getByText("1 interest · 1 watch")).toBeTruthy();
  fireEvent.click(
    within(ada).getByRole("button", { name: "Details for task" }),
  );
  expect(within(ada).getByText("Last woke 3 minutes ago")).toBeTruthy();
  expect(within(ada).getByText("build succeeded")).toBeTruthy();
  expect(within(ada).getByRole("heading", { name: "Command" })).toBeTruthy();
  expect(ada.querySelector(".attention-details code")?.textContent).toBe(
    "check",
  );
  expect(
    ada.querySelector(
      ".attention-instructions summary .attention-instructions-preview",
    ),
  ).not.toBeNull();
  expect(
    ada.querySelector(".attention-instructions-preview")?.textContent,
  ).toBe("Keep releases moving.");
  expect(
    ada.querySelector("details.attention-instructions")?.hasAttribute("open"),
  ).toBe(false);
  expect(
    within(screen.getByRole("region", { name: "Interest task" })).getByRole(
      "switch",
      { name: "Watch task" },
    ),
  ).toBeTruthy();
  expect(within(ada).getByText("Paused")).toBeTruthy();
  expect(
    within(ada).getByRole("switch", {
      name: "Watching for Ada on this device",
    }),
  ).toBeTruthy();
  fireEvent.click(within(ada).getByRole("switch", { name: "Watch task" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Save failed"),
  );
  expect(save).toHaveBeenCalledWith("membership-a", {
    watchEnabled: {
      "watch/check": {
        enabled: true,
        expected: record().attention["watch/check"],
      },
    },
  });
  await act(async () => {
    snapshot = {
      ...snapshot,
      running: [{ ...record(), attentionEnabled: false }],
    };
    changed();
  });
  expect(within(ada).getByText("Watching paused on this device")).toBeTruthy();
  const toggle = within(ada).getByRole("switch", {
    name: "Watching for Ada on this device",
  });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith("membership-a", {
      attentionEnabled: true,
    }),
  );
  expect(within(ada).getByRole("heading", { name: "task" })).toBeTruthy();
});

it.each(["source", "event", "timer"] as const)(
  "toggles and deletes only the selected %s subscription",
  async (type) => {
    let changed = () => {};
    const watch =
      type === "source"
        ? {
            type,
            provider: "attention/command",
            config: { command: ["check"] },
          }
        : type === "event"
          ? { type, channels: ["listen"] }
          : {
              type,
              prompt: "Check the release",
              interval_secs: 60,
              armed_at: 100,
              max_occurrences: null,
              expires_at: null,
            };
    const value = { ...watch, enabled: true, interest_id: "release", channel };
    let agent = {
      key: "membership-a",
      pubkey: "a",
      owner: viewer,
      relay: "wss://example.com",
      name: "Ada",
      attentionEnabled: true,
      timers: {},
      attention: {
        "interest/release": {
          slug: "interest/release",
          modifiedAt: 1,
          value: { type: "interest", instructions: "Keep releases moving." },
        },
        "watch/check": { slug: "watch/check", modifiedAt: 1, value },
      },
    };
    let snapshot = { status: "ready", running: [agent] };
    let finishSave = () => {};
    const saving = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    let rejectInterest = true;
    const save = vi.fn(
      async (
        _key: string,
        patch: {
          attention?: Record<string, unknown>;
          watchEnabled?: Record<
            string,
            { enabled: boolean; expected: unknown }
          >;
        },
      ) => {
        if (patch.attention?.["interest/release"] === null && rejectInterest)
          throw new Error("Interest save failed");
        const attention = { ...agent.attention } as Record<string, unknown>;
        for (const [slug, value] of Object.entries(patch.attention ?? {})) {
          if (value === null) delete attention[slug];
          else attention[slug] = { slug, modifiedAt: 2, value };
        }
        for (const [slug, target] of Object.entries(patch.watchEnabled ?? {})) {
          attention[slug] = {
            slug,
            modifiedAt: 2,
            value: { ...value, enabled: target.enabled },
          };
        }
        agent = { ...agent, attention: attention as typeof agent.attention };
        snapshot = { ...snapshot, running: [agent] };
        changed();
        await saving;
      },
    );
    const disconnected = { status: "disconnected", ...community };
    const ctx = {
      react: React,
      agents: {
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          changed = listener;
          return () => {};
        },
        save,
      },
      relay: { snapshot: () => disconnected, subscribe: () => () => {} },
    } as unknown as Context;
    render(React.createElement(createPage(ctx)));
    expect(
      screen
        .getByRole("button", { name: "Delete Interest release" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Watch release" }));
    const remove = screen.getByRole("button", { name: "Delete release" });
    try {
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", { name: "Watch release" })
            .getAttribute("aria-checked"),
        ).toBe("false"),
      );
      expect(save).toHaveBeenLastCalledWith("membership-a", {
        watchEnabled: {
          "watch/check": {
            enabled: false,
            expected: { slug: "watch/check", modifiedAt: 1, value },
          },
        },
      });
      expect(remove.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(remove);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => finishSave());
    }
    await waitFor(() =>
      expect(remove.getAttribute("aria-disabled")).not.toBe("true"),
    );
    if (type === "timer") {
      expect(
        screen
          .getByRole("switch", { name: "Watch release" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        screen.getByText("Ask Ada to set this timer’s next run."),
      ).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Delete release" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("switch", { name: "Watch release" }),
      ).toBeNull(),
    );
    expect(save).toHaveBeenLastCalledWith("membership-a", {
      attention: { "watch/check": null },
    });
    expect(agent.attention["interest/release"]).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Interest release" }),
    ).toBeTruthy();
    const removeInterest = screen.getByRole("button", {
      name: "Delete Interest release",
    });
    fireEvent.click(removeInterest);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Interest save failed",
      ),
    );
    expect(agent.attention["interest/release"]).toBeTruthy();
    rejectInterest = false;
    fireEvent.click(removeInterest);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Ada" })).toBeNull(),
    );
    expect(save).toHaveBeenLastCalledWith("membership-a", {
      attention: { "interest/release": null },
    });
  },
);

it("keeps subscription controls disabled while saving and preserves the row on failure", async () => {
  const record = {
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Check builds" },
      },
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          name: "Build",
          interest_id: "task",
          enabled: true,
          provider: "attention/command",
          config: { command: ["check"] },
        },
      },
    },
  };
  const snapshot = { status: "ready", running: [record] };
  const disconnected = { status: "disconnected", ...community };
  let reject!: (reason: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const save = vi.fn(() => held);
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  const toggle = screen.getByRole("switch", {
    name: "Watch Build",
  }) as HTMLButtonElement;
  const remove = screen.getByRole("button", {
    name: "Delete Build",
  }) as HTMLButtonElement;
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-disabled")).toBe("true"),
  );
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(remove);
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Could not save")));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Could not save"),
  );
  expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
  expect(remove.getAttribute("aria-disabled")).not.toBe("true");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(save).toHaveBeenCalledTimes(1);
});

it("resolves agent avatars through relay media, updates pictures and falls back on failure", async () => {
  let changed = () => {};
  let agent = {
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    picture: "https://example.com/avatar.png",
    attentionEnabled: true,
    timers: {},
    attention: {
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          interest_id: "task",
          enabled: true,
          provider: "attention/command",
          config: { command: ["check"] },
        },
      },
    },
  };
  let snapshot = { status: "ready", running: [agent] };
  const media = vi.fn(
    (picture: string) => `https://media.example/${encodeURIComponent(picture)}`,
  );
  const connection = { status: "ready", ...community, session: { media } };
  const ctx = {
    react: React,
    agents: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  const { container } = render(React.createElement(createPage(ctx)));
  expect(media).toHaveBeenCalledWith("https://example.com/avatar.png", "small");
  const image = container.querySelector("img") as HTMLImageElement;
  expect(image.src).toBe(
    "https://media.example/https%3A%2F%2Fexample.com%2Favatar.png",
  );
  fireEvent.load(image);
  expect(image.getAttribute("data-loaded")).toBe("true");
  expect(container.querySelector(".buzz-avatar")?.textContent).toBe("");
  const picture = "data:image/png;base64,AA==";
  await act(async () => {
    agent = { ...agent, picture };
    snapshot = { ...snapshot, running: [agent] };
    changed();
  });
  const replacement = container.querySelector("img") as HTMLImageElement;
  expect(replacement.src).toBe(picture);
  expect(replacement.getAttribute("data-loaded")).toBeNull();
  fireEvent.error(replacement);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".buzz-avatar")?.textContent).toBe("A");
});

it("enables a chosen empty agent without creating subscriptions and reports failures", async () => {
  const snapshot = {
    status: "ready",
    running: [
      {
        key: "membership-b",
        pubkey: "b",
        owner: viewer,
        relay: "wss://example.com",
        name: "Bo",
        attentionEnabled: false,
        timers: {},
        attention: {},
      },
    ],
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Enable failed"))
    .mockResolvedValueOnce(undefined);
  const disconnected = { status: "disconnected", ...community };
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  expect(screen.queryByRole("region", { name: "Bo" })).toBeNull();
  expect(screen.getByText(/Agents can ask to be woken later/)).toBeTruthy();
  expect(
    screen.getByText("Watches only run while Buzz is open on this device."),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Suggested asks" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "\u201cWatch this thread for new messages\u201d",
    "\u201cWatch my PR and tell me when CI finishes or someone reviews it\u201d",
    "\u201cCheck this channel every morning at 9\u201d",
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "Turn on watching on this device" }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Turn on watching",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Agent" }));
  await user.click(await screen.findByRole("option", { name: "Bo" }));
  fireEvent.click(screen.getByRole("button", { name: "Turn on watching" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Enable failed"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn on watching" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Watching turned on for Bo",
    ),
  );
  expect(save).toHaveBeenLastCalledWith("membership-b", {
    attentionEnabled: true,
  });
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.queryByRole("region", { name: "Bo" })).toBeNull();
});

it.each([undefined, "missing"])(
  "shows an orphan watch as a repair state when its Interest is %s",
  (interest_id) => {
    const save = vi.fn();
    const snapshot = {
      status: "ready",
      running: [
        {
          key: "membership-a",
          pubkey: "a",
          owner: viewer,
          relay: "wss://example.com",
          name: "Ada",
          attentionEnabled: true,
          timers: {},
          attention: {
            "watch/check": {
              slug: "watch/check",
              modifiedAt: 1,
              value: {
                type: "source",
                interest_id,
                name: "Release check",
                enabled: false,
                prompt: "Report blockers",
                provider: "attention/command",
                config: { command: ["check"] },
              },
            },
          },
        },
      ],
    };
    const disconnected = { status: "disconnected", ...community };
    const ctx = {
      react: React,
      agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
      relay: { snapshot: () => disconnected, subscribe: () => () => {} },
    } as unknown as Context;
    render(React.createElement(createPage(ctx)));
    const repair = screen.getByRole("region", { name: "Stray watches" });
    expect(within(repair).getByText("watch/check")).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Watch Release check" }),
    ).toBeNull();
    expect(screen.queryByRole("region", { name: /^Interest / })).toBeNull();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(
      within(repair).getByRole("button", { name: "Delete watch/check" }),
    );
    expect(save).toHaveBeenCalledWith("membership-a", {
      attention: { "watch/check": null },
    });
  },
);

it("keeps unreadable legacy watches visible and removes only the selected object", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const snapshot = {
    status: "ready",
    running: [
      {
        key: "membership-a",
        pubkey: "a",
        owner: viewer,
        relay: "wss://example.com",
        name: "Ada",
        attentionEnabled: true,
        timers: {},
        attention: {},
        skipped: {
          "watch/old": {
            slug: "watch/old",
            problem: "Legacy filter needs repair",
          },
        },
      },
    ],
  };
  const disconnected = { status: "disconnected", ...community };
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  expect(screen.getByText("Legacy filter needs repair")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove unreadable watch/old" }),
  );
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith("membership-a", {
      attention: { "watch/old": null },
    }),
  );
});

it.each([false, true])(
  "scans subscription types and destinations with history accessible (completed: %s)",
  (completed) => {
    let snapshot = {
      classifier: "unavailable",
      status: "ready",
      running: [
        {
          key: "membership-a",
          pubkey: "a",
          owner: viewer,
          relay: "wss://example.com",
          name: "Ada",
          attentionEnabled: true,
          timers: {},
          sourceRuns: {} as Record<string, string>,
          attentionHistory: {
            "watch/pr": { output: "CI completed: all checks passed" },
            "watch/messages": {
              output: "2026-10-27T14:00:00Z · Alex\nThe release is ready.",
            },
          },
          attention: {
            "interest/release": {
              slug: "interest/release",
              modifiedAt: 1,
              value: { type: "interest", instructions: "Watch the release." },
            },
            "watch/pr": {
              slug: "watch/pr",
              modifiedAt: 1,
              value: {
                type: "source",
                name: "Release checks",
                interest_id: "release",
                enabled: true,
                provider: "attention/github-pr",
                config: { pr: "https://github.com/block/buzz-app/pull/1578" },
                channel,
              },
            },
            "watch/messages": {
              slug: "watch/messages",
              modifiedAt: 1,
              value: {
                type: "event",
                name: "Discussion",
                classifier: {
                  questions: { ready: { question: "Is the release ready?" } },
                },
                interest_id: "release",
                enabled: true,
                channels: ["listen"],
                channel: "listen",
              },
            },
          },
        },
      ],
    };
    if (completed)
      for (const agent of snapshot.running)
        agent.sourceRuns["watch/pr"] = JSON.stringify(
          agent.attention["watch/pr"],
        );
    const connection = {
      status: "ready",
      ...community,
      session: {
        channels: {
          ensureList() {},
          subscribeList: () => () => {},
          list: () => channels,
        },
        media: () => "",
      },
    };
    const channels = {
      channels: [
        { id: channel, name: "Berd-call", channelType: "solo" },
        { id: "listen", name: "buzz-github-prs", channelType: "stream" },
      ],
    };
    let changed = () => {};
    const ctx = {
      react: React,
      agents: {
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          changed = listener;
          return () => {};
        },
      },
      relay: { snapshot: () => connection, subscribe: () => () => {} },
    } as unknown as Context;
    render(React.createElement(createPage(ctx)));
    const icon = (name: string) =>
      screen
        .getByRole("button", { name: `Open destination ${name}` })
        .querySelector("path")
        ?.getAttribute("d");
    expect(
      screen.getByRole("button", { name: "Open destination Berd-call" })
        .textContent,
    ).toBe("Replies inBerd-call");
    expect(icon("Berd-call")).toBeTruthy();
    expect(icon("buzz-github-prs")).toBeTruthy();
    expect(icon("Berd-call")).not.toBe(icon("buzz-github-prs"));
    expect(screen.getByText("GitHub PR")).toBeTruthy();
    expect(screen.getByText("Messages")).toBeTruthy();
    expect(screen.getByText("buzz-app#1578")).toBeTruthy();
    expect(screen.queryByText("On")).toBeNull();
    expect(screen.queryByText("Shared instructions")).toBeNull();
    expect(screen.queryByText("Show raw")).toBeNull();
    expect(screen.queryByRole("button", { name: "New watch" })).toBeNull();
    const disclosure = screen.getByRole("button", {
      name: "Details for Release checks",
    });
    expect(disclosure.textContent).toContain("buzz-app#1578");
    expect(disclosure.classList.contains("attention-heading")).toBe(true);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Release checks" }),
    );
    expect(screen.getByRole("heading", { name: "Recent events" })).toBeTruthy();
    expect(screen.getByText("CI completed: all checks passed")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Discussion" }),
    );
    expect(screen.getByText(/The release is ready/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open buzz-app#1578" });
    expect(disclosure.contains(link)).toBe(false);
    expect(link.getAttribute("href")).toBe(
      "https://github.com/block/buzz-app/pull/1578",
    );
    expect(screen.queryByText("Show raw")).toBeNull();
    expect(screen.getByText(/can't run message filters/)).toBeTruthy();
    act(() => {
      snapshot = { ...snapshot, classifier: "available" };
      changed();
    });
    expect(screen.queryByText(/can't run message filters/)).toBeNull();
  },
);

it("keeps overview and destination navigation in the selected community", async () => {
  const watch = {
    type: "source",
    interest_id: "task",
    name: "Build",
    enabled: true,
    provider: "attention/command",
    config: { command: ["check"] },
    channel,
  };
  const agent = {
    key: "membership-a",
    pubkey: "a",
    owner: viewer,
    relay: "wss://example.com",
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Check builds" },
      },
      "watch/check": { slug: "watch/check", modifiedAt: 1, value: watch },
    },
  };
  let connection = {
    status: "ready",
    ...community,
    session: {
      channels: {
        ensureList() {},
        subscribeList: () => () => {},
        list: () => choices,
      },
      media: () => "",
    },
  };
  const choices = { channels: [{ id: channel, name: "Release planning" }] };
  let changed = () => {};
  const snapshot = {
    status: "ready",
    running: [
      agent,
      {
        ...agent,
        key: "membership-b",
        pubkey: "a",
        name: "Bo",
        relay: "wss://other.example",
      },
      {
        ...agent,
        key: "membership-c",
        pubkey: "c",
        name: "Cy",
        owner: "e".repeat(64),
      },
    ],
  };
  const open = vi.fn(),
    save = vi.fn();
  const ctx = {
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: {
      snapshot: () => connection,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
    navigation: { open },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  expect(screen.getByRole("region", { name: "Ada" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Bo" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Cy" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Open destination Release planning" }),
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: { communityOrigin: origin, viewer },
      channelId: channel,
    }),
  );
  await act(async () => {
    connection = {
      ...connection,
      origin: "https://other.example",
      scope: `https://other.example:${viewer}`,
    };
    changed();
  });
  expect(screen.queryByRole("region", { name: "Ada" })).toBeNull();
  expect(screen.getByRole("region", { name: "Bo" })).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("switch", { name: "Watching for Bo" })).toBeNull();
});

it("keeps technical data out of message summaries and avoids repeating the destination", () => {
  const author = "a".repeat(64);
  const id = "release-12345678-abcd-1234-abcd-123456789abc";
  const agent = {
    key: "membership-a",
    pubkey: author,
    owner: viewer,
    relay: origin,
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attentionHistory: {
      "watch/messages": {
        output: `2026-10-27T14:00:00.000Z · ${author}\nRelease is ready.`,
      },
    },
    attention: {
      [`interest/${id}`]: {
        slug: `interest/${id}`,
        value: { type: "interest", instructions: "Follow releases." },
      },
      "watch/messages": {
        slug: "watch/messages",
        value: {
          type: "event",
          name: "Release messages",
          enabled: true,
          interest_id: id,
          channels: [channel],
          channel,
          kinds: [9],
          since: 0,
        },
      },
    },
  };
  const list = { channels: [{ id: channel, name: "Releases" }] };
  const queries = {
    ensureList() {},
    subscribeList: () => () => {},
    list: () => list,
  };
  const snapshot = { status: "ready", running: [agent] };
  const connection = {
    status: "ready",
    ...community,
    session: { channels: queries },
  };
  const ctx = {
    agents: { snapshot: () => snapshot, subscribe: () => () => {} },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  expect(screen.getByRole("heading", { name: "release" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Open destination Releases" }),
  ).toBeTruthy();
  expect(screen.getAllByText("Releases")).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Details for Release messages" }),
  );
  expect(screen.getByText(/Release is ready/).textContent).not.toContain(
    author,
  );
  expect(screen.getByText(/Release is ready/).textContent).not.toContain(
    "2026-10-27T",
  );
  expect(screen.queryByText("No additional filters")).toBeNull();
  expect(screen.queryByText("Event kinds: 9")).toBeNull();
});
