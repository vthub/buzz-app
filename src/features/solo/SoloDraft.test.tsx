// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { projectTemplateId } from "./workspace";
import { composerDOMFixture } from "../messages/composer-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import { linkedDraftKey, type LinkedChat } from "./linked-chat";
import { SoloDraft, resetNewChatProject } from "./SoloDraft";
import { ChatNotStarted, createChannelWrites } from "../relay/channel-writes";
import { createOutbox } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import { SOLO_LABEL } from "./labels";
import { attachmentDraft } from "../messages/attachment-draft";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import type { ComposerCompletion } from "../conversation/contracts";
import type { Contribution } from "../../plugins/contributions";

composerDOMFixture();
afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
beforeEach(() => {
  localStorage.clear();
  // jsdom lacks what the completion popup uses to position and reveal rows.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
const existing = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Engineering",
  channelType: "stream" as const,
  members: ["a".repeat(64)],
};
function taggedDraft(
  text: string,
  key = "a".repeat(64),
  name = "Member agent",
) {
  const mention = `@${name}`;
  return {
    text: `${mention} ${text}`,
    recipients: [{ pubkey: key, name, start: 0, end: mention.length }],
  };
}
const noOperations: readonly never[] = [];
function setup(available = true) {
  const rows = [
    { pubkey: "a".repeat(64), name: "Member agent" },
    { pubkey: "b".repeat(64), name: "Outside agent" },
  ];
  const agents = {
    status: "ready",
    complete: true,
    identities: rows,
    selectable: rows,
    archives: { status: "unavailable" as const, archived: [] },
  };
  const emoji = { status: "ready", entries: [] };
  const channelWrites = {
    available,
    addAgents: vi.fn(async () => {}),
    create: vi.fn<RelaySession["channelWrites"]["create"]>(() =>
      "c".repeat(64),
    ),
    delivered: vi.fn<RelaySession["channelWrites"]["delivered"]>(
      async () => {},
    ),
    refresh: vi.fn(async () => {}),
    failed: (_id: string) => false,
    discardFailed: vi.fn(async (_id: string) => {}),
    ready: Promise.resolve() as Promise<void>,
    start: vi.fn(
      (
        id: string,
        title: string,
        members: readonly string[],
        ttlSeconds?: number,
        named = false,
        setup?: { canvas: string; apply(): Promise<void> },
      ) => {
        const create = channelWrites.create(
          id,
          title,
          ttlSeconds,
          named,
          members,
        );
        void channelWrites.ready.then(() => setup?.apply()).catch(() => {});
        return { create, ready: channelWrites.ready };
      },
    ),
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(() => "d".repeat(64)),
  };
  const viewer = "f".repeat(64);
  let channelSnapshot = {
    channels: [
      {
        id: "",
        channelType: "solo" as const,
        creator: viewer,
        members: existing.members,
      },
    ],
  };
  const profileSnapshot = new Map();
  const session = {
    viewer,
    channelWrites,
    messages,
    channels: {
      list: () => {
        // The chat a start last refreshed, or the one it just created.
        const id =
          (
            channelWrites.refresh.mock.calls.at(-1) as string[] | undefined
          )?.[0] ??
          channelWrites.create.mock.calls.at(-1)?.[0] ??
          "";
        if (channelSnapshot.channels[0]?.id !== id)
          channelSnapshot = {
            channels: [
              {
                id,
                channelType: "solo",
                creator: viewer,
                members: existing.members,
              },
            ],
          };
        return channelSnapshot;
      },
      subscribeList: () => () => {},
    },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => profileSnapshot,
      subscribe: () => () => {},
    },
    agentChoices: {
      retain: () => () => {},
      snapshot: () => agents,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    emoji: {
      snapshot: () => emoji,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    outbox: {
      supports: () => true,
      snapshot: () => noOperations,
      subscribe: () => () => {},
      dismiss: vi.fn(async () => {}),
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  return { session, channelWrites, messages };
}
it("uses restored explicit mentions, not a separate picker", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  writeView("test", "solo:new-draft", {
    text: "@Outside agent Help",
    recipients: [
      { pubkey: "b".repeat(64), name: "Outside agent", start: 0, end: 14 },
    ],
  });
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  expect(screen.queryByRole("button", { name: "Choose an agent" })).toBeNull();
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  // The create names the agent; no separate add.
  expect(test.channelWrites.start).toHaveBeenCalledWith(
    id,
    expect.any(String),
    ["b".repeat(64)],
    undefined,
    false,
    undefined,
  );
  expect(test.channelWrites.addAgents).not.toHaveBeenCalled();
  expect(test.messages.send).toHaveBeenCalledWith(id, "@Outside agent Help", [
    "b".repeat(64),
  ]);
});
it("a refused start reports why and leaves New chat to the user", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  let refuse = () => {};
  test.channelWrites.ready = new Promise<void>((_resolve, reject) => {
    refuse = () => reject(new ChatNotStarted("Channel creation rejected"));
  });
  test.channelWrites.ready.catch(() => {});
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await user.type(screen.getByRole("textbox"), "Lost start");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  first.unmount();
  // A new chat is being written when the relay refuses the first.
  render(view());
  await user.type(screen.getByRole("textbox"), "Next idea");
  await act(async () => {
    refuse();
    await test.channelWrites.ready.catch(() => {});
  });
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      id,
      expect.stringMatching(/^Couldn't start ".+": Channel creation rejected$/),
    ),
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Next idea");
  expect(screen.getByRole("textbox")).not.toHaveTextContent("Lost start");
  expect(readView("test", `draft:${id}`, null)).toBeNull();
});

it("a start that is only unconfirmed keeps the chat and its message", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  test.channelWrites.ready = Promise.reject(
    new Error("Still waiting for confirmation"),
  );
  test.channelWrites.ready.catch(() => {});
  render(
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Maybe made");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  await act(() => test.channelWrites.ready.catch(() => {}));
  expect(onFailed).not.toHaveBeenCalled();
  expect(test.session.outbox?.dismiss).not.toHaveBeenCalled();
  expect(test.channelWrites.discardFailed).not.toHaveBeenCalled();
  expect(readView("test", "solo:new-draft", null)).toBe("");
});
it("cannot send on an unsupported community", async () => {
  const test = setup(false),
    user = userEvent.setup();
  render(
    <SoloDraft session={test.session} scope="test" onStarted={() => {}} />,
  );
  await user.type(screen.getByRole("textbox"), "Draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
});

it("opens the chat and sends its message before the relay confirms the create", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  test.channelWrites.ready = new Promise(() => {});
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.type(screen.getByRole("textbox"), "Right away");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.channelWrites.start).toHaveBeenCalledOnce();
  expect(test.channelWrites.delivered).not.toHaveBeenCalled();
  expect(test.messages.send).toHaveBeenCalledWith(
    test.channelWrites.create.mock.calls[0]?.[0],
    "Right away@Member agent ",
    ["a".repeat(64)],
  );
});

it.each([false, true])(
  "applies section defaults once the chat starts; failed setup still keeps the chat (failure=%s)",
  async (failure) => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const test = setup();
      const sequence: string[] = [];
      const onStarted = vi.fn();
      const id = await projectTemplateId("work");
      const canvasSave = vi.fn(async (_channel: string, _content: string) => {
        sequence.push("canvas");
        if (failure) throw new Error("Canvas save failed");
        return { id: "f".repeat(64) };
      });
      Object.assign(test.session, {
        channelKit: {
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            entries: [
              {
                eventId: "head",
                record: {
                  value: {
                    type: "template",
                    id,
                    canvas: "Use /repo",
                    agents: [],
                    teamIds: [],
                  },
                },
              },
            ],
          }),
        },
        soloPreferences: {
          writable: true,
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            data: { sections: [{ id: "work", name: "Work" }], assignments: {} },
          }),
          assign: async () => {
            sequence.push("placement");
          },
        },
        canvas: { read: async () => undefined, save: canvasSave },
      });
      test.messages.send.mockImplementation(() => {
        sequence.push("send");
        return "d".repeat(64);
      });
      writeView(
        "test",
        "solo:project:work:new-draft",
        taggedDraft("Build this"),
      );
      render(
        <SoloDraft
          session={test.session}
          scope="test"
          projectId="work"
          onStarted={onStarted}
        />,
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("textbox", { name: "Message your agents" }),
      );
      await user.keyboard("{Enter}");
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      expect(test.channelWrites.create).toHaveBeenCalledOnce();
      await waitFor(() =>
        // The chat joins its workspace at once and its message goes out;
        // the Canvas is saved behind them.
        expect(sequence).toEqual(["placement", "send", "canvas"]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("edits draft settings before creation, restores them, and applies Canvas once the chat starts", async () => {
  const test = setup();
  const order: string[] = [];
  const saveCanvas = vi.fn(async () => {
    order.push("canvas");
  });
  Object.assign(test.session, {
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  test.messages.send.mockImplementation(() => {
    order.push("send");
    return "d".repeat(64);
  });
  const onStarted = vi.fn();
  const user = userEvent.setup();
  const view = (focusRequest: number | AbortSignal = 0) => (
    <SoloDraft
      focusRequest={focusRequest}
      session={test.session}
      scope="test"
      onStarted={onStarted}
    />
  );
  let mounted = render(view());
  await user.click(screen.getByRole("button", { name: "Chat settings" }));
  const canvas = await screen.findByRole("textbox", { name: /^Instructions/ });
  expect(canvas).toHaveValue("");
  await user.clear(canvas);
  await user.type(canvas, "Keep the change small");
  // A stray outside click keeps the dialog and the typed instructions.
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await Promise.resolve();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Keep the change small",
  );
  await user.click(screen.getByRole("radio", { name: /^Temporary/ }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Chat settings" })).toHaveFocus(),
  );
  expect(screen.queryByRole("menu")).toBeNull();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(saveCanvas).not.toHaveBeenCalled();
  mounted.unmount();
  mounted = render(view(1));
  const composer = screen.getByRole("textbox", {
    name: "Message your agents",
  });
  expect(composer).toHaveFocus();
  const actions = screen.getByRole("button", { name: "Chat settings" });
  actions.focus();
  expect(actions).toHaveFocus();
  mounted.rerender(view(new AbortController().signal));
  expect(composer).toHaveFocus();
  await user.type(composer, "Build this");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(test.channelWrites.create.mock.calls[0]?.[2]).toBe(604800);
  expect(test.channelWrites.create).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "Keep the change small",
      undefined,
    ),
  );
  expect(order).toEqual(["send", "canvas"]);
});

it("a new Solo chat for a named agent starts tagged with it, not the default", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const agent = "b".repeat(64);
  render(
    <SoloDraft
      agent={agent}
      session={f.session}
      scope="me-route-agent"
      onStarted={started}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input).toHaveTextContent("@Outside agent"));
  expect(input).not.toHaveTextContent("@Member agent");
  await user.type(input, "Hello");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const [id] = started.mock.calls[0] ?? [];
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(
    id,
    expect.stringContaining("Hello"),
    [agent],
  );
});

