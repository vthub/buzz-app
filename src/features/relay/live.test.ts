import { getLogger, setLogLevel } from "../developer/logging";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { assert, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createLiveAdmission,
  liveChannels,
  liveReconnectDelay,
  liveResumeSince,
  SETUP_TIMEOUT_MS,
  liveSlowRetryDelay,
  subscribeRelayTraffic,
  type LiveCallbacks,
} from "./live";
import { keypair, message, roster, signed, scriptedTransport } from "./testing";
import { createRelaySession } from "./session";
import { liveRecoveryStatus } from "./live-recovery";
import { createPresence } from "../presence/presence";
import { matchesEvent } from "./projection";
type WireFilter = {
  kinds: number[];
  "#h"?: string[];
  "#p"?: string[];
  since: number;
  limit: number;
};
type WireRequest = [string, string, WireFilter, ...WireFilter[]];
const filtersOf = (request: WireRequest) => request.slice(2) as WireFilter[];
const scopeOf = (request: WireRequest) =>
  filtersOf(request).flatMap((f) => f["#h"] ?? []);
const isProbe = (frame: unknown[]) =>
  typeof frame[1] === "string" && frame[1].startsWith("probe-");
class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: (event?: { code?: number | undefined }) => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  /** A responsive relay answers liveness probes; a silent one answers nothing. */
  silent = false;
  send(text: string) {
    const frame = JSON.parse(text);
    this.sent.push(frame);
    if (frame[0] === "REQ" && isProbe(frame) && !this.silent)
      queueMicrotask(() => void this.receive(["EOSE", frame[1]]));
  }
  close(code?: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
  /** Route requests; liveness probes are counted by `probes`. */
  requests() {
    return this.sent.filter(
      (entry) => entry[0] === "REQ" && !isProbe(entry),
    ) as WireRequest[];
  }
  probes() {
    return this.sent.filter((entry) => entry[0] === "REQ" && isProbe(entry));
  }
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const event = this.sent.find((entry) => entry[0] === "AUTH")?.[1] as {
      id: string;
    };
    await this.receive(["OK", event.id, true]);
  }
}
afterEach(() => vi.useRealTimers());
function setup(
  channels = ["a", "b"],
  admission = createLiveAdmission(),
  random?: () => number,
) {
  const key = keypair(),
    sockets: Socket[] = [];
  const callbacks = {
    presence: vi.fn(),
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  } satisfies LiveCallbacks;
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    key.pubkey,
    callbacks,
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    admission,
    undefined,
    undefined,
    random,
  );
  owner.update(channels);
  const first = sockets[0];
  assert.exists(first);
  return { key, sockets, callbacks, owner, first };
}
it("uses independent explicit channel routes and self-p globals; equal interests do not restart", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  expect(h.first.requests().map((r) => r[2])).toEqual([
    { kinds: [0, 10100, 30177], since: expect.any(Number), limit: 500 },
    {
      kinds: [44100, 44101],
      "#p": [h.key.pubkey],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: expect.arrayContaining([
        20002, 9, 40002, 40008, 40003, 7, 39002, 40099,
      ]),
      "#h": ["a"],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: expect.arrayContaining([9]),
      "#h": ["b"],
      since: expect.any(Number),
      limit: 500,
    },
  ]);
  // NIP-CL: system channel notices reach only a filter with #t:["system"].
  expect(h.first.requests()[1]?.[3]).toEqual({
    kinds: [44100, 44101],
    "#p": [h.key.pubkey],
    "#t": ["system"],
    since: expect.any(Number),
    limit: 500,
  });
  const before = h.first.sent.length;
  h.owner.update(["b", "a", "a"]);
  expect(h.first.sent).toHaveLength(before);
  const request = h.first.requests()[2];
  assert.exists(request);
  const event = message(keypair(), "a", "incoming", 1700000000);
  await h.first.receive(["EVENT", request[1], event]);
  await h.first.receive(["EOSE", request[1]]);
  expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
    phase: "replay",
    channelId: "a",
  });
  await h.first.receive(["EVENT", request[1], event]);
  expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
    phase: "live",
    channelId: "a",
  });
  expect(h.callbacks.established).toHaveBeenCalledWith("a");
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find(
      (r) => r.channelId === "a",
    ),
  ).toMatchObject({ status: "live", replay: "unknown" });
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])(
  "delivers artifact changes to session consumers through a batched route (%s)",
  async (batched) => {
    vi.useFakeTimers();
    const h = setup([]);
    const relay = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        return {
          ...h.owner,
          update: (ids, joined) => h.owner.update(ids, batched ? joined : []),
        };
      },
    });
    try {
      h.callbacks.receive(
        ["notes", "other"].map((id) => roster(relay, id, [h.key.pubkey])),
      );
      const receive = vi.fn();
      owner.session.subscribeLive(receive);
      await h.first.auth();
      const route = h.first
        .requests()
        .find((r) => scopeOf(r).includes("notes"));
      assert.exists(route);
      expect(scopeOf(route)).toHaveLength(batched ? 2 : 1);
      await h.first.receive(["EOSE", route[1]]);
      const author = keypair();
      const event = signed(author, {
        kind: 45010,
        created_at: Math.floor(Date.now() / 1000),
        content: '{"text":"Shared note"}',
        tags: [
          ["ar", "1"],
          ["h", "notes"],
          ["d", crypto.randomUUID()],
          ["type", "example.note"],
          ["title", "Note"],
          ["op", "create"],
        ],
      });
      expect(
        filtersOf(route).some((filter) => matchesEvent(event, filter)),
      ).toBe(true);
      await h.first.receive(["EVENT", route[1], event]);
      expect(receive).toHaveBeenCalledWith({
        events: [event],
        channelId: "notes",
      });
      h.callbacks.receive([roster(relay, "notes", [], event.created_at + 1)]);
      receive.mockClear();
      const afterRemoval = signed(author, {
        kind: event.kind,
        created_at: event.created_at + 2,
        content: '{"text":"After removal"}',
        tags: [
          ...event.tags.map((tag) =>
            tag[0] === "op" ? ["op", "update"] : tag,
          ),
          ["prev", event.id],
        ],
      });
      await h.first.receive(["EVENT", route[1], afterRemoval]);
      expect(receive).not.toHaveBeenCalled();
    } finally {
      owner.dispose();
    }
  },
);
it("batches joined background interests without rebalance and fences retired batch wires", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    const joined = Array.from(
      { length: 332 },
      (_, i) => `c${String(i).padStart(3, "0")}`,
    );
    h.owner.prioritize?.(["c331"]);
    h.owner.update([...joined, "preview"], joined);
    await h.first.auth();
    // Each EOSE is the setup completion barrier and releases the next slot.
    for (let i = 0; i < h.first.requests().length; i++)
      await h.first.receive(["EOSE", h.first.requests()[i]?.[1]]);
    const requests = h.first.requests();
    expect(requests).toHaveLength(38);
    const batches = requests.filter((r) => scopeOf(r).length > 1);
    expect(batches.map((r) => scopeOf(r).length)).toEqual(Array(33).fill(10));
    for (const r of requests) {
      expect(filtersOf(r).length).toBeLessThanOrEqual(10);
      for (const f of filtersOf(r))
        if (f["#h"]) {
          expect(f["#h"]).toHaveLength(1);
          expect(f.limit).toBe(500);
        }
    }
    expect(
      requests.filter((r) => scopeOf(r).length === 1).map(scopeOf),
    ).toEqual([["c331"], ["preview"], ["c330"]]);
    expect(h.callbacks.established).toHaveBeenCalledTimes(38);
    expect(h.callbacks.state.mock.lastCall?.[0].routes).toHaveLength(335);
    const batch = batches[0];
    assert.exists(batch);
    const first = message(h.key, "c000", "first", 1700000000);
    await h.first.receive(["EVENT", batch[1], first]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([first], {
      phase: "live",
      channelId: "c000",
    });
    const other = message(h.key, "preview", "wrong wire", 1700000001);
    h.callbacks.receive.mockClear();
    await h.first.receive(["EVENT", batch[1], other]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    const typing = signed(h.key, {
      kind: 20002,
      tags: [["h", "c001"]],
      content: "",
    });
    await h.first.receive(["EVENT", batch[1], typing]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([typing], {
      phase: "live",
      channelId: "c001",
    });
    h.owner.prioritize?.(["c001"]);
    expect(h.first.requests()).toHaveLength(38);
    const retained = joined.filter((id) => id !== "c000");
    h.owner.update([...retained, "preview"], retained);
    // Healthy survivors keep one scope and overlap the old wire until EOSE.
    expect(h.first.requests()).toHaveLength(39);
    const replacement = h.first.requests().at(-1);
    assert.exists(replacement);
    expect(replacement[2].limit).toBe(0);
    expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([]);
    await h.first.receive(["EOSE", replacement[1]]);
    expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([
      ["CLOSE", batch[1]],
    ]);
    h.callbacks.receive.mockClear();
    h.callbacks.established.mockClear();
    await h.first.receive(["EVENT", batch[1], first]);
    await h.first.receive(["EOSE", batch[1]]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    expect(h.callbacks.established).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

describe("per-channel replay allowance", () => {
  const now = 1_700_000_100;
  let hot: ReturnType<typeof message>[];
  beforeAll(() => {
    // Signing also verifies each signature. Keep large fixture construction
    // separate from the behavior budget; socket delivery still verifies all 501
    // distinct received events through the real live/session path.
    const author = keypair();
    hot = Array.from({ length: 501 }, (_, i) =>
      message(author, "hot", `hot-${i}`, now - 1),
    );
  });
  it("keeps quiet-channel unread evidence when another filter fills its replay allowance", async () => {
    vi.useFakeTimers({ now: now * 1000 });
    const h = setup([]);
    const relay = keypair(),
      author = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        return h.owner;
      },
    });
    try {
      const ids = ["hot", "quiet"];
      h.callbacks.receive(ids.map((id) => roster(relay, id, [h.key.pubkey])));
      await h.first.auth();
      const batch = h.first
        .requests()
        .find((r) => scopeOf(r).includes("quiet"));
      assert.exists(batch);
      const incoming = vi.fn();
      owner.session.subscribeIncoming(incoming);
      const quiet = signed(author, {
        kind: 9,
        content: "quiet mention",
        created_at: now - 100,
        tags: [
          ["h", "quiet"],
          ["p", h.key.pubkey],
        ],
      });
      const history = [quiet, ...hot];
      // Relay's existing OR contract applies each filter's limit separately.
      // The former multi-h filter loses quiet to the 500 newer hot events.
      const delivered = new Set<string>();
      for (const filter of filtersOf(batch)) {
        const matches = history
          .filter(
            (e) =>
              filter.kinds.includes(e.kind) &&
              e.created_at >= filter.since &&
              e.tags.some(
                ([k, v]) =>
                  k === "h" && v !== undefined && filter["#h"]?.includes(v),
              ),
          )
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit);
        for (const event of matches)
          if (!delivered.has(event.id)) {
            delivered.add(event.id);
            await h.first.receive(["EVENT", batch[1], event]);
          }
      }
      await h.first.receive(["EOSE", batch[1]]);
      expect(delivered.has(quiet.id)).toBe(true);
      expect(delivered.size).toBe(501);
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "hot" }),
      ).toMatchObject({ observedCount: 500, attentionCount: 0 });
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "quiet" }),
      ).toMatchObject({ observedCount: 1, attentionCount: 1 });
      expect(incoming).not.toHaveBeenCalled();
      // Aggregate replay evidence stays conservative for every logical channel.
      expect(
        h.callbacks.state.mock.lastCall?.[0].routes
          .filter((r) => r.channelId)
          .every((r) => r.replay === "limited"),
      ).toBe(true);
    } finally {
      owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("delivers verified live-phase events to subscribeLive, never replay", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const relay = keypair(),
    author = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      return h.owner;
    },
  });
  try {
    h.callbacks.receive([roster(relay, "a", [h.key.pubkey])]);
    await h.first.auth();
    const initial = h.first.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(initial);
    const live = vi.fn();
    owner.session.subscribeLive(live);
    await h.first.receive([
      "EVENT",
      initial[1],
      message(author, "a", "replayed", 1700000000),
    ]);
    await h.first.receive(["EOSE", initial[1]]);
    expect(live).not.toHaveBeenCalled();
    const fresh = message(author, "a", "fresh", 1700000002);
    await h.first.receive(["EVENT", initial[1], fresh]);
    expect(live).toHaveBeenCalledTimes(1);
    expect(live.mock.calls[0]?.[0]).toMatchObject({
      channelId: "a",
      events: [expect.objectContaining({ id: fresh.id })],
    });
  } finally {
    owner.dispose();
  }
});

