import { ReadError } from "./errors";
import { assert, expect, it, vi, afterEach } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  type Scripted,
} from "./testing";

it("clears retained repository homes on live recovery, cache clearing, and disposal", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const seed = async () => {
    const pending = owner.session.repositories.home(
      "repo-channel",
      new AbortController().signal,
    );
    wire.next().respond([]);
    await pending;
    expect(owner.session.repositories.peekHome("repo-channel")).toEqual({
      status: "none",
    });
  };
  try {
    await seed();
    live.state({ status: "connected", routes: [] });
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
    await seed();
    await owner.clearCache();
    expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
    await seed();
  } finally {
    owner.dispose();
  }
  expect(owner.session.repositories.peekHome("repo-channel")).toBeUndefined();
});

it("establishing a large roster reads only retained windows, not every channel head", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    const ids = Array.from({ length: 128 }, (_, i) => `channel-${i}`);
    const first = ids[0];
    assert.exists(first);
    live.receive(ids.map((id) => roster(relay, id, [viewer.pubkey])));
    owner.session.channels.ensure(first);
    const initial = wire.next();
    initial.respond([
      bounds(relay, first, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    live.state({ status: "connected", routes: [] });
    for (const id of ids) live.established(id);
    await flush();
    const catchup = wire.next();
    expect(catchup.filters[0]?.["#h"]).toEqual([ids[0]]);
    catchup.respond([
      bounds(relay, first, "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(
      owner.session.live.snapshot().heads.filter((h) => h.state === "verified"),
    ).toHaveLength(1);
    expect(
      owner.session.live.snapshot().heads.filter((h) => h.state === "deferred"),
    ).toHaveLength(127);
  } finally {
    owner.dispose();
  }
});

it("a skipped warm head cannot hide the stream gap behind its freshness lease", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { prepared: true },
  );
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    owner.session.channels.prepare?.("a");
    const warm = wire.next();
    warm.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(owner.retainedChannels()).toEqual([]);
    expect(owner.diagnostics().heads.entries).toBe(1);
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(owner.session.live.snapshot().heads[0]?.state).toBe("deferred");
    // Same wall-clock: freshness lease has not expired, but post-gap read is still required.
    owner.session.channels.ensure("a");
    await flush();
    const demand = wire.next();
    expect(demand.filters[0]?.["#h"]).toEqual(["a"]);
    demand.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(owner.session.channels.window("a").freshness).toBe("verified");
    expect(
      owner.session.live.snapshot().heads.find((h) => h.channelId === "a")
        ?.state,
    ).toBe("verified");
    live.state({ status: "retrying", routes: [] });
    expect(owner.session.channels.window("a").freshness).toBe("cached");
  } finally {
    owner.dispose();
  }
});

afterEach(() => vi.useRealTimers());
it("post-subscribe demand supersedes a pre-stream head and prioritizes the current retained reader", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const priority = vi.fn();
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, prioritize: priority, retry() {}, dispose() {} };
    },
  });
  try {
    live.receive(["a", "z"].map((id) => roster(relay, id, [viewer.pubkey])));
    owner.session.channels.ensure("a");
    const oldA = wire.next();
    oldA.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    owner.session.channels.ensure("z");
    const oldZ = wire.next();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    live.established("z");
    await flush();
    const current = wire.next();
    expect(current.filters[0]?.["#h"]).toEqual(["z"]);
    expect(oldZ.signal?.aborted).toBe(true);
    expect(priority.mock.lastCall?.[0][0]).toBe("z");
    current.respond([
      bounds(relay, "z", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    const other = wire.next();
    expect(other.filters[0]?.["#h"]).toEqual(["a"]);
    other.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "verified"),
    ).toBe(true);
  } finally {
    owner.dispose();
  }
});
it("long API pause keeps lightweight catch-up obligations; retry does not drain or bypass cooldown", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    live.receive(["a", "b"].map((id) => roster(relay, id, [viewer.pubkey])));
    for (const id of ["a", "b"]) {
      owner.session.channels.ensure(id);
      wire
        .next()
        .respond([
          bounds(relay, id, "head", { has_more: false, next_cursor: null }),
        ]);
      await flush();
    }
    live.state({ status: "connected", routes: [] });
    live.established("a");
    live.established("b");
    await flush();
    wire
      .next()
      .fail(new ReadError("unavailable", "Relay requests paused", 429, 60000));
    await flush();
    expect(wire.pending).toHaveLength(0);
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "error"),
    ).toBe(true);
    owner.session.live.retry();
    owner.session.channels.ensure("a");
    await flush();
    expect(wire.pending).toHaveLength(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValue(performance.now() + 61000);
    owner.session.live.retry();
    await flush();
    const retry = wire.next();
    retry.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    const second = wire.next();
    second.respond([
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    clock.mockRestore();
    expect(
      owner.session.live.snapshot().heads.every((h) => h.state === "verified"),
    ).toBe(true);
  } finally {
    vi.restoreAllMocks();
    owner.dispose();
  }
});

