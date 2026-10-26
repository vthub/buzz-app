import { getLogger } from "../developer/logging.ts";
import { logSocketFrame, relayLabel } from "../developer/traffic.ts";

import {
  createSocketPublications,
  SocketRequestError,
} from "./socket-requests.ts";
import {
  OBSERVER_KIND,
  observerGeneration,
  type ObserverFrame,
} from "../agents/observer.ts";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { eventDto } from "./events.ts";
import { EMOJI_SET } from "./emoji.ts";
import type {
  ArtifactSyncFilter,
  ArtifactSyncSink,
} from "./artifact-sync-filter.ts";

export const LIVE_CHANNEL_CAPACITY = 1022;
export const LIVE_BATCH_SIZE = 10; // Relay's per-REQ filter cap; replay stays per channel.
export const LIVE_REPLAY_LIMIT = 500;
export const LIVE_RECOVERY_INTERVAL = 60_000;
/** Channel REQs awaiting EOSE at once. `scripts/live-setup-probe.mjs` compares others. */
export const SETUP_CONCURRENCY = 4;
/** How long one channel REQ may wait for EOSE before its route fails. */
export const SETUP_TIMEOUT_MS = 10_000;
const MAX_QUOTA_RETRIES = 3;
const BASE_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 30_000;
/** Wait before retrying a refusal that needs someone to act (a rejected AUTH, a
 * route CLOSED as blocked). It can still clear: access changes, a relay restarts,
 * a locked signer unlocks. One recovery tick first, doubling to 10 minutes, so
 * a relay that keeps refusing sees at most 6 attempts an hour per route. */
export const liveSlowRetryDelay = (failures: number) =>
  Math.min(LIVE_RECOVERY_INTERVAL * 2 ** (failures - 1), 600_000);
/** Host-owned server cooldown survives socket/POST replacement.
 * Healthy traffic has no inter-request delay; outstanding work is bounded below. */
export function createLiveAdmission() {
  let cooldown = 0;
  let presenceBusy = false,
    presenceNext = 0;
  const pending = new Set<object>();
  return {
    delay: () => Math.max(0, cooldown - performance.now()),
    setup(owner: object, busy: boolean) {
      if (busy) pending.add(owner);
      else pending.delete(owner);
    },
    presenceReady: () => performance.now() >= Math.max(cooldown, presenceNext),
    presenceDelay: () =>
      Math.ceil(
        Math.max(0, Math.max(cooldown, presenceNext) - performance.now()),
      ),
    tryPresence() {
      if (presenceBusy || !this.presenceReady()) return;
      presenceBusy = true;
      return () => {
        presenceBusy = false;
      };
    },
    presenceSent() {
      presenceNext = performance.now() + 5000;
    },
    presenceIdle: () =>
      !presenceBusy && performance.now() >= presenceNext && !pending.size,
    pause(seconds: number) {
      // Redis reports whole seconds; include a second rather than retry before expiry.
      cooldown = Math.max(cooldown, performance.now() + (seconds + 1) * 1000);
    },
  };
}
export type LiveAdmission = ReturnType<typeof createLiveAdmission>;
export type LiveRoute = Readonly<{
  id: string;
  channelId?: string;
  status: "pending" | "live" | "error" | "limited";
  /** EOSE establishes a stream, never proves historical completeness. */
  replay: "unknown" | "limited";
  error?: string;
}>;
export type LiveSnapshot = Readonly<{
  status: "unavailable" | "connecting" | "connected" | "retrying" | "error";
  routes: readonly LiveRoute[];
  error?: string;
}>;
/** Transport provenance, not a history-completeness claim or permission to alert. */
export type LiveProvenance = Readonly<{
  phase: "replay" | "live";
  channelId?: string;
  /** Original wire scope for ambiguous channel traffic; never alert attribution. */
  sourceChannels?: readonly string[];
}>;
export function liveProvenance(value: unknown): LiveProvenance {
  if (!value || typeof value !== "object")
    throw new Error("Invalid live provenance");
  const input = value as Record<string, unknown>;
  if (input.phase !== "replay" && input.phase !== "live")
    throw new Error("Invalid live provenance");
  if (
    input.channelId !== undefined &&
    (typeof input.channelId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.channelId))
  )
    throw new Error("Invalid live provenance channel");
  const sourceChannels =
    input.sourceChannels === undefined
      ? undefined
      : liveChannels(input.sourceChannels);
  if (
    sourceChannels &&
    (!sourceChannels.length || sourceChannels.length > LIVE_BATCH_SIZE)
  )
    throw new Error("Invalid live source scope");
  return Object.freeze({
    ...(sourceChannels
      ? { sourceChannels: Object.freeze(sourceChannels) }
      : {}),
    phase: input.phase,
    ...(typeof input.channelId === "string"
      ? { channelId: input.channelId }
      : {}),
  });
}
export type LiveCallbacks = {
  /** Legacy/missing provenance reconciles quietly; it is never implicitly fresh. */
  receive(events: readonly VerifiedEvent[], provenance?: LiveProvenance): void;
  /** Host-only encrypted telemetry route; never ordinary history reconciliation. */
  telemetry?(event: VerifiedEvent, generation: number): void;
  /** Decoded host DTO on the browser transport. */
  observer?(frame: ObserverFrame, generation: number): void;
  presence?(event: VerifiedEvent): void;
  state(snapshot: LiveSnapshot): void;
  established(channels?: string | readonly string[]): void;
  /** Periodic repair hint, not membership or historical-completeness evidence. */
  recover?(): void;
  denied(channelId: string, reason: string): void;
};
export type LiveSubscription = {
  /** Local broker handle; not a relay subscription ID. */
  identity?(): string | undefined;
  publish?(event: VerifiedEvent, signal: AbortSignal): Promise<string>;
  /** Purpose-bound host path when generic socket publication is unavailable. */
  publishTyping?(event: VerifiedEvent, signal: AbortSignal): Promise<string>;
  update(channels: readonly string[], joined?: readonly string[]): void;
  /** Host demand only: reorder existing pending routes, never grant new interests. */
  prioritize?(channels: readonly string[]): void;
  observe?(generation: number | null): void;
  /** Ephemeral status: true = accepted, false = unconfirmed/refused, null = unsent.
   * Admission skips report their remaining delay; no durable queue is created. */
  publishPresence?(
    status: "online" | "away" | "offline",
    signal: AbortSignal,
  ): Promise<boolean | null | { retryAfterMs: number }>;
  watchPresence?(authors: readonly string[]): void;
  /** One NIP-AR sync REQ on this socket. Sent once authenticated; a lost
   * socket ends it with `disconnected:`. The caller owns restart. */
  syncArtifacts?(
    filter: ArtifactSyncFilter,
    sink: ArtifactSyncSink,
  ): () => void;
  retry(): void;
  dispose(): void;
};
/** Demand-scoped ephemeral authors, never a channel/history interest. */
export function livePresenceAuthors(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 256 ||
    input.some((key) => typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key))
  )
    throw new Error("Invalid live presence authors");
  return [...new Set(input as string[])].sort();
}
/** IDs, not names/previews, define interest identity. Never silently truncate. */
export function liveChannels(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 1024 ||
    input.some(
      (id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id),
    )
  )
    throw new Error(
      "Invalid live channel interests (maximum 1024 bounded IDs)",
    );
  return [...new Set(input as string[])].sort();
}