it.each(["single", "chained"])(
  "preserves survivor alerts before replacement EOSE and deduplicates the overlapping live copy (%s removal)",
  async (removal) => {
    vi.useFakeTimers();
    const h = setup([]);
    const relay = keypair(),
      author = keypair();
    const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        h.callbacks.receive.mockImplementation(callbacks.receive);
        h.callbacks.state.mockImplementation(callbacks.state);
        return h.owner;
      },
    });
    try {
      h.callbacks.receive(
        ["a", "b", "c"].map((id) => roster(relay, id, [h.key.pubkey])),
      );
      await h.first.auth();
      const initial = h.first.requests().find((r) => scopeOf(r).length === 3);
      assert.exists(initial);
      expect(initial[2].limit).toBe(500);
      await h.first.receive(["EOSE", initial[1]]);
      const incoming = vi.fn();
      owner.session.subscribeIncoming(incoming);
      // Signed membership removes A through the real session's interest callback.
      await h.first.receive([
        "EVENT",
        initial[1],
        roster(relay, "a", [], 1700000001),
      ]);
      let replacement = h.first.requests().at(-1);
      assert.exists(replacement);
      expect(scopeOf(replacement)).toEqual(["b", "c"]);
      expect(filtersOf(replacement)).toEqual([
        expect.objectContaining({
          "#h": ["b", "c"],
          since: initial[2].since,
          limit: 0,
        }),
      ]);
      expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([]);
      if (removal === "chained") {
        const intermediate = replacement;
        // Hold both EOSEs. The original is still the only established source.
        await h.first.receive([
          "EVENT",
          initial[1],
          roster(relay, "b", [], 1700000001),
        ]);
        replacement = h.first.requests().at(-1);
        assert.exists(replacement);
        expect(replacement[2]).toMatchObject({
          "#h": ["c"],
          since: initial[2].since,
          limit: 0,
        });
        expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([
          ["CLOSE", intermediate[1]],
        ]);
        // Superseded EVENT/EOSE/CLOSED frames cannot retire or establish a source.
        h.callbacks.receive.mockClear();
        h.callbacks.established.mockClear();
        await h.first.receive([
          "EVENT",
          intermediate[1],
          message(author, "c", "superseded", 1700000002),
        ]);
        await h.first.receive(["EOSE", intermediate[1]]);
        await h.first.receive([
          "CLOSED",
          intermediate[1],
          "restricted: not a channel member",
        ]);
        expect(h.callbacks.receive).not.toHaveBeenCalled();
        expect(h.callbacks.established).not.toHaveBeenCalled();
        // Count at every sent frame, not only at the end of the handoff.
        const retained = new Set<unknown>();
        for (const [kind, id, filter] of h.first.sent) {
          if (kind === "REQ" && (filter as { "#h"?: string[] })["#h"])
            retained.add(id);
          if (kind === "CLOSE") retained.delete(id);
          expect(retained.size).toBeLessThanOrEqual(2);
        }
      }
      // Replacement-first and original-first orders both produce one incoming item.
      const firstChannel = removal === "chained" ? "c" : "b";
      for (const [first, second, id] of [
        [replacement[1], initial[1], firstChannel],
        [initial[1], replacement[1], "c"],
      ] as const) {
        const event = message(author, id, `fresh-${id}-${first}`, 1700000002);
        await h.first.receive(["EVENT", first, event]);
        await h.first.receive(["EVENT", second, event]);
      }
      expect(
        incoming.mock.calls.map(([events]) => events[0].channelId),
      ).toEqual([firstChannel, "c"]);
      h.callbacks.receive.mockClear();
      for (const id of removal === "chained" ? ["a", "b"] : ["a"])
        for (const source of [initial, replacement])
          await h.first.receive([
            "EVENT",
            source[1],
            message(author, id, "retired", 1700000003),
          ]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      // Re-adding A creates a new lifetime; the old scope must stay retired for A.
      h.callbacks.receive([roster(relay, "a", [h.key.pubkey], 1700000004)]);
      h.callbacks.receive.mockClear();
      await h.first.receive([
        "EVENT",
        initial[1],
        message(author, "a", "old lifetime", 1700000005),
      ]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      await h.first.receive(["EOSE", replacement[1]]);
      expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
    } finally {
      owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("renews with one bounded overlap and releases both wires on timeout and disposal", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const initial = h.first.requests()[2];
    assert.exists(initial);
    await vi.advanceTimersByTimeAsync(59999);
    expect(h.first.requests()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    const renewal = h.first.requests().at(-1);
    assert.exists(renewal);
    expect(h.first.requests()).toHaveLength(4);
    expect(scopeOf(renewal)).toEqual(["a", "b", "c"]);
    expect(filtersOf(renewal)).toEqual([
      expect.objectContaining({
        "#h": ["a", "b", "c"],
        kinds: initial[2].kinds,
        limit: 0,
        since: initial[2].since,
      }),
    ]);
    expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([]);
    const event = message(h.key, "b", "fresh", 1700000000);
    await h.first.receive(["EVENT", renewal[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      phase: "live",
      channelId: "b",
    });
    // Removal during a pending renewal never stacks a third retained wire.
    h.owner.update(["b", "c"], ["b", "c"]);
    const survivor = h.first.requests().at(-1);
    assert.exists(survivor);
    expect(h.first.sent.filter(([kind]) => kind === "CLOSE")).toEqual([
      ["CLOSE", renewal[1]],
    ]);
    h.callbacks.receive.mockClear();
    await h.first.receive(["EVENT", initial[1], event]);
    expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
      phase: "live",
      channelId: "b",
    });
    h.callbacks.receive.mockClear();
    await h.first.receive([
      "EVENT",
      initial[1],
      message(h.key, "a", "removed", 1700000001),
    ]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    await h.first.receive(["EOSE", renewal[1]]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.first.sent).toContainEqual(["CLOSE", survivor[1]]);
    expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes
        .filter((r) => r.channelId)
        .every((r) => r.status === "error"),
    ).toBe(true);
    h.owner.retry();
    const retry = h.first.requests().at(-1);
    assert.exists(retry);
    expect(filtersOf(retry)).toEqual(filtersOf(survivor));
    expect(filtersOf(retry)).toHaveLength(1);
    expect(retry[2]).toMatchObject({ "#h": ["b", "c"], limit: 0 });
    await h.first.receive([
      "CLOSED",
      retry[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    const quotaRetry = h.first.requests().at(-1);
    assert.exists(quotaRetry);
    expect(filtersOf(quotaRetry)).toEqual(filtersOf(retry));
    await h.first.receive(["EOSE", quotaRetry[1]]);
    await vi.advanceTimersByTimeAsync(47000);
    const nextRenewal = h.first.requests().at(-1);
    assert.exists(nextRenewal);
    expect(filtersOf(nextRenewal)).toEqual(filtersOf(retry));
  } finally {
    h.owner.dispose();
  }
  expect(h.first.readyState).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["timeout", "error: temporarily unavailable"])(
  "retains unchanged live coverage after renewal %s and retries on the minute boundary",
  async (failure) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      h.owner.update(["a", "b"], ["a", "b"]);
      await h.first.auth();
      for (const [, id] of h.first.requests())
        await h.first.receive(["EOSE", id]);
      const initial = h.first.requests()[2];
      assert.exists(initial);
      await vi.advanceTimersByTimeAsync(60000);
      const renewal = h.first.requests().at(-1);
      assert.exists(renewal);
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(10000);
      else await h.first.receive(["CLOSED", renewal[1], failure]);
      expect(h.first.sent).toContainEqual(["CLOSE", renewal[1]]);
      expect(h.first.sent).not.toContainEqual(["CLOSE", initial[1]]);
      expect(
        h.callbacks.state.mock.lastCall?.[0].routes.filter((r) => r.channelId),
      ).toEqual(
        ["a", "b"].map((channelId) =>
          expect.objectContaining({
            channelId,
            status: "error",
            error: expect.any(String),
          }),
        ),
      );
      const event = message(h.key, "b", "still live", 1700000001);
      h.callbacks.receive.mockClear();
      h.callbacks.established.mockClear();
      await h.first.receive(["EVENT", renewal[1], event]);
      await h.first.receive(["EOSE", renewal[1]]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      expect(h.callbacks.established).not.toHaveBeenCalled();
      await h.first.receive(["EVENT", initial[1], event]);
      expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
        phase: "live",
        channelId: "b",
      });
      await vi.advanceTimersByTimeAsync(failure === "timeout" ? 49999 : 59999);
      expect(h.first.requests()).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      const retry = h.first.requests().at(-1);
      assert.exists(retry);
      expect(h.first.requests()).toHaveLength(5);
      expect(filtersOf(retry)).toEqual(filtersOf(renewal));
      expect(
        h.callbacks.state.mock.lastCall?.[0].routes.find(
          (r) => r.channelId === "b",
        ),
      ).toMatchObject({ status: "pending", error: expect.any(String) });
      await h.first.receive(["EOSE", retry[1]]);
      expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
      const state = h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.channelId === "b",
      );
      expect(state?.status).toBe("live");
      expect(state?.error).toBeUndefined();
      h.callbacks.receive.mockClear();
      await h.first.receive(["EVENT", initial[1], event]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["recover", "exhaust", "unsupported"])(
  "retains coverage through renewal quota %s without resetting retry limits",
  async (outcome) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      h.owner.update(["a", "b"], ["a", "b"]);
      await h.first.auth();
      for (const [, id] of h.first.requests())
        await h.first.receive(["EOSE", id]);
      const initial = h.first.requests()[2];
      assert.exists(initial);
      await vi.advanceTimersByTimeAsync(60000);
      for (let i = 0; i < (outcome === "exhaust" ? 4 : 1); i++) {
        const renewal = h.first.requests().at(-1);
        assert.exists(renewal);
        const count = h.first.requests().length;
        await h.first.receive([
          "CLOSED",
          renewal[1],
          `rate-limited: quota exceeded; retry in ${outcome === "unsupported" ? 120 : 2}s`,
        ]);
        const event = message(
          h.key,
          "b",
          `during cooldown ${i}`,
          1700000001 + i,
        );
        await h.first.receive(["EVENT", initial[1], event]);
        expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
          phase: "live",
          channelId: "b",
        });
        expect(h.first.sent).not.toContainEqual(["CLOSE", initial[1]]);
        // Admission includes one safety second for the relay's rounded hint.
        await vi.advanceTimersByTimeAsync(2999);
        expect(h.first.requests()).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.first.requests()).toHaveLength(
          outcome === "unsupported" || i === 3 ? count : count + 1,
        );
      }
      if (outcome === "recover") {
        const retry = h.first.requests().at(-1);
        assert.exists(retry);
        await h.first.receive(["EOSE", retry[1]]);
        expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
      } else {
        const count = h.first.requests().length;
        await vi.advanceTimersByTimeAsync(180000);
        expect(h.first.requests()).toHaveLength(count);
        expect(
          h.callbacks.state.mock.lastCall?.[0].routes.find(
            (r) => r.channelId === "b",
          ),
        ).toMatchObject({
          status: "error",
          error: expect.stringContaining("rate-limited:"),
        });
        const event = message(h.key, "b", "after stopped retries", 1700000010);
        await h.first.receive(["EVENT", initial[1], event]);
        expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
          phase: "live",
          channelId: "b",
        });
        h.owner.retry();
        expect(h.first.requests()).toHaveLength(count + 1);
      }
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("replaces an open socket that stops answering and replays what it missed", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    // Writes still succeed, but nothing comes back: no error, no close.
    h.first.silent = true;
    await vi.advanceTimersByTimeAsync(60000);
    // Renewals were answered before this minute, so no probe yet.
    expect(h.first.probes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.first.probes()).toHaveLength(1);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
      status: "retrying",
      error: "Live connection stopped answering",
    });
    await vi.advanceTimersByTimeAsync(1000);
    const next = h.sockets[1];
    assert.exists(next);
    expect(h.first.readyState).toBe(3);
    await next.auth();
    // The new routes reach back past the silence, so its traffic replays.
    const silentSince = Math.floor(Date.now() / 1000) - 131;
    const batch = next.requests().find((r) => scopeOf(r).includes("b"));
    assert.exists(batch);
    expect(filtersOf(batch)[0]?.since).toBeLessThanOrEqual(silentSince);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a quiet socket that answers its probes", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    await vi.advanceTimersByTimeAsync(10 * 60000);
    expect(h.sockets).toHaveLength(1);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    // Each answered probe is closed, so none stays open on the relay.
    const probes = h.first.probes().map(([, id]) => id);
    expect(probes.length).toBeGreaterThan(0);
    for (const id of probes) expect(h.first.sent).toContainEqual(["CLOSE", id]);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a relay cooldown that a probe was refused with", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    h.first.silent = true;
    await vi.advanceTimersByTimeAsync(120000);
    const probe = h.first.probes().at(-1);
    assert.exists(probe);
    await h.first.receive([
      "CLOSED",
      probe[1],
      "rate-limited: quota exceeded; retry in 30s",
    ]);
    // The refusal is an answer, so the socket stays.
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    expect(h.sockets).toHaveLength(1);
    const count = h.first.requests().length;
    h.owner.update(["a", "b"]);
    await vi.advanceTimersByTimeAsync(20000 - SETUP_TIMEOUT_MS);
    expect(h.first.requests()).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(12000);
    expect(
      h.first.requests().filter((r) => scopeOf(r).includes("b")),
    ).not.toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("sends no probe while the relay asked it to wait", async () => {
  vi.useFakeTimers();
  const admission = createLiveAdmission();
  const h = setup(["a"], admission);
  try {
    await h.first.auth();
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    admission.pause(300);
    await vi.advanceTimersByTimeAsync(5 * 60000);
    expect(h.first.probes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.first.probes()).toHaveLength(1);
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["previous closed", "restricted: not a channel member"])(
  "does not preserve a renewal source after %s",
  async (failure) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      h.owner.update(["a", "b"], ["a", "b"]);
      await h.first.auth();
      for (const [, id] of h.first.requests())
        await h.first.receive(["EOSE", id]);
      const initial = h.first.requests()[2];
      assert.exists(initial);
      await vi.advanceTimersByTimeAsync(60000);
      const renewal = h.first.requests().at(-1);
      assert.exists(renewal);
      if (failure === "previous closed") {
        await h.first.receive(["CLOSED", initial[1], "error: closed"]);
        await vi.advanceTimersByTimeAsync(10000);
      } else await h.first.receive(["CLOSED", renewal[1], failure]);
      expect(h.first.sent).toContainEqual(["CLOSE", initial[1]]);
      expect(h.first.sent).toContainEqual(["CLOSE", renewal[1]]);
      const count = h.first.requests().length;
      await vi.advanceTimersByTimeAsync(120000);
      expect(h.first.requests()).toHaveLength(count);
      h.callbacks.receive.mockClear();
      await h.first.receive([
        "EVENT",
        initial[1],
        message(h.key, "b", "stale", 1700000001),
      ]);
      expect(h.callbacks.receive).not.toHaveBeenCalled();
      if (failure.startsWith("restricted:"))
        expect(h.callbacks.denied.mock.calls.map(([id]) => id)).toEqual([
          "a",
          "b",
        ]);
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

function captureLog() {
  const logger = getLogger("relay-ws");
  const reporters = [...logger.options.reporters];
  const lines: string[] = [];
  logger.setReporters([
    { log: (value) => lines.push(`${value.type} ${value.args.join(" ")}`) },
  ]);
  return {
    lines,
    restore: () => logger.setReporters(reporters),
  };
}

it("drops one undecodable event and keeps its batch route", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const log = captureLog();
  try {
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    const batch = h.first.requests().find((r) => scopeOf(r).length === 2);
    assert.exists(batch);
    await h.first.receive(["EVENT", batch[1], {}]);
    expect(log.lines).toEqual([
      "warn relay.test dropped an undecodable live event",
    ]);
    await h.first.receive(["EOSE", batch[1]]);
    const event = message(h.key, "a", "after the bad one", 1700000000);
    await h.first.receive(["EVENT", batch[1], event]);
    expect(h.callbacks.receive).toHaveBeenCalledWith(
      [event],
      expect.anything(),
    );
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes
        .filter((r) => r.channelId === "a" || r.channelId === "b")
        .map((r) => r.status),
    ).toEqual(["live", "live"]);
  } finally {
    log.restore();
    h.owner.dispose();
  }
});

it("retries a route closed with a needs-action reason on the recover tick, backing off, and resets once live", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a"], ["a"]);
    await h.first.auth();
    const route = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.channelId === "a",
      );
    const refuse = async () => {
      const request = h.first.requests().at(-1);
      assert.exists(request);
      await h.first.receive(["CLOSED", request[1], "auth-required: sign in"]);
      expect(route()).toMatchObject({
        status: "error",
        error: "auth-required: sign in",
      });
      return request;
    };
    // The first refusal waits one recover tick; each next one doubles.
    for (const wait of [60_000, 120_000, 240_000]) {
      const count = h.first.requests().length;
      await refuse();
      await vi.advanceTimersByTimeAsync(wait - 60_000 + 59_999);
      expect(h.first.requests()).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.first.requests()).toHaveLength(count + 1);
      // Retried routes keep showing the last refusal until EOSE.
      expect(route()).toMatchObject({
        status: "pending",
        error: "auth-required: sign in",
      });
    }
    const request = h.first.requests().at(-1);
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
    expect(route()?.status).toBe("live");
    const count = h.first.requests().length;
    await refuse();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.first.requests()).toHaveLength(count + 1);
    expect(liveSlowRetryDelay(1)).toBe(60_000);
    expect(liveSlowRetryDelay(100)).toBe(600_000);
  } finally {
    h.owner.dispose();
  }
});

