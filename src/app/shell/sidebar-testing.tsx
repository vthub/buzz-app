// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySession } from "../../features/relay/session";
import type { ReadTransport } from "../../features/relay/transport";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import type { OpenTarget } from "../../features/navigation/targets";
import { NewMenu } from "./NewMenu";
import type { Agents } from "../../features/agents/service";
import { PrimarySidebar } from "./PrimarySidebar";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { SoloInventory } from "../../features/channel-navigation/SoloInventory";
import { conversationTarget } from "../../features/channel-navigation/routes";
import type { ContributionReader } from "../../features/conversation/contracts";
import type { ChatIcon, ChatMenu } from "../../features/conversation/service";

export const owners: ReturnType<typeof createRelaySession>[] = [];
export const id = "11111111-1111-4111-8111-111111111111";
export const other = "22222222-2222-4222-8222-222222222222";
export const agent = "a".repeat(64);
export const outsider = "b".repeat(64);
export const viewer = "c".repeat(64);
export const root = "d".repeat(64);
export const scope = `https://relay.test:${viewer}`;
export function fixture(
  combined = false,
  canCreate = false,
  agents?: Agents,
  counts = { observedCount: 2, attentionCount: 1 },
  /** Newer, read Solo chats ahead of Planning and Other; only Planning is unread. */
  newer = 0,
  chatIcons?: ContributionReader<ChatIcon>,
  chatMenus?: ContributionReader<ChatMenu>,
  host: {
    transport?: ReadTransport;
    federatedIdentity?: FederatedIdentity;
  } = {},
) {
  const owner = createRelaySession(host.transport ?? null);
  owners.push(owner);
  const base = owner.session;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  let typing: ReturnType<RelaySession["typing"]["snapshot"]> = [];
  let activity: ReturnType<RelaySession["agentActivity"]["snapshot"]> = {
    ...base.agentActivity.snapshot(),
    status: "disabled",
  };
  let unread: ReturnType<RelaySession["unread"]["snapshot"]> = {
    target: { kind: "channel", channelId: id },
    ...counts,
    coverage: "observed",
    freshness: "observed",
    manual: "none",
  };
  let threads: ReturnType<RelaySession["unread"]["activity"]> = {
    channelId: id,
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const read = new Map<
    string,
    ReturnType<RelaySession["unread"]["snapshot"]>
  >();
  const markThrough = vi.fn(async () => ({
    operationId: "read",
    durability: "saved" as const,
    sync: "pending" as const,
  }));
  const list = {
    status: "ready" as const,
    channels: [
      {
        id,
        name: "Planning",
        channelType: "solo" as const,
        creator: viewer,
      },
      {
        id: other,
        name: "Other",
        channelType: "solo" as const,
        creator: viewer,
      },
      ...Array.from({ length: newer }, (_, index) => ({
        id: `newer-${index}`,
        name: `Newer ${index}`,
        channelType: "solo" as const,
        creator: viewer,
        lastActivityAt: 1_000 - index,
      })),
    ],
  };
  const preferences = {
    status: "ready" as const,
    data: { sections: [], assignments: {}, starred: [], muted: [] },
  };
  const choices = {
    ...base.agentChoices.snapshot(),
    identities: [{ pubkey: agent, name: "Owned Agent", managed: true }],
  } satisfies ReturnType<RelaySession["agentChoices"]["snapshot"]>;
  const profiles = new Map([
    [agent, { name: "Owned Agent", isAgent: true as const }],
    [outsider, { name: "Outside Agent", isAgent: true as const }],
  ]);
  const session: RelaySession = {
    ...base,
    scope,
    viewer,
    channelCreation: { ...base.channelCreation, available: canCreate },
    channels: { ...base.channels, list: () => list, ensureList() {} },
    soloPreferences: {
      ...base.soloPreferences,
      sectionCreationWritable: canCreate,
      snapshot: () => preferences,
      ensure: async () => {},
    },
    typing: { ...base.typing, snapshot: () => typing, subscribe },
    agentActivity: {
      ...base.agentActivity,
      snapshot: () => activity,
      subscribe,
      subscribeWorking: subscribe,
      workingSnapshot: () =>
        JSON.stringify(
          activity.turns
            .filter((turn) => turn.state === "working")
            .map((turn) => turn.channelId),
        ),
    },
    agentChoices: { ...base.agentChoices, snapshot: () => choices },
    profiles: { ...base.profiles, snapshot: () => profiles },
    unread: {
      ...base.unread,
      snapshot: (target) => {
        if (!newer || target.kind !== "channel" || target.channelId === id)
          return unread;
        // Stable per channel, as external-store snapshots must be.
        const known = read.get(target.channelId);
        if (known) return known;
        const quiet = {
          ...unread,
          target,
          observedCount: 0,
          attentionCount: 0,
        };
        read.set(target.channelId, quiet);
        return quiet;
      },
      subscribe: (_target, listener) => subscribe(listener),
      activity: () => threads,
      subscribeActivity: (_id, listener) => subscribe(listener),
      markThrough,
    },
  };
  let snapshot: RelaySnapshot = {
    status: "ready",
    session,
    generation: 1,
    scope,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe,
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  let attempt = 0;
  const open = vi.fn(async (next: OpenTarget) => {
    target = next;
    attempt++;
    rendered.rerender(tree());
    publish();
    return { status: "opened" as const };
  });
  const navigator = {
    open,
    subscribe,
    snapshot: () => ({
      attempt: { id: String(attempt), signal: new AbortController().signal },
    }),
  } as unknown as Navigation;
  let target: OpenTarget = conversationTarget(scope, other);
  let sidebarVisible = true;
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const tree = () => (
    <ToastProvider>
      <ChannelNavigationProvider relay={relay}>
        {combined ? (
          <>
            <NewMenu relay={relay} navigator={navigator} agents={agents} />
            {sidebarVisible && (
              <PrimarySidebar
                relay={relay}
                navigator={navigator}
                target={target}
                chatIcons={chatIcons}
                chatMenus={chatMenus}
                {...(host.federatedIdentity
                  ? { federatedIdentity: host.federatedIdentity }
                  : {})}
              >
                <button type="button">Inbox</button>
              </PrimarySidebar>
            )}
          </>
        ) : (
          <SoloInventory
            session={snapshot.session}
            scope={scope}
            navigator={navigator}
            target={target}
            chatIcons={chatIcons}
            chatMenus={chatMenus}
          />
        )}
      </ChannelNavigationProvider>
    </ToastProvider>
  );
  const rendered = render(tree());
  return {
    session,
    navigate(next: OpenTarget) {
      target = next;
      rendered.rerender(tree());
    },
    sidebar(visible: boolean) {
      sidebarVisible = visible;
      rendered.rerender(tree());
    },
    connection(change: Partial<RelaySnapshot>) {
      act(() => {
        snapshot = { ...snapshot, ...change };
        publish();
      });
    },
    replaceSession() {
      act(() => {
        snapshot = { ...snapshot, session: { ...session }, generation: 2 };
        publish();
      });
    },
    open,
    markThrough,
    listeners,
    typing(next: typeof typing) {
      act(() => {
        typing = next;
        publish();
      });
    },
    activity(next: typeof activity) {
      act(() => {
        activity = next;
        publish();
      });
    },
    threads(next: typeof threads) {
      act(() => {
        threads = next;
        publish();
      });
    },
    clearUnread() {
      act(() => {
        unread = { ...unread, observedCount: 0, attentionCount: 0 };
        publish();
      });
    },
    activitySnapshot: activity,
  };
}