/** Batchability is part of the same interest snapshot, not a priority hint. */
export function liveJoined(
  channels: readonly string[],
  input: unknown,
): string[] {
  const joined = liveChannels(input);
  if (joined.some((id) => !channels.includes(id)))
    throw new Error("Joined scope outside live interests");
  return joined;
}

type Route = {
  id: string;
  channelId?: string;
  channelIds?: readonly string[];
  status: LiveRoute["status"];
  replay: LiveRoute["replay"];
  error?: string;
  wire?: string;
  count: number;
  since: number;
  liveOnly?: boolean;
  previous?: Route;
  retryRenewal?: boolean;
  quotaRetries: number;
  /** Consecutive refusals that need action, and when the recover tick may retry. */
  refusals?: number;
  retryAt?: number;
  deadline?: ReturnType<typeof setTimeout>;
};
export const CHANNEL_KINDS = [
  9, 40002, 40008, 45001, 45003, 40099, 40100, 40003, 5, 9005, 7, 39000, 39002,
  39005, 20002, 45010, 48100, 48101, 48102, 48103,
];
/** The browser socket and native header-capable facade share only frame transport. */
export interface LiveSocket {
  readonly readyState: number;
  readonly connectionTimeoutMs?: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(data: string): void;
  close(): void;
}
/** One authenticated socket, bounded joined-channel batches, singleton previews and two globals.
 * Recent replay is opportunistic: finite reads own catch-up and history bounds. */