it("a cooldown stop after a manual retry is not revived by the earlier refusal's deadline", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    const wire = (channel: string) =>
      h.first
        .requests()
        .filter((r) => (r[2] as { "#h"?: string[] })["#h"]?.[0] === channel);
    const [a] = wire("a");
    const [b] = wire("b");
    const [observer] = h.first.requests();
    assert.exists(a);
    assert.exists(b);
    assert.exists(observer);
    await h.first.receive(["CLOSED", a[1], "auth-required: sign in"]);
    // Hold the queue so the retried route waits for admission.
    await h.first.receive([
      "CLOSED",
      b[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    h.owner.retry();
    await h.first.receive([
      "CLOSED",
      observer[1],
      "rate-limited: quota exceeded; retry in 120s",
    ]);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.channelId === "a",
      ),
    ).toMatchObject({
      status: "error",
      error: "Unsupported live cooldown; automatic setup stopped",
    });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(wire("a")).toHaveLength(1);
    expect(wire("b")).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("keeps the recover tick running when its hook throws, and logs the failure", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const log = captureLog();
  const recover = vi.fn(() => {
    throw new Error("hook failed");
  });
  Object.assign(h.callbacks, { recover });
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(log.lines.filter((line) => line.startsWith("error "))).toHaveLength(
      3,
    );
  } finally {
    log.restore();
    h.owner.dispose();
  }
});

