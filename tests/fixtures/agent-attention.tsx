// The production page and shared controls, with only the host data boundary replaced.
import { createRoot } from "react-dom/client";
import type { Context } from "../../src/plugins/author";
import { createPage } from "../../src/bundled/agents/attention/Page";
import { presentPull } from "../../src/bundled/github/attention";
import "../../src/shared/styles/globals.css";

const channel = "11111111-1111-4111-8111-111111111111";
const listeners = new Set<() => void>();
const value = {
  type: "event",
  name: "Release discussion",
  enabled: true,
  interest_id: "release",
  since: 0,
  kinds: [9],
  channels: [channel],
  channel,
};
let snapshot = {
  status: "ready",
  running: [
    {
      key: "membership-a",
      pubkey: "a".repeat(64),
      owner: "f".repeat(64),
      relay: "wss://example.com",
      name: "Ada",
      attentionEnabled: true,
      timers: {},
      attentionHistory: {
        "watch/discussion": {
          output:
            "2026-10-27T14:00:00Z · Alex\nThe release is ready for review.",
        },
      },
      attention: {
        "interest/release": {
          slug: "interest/release",
          modifiedAt: 1,
          value: {
            type: "interest",
            instructions:
              "# Release planning\nReport blockers and keep the release moving.",
          },
        },
        "watch/discussion": { slug: "watch/discussion", modifiedAt: 1, value },
        "interest/review": {
          slug: "interest/review",
          modifiedAt: 1,
          value: { type: "interest", instructions: "# Review checks" },
        },
        "watch/pr": {
          slug: "watch/pr",
          modifiedAt: 1,
          value: {
            type: "source",
            provider: "attention/github-pr",
            name: "example/project#42",
            enabled: true,
            interest_id: "review",
            config: { pr: "https://github.com/example/project/pull/42" },
            channel,
          },
        },
      },
    },
  ],
};
const channels = {
  channels: [{ id: channel, name: "Release planning", channelType: "stream" }],
};
const connection = {
  status: "ready",
  scope: `https://example.com:${"f".repeat(64)}`,
  session: {
    media: () => "",
    channels: {
      ensureList() {},
      subscribeList: () => () => {},
      list: () => channels,
    },
  },
};
let saveGate: Promise<void> | undefined;
const controls = {
  saveStarted: false,
  opened: undefined as unknown,
  releaseSave: () => {},
  holdSave() {
    controls.saveStarted = false;
    saveGate = new Promise<void>((resolve) => {
      controls.releaseSave = resolve;
    });
  },
};
declare global {
  interface Window {
    attentionFixture: typeof controls;
  }
}
window.attentionFixture = controls;
const navigation = {
  open: async (target: unknown) => {
    controls.opened = target;
  },
};
const presentGitHub = presentPull(navigation);
const Page = createPage({
  agents: {
    presentWatch: (
      watch: Parameters<typeof presentGitHub>[0],
      title: string,
    ) =>
      watch.provider === "attention/github-pr"
        ? presentGitHub(watch, title)
        : undefined,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save: async (
      _key: string,
      patch: {
        attentionEnabled?: boolean;
        attention?: Record<string, unknown>;
        watchEnabled?: Record<string, { enabled: boolean; expected: unknown }>;
      },
    ) => {
      controls.saveStarted = true;
      await saveGate;
      const agent = snapshot.running[0];
      if (!agent) throw new Error("No fixture agent");
      const attention: Record<string, unknown> = { ...agent.attention };
      for (const [slug, value] of Object.entries(patch.attention ?? {})) {
        if (value === null) delete attention[slug];
        else attention[slug] = { slug, value, modifiedAt: 2 };
      }
      for (const [slug, target] of Object.entries(patch.watchEnabled ?? {})) {
        const object = agent.attention[slug];
        if (!object) throw new Error("No watch");
        attention[slug] = {
          ...object,
          value: { ...object.value, enabled: target.enabled },
        };
      }
      snapshot = {
        ...snapshot,
        running: [
          {
            ...agent,
            attentionEnabled: patch.attentionEnabled ?? agent.attentionEnabled,
            attention: attention as typeof agent.attention,
          },
        ],
      };
      for (const listener of listeners) listener();
    },
  },
  relay: { snapshot: () => connection, subscribe: () => () => {} },
  navigation,
} as unknown as Context);
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Page />);