it("a named agent replaces a saved new-chat draft that holds only another agent's tag", async () => {
  const f = setup();
  const scope = "me-route-agent-after-default";
  const first = render(
    <SoloDraft session={f.session} scope={scope} onStarted={vi.fn()} />,
  );
  const initial = screen.getByRole("textbox");
  await waitFor(() => expect(initial).toHaveTextContent("@Member agent"));
  first.unmount();
  render(
    <SoloDraft
      agent={"b".repeat(64)}
      session={f.session}
      scope={scope}
      onStarted={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input).toHaveTextContent("@Outside agent"));
  expect(input).not.toHaveTextContent("@Member agent");
});

it("a named agent keeps a saved new-chat draft that has the person's own text", async () => {
  const f = setup();
  const user = userEvent.setup();
  const scope = "me-route-agent-after-text";
  const first = render(
    <SoloDraft session={f.session} scope={scope} onStarted={vi.fn()} />,
  );
  const initial = screen.getByRole("textbox");
  await waitFor(() => expect(initial).toHaveTextContent("@Member agent"));
  await user.type(initial, "Keep this");
  first.unmount();
  render(
    <SoloDraft
      agent={"b".repeat(64)}
      session={f.session}
      scope={scope}
      onStarted={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input).toHaveTextContent("Keep this"));
  expect(input).toHaveTextContent("@Member agent");
  expect(input).not.toHaveTextContent("@Outside agent");
});