it("applies a batch denial through the session before rescheduling surviving interests", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const relay = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      h.callbacks.denied.mockImplementation(callbacks.denied);
      return h.owner;
    },
  });
  try {
    h.callbacks.receive(
      ["a", "b", "c"].map((id) => roster(relay, id, [h.key.pubkey])),
    );
    await h.first.auth();
    const batch = h.first.requests().find((r) => scopeOf(r).length === 3);
    assert.exists(batch);
    await h.first.receive([
      "CLOSED",
      batch[1],
      "restricted: not a channel member",
    ]);
    expect(owner.session.channels.list().channels).toEqual([]);
    expect(h.callbacks.denied.mock.calls.map(([id]) => id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(h.first.requests().filter((r) => r[2]["#h"])).toHaveLength(1);
  } finally {
    owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("batch denial does not cross a synchronous removal and re-addition", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    h.owner.update(["a", "b", "c"], ["a", "b", "c"]);
    await h.first.auth();
    const batch = h.first.requests().find((r) => scopeOf(r).length === 3);
    assert.exists(batch);
    h.callbacks.denied.mockImplementation((id) => {
      if (id === "a") {
        h.owner.update(["c"], ["c"]);
        h.owner.update(["b", "c"], ["b", "c"]);
      } else h.owner.update(["b"], ["b"]);
    });
    await h.first.receive([
      "CLOSED",
      batch[1],
      "restricted: not a channel member",
    ]);
    expect(h.callbacks.denied.mock.calls.map(([id]) => id)).toEqual(["a", "c"]);
    expect(
      h.first
        .requests()
        .filter((r) => r[2]["#h"])
        .map(scopeOf),
    ).toEqual([["a", "b", "c"], ["b"]]);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("isolates denial, fences removed/readded routes and late sockets, and disposes retries", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const a = h.first.requests()[2],
    b = h.first.requests()[3];
  assert.exists(a);
  assert.exists(b);
  await h.first.receive(["CLOSED", a[1], "restricted: not a channel member"]);
  expect(h.callbacks.denied).toHaveBeenCalledWith(
    "a",
    "restricted: not a channel member",
  );
  expect(h.first.readyState).toBe(1);
  await h.first.receive(["EOSE", b[1]]);
  h.owner.update(["b"]);
  h.owner.update(["a", "b"]);
  await vi.advanceTimersByTimeAsync(250);
  const fresh = h.first.requests().at(-1);
  assert.exists(fresh);
  expect(fresh[1]).not.toBe(a[1]);
  await h.first.receive(["EVENT", a[1], message(h.key, "a", "stale", 1)]);
  await h.first.receive(["CLOSED", a[1], "restricted: not a channel member"]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  expect(h.callbacks.denied).toHaveBeenCalledTimes(1);
  h.first.close();
  await vi.advanceTimersByTimeAsync(625);
  expect(h.sockets).toHaveLength(2);
  await h.first.receive(["EVENT", b[1], message(h.key, "b", "old socket", 2)]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  h.owner.dispose();
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.sockets).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("restores prompt reconnects after each healthy connection across repeated rollouts", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    for (let cycle = 0; cycle < 7; cycle++) {
      const socket = h.sockets[cycle];
      assert.exists(socket);
      await socket.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const request of socket.requests())
        await socket.receive(["EOSE", request[1]]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
      socket.close();
      await vi.advanceTimersByTimeAsync(625);
      expect(h.sockets).toHaveLength(cycle + 2);
    }
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, 0.5])(
  "keeps jittered recovery capped through auth flaps and a prolonged outage (random=%s)",
  async (sample) => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(sample);
    const h = setup([]);
    try {
      const ceilings = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000];
      for (const [cycle, ceiling] of ceilings.entries()) {
        const socket = h.sockets[cycle];
        assert.exists(socket);
        // Authentication alone must not reset backoff on a flapping relay.
        if (cycle < 4) await socket.auth();
        socket.close();
        const delay = ceiling * (0.75 + sample / 2);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(h.sockets).toHaveLength(cycle + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.sockets).toHaveLength(cycle + 2);
      }
      const recovered = h.sockets.at(-1);
      assert.exists(recovered);
      await recovered.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const request of recovered.requests())
        await recovered.receive(["EOSE", request[1]]);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
      expect(h.callbacks.established).toHaveBeenCalled();
      // Cancel a retry at the capped delay, not just the initial short delay.
      recovered.close();
      h.owner.dispose();
      await vi.advanceTimersByTimeAsync(60000);
      expect(h.sockets).toHaveLength(9);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.owner.dispose();
      random.mockRestore();
    }
  },
);

it.each([
  ["no cursor keeps the first-connect window", 1000, undefined, 1000],
  ["resumes a minute before the connection last heard", 1000, 1100, 1040],
  [
    "an outage longer than the window gets no more than a first connect",
    1000,
    1030,
    1000,
  ],
  ["a recent connection resumes close to its end", 1000, 2000, 1940],
] as const)("liveResumeSince: %s", (_name, floor, liveUntil, expected) => {
  expect(
    liveResumeSince(floor, liveUntil === undefined ? undefined : { liveUntil }),
  ).toBe(expected);
});

it.each([
  ["a restarting relay is spread from zero", 1012, 500, 0, 0],
  ["going away is spread the same way", 1001, 500, 0.5, 5000],
  ["the spread stays under its bound", 1012, 500, 0.999, 9990],
  [
    "repeated bounces widen the spread with the backoff",
    1012,
    16000,
    0.5,
    8000,
  ],
  ["other closes back off at -25%", 1006, 500, 0, 375],
  ["other closes back off at the backoff", undefined, 500, 0.5, 500],
  ["other closes back off at +25%", 1000, 8000, 1, 10000],
] as const)(
  "liveReconnectDelay: %s",
  (_name, code, backoff, sample, expected) => {
    expect(liveReconnectDelay(code, backoff, () => sample)).toBeCloseTo(
      expected,
      6,
    );
  },
);

it("resumes a rebuilt route from where its connection last heard the relay, and only if it reached EOSE", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a", "b"], undefined, () => 0.5);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const [profiles, membership, a, b] = h.first.requests();
    assert.exists(profiles);
    assert.exists(membership);
    assert.exists(a);
    assert.exists(b);
    // Established: profiles and "a". Still replaying at the close: membership and "b".
    await h.first.receive(["EOSE", profiles[1]]);
    await h.first.receive(["EOSE", a[1]]);
    const heard = Math.floor(Date.now() / 1000);
    await vi.advanceTimersByTimeAsync(30_000);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const first = Math.floor(Date.now() / 1000) - 300;
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    const since = (socket: Socket, match: (r: WireRequest) => boolean) =>
      filtersOf(socket.requests().find(match) as WireRequest).map(
        (f) => f.since,
      );
    expect(since(next, (r) => scopeOf(r).includes("a"))).toEqual([heard - 60]);
    expect(
      since(next, (r) => filtersOf(r)[0]?.kinds.includes(0) === true)[0],
    ).toBe(heard - 60);
    // Not established on the dropped connection: today's window.
    expect(since(next, (r) => scopeOf(r).includes("b"))).toEqual([first]);
    expect(
      since(next, (r) => filtersOf(r)[0]?.kinds.includes(44100) === true)[0],
    ).toBe(first);
  } finally {
    h.owner.dispose();
  }
});

it("takes a batch's resume point from its slowest channel", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup([], undefined, () => 0.5);
  try {
    h.owner.update(["a", "b"], ["a", "b"]);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const batch = h.first.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(batch);
    await h.first.receive(["EOSE", batch[1]]);
    const heard = Math.floor(Date.now() / 1000);
    h.first.close();
    // "c" joins after the last connection: it has no cursor.
    h.owner.update(["a", "c"], ["a", "c"]);
    await vi.advanceTimersByTimeAsync(500);
    const floor = Math.floor(Date.now() / 1000) - 300;
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    const rebuilt = next.requests().find((r) => scopeOf(r).includes("c"));
    assert.exists(rebuilt);
    expect(heard - 60).toBeGreaterThan(floor);
    // "c" has no cursor, so the shared REQ cannot start later than a first connect.
    expect(filtersOf(rebuilt).map((f) => f.since)).toEqual([floor, floor]);
  } finally {
    h.owner.dispose();
  }
});

it("resumes from when a silent socket last answered, not from when it was replaced", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, () => 0.5);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    const heard = Math.floor(Date.now() / 1000);
    h.first.silent = true;
    await vi.advanceTimersByTimeAsync(120_000 + SETUP_TIMEOUT_MS);
    expect(h.callbacks.state.mock.lastCall?.[0].error).toBe(
      "Live connection stopped answering",
    );
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1];
    assert.exists(next);
    await next.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = next.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(route);
    expect(filtersOf(route)[0]?.since).toBe(heard - 60);
  } finally {
    h.owner.dispose();
  }
});

it("drops the cursor of a connection whose routes never reached EOSE", async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const h = setup(["a"], undefined, () => 0.5);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    for (const [, id] of h.first.requests())
      await h.first.receive(["EOSE", id]);
    h.first.close();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1];
    assert.exists(second);
    // Authenticated, but the relay closes before any route is established.
    await second.auth();
    await vi.advanceTimersByTimeAsync(750);
    second.close();
    await vi.advanceTimersByTimeAsync(1000);
    const floor = Math.floor(Date.now() / 1000) - 300;
    const third = h.sockets[2];
    assert.exists(third);
    await third.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = third.requests().find((r) => scopeOf(r).includes("a"));
    assert.exists(route);
    expect(filtersOf(route)[0]?.since).toBe(floor);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  [1012, 9000],
  [1001, 9000],
  [1006, 600],
  [undefined, 600],
])(
  "waits for the jitter its close code calls for before reconnecting (code %s)",
  async (code, delay) => {
    vi.useFakeTimers();
    const h = setup(["a"], undefined, () => 0.9);
    try {
      await h.first.auth();
      h.first.close(code);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(2);
    } finally {
      h.owner.dispose();
    }
  },
);