export function subscribeRelayTraffic(
  url: string,
  sign: (event: EventTemplate) => Promise<VerifiedEvent>,
  viewer: string,
  callbacks: LiveCallbacks,
  socketFactory: (url: string) => LiveSocket = (url) => new WebSocket(url),
  admission: LiveAdmission = createLiveAdmission(),
  setupConcurrency = SETUP_CONCURRENCY,
  setupTimeoutMs = SETUP_TIMEOUT_MS,
): LiveSubscription {
  const log = getLogger("relay-ws");
  const peer = relayLabel(url);
  let closed = false;
  let socket: LiveSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = BASE_RECONNECT_DELAY;
  let authFailures = 0;
  let generation = 0,
    serial = 0;
  let authenticated = false;
  // Whether the relay sent anything since the last recovery tick, the probe
  // that asks it to when it did not, and the current socket's reconnect.
  let heard = false;
  let probe: string | undefined;
  let unresponsive: ((reason: string) => void) | undefined;
  // A policy close (1008) gets one fresh-evidence reconnect; only NIP-42
  // admission restores it, so a post-admission denial cannot loop.
  let policyRecovery = true;
  let connection: LiveSnapshot["status"] = "connecting";
  let connectionError: string | undefined;
  let interests: string[] = [];
  let joined: string[] = [];
  // Keep denial callbacks in one scheduling transaction; updates can retire
  // individual lifetimes without admitting a replacement mid-denial.
  let denying: Set<string> | undefined;
  let priority: string[] = [];
  let observer: number | null = null;
  let presenceAuthors: readonly string[] = [];
  let presenceReceipt:
    | { id: string; finish(accepted: boolean): void }
    | undefined;
  const routes = new Map<string, Route>();
  const wires = new Map<string, Route>();
  type SyncWire = {
    filter: ArtifactSyncFilter;
    sink: ArtifactSyncSink;
    wire?: string;
  };
  const syncs = new Set<SyncWire>();
  const syncWires = new Map<string, SyncWire>();
  function endSync(sync: SyncWire, reason: string) {
    if (!syncs.delete(sync)) return;
    if (sync.wire) syncWires.delete(sync.wire);
    sync.sink.closed(reason);
  }
  const notify = () => {
    admission.setup(
      routes,
      !closed &&
        connection !== "error" &&
        [...routes.values()].some((route) => route.status === "pending"),
    );
    if (closed) return;
    callbacks.state(
      Object.freeze({
        status: connection,
        routes: Object.freeze(
          [...routes.values()].flatMap(
            ({ id, channelId, channelIds, status, replay, error }) =>
              (channelIds ?? [channelId]).map((channelId) =>
                Object.freeze({
                  id: channelId ? `channel:${channelId}` : id,
                  ...(channelId ? { channelId } : {}),
                  status,
                  replay,
                  ...(error ? { error } : {}),
                }),
              ),
          ),
        ),
        ...(connectionError ? { error: connectionError } : {}),
      }),
    );
  };
  const send = (value: unknown) => {
    if (!closed && socket?.readyState === 1) {
      const raw = JSON.stringify(value);
      socket.send(raw);
      logSocketFrame(peer, "→", raw, value);
    }
  };
  const requests = createSocketPublications(() => queueMicrotask(pump));
  function closeWire(route: Route) {
    clearTimeout(route.deadline);
    if (route.wire) {
      wires.delete(route.wire); // Fence before CLOSE, including reentrant callbacks.
      send(["CLOSE", route.wire]);
      delete route.wire;
    }
    if (route.previous) closeWire(route.previous);
    delete route.previous;
  }
  function remove(route: Route) {
    closeWire(route);
    routes.delete(route.id);
  }
  const scope = (route: Route) =>
    route.channelIds ?? (route.channelId ? [route.channelId] : []);
  function replace(route: Route, ids = scope(route)) {
    // A sent replacement is not yet established. Keep the established source
    // through repeated removals; retire the pending intermediate, not a survivor.
    const previous = route.previous ?? (route.wire ? route : undefined);
    delete route.previous;
    if (previous !== route) closeWire(route); // Never retain a third wire.
    clearTimeout(route.deadline);
    const next: Route = {
      ...route,
      ...(route.channelIds ? { channelIds: ids } : {}),
      status: "pending",
      liveOnly: true,
      count: 0,
      quotaRetries: 0,
      ...(previous ? { previous } : {}),
    };
    delete next.wire;
    delete next.deadline;
    delete next.retryRenewal;
    routes.set(next.id, next);
    return next;
  }
  function recover() {
    if (closed || !authenticated) return;
    // An open socket can stop delivering without an error or close, and its
    // routes then only time out. A minute of silence asks for an empty answer;
    // no answer at all means the socket is dead, so replace it. A probe is a
    // request too: during a relay cooldown it waits for a later silent minute.
    if (!heard && !admission.delay()) {
      if (probe) send(["CLOSE", probe]);
      probe = `probe-${++serial}`;
      send(["REQ", probe, { kinds: [44100], "#p": [viewer], limit: 0 }]);
      clearTimeout(deadline);
      deadline = setTimeout(
        () => unresponsive?.("Live connection stopped answering"),
        setupTimeoutMs,
      );
    }
    heard = false;
    // A minute authenticated restores prompt recovery for the next rollout;
    // opening/authenticating alone must not reset backoff on a flapping relay.
    reconnectDelay = BASE_RECONNECT_DELAY;
    const current = generation;
    // Only multi-channel scopes can be silently pruned by this relay. Singleton
    // preview/legacy callers retain their existing CLOSED/retry behavior.
    for (const route of routes.values()) {
      if (route.channelIds && route.status === "live" && !route.previous)
        replace(route);
      else if (
        route.status === "error" &&
        route.retryRenewal &&
        route.previous?.wire
      ) {
        route.status = "pending";
        delete route.retryRenewal;
      } else if (
        route.status === "error" &&
        route.retryAt !== undefined &&
        route.retryAt <= Date.now()
      ) {
        route.status = "pending";
        delete route.retryAt;
      }
    }
    pump();
    notify();
    if (closed || generation !== current) return;
    try {
      callbacks.recover?.();
    } catch (error) {
      // The chain must outlive a failing hook: log it and keep recovering.
      log.error(`${peer} live recovery hook failed`, error);
    }
    if (!closed && authenticated && generation === current)
      recoveryTimer = setTimeout(recover, LIVE_RECOVERY_INTERVAL);
  }
  function sync() {
    if (denying || closed) return;
    const ranked = [
      ...new Set([
        ...priority.filter((id) => interests.includes(id)),
        ...interests,
      ]),
    ];
    const admitted = new Set(
      ranked.slice(
        0,
        LIVE_CHANNEL_CAPACITY -
          (observer !== null ? 1 : 0) -
          (presenceAuthors.length ? 1 : 0),
      ),
    );
    const remaining = new Set(interests);
    const globals = new Set([
      "profiles",
      "membership",
      ...(observer !== null ? ["observer"] : []),
      ...(presenceAuthors.length ? ["presence"] : []),
    ]);
    // Scope is immutable for a wire. Retirement rebuilds only the affected batch;
    // navigation is scheduling, never a reason to rebalance healthy subscriptions.
    for (const route of routes.values()) {
      const ids = scope(route);
      if (
        ids.length
          ? ids.some(
              (id) =>
                !remaining.has(id) ||
                (route.status === "limited") === admitted.has(id) ||
                (!!route.channelIds && !joined.includes(id)),
            )
          : !globals.has(route.id)
      ) {
        const survivors = ids.filter(
          (id) => remaining.has(id) && admitted.has(id) && joined.includes(id),
        );
        if (
          route.channelIds &&
          survivors.length &&
          (route.status === "live" || route.liveOnly)
        ) {
          replace(route, survivors);
          for (const id of survivors) remaining.delete(id);
        } else remove(route);
      } else {
        for (const id of ids) remaining.delete(id);
        globals.delete(route.id);
      }
    }
    const add = (id: string, ids: readonly string[] = [], batch = false) => {
      const route: Route = {
        id,
        ...(batch ? { channelIds: ids } : ids[0] ? { channelId: ids[0] } : {}),
        status: "pending",
        replay: "unknown",
        count: 0,
        quotaRetries: 0,
        since: Math.floor(Date.now() / 1000) - 300,
      };
      routes.set(id, route);
      return route;
    };
    for (const id of globals) {
      const route = add(id);
      if (id === "presence") route.liveOnly = true;
    }
    const batch: string[] = [];
    for (const id of remaining) {
      if (!admitted.has(id)) {
        const route = add(`channel:${id}`, [id]);
        route.status = "limited";
        route.error =
          "Live channel capacity reached; finite reads remain available";
      } else if (!joined.includes(id) || priority.includes(id))
        add(`channel:${id}`, [id]);
      else batch.push(id);
    }
    for (let i = 0; i < batch.length; i += LIVE_BATCH_SIZE)
      add(`batch:${++serial}`, batch.slice(i, i + LIVE_BATCH_SIZE), true);
    pump();
    notify();
  }
  /** A stop waits for manual Retry, so an earlier refusal's deadline must not revive it. */
  function stop(route: Route, reason: string) {
    route.status = "error";
    route.error = reason;
    delete route.retryAt;
  }
  function fail(route: Route, reason: string, transient = false) {
    const denial = reason === "restricted: not a channel member";
    const previous = route.previous;
    // Only an established, unchanged scope may outlive a failed renewal. Never
    // restore a retired channel lifetime or bypass denial cleanup.
    const retain =
      transient &&
      previous?.status === "live" &&
      previous.wire &&
      wires.get(previous.wire) === previous &&
      JSON.stringify(scope(previous)) === JSON.stringify(scope(route));
    if (retain) delete route.previous;
    closeWire(route);
    delete route.retryRenewal;
    delete route.retryAt;
    if (retain) {
      route.previous = previous;
      // Quota owns its existing bounded retries; the minute timer cannot reset it.
      route.retryRenewal = !reason.startsWith("rate-limited:");
    }
    route.status = "error";
    route.error = reason;
    // A denial belongs to the session's membership flow. Any other refusal can
    // still clear, so the recover tick retries it with backoff.
    if (!transient && !denial) {
      route.refusals = (route.refusals ?? 0) + 1;
      route.retryAt = Date.now() + liveSlowRetryDelay(route.refusals);
    }
    if (reason.startsWith("rate-limited:")) {
      const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
        reason,
      );
      const seconds = hint ? Number(hint[1]) : 5;
      if (!Number.isSafeInteger(seconds) || seconds > 60) {
        for (const queued of routes.values())
          if (queued.status === "pending" && !queued.wire)
            stop(queued, "Unsupported live cooldown; automatic setup stopped");
        // Conservative shared pause survives replacement; never overflow a timer.
        admission.pause(
          Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
        );
      } else {
        admission.pause(seconds);
        if (++route.quotaRetries <= MAX_QUOTA_RETRIES) route.status = "pending";
        else {
          // Stop the unsent queue too: rejection must never drain it into an exhausted budget.
          for (const queued of routes.values())
            if (queued.status === "pending" && !queued.wire)
              stop(
                queued,
                "Live request cooldown retries exhausted; retry available",
              );
        }
      }
    }
    if (denial) {
      const current = generation;
      const denied = new Set(scope(route));
      denying = denied;
      try {
        notify();
        for (const id of denied) {
          if (closed || generation !== current) break;
          callbacks.denied(id, reason);
        }
      } finally {
        denying = undefined;
        sync();
      }
    } else notify();
    pump();
  }
  function pump() {
    clearTimeout(dispatchTimer);
    if (closed || denying || !authenticated || socket?.readyState !== 1) return;
    for (let request = requests.next(); request; request = requests.next()) {
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        return;
      }
      requests.dispatch(request, send);
    }
    for (const sync of syncs) {
      if (sync.wire) continue;
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        return;
      }
      sync.wire = `sync-${++serial}`;
      syncWires.set(sync.wire, sync);
      send(["REQ", sync.wire, sync.filter]);
    }
    let active = [...routes.values()].filter(
      (route) => route.wire && route.status === "pending",
    ).length;
    const rank = (route: Route) =>
      !scope(route).length
        ? -2
        : Math.min(
            priority.length,
            ...scope(route).map((id) =>
              priority.includes(id) ? priority.indexOf(id) : priority.length,
            ),
          );
    for (const route of [...routes.values()].sort(
      (a, b) => rank(a) - rank(b),
    )) {
      if (active >= setupConcurrency) break;
      if (route.status !== "pending" || route.wire) continue;
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        break;
      }
      // A retry being sent is not recovery. Retain its last failure until EOSE.
      const wire = `live-${++serial}`;
      route.wire = wire;
      wires.set(wire, route);
      route.deadline = setTimeout(() => {
        if (wires.get(wire) === route)
          fail(
            route,
            "Live subscription setup timed out; retry available",
            true,
          );
      }, setupTimeoutMs);
      active++;
      if (route.id === "observer") route.since = Math.floor(Date.now() / 1000);
      const filters = scope(route).length
        ? (route.liveOnly
            ? [scope(route)]
            : scope(route).map((id) => [id])
          ).map((ids) => ({ kinds: CHANNEL_KINDS, "#h": ids }))
        : route.id === "presence"
          ? [{ kinds: [20001], authors: presenceAuthors }]
          : route.id === "profiles"
            ? [{ kinds: [0, 10100, 30177] }]
            : route.id === "observer"
              ? [{ kinds: [OBSERVER_KIND], "#p": [viewer] }]
              : [
                  { kinds: [44100, 44101], "#p": [viewer] },
                  // NIP-CL: the relay sends a system channel's notices only
                  // to a filter that asks for them with #t.
                  { kinds: [44100, 44101], "#p": [viewer], "#t": ["system"] },
                ];
      send([
        "REQ",
        wire,
        ...filters.map((filter) => ({
          ...filter,
          // Each channel retains its original replay allowance. Replacements
          // are live-only on every actual dispatch, including cooldown retries.
          since: route.since,
          ...(route.id === "observer"
            ? {}
            : { limit: route.liveOnly ? 0 : LIVE_REPLAY_LIMIT }),
        })),
        ...(route.id === "membership"
          ? [
              {
                kinds: [30078],
                authors: [viewer],
                "#t": ["read-state"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
              // Edits from another device; history and due times come from the reader.
              {
                kinds: [30300],
                authors: [viewer],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
        ...(route.id === "profiles"
          ? [
              {
                kinds: [30315],
                "#d": ["general"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
              {
                kinds: [30030],
                "#d": [EMOJI_SET],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
      ]);
    }
  }
  function clearSocket() {
    generation++;
    authenticated = false;
    presenceReceipt?.finish(false);
    admission.setup(routes, false);
    clearTimeout(dispatchTimer);
    clearTimeout(recoveryTimer);
    clearTimeout(deadline);
    for (const route of routes.values()) clearTimeout(route.deadline);
    wires.clear();
    requests.clear();
    // A sync has no resume: every sent one ends; unsent ones wait for the next socket.
    const lost = [...syncs].filter((sync) => sync.wire);
    syncWires.clear();
    for (const sync of lost)
      endSync(sync, "disconnected: live connection lost");
    if (socket) log.info(`${peer} disconnect`);
    socket?.close();
    socket = undefined;
  }
  function connect() {
    if (closed) return;
    clearSocket();
    routes.clear();
    connection = "connecting";
    connectionError = undefined;
    sync();
    const current = generation;
    const valid = () => !closed && current === generation;
    heard = false;
    probe = undefined;
    const reconnect = (reason: string) => {
      if (!valid()) return;
      log.warn(`${peer} ${reason}`);
      clearSocket();
      connection = "retrying";
      connectionError = reason;
      for (const route of routes.values())
        if (route.status !== "limited") route.status = "pending";
      notify();
      // Transient outages must recover without manual retry. Equal jitter
      // spreads reconnects while retaining a minimum delay under sustained failure.
      const delay = reconnectDelay * (0.5 + Math.random() / 2);
      reconnectDelay = Math.min(MAX_RECONNECT_DELAY, reconnectDelay * 2);
      retryTimer = setTimeout(connect, delay);
    };
    unresponsive = reconnect;
    // The error stays in state. Recovery treats it as settled, so only this
    // slow timer retries it; a signer/viewer mismatch cannot clear and never does.
    const terminal = (reason: string, retryable = true) => {
      if (!valid()) return;
      log.error(`${peer} ${reason}`);
      clearSocket();
      connection = "error";
      connectionError = reason;
      notify();
      if (retryable)
        retryTimer = setTimeout(connect, liveSlowRetryDelay(++authFailures));
    };
    let ws: LiveSocket;
    try {
      log.info(`${peer} connecting`);
      ws = socketFactory(url);
      socket = ws;
    } catch {
      reconnect("Live connection unavailable");
      return;
    }
    let authId: string | undefined;
    let authenticating = false;
    deadline = setTimeout(
      () => reconnect("Live authentication timed out"),
      ws.connectionTimeoutMs ?? 10000,
    );
    ws.onopen = () => {
      if (!valid()) return;
      log.info(`${peer} connected`);
      if (ws.connectionTimeoutMs !== undefined) {
        clearTimeout(deadline);
        deadline = setTimeout(
          () => reconnect("Live authentication timed out"),
          10000,
        );
      }
    };
    ws.onmessage = async (event) => {
      if (!valid()) return;
      if (authenticated) {
        // Any frame proves the socket still reaches the relay.
        heard = true;
        clearTimeout(deadline);
      }
      if (typeof event.data !== "string" || event.data.length > 1024 * 1024) {
        logSocketFrame(peer, "←", event.data);
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        logSocketFrame(peer, "←", event.data);
        return;
      }
      logSocketFrame(peer, "←", event.data, data);
      if (!Array.isArray(data)) return;
      if (
        probe &&
        data[1] === probe &&
        (data[0] === "EOSE" || data[0] === "CLOSED")
      ) {
        if (data[0] === "EOSE") send(["CLOSE", probe]);
        else if (
          typeof data[2] === "string" &&
          data[2].startsWith("rate-limited:")
        ) {
          const hint = /retry in (\d+)s$/.exec(data[2]);
          admission.pause(hint ? Math.min(Number(hint[1]), 86400) : 5);
        }
        probe = undefined;
        return;
      }
      if (
        data[0] === "AUTH" &&
        typeof data[1] === "string" &&
        !authenticating
      ) {
        authenticating = true;
        try {
          const auth = await sign({
            kind: 22242,
            content: "",
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["relay", url],
              ["challenge", data[1]],
            ],
          });
          if (!valid()) return;
          if (auth.pubkey !== viewer) {
            terminal("Live signer does not match viewer", false);
            return;
          }
          authId = auth.id;
          send(["AUTH", auth]);
        } catch {
          terminal("Live authentication signing failed");
        }
        return;
      }
      if (data[0] === "OK" && authId && data[1] === authId && !authenticated) {
        if (data[2] !== true) {
          terminal("Relay rejected live authentication");
          return;
        }
        clearTimeout(deadline);
        authenticated = true;
        authFailures = 0;
        policyRecovery = true;
        connection = "connected";
        recoveryTimer = setTimeout(recover, LIVE_RECOVERY_INTERVAL);
        pump();
        notify();
        return;
      }
      if (data[0] === "OK" && presenceReceipt?.id === data[1]) {
        if (
          data[2] === false &&
          typeof data[3] === "string" &&
          data[3].startsWith("rate-limited:")
        ) {
          const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
            data[3],
          );
          const seconds = hint ? Number(hint[1]) : 86400;
          admission.pause(
            Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
          );
        }
        presenceReceipt?.finish(data[2] === true);
        return;
      }
      if (authenticated && requests.receive(data)) {
        if (data[2] === false) {
          const reason = data[3];
          if (
            typeof reason === "string" &&
            reason.startsWith("rate-limited:")
          ) {
            const hint = /retry in (\d+)s$/.exec(reason);
            admission.pause(hint ? Math.min(Number(hint[1]), 86400) : 5);
          }
        }
        return;
      }
      const sync =
        typeof data[1] === "string" ? syncWires.get(data[1]) : undefined;
      if (sync) {
        if (!authenticated) return;
        if (data[0] === "EVENT") {
          let incoming: VerifiedEvent;
          try {
            incoming = eventDto(data[2]);
          } catch {
            send(["CLOSE", data[1]]);
            endSync(sync, "error: relay supplied an invalid event");
            return;
          }
          sync.sink.event(incoming);
        } else if (data[0] === "EOSE") sync.sink.eose();
        else if (data[0] === "CLOSED") {
          const reason =
            typeof data[2] === "string"
              ? data[2].slice(0, 512)
              : "error: relay closed the sync";
          // The quota is shared: the view's restart and every other queued
          // dispatch wait for the server cooldown.
          if (reason.startsWith("rate-limited:")) {
            const hint = /retry in (\d+)s$/.exec(reason);
            admission.pause(hint ? Math.min(Number(hint[1]), 86400) : 5);
          }
          endSync(sync, reason);
        }
        return;
      }
      const route =
        typeof data[1] === "string" ? wires.get(data[1]) : undefined;
      if (!authenticated || !route) return;
      const currentRoute = routes.get(route.id);
      const previous = currentRoute?.previous === route;
      if (currentRoute !== route && !previous) return;
      if (previous && data[0] !== "EVENT") {
        if (data[0] === "CLOSED") {
          closeWire(route);
          delete currentRoute.previous;
        }
        return;
      }
      if (data[0] === "EVENT") {
        let incoming: VerifiedEvent;
        try {
          incoming = eventDto(data[2]);
        } catch {
          // One undecodable event must not take the route (or its batch) down.
          log.warn(`${peer} dropped an undecodable live event`);
          return;
        }
        const ids = scope(route);
        const tags = incoming.tags.filter(([name]) => name === "h");
        const destination =
          tags.length === 1
            ? tags[0]?.[1]
            : !tags.length && [39000, 39002].includes(incoming.kind)
              ? incoming.tags.find(([name]) => name === "d")?.[1]
              : undefined;
        const channelId =
          destination && ids.includes(destination)
            ? destination
            : !tags.length && route.channelId
              ? route.channelId
              : undefined;
        if (
          ids.length &&
          tags.length &&
          !tags.some(([, id]) => id && ids.includes(id))
        )
          return;
        if (previous) {
          const retained = scope(currentRoute);
          // Untagged auxiliary events cannot inherit a narrowed scope. Preserve
          // the original source fence; the replacement can deliver fresh copies.
          if (
            channelId
              ? !retained.includes(channelId)
              : ids.some((id) => !retained.includes(id))
          )
            return;
        }
        // The session still verifies access and auxiliary target evidence.
        if (incoming.kind === 20002 && !channelId) return;
        if (route.status === "pending" && !route.liveOnly) route.count++;
        if (route.id === "presence") {
          if (
            incoming.kind === 20001 &&
            presenceAuthors.includes(incoming.pubkey)
          )
            callbacks.presence?.(incoming);
        } else if (route.id === "observer") {
          if (
            observer !== null &&
            incoming.kind === OBSERVER_KIND &&
            incoming.created_at >= route.since
          )
            callbacks.telemetry?.(incoming, observer);
        } else if (incoming.kind !== OBSERVER_KIND)
          callbacks.receive(
            [incoming],
            Object.freeze({
              phase:
                route.liveOnly || route.status === "live" ? "live" : "replay",
              ...(channelId
                ? { channelId }
                : ids.length
                  ? { sourceChannels: ids }
                  : {}),
            }),
          );
      } else if (data[0] === "EOSE" && route.status === "pending") {
        clearTimeout(route.deadline);
        if (route.previous) closeWire(route.previous);
        delete route.previous;
        route.status = "live";
        delete route.error;
        delete route.refusals;
        route.replay = route.count >= LIVE_REPLAY_LIMIT ? "limited" : "unknown";
        notify();
        if (!valid() || wires.get(route.wire ?? "") !== route) return;
        if (route.id !== "observer" && route.id !== "presence")
          callbacks.established(route.channelIds ?? route.channelId);
        if (valid()) pump();
      } else if (data[0] === "CLOSED") {
        const reason =
          typeof data[2] === "string"
            ? data[2].slice(0, 512)
            : "Relay closed live subscription";
        fail(
          route,
          reason,
          reason.startsWith("rate-limited:") || reason.startsWith("error:"),
        );
      }
    };
    ws.onerror = (event) => {
      const failure = event as Event & { terminal?: boolean; message?: string };
      if (failure.terminal)
        terminal(
          failure.message || "Federated relay authorization unavailable",
          false,
        );
      else reconnect("Live connection interrupted");
    };
    // Keep the relay's close detail. A 1008 also ends a normally expired
    // assertion, so the first reconnects with fresh evidence. The relay denies
    // after the upgrade and NIP-42, so a second 1008 before admission stops.
    ws.onclose = (event) => {
      // A replaced socket's late close must not spend the current budget.
      if (!valid()) return;
      const reason = event?.code
        ? `Live connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`
        : "Live connection closed";
      if (event?.code !== 1008) return reconnect(reason);
      if (!policyRecovery) return terminal(reason, false);
      policyRecovery = false;
      reconnect(reason);
    };
  }
  connect();
  return {
    syncArtifacts(filter, sink) {
      const sync: SyncWire = { filter, sink };
      if (closed) {
        queueMicrotask(() =>
          sink.closed("unsupported: relay session disposed"),
        );
        return () => {};
      }
      syncs.add(sync);
      queueMicrotask(pump);
      return () => {
        if (!syncs.delete(sync)) return;
        if (sync.wire) {
          syncWires.delete(sync.wire);
          send(["CLOSE", sync.wire]);
        }
      };
    },
    watchPresence(authors) {
      const next = livePresenceAuthors(authors);
      if (closed || JSON.stringify(next) === JSON.stringify(presenceAuthors))
        return;
      presenceAuthors = next;
      const route = routes.get("presence");
      if (route) {
        if (next.length) replace(route);
        else remove(route);
      }
      sync();
    },
    async publishPresence(status, signal) {
      if (
        (status !== "online" && status !== "away" && status !== "offline") ||
        signal.aborted ||
        closed ||
        !authenticated
      )
        return null;
      const release = admission.tryPresence();
      // Busy alone is not a retry deadline; only actual gates get boundary retries.
      if (!release)
        return admission.presenceReady()
          ? null
          : { retryAfterMs: admission.presenceDelay() };
      const current = generation;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      try {
        const event = eventDto(
          await sign({
            kind: 20001,
            content: status,
            tags: [],
            created_at: Math.floor(Date.now() / 1000),
          }),
        );
        if (
          bounded.aborted ||
          closed ||
          current !== generation ||
          !authenticated ||
          socket?.readyState !== 1
        )
          return null;
        if (!admission.presenceReady())
          return { retryAfterMs: admission.presenceDelay() };
        if (
          event.pubkey !== viewer ||
          event.kind !== 20001 ||
          event.content !== status ||
          event.tags.length
        )
          throw new Error("Presence signer changed intent");
        return await new Promise<boolean>((resolve, reject) => {
          const finish = (accepted: boolean) => {
            clearTimeout(receiptTimeout);
            presenceReceipt = undefined;
            resolve(accepted);
          };
          // Once sent, retain the correlated receipt even if the caller leaves:
          // a late quota refusal still belongs to the shared host cooldown.
          const receiptTimeout = setTimeout(() => finish(false), 10000);
          presenceReceipt = { id: event.id, finish };
          try {
            admission.presenceSent();
            send(["EVENT", event]);
          } catch (error) {
            finish(false);
            reject(error);
          }
        });
      } finally {
        release();
      }
    },
    publish(event, signal) {
      if (closed)
        return Promise.reject(
          new SocketRequestError("Relay session disposed", false),
        );
      if (event.pubkey !== viewer)
        return Promise.reject(
          new SocketRequestError(
            "Publication signer does not match viewer",
            false,
          ),
        );
      return requests.publish(event, signal);
    },
    observe(value) {
      const next = observerGeneration(value);
      if (closed || observer === next) return;
      observer = next;
      const route = routes.get("observer");
      if (route) remove(route); // Fence the old wire before enabling a new generation.
      sync();
    },
    prioritize(input) {
      liveChannels(input); // Same bounded ID validation, but preserve demand order.
      priority = [...new Set(input)].slice(0, 64);
      if (!closed) sync();
    },
    update(input, batchable = []) {
      const next = liveChannels(input);
      const nextJoined = liveJoined(next, batchable);
      if (
        closed ||
        (JSON.stringify(next) === JSON.stringify(interests) &&
          JSON.stringify(nextJoined) === JSON.stringify(joined))
      )
        return;
      for (const id of denying ?? [])
        if (
          !next.includes(id) ||
          joined.includes(id) !== nextJoined.includes(id)
        )
          denying?.delete(id);
      interests = next;
      joined = nextJoined;
      sync();
    },
    retry() {
      if (closed) return;
      clearTimeout(retryTimer);
      reconnectDelay = BASE_RECONNECT_DELAY;
      if (authenticated) {
        for (const route of routes.values()) {
          if (route.status !== "error") continue;
          route.status = "pending";
          route.count = 0;
          route.quotaRetries = 0;
        }
        pump();
        notify();
      } else connect();
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      const ending = [...syncs];
      syncs.clear();
      clearSocket();
      routes.clear();
      for (const sync of ending)
        sync.sink.closed("unsupported: relay session disposed");
    },
  };
}