it("a new Solo chat needs a tagged agent to send", async () => {
  const f = setup();
  const user = userEvent.setup();
  render(
    <SoloDraft session={f.session} scope="me-untagged" onStarted={vi.fn()} />,
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.value = "Start here";
  fireEvent.input(input);
  await user.keyboard("{Enter}");
  const form = input.closest("form");
  if (!form) throw new Error("Missing composer form");
  fireEvent.submit(form);
  expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(f.channelWrites.create).not.toHaveBeenCalled();
});

it("opens and saves local draft settings in a fresh Solo project after a failed initial read", async () => {
  vi.stubGlobal("crypto", webcrypto);
  try {
    const f = setup();
    const refreshSolo = vi.fn(async () => {});
    // Both the workspace's preload on mount and the settings dialog's read
    // fail.
    refreshSolo
      .mockRejectedValueOnce(new Error("Settings unavailable"))
      .mockRejectedValueOnce(new Error("Settings unavailable"));
    Object.assign(f.session, {
      soloPreferences: {
        writable: true,
        refresh: refreshSolo,
        snapshot: () => ({
          status: "ready",
          data: {
            sections: [{ id: "solo-only", name: "Work" }],
            assignments: {},
          },
        }),
      },
      channelKit: {
        refresh: async () => {},
        snapshot: () => ({ status: "ready", entries: [] }),
      },
    });
    const view = () => (
      <SoloDraft
        session={f.session}
        scope="solo-settings"
        projectId="solo-only"
        onStarted={() => {}}
      />
    );
    const user = userEvent.setup();
    const mounted = render(view());
    const open = async () => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
    };
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings unavailable",
    );
    expect(screen.queryByText("Loading settings…")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshSolo.mockImplementationOnce(() => held);
    const reads = refreshSolo.mock.calls.length;
    try {
      await user.click(screen.getByRole("button", { name: "Retry settings" }));
      await waitFor(() => expect(refreshSolo).toHaveBeenCalledTimes(reads + 1));
      expect(screen.getByRole("status")).toHaveTextContent("Loading settings…");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await user.type(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
      "Keep this Solo draft",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(refreshSolo).toHaveBeenCalledTimes(reads + 1);
    mounted.unmount();
    render(view());
    await open();
    expect(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
    ).toHaveValue("Keep this Solo draft");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(f.channelWrites.create).not.toHaveBeenCalled();
    expect(f.messages.send).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("invalid stored draft lifetime fails visibly without a new create", async () => {
  const h = setup();
  writeView("test", "solo:new-draft", taggedDraft("Keep this draft"));
  writeView("test", "solo:settings", { canvas: "", ttlSeconds: -1 });
  const user = userEvent.setup();
  render(<SoloDraft session={h.session} scope="test" onStarted={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "duration could not be verified",
  );
  expect(h.channelWrites.create).not.toHaveBeenCalled();
  expect(h.channelWrites.delivered).not.toHaveBeenCalled();
});

async function projectSetup() {
  vi.stubGlobal("crypto", webcrypto);
  const f = setup();
  const entries = await Promise.all(
    ["work", "other"].map(async (id) => ({
      eventId: id,
      record: {
        value: {
          type: "template",
          id: await projectTemplateId(id),
          canvas: `${id} instructions`,
          agents: [],
          teamIds: [],
        },
      },
    })),
  );
  const preferences = {
    status: "ready",
    data: {
      sections: [
        { id: "work", name: "Work" },
        { id: "other", name: "Other" },
      ],
      assignments: {},
    },
  };
  const saveCanvas = vi.fn(async () => {});
  const assign = vi.fn(async (_id: string, _sectionId?: string) => {});
  Object.assign(f.session, {
    soloPreferences: {
      writable: true,
      refresh: async () => {},
      snapshot: () => preferences,
      subscribe: () => () => {},
      assign,
    },
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries }),
    },
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  return { ...f, saveCanvas, assign, entries };
}

it("a workspace's defaults changed while New chat is open start the chat", async () => {
  const f = await projectSetup();
  const refresh = vi.fn(async () => {});
  Object.assign(f.session.channelKit, { refresh });
  const user = userEvent.setup();
  const started = vi.fn();
  render(
    <SoloDraft
      session={f.session}
      scope="changed-defaults"
      projectId="work"
      onStarted={started}
    />,
  );
  // The defaults load once the workspace is picked; then they are saved anew.
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await act(async () => {});
  const [work] = f.entries;
  if (!work) throw new Error("missing work defaults");
  f.entries[0] = {
    ...work,
    eventId: "work-2",
    record: {
      value: { ...work.record.value, canvas: "new work instructions" },
    },
  };
  await user.type(screen.getByRole("textbox"), "Go");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(f.saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "new work instructions",
      undefined,
    ),
  );
});

it("re-entering a mounted project clears changed defaults", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const scope = "project-reset";
  const key = "solo:project:work";
  writeView(scope, `${key}:new-project`, "other");
  writeView(scope, `${key}:settings`, "other edited instructions");
  render(
    <SoloDraft
      projectId="work"
      session={f.session}
      scope={scope}
      onStarted={started}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Workspace: Other" }),
  ).toBeVisible();
  act(() => resetNewChatProject(scope, "work"));
  expect(
    await screen.findByRole("button", { name: "Workspace: Work" }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Chat settings" }));
  expect(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
  ).toHaveValue("work instructions");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.type(screen.getByRole("textbox"), "Start in Work");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.assign).toHaveBeenCalledWith(expect.any(String), "work");
  expect(f.saveCanvas).toHaveBeenCalledWith(
    expect.any(String),
    "work instructions",
    undefined,
  );
});

it("keeps a locally chosen project when its persistence fails and other draft writes succeed", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const user = userEvent.setup();
  const scope = "project-write-failure";
  const key = `buzz-view.v1:${JSON.stringify([scope, "solo:project:work:new-project"])}`;
  const setItem = Storage.prototype.setItem;
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new Error("Storage unavailable");
      setItem.call(this, name, value);
    });
  try {
    render(
      <SoloDraft
        projectId="work"
        session={f.session}
        scope={scope}
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Workspace: Work" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Other" }),
    );
    await user.type(screen.getByRole("textbox"), "Keep this project");
    expect(
      screen.getByRole("button", { name: "Workspace: Other" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.assign).toHaveBeenCalledWith(expect.any(String), "other");
  } finally {
    storage.mockRestore();
  }
});

it("inherits the project's defaults for two consecutive new chats", async () => {
  const f = await projectSetup();
  const user = userEvent.setup();
  const started = vi.fn();
  for (let index = 0; index < 2; index++) {
    const view = render(
      <SoloDraft
        session={f.session}
        scope="repeat-project"
        projectId="work"
        onStarted={started}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Workspace: Work" }),
    ).toBeVisible();
    await user.type(screen.getByRole("textbox"), `Chat ${index}`);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledTimes(index + 1));
    await waitFor(() =>
      expect(f.saveCanvas).toHaveBeenNthCalledWith(
        index + 1,
        expect.any(String),
        "work instructions",
        undefined,
      ),
    );
    view.unmount();
  }
  expect(f.channelWrites.create.mock.calls[0]?.[0]).not.toBe(
    f.channelWrites.create.mock.calls[1]?.[0],
  );
});