it("reconnects at once when the spread draws zero, then backs off normally after a plain failure", async () => {
  vi.useFakeTimers();
  const draws = [0, 0.5];
  const h = setup(["a"], undefined, () => draws.shift() ?? 0.5);
  try {
    await h.first.auth();
    h.first.close(1012);
    await vi.advanceTimersByTimeAsync(0);
    const second = h.sockets[1];
    assert.exists(second);
    // The restart spread leaves the backoff to double: a failure now waits 1000ms.
    second.close(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(3);
  } finally {
    h.owner.dispose();
  }
});

it("retries a rejected authentication slowly, doubling the wait, and keeps the error visible", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    for (const [index, wait] of [60_000, 120_000, 240_000].entries()) {
      const socket = h.sockets[index];
      assert.exists(socket);
      await socket.receive(["AUTH", "challenge"]);
      const auth = socket.sent.find((frame) => frame[0] === "AUTH")?.[1] as {
        id: string;
      };
      await socket.receive(["OK", auth.id, false, "restricted: access denied"]);
      expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
        status: "error",
        error: "Relay rejected live authentication",
      });
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(h.sockets).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(index + 2);
    }
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("retries a failed live signature slowly, but never a signer that does not match the viewer", async () => {
  vi.useFakeTimers();
  const key = keypair(),
    sockets: Socket[] = [];
  let signer: (event: EventTemplate) => Promise<VerifiedEvent> = async () => {
    throw new Error("keychain locked");
  };
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    (event) => signer(event),
    key.pubkey,
    {
      state: vi.fn(),
      receive: vi.fn(),
      established: vi.fn(),
      denied: vi.fn(),
    },
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  try {
    await sockets[0]?.receive(["AUTH", "challenge"]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    signer = async (event) => signed(keypair(), event);
    await sockets[1]?.receive(["AUTH", "challenge"]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sockets).toHaveLength(2);
  } finally {
    owner.dispose();
  }
});

it("times out individual setup, releases queue slots and never calls capped replay complete", async () => {
  vi.useFakeTimers();
  const h = setup(["a", "b", "c", "d"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  expect(h.first.requests()).toHaveLength(4);
  const a = h.first.requests()[2];
  assert.exists(a);
  const event = message(h.key, "a", "echo", 1);
  for (let i = 0; i < 500; i++) await h.first.receive(["EVENT", a[1], event]);
  await h.first.receive(["EOSE", a[1]]);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.first.requests()).toHaveLength(5);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.replay,
  ).toBe("limited");
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.first.requests()).toHaveLength(6);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "b")
      ?.status,
  ).toBe("error");
  expect(h.callbacks.denied).not.toHaveBeenCalled();
  h.owner.dispose();
});
it("bounds interests and exposes every omitted ID without exceeding 1024 subscriptions", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 1024 },
    (_, i) => `channel-${i.toString().padStart(4, "0")}`,
  );
  const h = setup(ids);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  let index = 0;
  while (index < 1024) {
    if (index >= h.first.requests().length)
      await vi.advanceTimersByTimeAsync(250);
    const request = h.first.requests()[index++];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
  }
  expect(h.first.requests()).toHaveLength(1024);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes
      .filter((r) => r.status === "limited")
      .map((r) => r.channelId),
  ).toEqual(ids.slice(1022));
  expect(() => liveChannels([...ids, "excess"])).toThrow();
  for (const invalid of [[""], ["a b"], ["x".repeat(129)], [9], {}])
    expect(() => liveChannels(invalid)).toThrow();
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("surfaces invalid signatures and terminal auth failure without an automatic policy loop", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const request = h.first.requests()[2];
  assert.exists(request);
  const event = message(h.key, "a", "valid", 1);
  await h.first.receive([
    "EVENT",
    request[1],
    { ...event, content: "tampered" },
  ]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  // Only that event is dropped: the route survives.
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.status,
  ).toBe("pending");
  h.owner.dispose();
  const key = keypair(),
    socket = new Socket(),
    state = vi.fn();
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    keypair().pubkey,
    { state, receive: vi.fn(), established: vi.fn(), denied: vi.fn() },
    () => socket as unknown as WebSocket,
  );
  await socket.receive(["AUTH", "challenge"]);
  expect(state.mock.lastCall?.[0]).toMatchObject({
    status: "error",
    error: "Live signer does not match viewer",
  });
  expect(socket.sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it.each([false, true])(
  "bounds outstanding setup by the supplied concurrency (joined=%s)",
  async (joined) => {
    const key = keypair();
    const socket = new Socket();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (event) => signed(key, event),
      key.pubkey,
      { receive() {}, state() {}, established() {}, denied() {} },
      () => socket as unknown as WebSocket,
      undefined,
      16,
    );
    const channels = Array.from({ length: 170 }, (_, i) => `channel-${i}`);
    owner.update(channels, joined ? channels : []);
    await socket.auth();
    expect(socket.requests()).toHaveLength(16);
    const first = socket.requests()[0];
    assert.exists(first);
    await socket.receive(["EOSE", first[1]]);
    expect(socket.requests()).toHaveLength(17);
    owner.dispose();
  },
);
it("refills setup immediately on EOSE; quota CLOSED pauses the whole queue and only retries refused routes", async () => {
  vi.useFakeTimers();
  const h = setup(Array.from({ length: 80 }, (_, i) => `channel-${i}`));
  await h.first.auth();
  // Each completion immediately frees one of four outstanding setup slots.
  for (let i = 0; i < 20; i++) {
    expect(h.first.requests()).toHaveLength(i + 4);
    const request = h.first.requests()[i];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
    expect(h.first.requests()).toHaveLength(i + 5);
    expect(performance.now()).toBe(0);
  }
  const refused = h.first.requests()[20];
  assert.exists(refused);
  const before = h.first.requests().length;
  await h.first.receive([
    "CLOSED",
    refused[1],
    "rate-limited: quota exceeded; retry in 2s",
  ]);
  await vi.advanceTimersByTimeAsync(2999);
  expect(h.first.requests()).toHaveLength(before);
  // Explicit retry keeps established routes and cannot bypass the shared cooldown.
  h.owner.retry();
  expect(h.sockets).toHaveLength(1);
  expect(h.first.requests()).toHaveLength(before);
  await vi.advanceTimersByTimeAsync(1);
  const retry = h.first.requests().at(-1);
  assert.exists(retry);
  expect(retry[2]).toEqual(refused[2]);
  expect(retry[1]).not.toBe(refused[1]);
  await h.first.receive(["EOSE", refused[1]]);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.filter(
      (r) => r.status === "live",
    ),
  ).toHaveLength(20);
  await h.first.receive(["EOSE", retry[1]]);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.filter(
      (r) => r.status === "live",
    ),
  ).toHaveLength(21);
  expect(h.callbacks.denied).not.toHaveBeenCalled();
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves host cooldown across subscription replacement and stops bounded quota retries", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const admission = createLiveAdmission();
  const callbacks = {
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  };
  const open = () => {
    const socket = new Socket();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (e) => signed(key, e),
      key.pubkey,
      callbacks,
      () => socket as unknown as WebSocket,
      admission,
    );
    owner.update(["a", "b"]);
    return { socket, owner };
  };
  const first = open();
  await first.socket.auth();
  const request = first.socket.requests()[0];
  assert.exists(request);
  await first.socket.receive([
    "CLOSED",
    request[1],
    "rate-limited: quota exceeded; retry in 2s",
  ]);
  first.owner.dispose();
  const second = open();
  await second.socket.auth();
  expect(second.socket.requests()).toHaveLength(0);
  second.owner.retry();
  await vi.advanceTimersByTimeAsync(2999);
  expect(second.socket.requests()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 0; i < 4; i++) {
    const pending = second.socket.requests().at(-1);
    assert.exists(pending);
    await second.socket.receive([
      "CLOSED",
      pending[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    await vi.advanceTimersByTimeAsync(3000);
  }
  const count = second.socket.requests().length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(second.socket.requests()).toHaveLength(count);
  expect(
    callbacks.state.mock.lastCall?.[0].routes.every(
      (r) => r.status === "error",
    ),
  ).toBe(true);
  expect(callbacks.denied).not.toHaveBeenCalled();
  second.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["61", "9007199254740992"])(
  "an unsupported %s-second hint stops the unsent queue instead of draining it",
  async (seconds) => {
    vi.useFakeTimers();
    const h = setup(["a", "b", "c", "d"]);
    await h.first.auth();
    const request = h.first.requests()[0];
    assert.exists(request);
    await h.first.receive([
      "CLOSED",
      request[1],
      `rate-limited: quota exceeded; retry in ${seconds}s`,
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.first.requests()).toHaveLength(4);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.filter(
        (r) => r.status === "error",
      ).length,
    ).toBe(3);
    h.owner.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.first.requests()).toHaveLength(4);
    h.owner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("disposal from a live state notification fences the following established callback", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  const request = h.first.requests()[0];
  assert.exists(request);
  h.callbacks.state.mockImplementation((snapshot) => {
    if (snapshot.routes.some((r) => r.status === "live")) h.owner.dispose();
  });
  await h.first.receive(["EOSE", request[1]]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

// Reentrant remove/re-add control contributed by Brain.
it("EOSE from a removed incarnation cannot establish its replacement", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(500);
    const old = h.first.requests()[2];
    assert.exists(old);
    let replaced = false;
    h.callbacks.state.mockImplementation((snapshot) => {
      if (
        !replaced &&
        snapshot.routes.find((r) => r.channelId === "a")?.status === "live"
      ) {
        replaced = true;
        h.owner.update(["b"]);
        h.owner.update(["a", "b"]);
      }
    });
    await h.first.receive(["EOSE", old[1]]);
    expect(replaced).toBe(true);
    expect(h.callbacks.established).not.toHaveBeenCalledWith("a");
    await vi.advanceTimersByTimeAsync(500);
    const fresh = h.first
      .requests()
      .find((r) => r[2]["#h"]?.[0] === "a" && r[1] !== old[1]);
    assert.exists(fresh);
    await h.first.receive(["EOSE", fresh[1]]);
    expect(h.callbacks.established).toHaveBeenCalledWith("a");
  } finally {
    h.owner.dispose();
  }
});

it("prioritizes a demanded tail channel after globals, without bypassing cooldown or adding interests", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 128 },
    (_, i) => `channel-${String(i).padStart(3, "0")}`,
  );
  const h = setup(ids);
  try {
    h.owner.prioritize?.([ids[127] as string, "unowned"]);
    await h.first.auth();
    expect(h.first.requests()[2]?.[2]["#h"]).toEqual([ids[127]]);
    const first = h.first.requests()[0];
    assert.exists(first);
    await h.first.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    h.owner.prioritize?.([ids[126] as string]);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.first.requests()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await h.first.receive(["EOSE", h.first.requests().at(-1)?.[1]]);
    expect(h.first.requests().at(-1)?.[2]["#h"]).toEqual([ids[126]]);
    expect(h.first.requests().some((r) => r[2]["#h"]?.[0] === "unowned")).toBe(
      false,
    );
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("retains quota recovery evidence through automatic and manual retries until fresh EOSE", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    const error = "rate-limited: quota exceeded; retry in 0s";
    const profiles = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.id === "profiles",
      );
    await h.first.receive(["CLOSED", first[1], error]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    await vi.advanceTimersByTimeAsync(1000);
    const retry = h.first.requests().at(-1);
    assert.exists(retry);
    // Force an unrelated notification after retry dispatch: old error must not
    // disappear just because the new REQ was sent, or because stale EOSE arrives.
    h.owner.prioritize?.(["a"]);
    await h.first.receive(["EOSE", first[1]]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    await h.first.receive(["EOSE", retry[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
    // Exhaust the same route's remaining automatic attempts.
    for (let i = 0; i < 3; i++) {
      const latest = h.first
        .requests()
        .filter((r) => r[2].kinds?.includes(0))
        .at(-1);
      assert.exists(latest);
      await h.first.receive(["CLOSED", latest[1], error]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(profiles()).toMatchObject({ status: "error", error });
    h.owner.retry();
    h.owner.prioritize?.(["b"]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    const manual = h.first
      .requests()
      .filter((r) => r[2].kinds?.includes(0))
      .at(-1);
    assert.exists(manual);
    await h.first.receive(["EOSE", manual[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
  } finally {
    h.owner.dispose();
  }
});

it("replaces unconfirmed quota recovery with a timeout and retains nonquota manual failures", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    await h.first.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    await vi.advanceTimersByTimeAsync(11000);
    const profiles = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (route) => route.id === "profiles",
      );
    const error = "Live subscription setup timed out; retry available";
    expect(profiles()).toMatchObject({ status: "error", error });
    h.owner.retry();
    expect(profiles()).toMatchObject({ status: "pending", error });
    const manual = h.first
      .requests()
      .filter((r) => r[2].kinds.includes(0))
      .at(-1);
    assert.exists(manual);
    await h.first.receive(["EOSE", manual[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
  } finally {
    h.owner.dispose();
  }
});

it("requests statuses and community emoji on the profile route and delivers verified updates", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  await h.first.auth();
  const req = h.first.sent.find((entry) => entry[0] === "REQ");
  expect(req?.slice(2)).toEqual([
    { kinds: [0, 10100, 30177], since: expect.any(Number), limit: 500 },
    {
      kinds: [30315],
      "#d": ["general"],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: [30030],
      "#d": ["buzz:custom-emoji"],
      since: expect.any(Number),
      limit: 500,
    },
  ]);
  const event = signed(h.key, {
    kind: 30030,
    content: "",
    tags: [
      ["d", "buzz:custom-emoji"],
      ["emoji", "party", "https://x.test/p"],
    ],
  });
  await h.first.receive(["EVENT", req?.[1], event]);
  expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
    phase: "replay",
  });
  h.owner.dispose();
});

it.each([false, true])(
  "a reconnect restores per-channel replay after established/renewed routes (joined=%s)",
  async (joined) => {
    vi.useFakeTimers();
    const h = setup([]);
    h.owner.update(["a", "b"], joined ? ["a", "b"] : []);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const request = h.first.requests()[2];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
    const event = message(keypair(), "a", "live", 1700000000);
    await h.first.receive(["EVENT", request[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      phase: "live",
      channelId: "a",
    });
    if (joined) {
      await vi.advanceTimersByTimeAsync(60000);
      const renewal = h.first.requests().at(-1);
      assert.exists(renewal);
      expect(filtersOf(renewal)).toHaveLength(1);
      expect(renewal[2]).toMatchObject({ "#h": ["a", "b"], limit: 0 });
      await h.first.receive(["EOSE", renewal[1]]);
    }
    h.first.close();
    await vi.advanceTimersByTimeAsync(625);
    const socket = h.sockets[1];
    assert.exists(socket);
    await socket.auth();
    await vi.advanceTimersByTimeAsync(750);
    const replay = socket.requests()[2];
    assert.exists(replay);
    expect(filtersOf(replay)).toEqual(
      (joined ? ["a", "b"] : ["a"]).map((id) =>
        expect.objectContaining({ "#h": [id], limit: 500 }),
      ),
    );
    await socket.receive(["EVENT", replay[1], event]);
    expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
      phase: "replay",
      channelId: "a",
    });
    h.owner.dispose();
  },
);

it("live channel provenance excludes observer telemetry while preserving membership traffic", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first.requests()[2];
    assert.exists(route);
    await h.first.receive(["EOSE", route[1]]);
    const telemetry = signed(h.key, {
      kind: 24200,
      content: "opaque",
      tags: [],
    });
    await h.first.receive(["EVENT", route[1], telemetry]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    const membership = signed(h.key, {
      kind: 40099,
      content: "{}",
      tags: [["h", "a"]],
    });
    await h.first.receive(["EVENT", route[1], membership]);
    expect(h.callbacks.receive).toHaveBeenCalledExactlyOnceWith([membership], {
      phase: "live",
      channelId: "a",
    });
  } finally {
    h.owner.dispose();
  }
});

it("observer route is optional, live-only at dispatch/retry, separately fenced and never ordinary replay", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const h = setup([]);
  const telemetry = vi.fn();
  Object.assign(h.callbacks, { telemetry });
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(500);
  const globals = h.first.requests().map((request) => request[1]);
  h.owner.observe?.(1);
  await vi.advanceTimersByTimeAsync(250);
  const first = h.first.requests().at(-1);
  assert.exists(first);
  expect(first[2]).toEqual({
    kinds: [24200],
    "#p": [h.key.pubkey],
    since: Math.floor(Date.now() / 1000),
  });
  const event = signed(h.key, {
    kind: 24200,
    content: "opaque",
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  });
  await h.first.receive(["EVENT", first[1], event]);
  expect(telemetry).toHaveBeenCalledWith(event, 1);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EOSE", first[1]]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  await h.first.receive(["CLOSED", first[1], "temporary: unavailable"]);
  await vi.advanceTimersByTimeAsync(3000);
  h.owner.retry();
  const retried = h.first.requests().at(-1);
  assert.exists(retried);
  expect(retried[2].since).toBeGreaterThan(first[2].since);
  h.owner.observe?.(2);
  await vi.advanceTimersByTimeAsync(250);
  await h.first.receive(["EVENT", first[1], event]);
  await h.first.receive(["EVENT", retried[1], event]);
  expect(telemetry).toHaveBeenCalledTimes(1);
  h.owner.observe?.(null);
  expect(
    h.first.sent
      .filter((entry) => entry[0] === "CLOSE")
      .some((entry) => globals.includes(entry[1] as string)),
  ).toBe(false);
  expect(h.sockets).toHaveLength(1);
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("presence holds its receipt without delaying ordinary setup and shares correlated cooldown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  expect(
    await h.owner.publishPresence?.("online", new AbortController().signal),
  ).toBeNull();
  await h.first.auth();
  // No EOSE: ordinary setup is still pending.
  const abort = new AbortController();
  const result = h.owner.publishPresence?.("online", abort.signal);
  await vi.advanceTimersByTimeAsync(0);
  const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
    id: string;
    content: string;
  };
  assert.exists(event);
  expect(event.content).toBe("online");
  h.owner.update(["foreground"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.first.requests().at(-1)?.[2]["#h"]).toEqual(["foreground"]);
  abort.abort(); // Keep the receipt correlation after cancellation, to honor late quota.
  await h.first.receive(["OK", "unrelated", true]);
  await h.first.receive([
    "OK",
    event.id,
    false,
    "rate-limited: quota exceeded; retry in 3s",
  ]);
  expect(await result).toBe(false);
  const count = h.first.requests().length;
  h.owner.update(["foreground", "next"]);
  expect(h.first.requests()).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(4000);
  expect(h.first.requests()).toHaveLength(count + 1);
  h.owner.dispose();
});

it.each(["reconnect", "cooldown"])(
  "an outstanding presence signer respects %s",
  async (mode) => {
    vi.useFakeTimers();
    const key = keypair(),
      sockets: Socket[] = [];
    const admission = createLiveAdmission();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callbacks = {
      receive() {},
      state() {},
      established() {},
      denied() {},
    };
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (event) => {
        if (event.kind === 20001) await gate;
        return signed(key, event);
      },
      key.pubkey,
      callbacks,
      () => {
        const s = new Socket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      admission,
    );
    const first = sockets[0];
    assert.exists(first);
    await first.auth();
    await vi.advanceTimersByTimeAsync(500);
    for (const [, id] of first.requests()) await first.receive(["EOSE", id]);
    const result = owner.publishPresence?.(
      "away",
      new AbortController().signal,
    );
    expect(admission.presenceIdle()).toBe(false);
    if (mode === "reconnect") {
      first.close();
      await vi.advanceTimersByTimeAsync(625);
      const next = sockets[1];
      assert.exists(next);
      await next.auth();
      await vi.advanceTimersByTimeAsync(500);
      for (const [, id] of next.requests()) await next.receive(["EOSE", id]);
      expect(
        await owner.publishPresence?.("online", new AbortController().signal),
      ).toBeNull();
    } else {
      admission.pause(3);
      // A real cooldown wins even when another flight is busy signing.
      expect(
        await owner.publishPresence?.("online", new AbortController().signal),
      ).toEqual({ retryAfterMs: 4000 });
    }
    release();
    expect(await result).toEqual(
      mode === "reconnect" ? null : { retryAfterMs: 4000 },
    );
    expect(
      sockets.flatMap((s) => s.sent).filter(([kind]) => kind === "EVENT"),
    ).toEqual([]);
    expect(admission.presenceIdle()).toBe(true);
    owner.dispose();
  },
);

it("admits signed typing only on its authenticated channel route, without extra subscriptions", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const requests = h.first.requests();
  expect(requests).toHaveLength(4);
  const route = requests[2];
  assert.exists(route);
  expect(route[2].kinds).toContain(20002);
  const event = signed(keypair(), {
    kind: 20002,
    content: "",
    tags: [["h", "a"]],
  });
  await h.first.receive(["EVENT", requests[0]?.[1], event]);
  await h.first.receive(["EVENT", requests[3]?.[1], event]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EVENT", route[1], event]);
  expect(h.callbacks.receive).toHaveBeenCalledExactlyOnceWith([event], {
    channelId: "a",
    phase: "replay",
  });
  await h.first.receive([
    "EVENT",
    route[1],
    { ...event, sig: "0".repeat(128) },
  ]);
  expect(h.callbacks.receive).toHaveBeenCalledTimes(1);
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps misrouted activity out of accessible conversations; session rejects ambiguous scope", async () => {
  vi.useFakeTimers();
  const h = setup();
  const relay = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      return h.owner;
    },
  });
  // Establish both accessible channels before starting their live routes.
  h.callbacks.receive([
    roster(relay, "a", [h.key.pubkey]),
    roster(relay, "b", [h.key.pubkey]),
  ]);
  // This case exercises distinct wire scopes. Joined background batching is
  // covered separately below; membership alone no longer implies one wire each.
  h.owner.update(["a", "b"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const requests = h.first.requests();
  const a = requests.find((r) => r[2]["#h"]?.includes("a"));
  const b = requests.find((r) => r[2]["#h"]?.includes("b"));
  assert.exists(a);
  assert.exists(b);
  const agent = keypair();
  const activity = (tags: string[][]) =>
    signed(agent, {
      kind: 20002,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags,
    });
  const pulse = activity([["h", "b"]]);
  const snapshot = owner.session.typing.snapshot;
  for (const route of [requests[0], requests[1], a]) {
    await h.first.receive(["EVENT", route?.[1], pulse]);
    expect(snapshot()).toEqual([]);
  }
  for (const tags of [
    [],
    [["h"]],
    [["h", "bad channel"]],
    [["h", "denied"]],
    [
      ["h", "b"],
      ["h", "b"],
    ],
    [
      ["h", "b"],
      ["h", "a"],
    ],
    [
      ["h", "b"],
      ["e", "bad", "", "reply"],
    ],
  ]) {
    const event = activity(tags);
    await h.first.receive(["EVENT", b[1], event]);
    expect(snapshot()).toEqual([]);
    // Even a host that has already discarded route metadata cannot activate these.
    h.callbacks.receive([event]);
    expect(snapshot()).toEqual([]);
  }
  await h.first.receive(["EVENT", b[1], pulse]);
  expect(snapshot()).toEqual([{ channelId: "b", pubkey: agent.pubkey }]);
  // Once route metadata is gone, the session can only use the event's own scope.
  const other = activity([["h", "a"]]);
  await h.first.receive(["EVENT", b[1], other]);
  expect(snapshot()).toHaveLength(1);
  h.callbacks.receive([other]);
  expect(snapshot()).toEqual([
    { channelId: "b", pubkey: agent.pubkey },
    { channelId: "a", pubkey: agent.pubkey },
  ]);
  owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("gates publication on AUTH, shares admission with live routes, and accepts only matching OK", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    const event = message(h.key, "a", "outgoing", 1700000000);
    assert.exists(h.owner.publish);
    const done = vi.fn();
    const result = h.owner
      .publish(event, new AbortController().signal)
      .then(done, done);
    await h.first.receive(["OK", event.id, true, "early"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.first.sent).toEqual([]);
    await h.first.auth();
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toEqual([
      ["EVENT", JSON.parse(JSON.stringify(event))],
    ]);
    expect(h.first.requests()).toHaveLength(4);
    await h.first.receive(["OK", "f".repeat(64), true, "wrong"]);

    expect(done).not.toHaveBeenCalled();
    expect(h.first.requests()).toHaveLength(4);
    expect(performance.now()).toBe(100);
    await h.first.receive(["OK", event.id, true, "private-result"]);
    await result;
    expect(done).toHaveBeenCalledWith("private-result");
    expect(h.callbacks.receive).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["restricted: not a member", false],
  ["invalid: event rejected", false],
  ["error: internal server error", true],
  ["unknown failure", true],
])("preserves publication uncertainty for %s", async (reason, sent) => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    const event = message(h.key, "a", "command", 1700000000);
    assert.exists(h.owner.publish);
    const result = h.owner
      .publish(event, new AbortController().signal)
      .catch((e) => e);
    await h.first.auth();
    await h.first.receive(["OK", event.id, false, reason]);
    expect(await result).toMatchObject({ sent });
  } finally {
    h.owner.dispose();
  }
});

it.each(["abort", "dispose", "disconnect"])(
  "settles queued versus sent publications on %s without replay",
  async (action) => {
    vi.useFakeTimers();
    for (const dispatched of [false, true]) {
      const h = setup([]);
      try {
        const event = message(h.key, "a", "outgoing", 1700000000);
        const cancel = new AbortController();
        assert.exists(h.owner.publish);
        const result = h.owner.publish(event, cancel.signal).catch((e) => e);
        if (dispatched) await h.first.auth();
        if (action === "abort") cancel.abort();
        else if (action === "dispose") h.owner.dispose();
        else h.first.close();
        expect(await result).toMatchObject({ sent: dispatched });
        if (action === "disconnect") {
          await vi.advanceTimersByTimeAsync(625);
          const next = h.sockets[1];
          assert.exists(next);
          await next.auth();
          await h.first.receive(["OK", event.id, true, "late"]);
          expect(next.sent.filter((f) => f[0] === "EVENT")).toEqual([]);
        }
      } finally {
        h.owner.dispose();
      }
    }
  },
);

it("bounds pending IDs, receipts and timeout; a socket send exception remains unknown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    assert.exists(h.owner.publish);
    const event = message(h.key, "a", "outgoing", 1700000000);
    const result = h.owner
      .publish(event, new AbortController().signal)
      .catch((e) => e);
    await expect(
      h.owner.publish(event, new AbortController().signal),
    ).rejects.toMatchObject({ sent: false });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ sent: false });
  } finally {
    h.owner.dispose();
  }
  const second = setup([]);
  try {
    assert.exists(second.owner.publish);
    await second.first.auth();
    second.first.send = () => {
      throw new Error("interrupted");
    };
    const result = second.owner
      .publish(
        message(second.key, "a", "outgoing", 1700000000),
        new AbortController().signal,
      )
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ sent: true });
  } finally {
    second.owner.dispose();
  }
});