it.each([1, 2, 130])(
  "catch-up preserves unread evidence for a %s-channel roster",
  async (count) => {
    const relay = keypair(),
      viewer = keypair(),
      peer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      const ids = Array.from(
        { length: count },
        (_, i) => `room-${i.toString().padStart(3, "0")}`,
      );
      const first = ids[0];
      assert.exists(first);
      live.receive(ids.map((id) => roster(relay, id, [viewer.pubkey])));
      owner.session.channels.ensure(first);
      const oldHead = wire.next();
      const repair = owner.session.unread.ensure();
      await flush();
      // Per-channel windows ride up to four single-channel filters per
      // request, two requests in flight beside the head.
      await vi.waitFor(() =>
        expect(wire.pending[0]?.filters[0]?.since).toEqual(expect.any(Number)),
      );
      const evidence = wire.next();
      expect(evidence.filters[0]).toMatchObject({
        "#h": [first],
        include_aux: true,
        limit: 100,
        since: expect.any(Number),
      });
      // Force the production race: both the old head and unread batch are still
      // in flight when the live route establishes. Only the old head is obsolete.
      live.state({ status: "connected", routes: [] });
      live.established(first);
      await flush();
      expect(oldHead.signal?.aborted).toBe(true);
      expect(evidence.signal?.aborted).toBe(false);
      const answered: string[] = [];
      let authored = 0;
      const answer = (batch: Scripted) => {
        expect(batch.filters.length).toBeLessThanOrEqual(4);
        const batchIds = batch.filters.flatMap((filter) => {
          // The viewer's newest messages ride the last request, for the
          // participation pass.
          if (filter.authors) {
            authored++;
            expect(filter).toMatchObject({
              authors: [viewer.pubkey],
              include_aux: true,
              limit: 100,
            });
            return [];
          }
          expect(filter["#h"]).toHaveLength(1);
          return [filter["#h"]?.[0] ?? ""];
        });
        answered.push(...batchIds);
        batch.respond(
          batchIds.map((id) =>
            message(peer, id, "unread evidence", 1700000900),
          ),
        );
      };
      answer(evidence);
      let heads = 0;
      while (answered.length < ids.length || heads === 0) {
        await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
        const batch = wire.next();
        if (batch.filters[0]?.top_level) {
          heads++;
          expect(batch.filters[0]).toMatchObject({ "#h": [first] });
          batch.respond([
            bounds(relay, first, "head", {
              has_more: false,
              next_cursor: null,
            }),
          ]);
        } else answer(batch);
      }
      expect(heads).toBe(1);
      expect([...answered].sort()).toEqual([...ids].sort());
      while (!authored) {
        await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
        answer(wire.next());
      }
      expect(authored).toBe(1);
      await flush();
      await repair;
      expect(wire.pending).toHaveLength(0);
      for (const channelId of ids) {
        const snapshot = owner.session.unread.snapshot({
          kind: "channel",
          channelId,
        });
        expect(snapshot).toMatchObject({
          observedCount: 1,
          freshness: "observed",
        });
        expect(snapshot.error).toBeUndefined();
      }
      // Evidence repair must not populate timeline windows or undo catch-up.
      expect(owner.session.channels.window(first).rows).toEqual([]);
      expect(
        owner.session.live.snapshot().heads.find((h) => h.channelId === first)
          ?.state,
      ).toBe("verified");
    } finally {
      owner.dispose();
    }
  },
);

it("a reconnect catch-up head newer than every loaded row keeps those rows on screen", async () => {
  // The catch-up moves the read cursor to the new head. Rows the reader had
  // already loaded sit below that cursor and must stay visible.
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { prepared: true },
  );
  const rows = () =>
    owner.session.channels.window("c").rows.map((row) => row.id);
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "c", [viewer.pubkey]),
        metadata(relay, "c", "C"),
      ]);
    await flush();
    const seen = message(alice, "c", "seen", 10),
      missed = message(alice, "c", "missed", 30),
      old = message(alice, "c", "old", 5);
    owner.session.channels.ensure("c");
    await flush();
    wire.next().respond([
      seen,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 10, id: seen.id },
      }),
    ]);
    await flush();
    expect(rows()).toEqual([seen.id]);
    live.state({ status: "connected", routes: [] });
    live.established("c");
    await flush();
    expect(wire.pending.length).toBeGreaterThan(0);
    while (wire.pending.length) {
      wire.next().respond([
        missed,
        bounds(relay, "c", "head", {
          has_more: true,
          next_cursor: { created_at: 30, id: missed.id },
        }),
      ]);
      await flush();
    }
    expect(rows()).toEqual([seen.id, missed.id]);
    // Reads older than any loaded page still wait for paging to reach them.
    const read = owner.session.read([{ ids: [old.id], limit: 1 }]);
    wire.next().respond([old]);
    await read;
    expect(rows()).toEqual([seen.id, missed.id]);
  } finally {
    owner.dispose();
  }
});