it.each([
  { saved: true, remount: true, fromProject: true },
  { saved: false, remount: false, fromProject: false },
])(
  "switching projects uses new defaults and retains independent naming/lifetime (saved=$saved, remount=$remount, fromProject=$fromProject)",
  async ({ saved, remount, fromProject }) => {
    const f = await projectSetup();
    const user = userEvent.setup();
    const started = vi.fn();
    const draftKey = fromProject ? "solo:project:work" : "solo";
    writeView("switch-project", `${draftKey}:settings`, {
      name: "My chosen title",
      ttlSeconds: 600,
    });
    const view = () => (
      <SoloDraft
        session={f.session}
        scope="switch-project"
        projectId={fromProject ? "work" : undefined}
        onStarted={started}
      />
    );
    const mounted = render(view());
    const openSettings = async () => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
      return screen.findByRole("textbox", { name: /^Instructions/ });
    };
    if (saved) {
      const canvas = await openSettings();
      await waitFor(() =>
        expect(canvas).toHaveValue(fromProject ? "work instructions" : ""),
      );
      await user.clear(canvas);
      await user.type(canvas, "Old project override");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
    }
    await user.click(
      screen.getByRole("button", {
        name: fromProject ? "Workspace: Work" : "Add workspace",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Other$/ }),
    );
    if (remount) {
      mounted.unmount();
      render(view());
    }
    const canvas = await openSettings();
    await waitFor(() => expect(canvas).toHaveValue("other instructions"));
    expect(screen.getByRole("textbox", { name: /^Chat name/ })).toHaveValue(
      "My chosen title",
    );
    expect(screen.getByRole("radio", { name: /^Temporary/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.type(screen.getByRole("textbox"), "New project chat");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.channelWrites.create).toHaveBeenCalledWith(
      expect.any(String),
      "My chosen title",
      600,
      true,
      ["a".repeat(64)],
    );
    await waitFor(() =>
      expect(f.assign).toHaveBeenCalledWith(expect.any(String), "other"),
    );
    expect(f.saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "other instructions",
      undefined,
    );
  },
);

it("allows changing an unavailable assistant before any remote creation", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const choices = f.session.agentChoices.snapshot();
  vi.spyOn(f.session.agentChoices, "snapshot").mockReturnValue({
    ...choices,
    selectable: choices.selectable.filter(
      (agent) => agent.pubkey === "a".repeat(64),
    ),
  });
  writeView(
    "unavailable-agent",
    "solo:new-draft",
    taggedDraft("Keep my draft", "b".repeat(64), "Outside agent"),
  );
  render(
    <SoloDraft
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(
    "Only your available agents can be mentioned in Solo chats. Remove the unavailable recipient and retry.",
  );
  expect(f.channelWrites.create).not.toHaveBeenCalled();
  cleanup();
  writeView(
    "unavailable-agent",
    "solo:new-draft",
    taggedDraft("Keep my draft"),
  );
  render(
    <SoloDraft
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.messages.send).toHaveBeenCalledWith(
    expect.any(String),
    "@Member agent Keep my draft",
    ["a".repeat(64)],
  );
});

it.each([{ fields: { name: 7 } }, { fields: { name: "x".repeat(121) } }])(
  "rejects malformed persisted naming before start side effects: $fields",
  async ({ fields }) => {
    const h = setup(),
      user = userEvent.setup(),
      started = vi.fn();
    const refreshPreferences = vi.fn(async () => {});
    const refreshSetup = vi.fn(async () => {});
    const readCanvas = vi.fn(async () => undefined);
    const saveCanvas = vi.fn(async () => {});
    const refreshAgents = vi.fn(async () => {});
    Object.assign(h.session, {
      channelKit: { refresh: refreshSetup },
      soloPreferences: {
        refresh: refreshPreferences,
        snapshot: () => ({
          data: { sections: [{ id: "work", name: "Work" }] },
        }),
      },
      canvas: { read: readCanvas, save: saveCanvas },
      agentChoices: { ...h.session.agentChoices, refresh: refreshAgents },
    });
    const key = "solo:project:work";
    writeView("test", `${key}:new-draft`, taggedDraft("Keep this draft"));
    writeView("test", `${key}:settings`, fields);
    render(
      <SoloDraft
        session={h.session}
        scope="test"
        projectId="work"
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/name/i);
    // The workspace's defaults load when it is picked; that is a read, not a
    // start.
    for (const operation of [
      readCanvas,
      saveCanvas,
      refreshAgents,
      h.channelWrites.create,
      h.channelWrites.delivered,
      h.channelWrites.refresh,
      h.channelWrites.addAgents,
      h.messages.send,
      started,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "naming crosses the real composer → creation/outbox boundary with frozen intent (explicit=%s)",
  async (explicit) => {
    const h = setup();
    const viewer = keypair();
    const publish = vi.fn(async (_event: Parameters<typeof signed>[1]) => {});
    const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(viewer, template),
    );
    const outbox = createOutbox(
      viewer.pubkey,
      { kinds: [9, 9007], sign, publish },
      { load: () => [], save() {} },
    );
    const lifetime = new AbortController();
    writeView("real-creation", "solo:settings", {
      name: explicit ? "Chosen title" : "",
      ttlSeconds: 600,
    });
    writeView(
      "real-creation",
      "solo:new-draft",
      taggedDraft("Original prompt", viewer.pubkey, "Viewer"),
    );
    let observed = outbox.outbox.snapshot();
    let channelList = {
      status: "ready" as const,
      channels: [] as {
        id: string;
        name: string;
        channelType: "solo";
        creator: string;
        members: string[];
      }[],
    };
    const channels = {
      ...h.session.channels,
      list: () => {
        const next = outbox.outbox.snapshot();
        if (next !== observed) {
          observed = next;
          channelList = {
            status: "ready",
            channels: next
              .filter(({ event }) => event.kind === 9007)
              .map(({ event }) => ({
                id: event.tags.find(([key]) => key === "h")?.[1] ?? "",
                name: "Chosen title",
                channelType: "solo",
                creator: viewer.pubkey,
                members: [viewer.pubkey],
              })),
          };
        }
        return channelList;
      },
    };
    const authority = keypair();
    const channelWrites = createChannelWrites(
      outbox.outbox,
      channels,
      {
        read: async (filters) =>
          filters.flatMap((filter) =>
            filter.kinds?.includes(39002)
              ? [
                  signed(authority, {
                    kind: 39002,
                    content: "",
                    created_at: 1,
                    tags: [
                      ["d", filter["#d"]?.[0] ?? ""],
                      ["p", viewer.pubkey],
                    ],
                  }),
                ]
              : [],
          ),
      },
      lifetime.signal,
      undefined,
      undefined,
      undefined,
      authority.pubkey,
      undefined,
      true,
    );
    const eligible = {
      ...h.session.agentChoices.snapshot(),
      selectable: [{ pubkey: viewer.pubkey, name: "Viewer", managed: true }],
    };
    const session = {
      ...h.session,
      agentChoices: { ...h.session.agentChoices, snapshot: () => eligible },
      viewer: viewer.pubkey,
      channels,
      channelWrites,
      messages: {
        ...h.session.messages,
        send: (id: string, text: string, recipients: readonly string[] = []) =>
          outbox.outbox.send({
            kind: 9,
            content: text,
            tags: [["h", id], ...recipients.map((key) => ["p", key])],
          }),
      },
    } as RelaySession;
    const started = vi.fn();
    const mounted = render(
      <SoloDraft session={session} scope="real-creation" onStarted={started} />,
    );
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      const created = publish.mock.calls
        .map(([event]) => event)
        .find((event) => event.kind === 9007);
      expect(created?.tags).toContainEqual([
        "name",
        explicit ? "Chosen title" : "Original prompt",
      ]);
      expect(created?.tags).toContainEqual(["t", SOLO_LABEL]);
      expect(created?.tags.some(([key]) => key === "about")).toBe(false);
      expect(created?.tags).toContainEqual(["ttl", "600"]);
      expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([
        9007, 9,
      ]);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      mounted.unmount();
      lifetime.abort();
      outbox.dispose();
    }
  },
);

it("starts a new chat with a session card and no caption", async () => {
  const h = setup(),
    started = vi.fn(),
    user = userEvent.setup();
  const link = "[Session: Fix](buzz://channel/session-id)";
  writeView("test", "solo:new-draft", taggedDraft(link));
  render(<SoloDraft session={h.session} scope="test" onStarted={started} />);
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeEnabled();
  await user.click(send);
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(h.channelWrites.create).toHaveBeenCalledOnce();
  expect(h.messages.send).toHaveBeenCalledWith(
    h.channelWrites.create.mock.calls[0]?.[0],
    expect.stringContaining(link),
    ["a".repeat(64)],
  );
});

it("starting titles omit structured leading tags but retain literal @ text", async () => {
  const f = setup();
  const content = "@Literal investigate this";
  writeView("clean-title", "solo:new-draft", taggedDraft(content));
  render(
    <SoloDraft session={f.session} scope="clean-title" onStarted={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.messages.send).toHaveBeenCalledOnce());
  expect(f.channelWrites.create.mock.calls[0]?.[1]).toBe(content);
});

it.each(["remember", "off"])(
  "first Solo send transfers all tagged agents into the saved chat draft (%s)",
  async (mode) => {
    const { setRememberAgentsPreference } = await import(
      "../messages/mention-preferences"
    );
    const { followupDraft } = await import("../messages/mention-draft");
    const f = setup();
    const recipients = [
      { pubkey: "a".repeat(64), name: "Member agent" },
      { pubkey: "b".repeat(64), name: "Outside agent" },
    ];
    const tags = followupDraft(recipients);
    writeView("first-followup", "solo:new-draft", {
      ...tags,
      text: `${tags.text}Start here`,
    });
    if (mode === "off") setRememberAgentsPreference(false);
    const started = vi.fn();
    render(
      <SoloDraft
        session={f.session}
        scope="first-followup"
        onStarted={started}
      />,
    );
    try {
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      expect(f.messages.send).toHaveBeenCalledOnce();
      expect(f.channelWrites.create).toHaveBeenCalledOnce();
      const id = started.mock.calls[0]?.[0];
      expect(readView("first-followup", `draft:${id}`, null)).toEqual(
        mode === "off" ? { text: "", recipients: [] } : tags,
      );
      expect(f.messages.send.mock.calls[0]?.[2]).toEqual(
        recipients.map((r) => r.pubkey),
      );
    } finally {
      setRememberAgentsPreference(true);
    }
  },
);

const notes = {
  name: "notes.txt",
  url: `https://relay.test/media/${"f".repeat(64)}.txt`,
  type: "text/plain",
  size: 5,
  sha256: "f".repeat(64),
};

it("uploads files as soon as they are attached to a new chat, then sends them", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const upload = vi.fn();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, { attachments: { upload, uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(uploadForNewChat).toHaveBeenCalledOnce();
  expect(upload).not.toHaveBeenCalled();
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  expect(test.messages.send).toHaveBeenCalledWith(
    id,
    expect.stringContaining("See attached"),
    ["a".repeat(64)],
    [notes],
  );
  if (!id) throw new Error("Expected a created chat");
  expect(
    attachmentDraft(test.session, `test:draft:${id}`, id).snapshot(),
  ).toEqual([]);
});

it("a file dropped anywhere on the new chat page attaches to its composer", async () => {
  const test = setup();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, {
    attachments: { upload: vi.fn(), uploadForNewChat },
  });
  render(<SoloDraft session={test.session} scope="test" onStarted={vi.fn()} />);
  const page = screen.getByRole("region", { name: "New chat" });
  const dataTransfer = {
    types: ["Files"],
    files: [new File(["notes"], "notes.txt", { type: "text/plain" })],
    dropEffect: "uninitialized",
  };
  fireEvent.dragEnter(page, { dataTransfer });
  expect(
    await screen.findByText("Drop files into this conversation"),
  ).toBeInTheDocument();
  fireEvent.drop(page, { dataTransfer });
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  expect(screen.queryByText("Drop files into this conversation")).toBeNull();
});

it("a failed upload blocks a new chat before anything is created", async () => {
  const test = setup(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(async () => {
    throw new Error("Upload failed. Retry or remove this file.");
  });
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(<SoloDraft session={test.session} scope="test" onStarted={vi.fn()} />);
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  expect(
    await screen.findByRole("button", { name: "Retry notes.txt" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(test.messages.send).not.toHaveBeenCalled();
});

it("a first message that can't go out waits in the new chat's composer with its files", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  Object.assign(test.session, {
    attachments: { uploadForNewChat: vi.fn(async () => notes) },
  });
  test.messages.send.mockImplementationOnce(() => {
    throw new Error("offline");
  });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(readView("test", `draft:${id}`, null)).toEqual(
    taggedDraft("See attached"),
  );
  expect(
    attachmentDraft(test.session, `test:draft:${id}`, id)
      .snapshot()
      .map((item) => item.uploaded),
  ).toEqual([notes]);
});

it("resumes a new chat's interrupted upload after navigating away and back", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(
    (_file: File, signal: AbortSignal) =>
      new Promise<typeof notes>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  );
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  const view = render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  view.unmount();

  uploadForNewChat.mockImplementation(async () => notes);
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.messages.send).toHaveBeenCalledWith(
    test.channelWrites.create.mock.calls[0]?.[0],
    expect.stringContaining("See attached"),
    ["a".repeat(64)],
    [notes],
  );
});

it("shows an editable ordinary source link and sends it with the default agent", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: `buzz://message?channel=design&id=${"c".repeat(64)}&thread=${"b".repeat(64)}`,
  };
  writeView("test", linkedDraftKey(linkedId), source);
  const started = vi.fn();
  render(
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      onStarted={started}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveTextContent("@Member agent"),
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.value).toContain(source.link);
  expect(t.channelWrites.create).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const id = started.mock.calls[0]?.[0];
  expect(t.channelWrites.start).toHaveBeenCalledWith(
    id,
    expect.any(String),
    ["a".repeat(64)],
    undefined,
    false,
    undefined,
  );
  expect(t.messages.send).toHaveBeenCalledWith(
    id,
    expect.stringContaining(source.link),
    ["a".repeat(64)],
  );
});
it("starting again from a sent source seeds its link and default agent again", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  const start = () => {
    writeView("test", linkedDraftKey(linkedId), source);
    return render(
      <SoloDraft
        session={t.session}
        scope="test"
        linkedId={linkedId}
        source={source}
        onStarted={started}
      />,
    );
  };
  const started = vi.fn();
  const first = start();
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveTextContent("@Member agent"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  first.unmount();
  start();
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveTextContent("@Member agent"),
  );
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain(
    source.link,
  );
});
it("keeps a removed default tag when the linked draft is reopened", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  writeView("test", linkedDraftKey(linkedId), source);
  const draft = () => (
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      onStarted={vi.fn()}
    />
  );
  const first = render(draft());
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveTextContent("@Member agent"),
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  await userEvent.clear(input);
  await userEvent.type(input, source.link);
  await waitFor(() =>
    expect(
      readView<{ text?: string } | null>(
        "test",
        `${linkedDraftKey(linkedId)}:new-draft`,
        null,
      )?.text,
    ).toBe(source.link),
  );
  first.unmount();
  render(draft());
  const reopened = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(reopened.value).toBe(source.link);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reopened.value).not.toContain("@Member agent");
});
it("keeps an edited linked draft instead of reinserting its removed source", async () => {
  const t = setup();
  const started = vi.fn();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  writeView(
    "test",
    `${linkedDraftKey(linkedId)}:new-draft`,
    taggedDraft("Changed request"),
  );
  render(
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      onStarted={started}
    />,
  );
  expect(
    (screen.getByRole("textbox") as HTMLTextAreaElement).value,
  ).not.toContain(source.link);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(t.messages.send.mock.calls[0]?.[1]).toBe(
    "@Member agent Changed request",
  );
});
const aaron = { pubkey: "e".repeat(64), name: "Aaron" };
/** A new Solo chat over the real mentions completion, with the agent
 * inventory answered by `read`; returns the composer and the `p` tags the
 * eventual send carried. */