it("publication quota pauses both writes and live REQs without replaying the refused event", async () => {
  vi.useFakeTimers();
  const h = setup(["a", "b", "c"]);
  try {
    assert.exists(h.owner.publish);
    const a = message(h.key, "a", "first", 1700000000);
    const b = message(h.key, "a", "second", 1700000001);
    const first = h.owner
      .publish(a, new AbortController().signal)
      .catch((e) => e);
    await h.first.auth();
    await h.first.receive([
      "OK",
      a.id,
      false,
      "rate-limited: quota exceeded; retry in 1s",
    ]);
    const second = h.owner
      .publish(b, new AbortController().signal)
      .catch((e) => e);
    await h.first.receive(["EOSE", h.first.requests()[0]?.[1]]);
    expect(await first).toMatchObject({ sent: false });
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toHaveLength(1);
    expect(h.first.requests()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toHaveLength(2);
    await h.first.receive(["OK", b.id, true, ""]);
    expect(await second).toBe("");
    expect(h.first.requests()).toHaveLength(5);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  ["OK", true],
  ["OK", true, "x".repeat(16385)],
  ["OK", "true", ""],
])(
  "rejects malformed/bounded receipt (%j) without acceptance",
  async (...frame) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      assert.exists(h.owner.publish);
      const event = message(h.key, "a", "outgoing", 1700000000);
      const result = h.owner
        .publish(event, new AbortController().signal)
        .catch((e) => e);
      await h.first.auth();
      await h.first.receive([frame[0], event.id, ...frame.slice(1)]);
      expect(await result).toMatchObject({
        sent: true,
        message: "Invalid publication receipt",
      });
    } finally {
      h.owner.dispose();
    }
  },
);

it("fills three publication slots at one clock instant and refills on matching OK without a timer", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    assert.exists(h.owner.publish);
    const events = Array.from({ length: 4 }, (_, i) =>
      message(h.key, "a", `burst-${i}`, 1700000000 + i),
    );
    const publish = h.owner.publish;
    const results = events.map((event) =>
      publish(event, new AbortController().signal),
    );
    await h.first.auth();
    const writes = () => h.first.sent.filter((f) => f[0] === "EVENT");
    expect(writes()).toHaveLength(3);
    expect(performance.now()).toBe(0);
    await h.first.receive(["OK", events[0]?.id, true, ""]);
    expect(writes()).toHaveLength(4);
    expect(performance.now()).toBe(0);
    for (const event of events.slice(1))
      await h.first.receive(["OK", event.id, true, ""]);
    await Promise.all(results);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("presence and ordinary publications correlate independently and share only real cooldown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    assert.exists(h.owner.publish);
    assert.exists(h.owner.publishPresence);
    const presenceDone = vi.fn();
    const presence = h.owner
      .publishPresence("online", new AbortController().signal)
      .then(presenceDone);
    await vi.advanceTimersByTimeAsync(0);
    const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
      id: string;
    };
    assert.exists(event);
    const chat = message(h.key, "a", "ordinary", 1700000000);
    const ordinaryDone = vi.fn();
    const ordinary = h.owner
      .publish(chat, new AbortController().signal)
      .then(ordinaryDone);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.first.sent.filter(([kind]) => kind === "EVENT")).toHaveLength(2);
    expect(performance.now()).toBe(0);
    await h.first.receive(["OK", event.id, true, ""]);
    await presence;
    expect(presenceDone).toHaveBeenCalledWith(true);
    expect(ordinaryDone).not.toHaveBeenCalled();
    await h.first.receive(["OK", chat.id, true, "chat accepted"]);
    await ordinary;
    expect(ordinaryDone).toHaveBeenCalledWith("chat accepted");
    await vi.advanceTimersByTimeAsync(5000);
    const refused = message(h.key, "a", "refused", 1700000001);
    const result = h.owner
      .publish(refused, new AbortController().signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await h.first.receive([
      "OK",
      refused.id,
      false,
      "rate-limited: quota exceeded; retry in 1s",
    ]);
    expect(await result).toMatchObject({ sent: false });
    expect(
      await h.owner.publishPresence("away", new AbortController().signal),
    ).toEqual({ retryAfterMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    const renewal = h.owner.publishPresence(
      "away",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    const last = h.first.sent
      .filter(([kind]) => kind === "EVENT")
      .at(-1)?.[1] as { id: string; content: string };
    expect(last.content).toBe("away");
    await h.first.receive(["OK", last.id, true, ""]);
    expect(await renewal).toBe(true);
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("publishes manual Offline on the authenticated presence socket with a correlated receipt", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    const result = h.owner.publishPresence?.(
      "offline",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
      id: string;
      kind: number;
      content: string;
      tags: string[][];
    };
    assert.exists(event);
    expect(event).toMatchObject({ kind: 20001, content: "offline", tags: [] });
    await h.first.receive(["OK", event.id, true]);
    expect(await result).toBe(true);
  } finally {
    h.owner.dispose();
  }
});

it("receives public agent metadata on the existing profile route without another subscription", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first
      .requests()
      .find((request) => request[2].kinds.includes(10100));
    assert.exists(route);
    expect(route[2].kinds).toEqual([0, 10100, 30177]);
    expect(h.first.requests()).toHaveLength(2);
    await h.first.receive(["EOSE", route[1]]);
    for (const kind of [10100, 30177]) {
      const event = signed(h.key, {
        kind,
        content: "{}",
        tags: [],
        created_at: 10,
      });
      await h.first.receive(["EVENT", route[1], event]);
      expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
        phase: "live",
      });
    }
  } finally {
    h.owner.dispose();
  }
});