function soloDraftWithInventory(
  read: () => Promise<{ definitions: []; identities: [typeof aaron] }>,
) {
  const test = setup();
  const library = createAgentLibrary(read);
  const session = {
    ...test.session,
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
  } as unknown as RelaySession;
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "typeahead",
      key: "buzz.mentions/typeahead",
      pluginId: "buzz.mentions",
      revision: "1",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: MentionCompletion,
    },
  ];
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const onStarted = vi.fn();
  render(
    <SoloDraft
      session={session}
      scope="test"
      onStarted={onStarted}
      extensions={{
        tools: none,
        inline: none,
        completions: { snapshot: () => completions, subscribe: () => () => {} },
      }}
    />,
  );
  const input = screen.getByRole("textbox");
  return {
    input,
    chip: () =>
      within(input).queryByRole("img", { name: "Resolving mention Aaron" }),
    async send() {
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      const id = test.channelWrites.create.mock.calls[0]?.[0];
      expect(test.channelWrites.start).toHaveBeenCalledWith(
        id,
        expect.any(String),
        [aaron.pubkey],
        undefined,
        false,
        undefined,
      );
      expect(test.messages.send).toHaveBeenCalledWith(id, "@Aaron hi", [
        aaron.pubkey,
      ]);
    },
    dispose: library.dispose,
  };
}
it("tags an agent whose name was typed with Space before the agent inventory loaded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const draft = soloDraftWithInventory(async () => {
    await gate;
    return { definitions: [], identities: [aaron] };
  });
  try {
    // Fast typing: the inventory has not answered when Space arrives.
    await userEvent.type(draft.input, "@Aaron hi");
    expect(draft.input).toHaveValue("@Aaron hi");
    expect(draft.chip()).toHaveAttribute("aria-busy", "true");
    await act(async () => release());
    await waitFor(() => expect(draft.chip()).toBeNull());
    await draft.send();
  } finally {
    release();
    draft.dispose();
  }
});
it("tags an agent whose name was typed with Space while a retry after a failed inventory read loads", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const draft = soloDraftWithInventory(async () => {
    if (reads++ === 0) throw new Error("offline");
    await gate;
    return { definitions: [], identities: [aaron] };
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry agents" }),
    );
    // The failed read settled the roster empty; the retry's Space must wait
    // for the retry, not consume that settled roster.
    await userEvent.type(draft.input, "@Aaron hi");
    expect(draft.input).toHaveValue("@Aaron hi");
    expect(draft.chip()).toHaveAttribute("aria-busy", "true");
    await act(async () => release());
    await waitFor(() => expect(draft.chip()).toBeNull());
    await draft.send();
  } finally {
    release();
    draft.dispose();
  }
});