it("logs every real transport frame without payloads and applies level changes to an open socket", async () => {
  vi.useFakeTimers();
  const logger = getLogger("relay-ws");
  const reporters = [...logger.options.reporters];
  const lines: string[] = [];
  logger.setReporters([{ log: (value) => lines.push(value.args.join(" ")) }]);
  setLogLevel("debug");
  const h = setup(["a"]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(lines.some((line) => line.includes("← AUTH"))).toBe(true);
    expect(lines.some((line) => line.includes("→ AUTH"))).toBe(true);
    expect(lines.some((line) => line.includes("→ REQ"))).toBe(true);
    const request = h.first.requests().find((r) => r[2]["#h"]?.[0] === "a");
    assert.exists(request);
    const incoming = message(keypair(), "a", "secret message", 1700000000);
    lines.length = 0;
    for (let i = 0; i < 20; i++)
      await h.first.receive(["EVENT", request[1], incoming]);
    expect(lines).toHaveLength(20);
    expect(
      lines.every(
        (line) => line.includes("← EVENT") && line.includes("kind=9"),
      ),
    ).toBe(true);
    expect(lines.join(" ")).not.toContain("secret message");
    expect(h.callbacks.receive).toHaveBeenCalledTimes(20);
    setLogLevel("info");
    await h.first.receive(["EVENT", request[1], incoming]);
    expect(lines).toHaveLength(20);
    expect(h.callbacks.receive).toHaveBeenCalledTimes(21);
  } finally {
    h.owner.dispose();
    logger.setReporters(reporters);
    setLogLevel("info");
  }
});

it("logs authentication failure and retry reasons at Info without server payloads", async () => {
  vi.useFakeTimers();
  const logger = getLogger("relay-ws");
  const reporters = [...logger.options.reporters];
  const lines: string[] = [];
  logger.setReporters([
    { log: (value) => lines.push(`${value.type} ${value.args.join(" ")}`) },
  ]);
  setLogLevel("info");
  const rejected = setup([]);
  let timedOut: ReturnType<typeof setup> | undefined;
  try {
    await rejected.first.receive(["AUTH", "private challenge"]);
    const auth = rejected.first.sent.find(
      (frame) => frame[0] === "AUTH",
    )?.[1] as { id: string };
    await rejected.first.receive(["OK", auth.id, false, "private rejection"]);
    expect(
      lines.filter((line) =>
        line.includes("Relay rejected live authentication"),
      ),
    ).toEqual(["error relay.test Relay rejected live authentication"]);
    timedOut = setup([]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(
      lines.filter((line) => line.includes("Live authentication timed out")),
    ).toEqual(["warn relay.test Live authentication timed out"]);
    expect(lines.join(" ")).not.toContain("private");
  } finally {
    rejected.owner.dispose();
    timedOut?.owner.dispose();
    logger.setReporters(reporters);
    setLogLevel("info");
  }
});

it("a rejected AUTH is settled for session recovery, retries on its own slow timer and on explicit retry", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.receive(["AUTH", "challenge"]);
    const auth = h.first.sent.find((frame) => frame[0] === "AUTH")?.[1] as {
      id: string;
    };
    await h.first.receive(["OK", auth.id, false, "restricted: no"]);
    const view = h.callbacks.state.mock.lastCall?.[0];
    assert.exists(view);
    expect(view).toMatchObject({
      status: "error",
      error: "Relay rejected live authentication",
    });
    // Recovery and wake signals skip it, so they cannot shorten the slow timer.
    expect(
      liveRecoveryStatus({ ...view, roster: { state: "verified" }, heads: [] }),
    ).toBe("settled");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.sockets).toHaveLength(1);
    // The conversation's Retry live updates calls this after the user fixes
    // the signer or access problem.
    h.owner.retry();
    expect(h.sockets).toHaveLength(2);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connecting");
  } finally {
    h.owner.dispose();
  }
});

it("presence shares the authenticated socket, verifies signatures, and replaces demand without an observation gap", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  const peer = keypair();
  h.owner.watchPresence?.([peer.pubkey]);
  await h.first.auth();
  const first = h.first.requests().find((r) => r[2].kinds.includes(20001));
  assert.exists(first);
  expect(first[2]).toMatchObject({ authors: [peer.pubkey], limit: 0 });
  await h.first.receive(["EOSE", first[1]]);
  const event = signed(peer, {
    kind: 20001,
    tags: [],
    content: "away",
    created_at: Math.floor(Date.now() / 1000),
  });
  h.owner.watchPresence?.([peer.pubkey, h.key.pubkey]);
  const next = h.first
    .requests()
    .filter((r) => r[2].kinds.includes(20001))
    .at(-1);
  assert.exists(next);
  expect(next[1]).not.toBe(first[1]);
  expect(h.first.sent).not.toContainEqual(["CLOSE", first[1]]);
  await h.first.receive(["EVENT", first[1], event]);
  expect(h.callbacks.presence).toHaveBeenLastCalledWith(event);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EOSE", next[1]]);
  expect(h.first.sent).toContainEqual(["CLOSE", first[1]]);
  h.callbacks.presence.mockClear();
  await h.first.receive(["EVENT", first[1], event]);
  await h.first.receive(["EVENT", next[1], { ...event, content: "online" }]);
  expect(h.callbacks.presence).not.toHaveBeenCalled();
  h.owner.dispose();
});

it.each([false, true])(
  "paces replacement commands behind a held receipt without polling (late cooldown: %s)",
  async (cooldown) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          work: () => Promise<void>,
        ) => work(),
      },
    });
    const h = setup([]);
    const listeners = new Set<() => void>();
    let status: "online" | "away" | "offline" = "online",
      command = 0;
    const attempts: number[] = [];
    const publishPresence = h.owner.publishPresence;
    assert.exists(publishPresence);
    const publish = vi.fn(
      (value: "online" | "away" | "offline", signal: AbortSignal) => {
        attempts.push(performance.now());
        return publishPresence(value, signal);
      },
    );
    const owner = createPresence(
      {
        ...scriptedTransport(h.key.pubkey, h.key.pubkey).transport,
        viewer: h.key.pubkey,
        presenceSnapshot: async () => new Map([[h.key.pubkey, "online"]]),
      },
      {
        visible: () => true,
        status: () => status,
        command: () => command,
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        dispose() {},
      },
      publish,
      (fn) => fn(),
    );
    const events = () =>
      h.first.sent
        .filter(([kind]) => kind === "EVENT")
        .map(([, event]) => event as { id: string; content: string });
    try {
      await h.first.auth();
      owner.subscribe(h.key.pubkey, () => {});
      owner.connected(true);
      await vi.advanceTimersByTimeAsync(250);
      for (const request of h.first.requests())
        await h.first.receive(["EOSE", request[1]]);
      expect(events().map((event) => event.content)).toEqual(["online"]);
      await vi.advanceTimersByTimeAsync(1000);
      status = "away";
      command++;
      for (const fn of listeners) fn();
      await vi.advanceTimersByTimeAsync(4050);
      // The gate opened, but the original receipt still owns the flight.
      expect(attempts).toEqual([250, 1250, 5300]);
      expect(await publish.mock.results[2]?.value).toBeNull();
      await vi.advanceTimersByTimeAsync(700);
      status = "offline";
      command++;
      for (const fn of listeners) fn();
      await vi.advanceTimersByTimeAsync(4000);
      expect(attempts).toEqual([250, 1250, 5300, 6000]);
      expect(events()).toHaveLength(1);
      const first = events()[0];
      assert.exists(first);
      // Aborting the old owner must not discard a late shared quota refusal.
      await h.first.receive([
        "OK",
        first.id,
        !cooldown,
        cooldown ? "rate-limited: quota exceeded; retry in 1s" : "",
      ]);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual([250, 1250, 5300, 6000]);
      await vi.advanceTimersByTimeAsync(1);
      if (cooldown) {
        expect(events()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1049);
        expect(attempts).toEqual([250, 1250, 5300, 6000, 11000]);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(attempts).toEqual(
        cooldown
          ? [250, 1250, 5300, 6000, 11000, 12050]
          : [250, 1250, 5300, 6000, 11000],
      );
      expect(events().map((event) => event.content)).toEqual([
        "online",
        "offline",
      ]);
      expect(owner.status(h.key.pubkey)).toBe("online");
      const last = events().at(-1);
      assert.exists(last);
      await h.first.receive(["OK", last.id, true, ""]);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.status(h.key.pubkey)).toBe("offline");
      const count = attempts.length;
      await vi.advanceTimersByTimeAsync(65000);
      expect(attempts).toHaveLength(count); // No superseded renewal or Offline lease.
    } finally {
      owner.dispose();
      h.owner.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);

it("reports the remaining presence gate without extending it and honors cooldown", () => {
  vi.useFakeTimers();
  const admission = createLiveAdmission();
  expect(admission.presenceDelay()).toBe(0);
  const release = admission.tryPresence();
  expect(admission.presenceDelay()).toBe(0);
  admission.presenceSent();
  vi.advanceTimersByTime(1200);
  expect(admission.presenceDelay()).toBe(3800);
  release?.();
  expect(admission.tryPresence()).toBeUndefined();
  admission.pause(10);
  expect(admission.presenceDelay()).toBe(11000);
  vi.advanceTimersByTime(10999);
  expect(admission.presenceDelay()).toBe(1);
  expect(admission.tryPresence()).toBeUndefined();
  vi.advanceTimersByTime(1);
  expect(admission.presenceDelay()).toBe(0);
  admission.tryPresence()?.();
});

it("carries verified workflow attribution from live admission to notification candidates", async () => {
  vi.useFakeTimers({ now: 1_700_000_100_000 });
  const h = setup([]),
    relay = keypair(),
    workflowOwner = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    archiveAuthority: relay.pubkey,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      return h.owner;
    },
  });
  try {
    h.callbacks.receive([roster(relay, "room", [h.key.pubkey])]);
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first
      .requests()
      .find((request) => scopeOf(request).includes("room"));
    assert.exists(route);
    await h.first.receive(["EOSE", route[1]]);
    const incoming = vi.fn();
    owner.session.subscribeIncoming(incoming);
    const event = message(relay, "room", "workflow live", 1_700_000_100, [
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", workflowOwner.pubkey],
    ]);
    await h.first.receive(["EVENT", route[1], event]);
    expect(incoming).toHaveBeenCalledWith([
      expect.objectContaining({
        messageId: event.id,
        authorId: relay.pubkey,
        workflowOwnerId: workflowOwner.pubkey,
      }),
    ]);
  } finally {
    owner.dispose();
    h.owner.dispose();
  }
});
