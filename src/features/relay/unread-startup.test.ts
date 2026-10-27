import { afterEach, assert, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import { readJournal, type ReadJournal } from "./read-state-storage";
import { keypair, message, metadata, roster, signed } from "./testing";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function setup(count = 1) {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  let journal: ReadJournal | undefined;
  let receive: (events: readonly RelayEvent[]) => void = () => {};
  let live: LiveCallbacks | undefined;
  const marker = deferred(),
    profile = deferred();
  let holdMarker = false,
    holdProfile = false;
  const row = message(peer, "other", "unread evidence", 11);
  const trace: { kind: number | undefined; ms: number }[] = [];
  const started = performance.now();
  const profileSignals: (AbortSignal | undefined)[] = [];
  const query = vi.fn(
    async (filters: readonly ReadFilter[], signal?: AbortSignal) => {
      const kind = filters[0]?.kinds?.includes(9) ? 9 : filters[0]?.kinds?.[0];
      trace.push({ kind, ms: performance.now() - started });
      if (kind === 0) profileSignals.push(signal);
      const wait =
        kind === 0 && holdProfile
          ? profile.promise
          : kind === 30078 && holdMarker
            ? marker.promise
            : undefined;
      if (wait)
        await Promise.race([
          wait,
          new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      return kind === 9 ? [row] : [];
    },
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      readState: { decode: async () => [] },
      subscribe(callbacks) {
        live = callbacks;
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateStorage: {
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
    },
  );
  owners.push(owner);
  const ids = Array.from({ length: count }, (_, i) =>
    i === 0 ? "other" : `room-${i}`,
  );
  receive(
    ids.flatMap((id) => [
      roster(relay, id, [viewer.pubkey], 10),
      metadata(relay, id, id, 10),
    ]),
  );
  return {
    ...owner,
    viewer,
    relay,
    peer,
    row,
    query,
    trace,
    profileSignals,
    ids,
    receive,
    reconnect() {
      assert(live);
      live.state({ status: "connected", routes: [] });
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
      live.established();
    },
    holdProfile() {
      holdProfile = true;
      return profile.release;
    },
    holdMarker() {
      holdMarker = true;
      return marker.release;
    },
    snapshot: () =>
      owner.session.unread.snapshot({ kind: "channel", channelId: "other" }),
  };
}

it("initial unread markers and evidence bypass held optional profiles without cancelling them", async () => {
  const h = setup();
  const release = h.holdProfile();
  let profileFinished = false;
  const profiles = h.session.profiles
    .ensure([h.peer.pubkey], "background")
    .finally(() => {
      profileFinished = true;
    });
  try {
    await h.session.unread.ensure();
    expect(h.trace.map(({ kind }) => kind)).toEqual([0, 30078, 9]);
    expect(profileFinished).toBe(false);
    expect(h.profileSignals).toHaveLength(1);
    expect(h.profileSignals[0]?.aborted).toBe(false);
    expect(h.snapshot().observedCount).toBe(1);
  } finally {
    release();
    await profiles;
  }
}, 15000);

it("evidence gets its own deadline after a failed marker read; marker errors stay visible", async () => {
  const h = setup();
  // Control the caller deadline directly instead of coupling this test to
  // Node's native timeout clock or the reader's separate job timer.
  const deadlines: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const release = h.holdMarker();
  try {
    const done = h.session.unread.ensure();
    await vi.waitFor(() =>
      expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
    );
    expect(deadlines).toHaveLength(1);
    const marker = deadlines[0];
    assert(marker);
    marker.abort(new DOMException("Marker deadline expired", "TimeoutError"));
    await done;
    expect(deadlines).toHaveLength(2);
    expect(deadlines[1]?.signal.aborted).toBe(false);
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9]);
    expect(h.snapshot()).toMatchObject({
      observedCount: 1,
      freshness: "observed",
    });
    expect(h.session.unread.sync()).toMatchObject({
      status: "error",
      completeness: "unknown",
    });
  } finally {
    timeout.mockRestore();
    release();
  }
  await h.session.unread.refresh();
  expect(h.session.unread.sync().status).toBe("reconciled");
});

it("queries all 278 membership IDs in four-channel requests and publishes each landed request", async () => {
  const h = setup(278);
  const batches: string[][] = [];
  const first = message(h.peer, "other", "first", 11);
  const second = message(h.peer, "room-128", "second", 12);
  const last = message(h.peer, "room-277", "last", 13);
  const observed: (number | null)[] = [];
  h.session.unread.subscribe({ kind: "channel", channelId: "other" }, () => {
    observed.push(h.snapshot().observedCount);
  });
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9)) return [];
    if (!filters[0]["#h"]) return [];
    expect(filters.length).toBeLessThanOrEqual(4);
    // The viewer's authored page rides the last request.
    const ids = filters.flatMap((filter) => {
      if (filter.authors) return [];
      expect(filter["#h"]).toHaveLength(1);
      expect(filter).toMatchObject({
        include_aux: true,
        limit: 100,
        since: expect.any(Number),
      });
      return [filter["#h"]?.[0] ?? ""];
    });
    batches.push(ids);
    // Two requests run at once; the first has landed before a third starts.
    if (batches.length > 2) expect(h.snapshot().observedCount).toBe(1);
    return [first, second, last].filter((event) =>
      ids.includes(event.tags[0]?.[1] ?? ""),
    );
  });
  await h.session.unread.ensure();
  expect(batches).toHaveLength(70);
  expect(batches.flat().sort()).toEqual([...h.ids].sort());
  expect(observed).toContain(1);
  expect(
    h.session.unread.snapshot({ kind: "channel", channelId: "room-277" })
      .observedCount,
  ).toBe(1);
  expect(h.session.channels.window("room-277").rows).toEqual([]);
});

it("a full channel window does not starve later channels, and a failed request retains evidence until explicit retry", async () => {
  const h = setup(129);
  const rows = Array.from({ length: 100 }, (_, i) =>
    message(h.peer, "other", `busy ${i}`, 11 + i),
  );
  let fail = true;
  const batches: string[][] = [];
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9) || !filters[0]["#h"]) return [];
    const ids = filters.flatMap((filter) => filter["#h"] ?? []);
    batches.push(ids);
    if (ids.includes("other")) return rows;
    if (fail) throw new Error("Later chunk unavailable");
    return ids.map((id) => message(h.peer, id, "quiet", 11));
  });
  await h.session.unread.ensure();
  // The failure stops the pass once the requests in flight have landed.
  const attempted = batches.length;
  expect(attempted).toBeGreaterThanOrEqual(2);
  expect(attempted).toBeLessThan(33);
  expect(h.snapshot()).toMatchObject({
    observedCount: 100,
    freshness: "stale",
    error: "Later chunk unavailable",
  });
  await h.session.unread.ensure();
  expect(batches).toHaveLength(attempted); // No automatic retry loop.
  fail = false;
  await h.session.unread.refresh();
  expect(batches).toHaveLength(attempted + 33);
  expect(h.snapshot()).toMatchObject({
    observedCount: 100,
    freshness: "observed",
  });
  expect(h.snapshot().error).toBeUndefined();
  const quiet = batches[1]?.[0];
  assert(quiet);
  expect(
    h.session.unread.snapshot({ kind: "channel", channelId: quiet })
      .observedCount,
  ).toBe(1);
});

function conversationRelay(h: ReturnType<typeof setup>) {
  // A relay whose channel window holds only the 100 newest rows and whose
  // page of the viewer's own messages holds none of these older replies, so
  // older conversation membership is reachable only by parent lookup.
  const store: RelayEvent[] = [];
  const lookups: ReadFilter[][] = [];
  let fail = false;
  const tagged = (event: RelayEvent, ids: readonly string[]) =>
    event.tags.some(
      ([name, value]) => name === "e" && ids.includes(value ?? ""),
    );
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9)) return [];
    if (filters[0].ids || (filters[0].authors && filters[0]["#e"])) {
      lookups.push([...filters]);
      if (fail) throw new Error("lookup failed");
    }
    return filters.flatMap((filter) =>
      filter.authors && !filter["#e"]
        ? []
        : [...store]
            .filter(
              (event) =>
                (!filter["#h"] ||
                  event.tags.some(
                    ([name, value]) =>
                      name === "h" && filter["#h"]?.includes(value ?? ""),
                  )) &&
                (!filter.ids || filter.ids.includes(event.id)) &&
                (!filter.authors || filter.authors.includes(event.pubkey)) &&
                (filter.until === undefined ||
                  event.created_at <= filter.until) &&
                (!filter["#e"] || tagged(event, filter["#e"])),
            )
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit),
    );
  });
  const asked = () =>
    lookups.flatMap((filters) =>
      filters.flatMap((filter) => (filter.authors ? (filter["#e"] ?? []) : [])),
    );
  const fetched = () =>
    lookups.flatMap((filters) => filters.flatMap((filter) => filter.ids ?? []));
  return {
    store,
    lookups,
    asked,
    fetched,
    fail(value: boolean) {
      fail = value;
    },
  };
}
const reply = (
  author: ReturnType<typeof keypair>,
  content: string,
  time: number,
  root: RelayEvent,
  parent: RelayEvent,
  channel = "other",
) =>
  message(author, channel, content, time, [
    ...(root === parent ? [] : [["e", root.id, "", "root"]]),
    ["e", parent.id, "", "reply"],
  ]);
const busy = (h: ReturnType<typeof setup>, count: number) =>
  Array.from({ length: count }, (_, i) =>
    message(h.peer, "other", `busy ${i}`, 100 + i),
  );

it("looks up conversation membership that falls outside the sampled window", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "other", "my old post", 10);
  const agentRoot = message(h.peer, "other", "agent post", 11);
  const myOldReply = reply(h.viewer, "my old reply", 12, agentRoot, agentRoot);
  const answer = reply(h.peer, "answer to me", 700, mine, mine);
  const sibling = reply(h.peer, "same level as me", 701, agentRoot, agentRoot);
  const nested = reply(h.peer, "nested, not mine", 702, agentRoot, sibling);
  const underAnswer = reply(
    h.peer,
    "nested under the answer",
    703,
    mine,
    answer,
  );
  // 100 newer rows fill the channel window and push out every older message.
  relay.store.push(
    mine,
    agentRoot,
    myOldReply,
    answer,
    sibling,
    nested,
    underAnswer,
    ...busy(h, 96),
  );
  await h.session.unread.ensure();
  const attention = (id: string) => h.session.unread.attention("other", id);
  // Before membership arrives, undecided replies stay quiet and pending.
  expect(attention(answer.id)).toMatchObject({
    status: "unknown",
    pending: true,
    unread: false,
  });
  expect(h.snapshot().observedCount).toBe(96);
  await vi.waitFor(() =>
    expect(attention(answer.id)).toMatchObject({
      status: "eligible",
      category: "thread",
      rootId: mine.id,
      unread: true,
    }),
  );
  await vi.waitFor(() =>
    expect(attention(sibling.id)).toMatchObject({
      category: "thread",
      unread: true,
    }),
  );
  // The viewer's thread membership covers every reply under its root.
  for (const item of [nested, underAnswer])
    await vi.waitFor(() =>
      expect(attention(item.id)).toMatchObject({
        category: "thread",
        unread: true,
      }),
    );
  // Fetched parents are structure only: the badge gains the four replies in
  // the viewer's threads, not the fetched old posts.
  expect(h.snapshot()).toMatchObject({ observedCount: 100, attentionCount: 4 });
  // Each undecided parent is asked once, scoped to its channel: by ID when
  // missing, and for the viewer's replies to it.
  expect(relay.asked().sort()).toEqual(
    [mine.id, agentRoot.id, sibling.id, answer.id].sort(),
  );
  expect(relay.fetched().sort()).toEqual([mine.id, agentRoot.id].sort());
  for (const filters of relay.lookups)
    for (const filter of filters)
      expect(filter).toMatchObject(
        filter.ids
          ? { include_aux: true, limit: filter.ids.length }
          : {
              authors: [h.viewer.pubkey],
              "#h": ["other"],
              include_aux: true,
              limit: 500,
            },
      );
  const count = relay.lookups.length;
  // Decided parents are not asked again; fetched parents start no lookup.
  h.session.unread.snapshot({ kind: "channel", channelId: "other" });
  h.session.unread.activity("other");
  await Promise.resolve();
  expect(relay.lookups).toHaveLength(count);
});

it("a reply whose parent and root are both outside the window still groups as the viewer's thread", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const root = message(h.peer, "other", "old root", 10);
  const mine = reply(h.viewer, "my old nested reply", 11, root, root);
  const answer = reply(h.peer, "agent answers me", 700, root, mine);
  relay.store.push(root, mine, answer, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  const attention = () => h.session.unread.attention("other", answer.id);
  await vi.waitFor(() =>
    expect(attention()).toMatchObject({
      status: "eligible",
      category: "thread",
      rootId: root.id,
      unread: true,
    }),
  );
  // The parent and the root are fetched together; neither recurses.
  expect(relay.fetched().sort()).toEqual([mine.id, root.id].sort());
  expect(h.snapshot()).toMatchObject({ observedCount: 100, attentionCount: 1 });
  expect(
    h.session.unread.snapshot({
      kind: "thread",
      channelId: "other",
      rootId: root.id,
    }).observedCount,
  ).toBe(1);
  expect(h.session.unread.activity("other").items).toMatchObject([
    { rootId: root.id, latestMessageId: answer.id },
  ]);
});

it("a full page of replies under one parent cannot hide the viewer's reply to another", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const busyRoot = message(h.peer, "other", "busy root", 10);
  const quietRoot = message(h.peer, "other", "quiet root", 11);
  const mineQuiet = reply(h.viewer, "my one reply", 12, quietRoot, quietRoot);
  const busyParent = reply(h.peer, "busy parent", 13, busyRoot, busyRoot);
  // 500 newer replies of the viewer deep under busyRoot match `#e` by root tag.
  const deep = Array.from({ length: 500 }, (_, i) =>
    reply(h.viewer, `deep ${i}`, 20 + i, busyRoot, busyParent),
  );
  const answer = reply(h.peer, "same level as me", 700, quietRoot, quietRoot);
  const peerUnderBusy = reply(
    h.peer,
    "under busy root",
    701,
    busyRoot,
    busyRoot,
  );
  relay.store.push(busyRoot, quietRoot, mineQuiet, busyParent, ...deep);
  relay.store.push(answer, peerUnderBusy, ...busy(h, 98));
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() =>
    expect(h.session.unread.attention("other", answer.id)).toMatchObject({
      category: "thread",
      unread: true,
    }),
  );
  // The viewer's deep replies make busyRoot's whole thread the viewer's.
  expect(h.session.unread.attention("other", peerUnderBusy.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
  expect(h.session.unread.attention("other", peerUnderBusy.id).pending).toBe(
    undefined,
  );
});

it("a busy root's deep replies of the viewer decide its thread in one page", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const root = message(h.peer, "other", "busy root", 10);
  const mine = reply(h.viewer, "my direct reply", 12, root, root);
  const nestedParent = reply(h.peer, "nested parent", 13, root, root);
  // 500 newer replies of the viewer, nested deeper, match `#e` by root tag.
  const deep = Array.from({ length: 500 }, (_, i) =>
    reply(h.viewer, `deep ${i}`, 20 + i, root, nestedParent),
  );
  const answer = reply(h.peer, "same level as me", 2000, root, root);
  relay.store.push(root, mine, nestedParent, ...deep, answer);
  relay.store.push(
    ...Array.from({ length: 99 }, (_, i) =>
      message(h.peer, "other", `busy ${i}`, 1000 + i),
    ),
  );
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() =>
    expect(h.session.unread.attention("other", answer.id)).toMatchObject({
      category: "thread",
      unread: true,
    }),
  );
  const pages = relay.lookups
    .flat()
    .filter((filter) => filter.authors && filter["#e"]?.includes(root.id));
  // Any reply of the viewer under the root makes the whole thread the
  // viewer's, so the first full page already decides it.
  expect(pages.map((filter) => filter.until)).toEqual([undefined]);
});

it("a reply to the viewer's message in another channel is not the viewer's conversation", async () => {
  const h = setup(2);
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "room-1", "my post elsewhere", 10);
  const forged = reply(h.peer, "claims my parent", 700, mine, mine);
  relay.store.push(mine, forged, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() =>
    expect(
      h.session.unread.attention("other", forged.id).pending,
    ).toBeUndefined(),
  );
  const forgedAttention = h.session.unread.attention("other", forged.id);
  expect(forgedAttention).toMatchObject({ unread: false });
  expect(forgedAttention.category).toBeUndefined();
});

it("a deleted reply of the viewer does not join its parent", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const agentRoot = message(h.peer, "other", "agent post", 10);
  const mine = reply(h.viewer, "my old reply", 11, agentRoot, agentRoot);
  const removal = signed(h.viewer, {
    kind: 5,
    content: "",
    created_at: 12,
    tags: [
      ["e", mine.id],
      ["h", "other"],
    ],
  });
  const sibling = reply(h.peer, "same level", 700, agentRoot, agentRoot);
  relay.store.push(agentRoot, mine, removal, sibling, ...busy(h, 99));
  // The fixture relay returns the deletion with include_aux lookups.
  const base = h.query.getMockImplementation();
  h.query.mockImplementation(async (filters, signal) => {
    const rows = (await base?.(filters, signal)) ?? [];
    return filters[0]?.authors && filters[0].include_aux
      ? [...rows, removal]
      : rows;
  });
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() =>
    expect(
      h.session.unread.attention("other", sibling.id).pending,
    ).toBeUndefined(),
  );
  expect(h.session.unread.attention("other", sibling.id).unread).toBe(false);
});

it("deleting the viewer's reply after a completed lookup ends the membership", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const agentRoot = message(h.peer, "other", "agent post", 10);
  const mine = reply(h.viewer, "my old reply", 11, agentRoot, agentRoot);
  const sibling = reply(h.peer, "same level", 700, agentRoot, agentRoot);
  relay.store.push(agentRoot, mine, sibling, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  const attention = () => h.session.unread.attention("other", sibling.id);
  await vi.waitFor(() =>
    expect(attention()).toMatchObject({ category: "thread", unread: true }),
  );
  const count = relay.lookups.length;
  // Another client deletes the old reply. This client never loaded it, so
  // the deletion must still pass the session's target-visibility check.
  expect(h.session.channels.window("other").rows).toEqual([]);
  h.receive([
    signed(h.viewer, {
      kind: 5,
      content: "",
      created_at: 800,
      tags: [
        ["h", "other"],
        ["e", mine.id],
      ],
    }),
  ]);
  expect(attention()).toMatchObject({ status: "ineligible", unread: false });
  expect(attention().category).toBeUndefined();
  const later = reply(h.peer, "another sibling", 801, agentRoot, agentRoot);
  h.receive([later]);
  expect(h.session.unread.attention("other", later.id).unread).toBe(false);
  expect(relay.lookups).toHaveLength(count);
});

it("deleting one of the viewer's replies keeps the membership its other replies hold", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const agentRoot = message(h.peer, "other", "agent post", 10);
  const older = reply(h.viewer, "my older reply", 11, agentRoot, agentRoot);
  const newer = reply(h.viewer, "my newer reply", 12, agentRoot, agentRoot);
  const sibling = reply(h.peer, "same level", 700, agentRoot, agentRoot);
  relay.store.push(agentRoot, older, newer, sibling, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  const attention = () => h.session.unread.attention("other", sibling.id);
  await vi.waitFor(() =>
    expect(attention()).toMatchObject({ category: "thread", unread: true }),
  );
  const asked = relay.lookups.length;
  relay.store.splice(relay.store.indexOf(newer), 1);
  h.receive([
    signed(h.viewer, {
      kind: 5,
      content: "",
      created_at: 800,
      tags: [
        ["h", "other"],
        ["e", newer.id],
      ],
    }),
  ]);
  // The deleted reply was the lookup's witness; the parent is asked again.
  await vi.waitFor(() => {
    expect(attention()).toMatchObject({ category: "thread", unread: true });
    expect(relay.lookups.length).toBeGreaterThan(asked);
  });
});

it("deleting the viewer's parent and then their reply ends the membership", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "other", "my old post", 10);
  const myReply = reply(h.viewer, "my reply to it", 11, mine, mine);
  const answer = reply(h.peer, "answer", 700, mine, mine);
  relay.store.push(mine, myReply, answer, ...busy(h, 99));
  await h.session.unread.ensure();
  h.snapshot();
  const attention = () => h.session.unread.attention("other", answer.id);
  await vi.waitFor(() =>
    expect(attention()).toMatchObject({ category: "thread", unread: true }),
  );
  const remove = (target: RelayEvent, time: number) => {
    relay.store.splice(relay.store.indexOf(target), 1);
    h.receive([
      signed(h.viewer, {
        kind: 5,
        content: "",
        created_at: time,
        tags: [
          ["h", "other"],
          ["e", target.id],
        ],
      }),
    ]);
  };
  // Another client deletes the parent, then the reply; this client loaded
  // neither into its window.
  expect(h.session.channels.window("other").rows).toEqual([]);
  remove(mine, 800);
  await vi.waitFor(() => {
    expect(attention().pending).toBeUndefined();
    expect(attention()).toMatchObject({ category: "thread", unread: true });
  });
  remove(myReply, 801);
  await vi.waitFor(() => {
    expect(attention().pending).toBeUndefined();
    expect(attention()).toMatchObject({ unread: false });
  });
  expect(attention().category).toBeUndefined();
});

it("lookups for the same parent ID in two channels do not share a result", async () => {
  const h = setup(2);
  const relay = conversationRelay(h);
  const root = message(h.peer, "other", "peer post", 10);
  const mine = reply(h.viewer, "my old reply", 11, root, root);
  // A reply in another channel that deliberately tags the same parent.
  const elsewhere = reply(h.peer, "cross-channel", 700, root, root, "room-1");
  const sibling = reply(h.peer, "same level as me", 701, root, root);
  relay.store.push(root, mine, elsewhere, sibling, ...busy(h, 98));
  await h.session.unread.ensure();
  // The other channel asks first, in the same turn.
  h.session.unread.attention("room-1", elsewhere.id);
  h.session.unread.attention("other", sibling.id);
  await vi.waitFor(() =>
    expect(h.session.unread.attention("other", sibling.id)).toMatchObject({
      category: "thread",
      unread: true,
    }),
  );
  await vi.waitFor(() =>
    expect(
      h.session.unread.attention("room-1", elsewhere.id).pending,
    ).toBeUndefined(),
  );
  const elsewhereAttention = h.session.unread.attention("room-1", elsewhere.id);
  expect(elsewhereAttention).toMatchObject({ unread: false });
  expect(elsewhereAttention.category).toBeUndefined();
});

it("a lookup in flight during a cache clear cannot restore its result", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "other", "my old post", 10);
  const answer = reply(h.peer, "answer to me", 700, mine, mine);
  relay.store.push(mine, answer, ...busy(h, 99));
  const base = h.query.getMockImplementation();
  const held = deferred();
  let hold = true;
  h.query.mockImplementation(async (filters, signal) => {
    // Evaluate against the relay now; answer after the clear.
    const rows = (await base?.(filters, signal)) ?? [];
    const lookup =
      filters[0]?.kinds?.includes(9) &&
      (filters[0].ids || (filters[0].authors && filters[0]["#e"]));
    if (hold && lookup) await held.promise;
    return rows;
  });
  await h.session.unread.ensure();
  h.snapshot();
  await vi.waitFor(() => expect(relay.lookups.length).toBeGreaterThan(0));
  await h.clearCache();
  // After the clear, the viewer's post is gone from the relay.
  relay.store.splice(relay.store.indexOf(mine), 1);
  hold = false;
  held.release();
  const asked = relay.lookups.length;
  h.receive([
    roster(h.relay, "other", [h.viewer.pubkey], 11),
    metadata(h.relay, "other", "other", 11),
  ]);
  await h.session.unread.refresh();
  h.snapshot();
  await vi.waitFor(() => expect(relay.lookups.length).toBeGreaterThan(asked));
  await vi.waitFor(() =>
    expect(
      h.session.unread.attention("other", answer.id).pending,
    ).toBeUndefined(),
  );
  expect(h.session.unread.attention("other", answer.id).unread).toBe(false);
});

it("a failed membership lookup stays pending and retries with backoff", async () => {
  const h = setup();
  const relay = conversationRelay(h);
  const mine = message(h.viewer, "other", "my old post", 10);
  const answer = reply(h.peer, "answer to me", 700, mine, mine);
  relay.store.push(mine, answer, ...busy(h, 99));
  relay.fail(true);
  await h.session.unread.ensure();
  const attention = () => h.session.unread.attention("other", answer.id);
  h.snapshot();
  await vi.waitFor(() => expect(relay.lookups.length).toBeGreaterThan(0));
  const failed = relay.lookups.length;
  expect(attention()).toMatchObject({ pending: true, unread: false });
  relay.fail(false);
  // New evidence does not retry at once: the parent stays pending in backoff.
  h.receive([message(h.peer, "other", "new top-level", 800)]);
  h.snapshot();
  await Promise.resolve();
  expect(relay.lookups).toHaveLength(failed);
  await vi.waitFor(
    () =>
      expect(attention()).toMatchObject({ category: "thread", unread: true }),
    { timeout: 3000 },
  );
});

it.each(["clear", "dispose", "revoke", "join"])(
  "late chunk cannot publish or dispatch another after %s",
  async (boundary) => {
    const h = setup(129);
    const held = deferred(),
      fresh = deferred();
    const batches: string[][] = [];
    const windows = () => batches.filter((ids) => ids.length);
    h.query.mockImplementation(async (filters) => {
      if (!filters[0]?.kinds?.includes(9)) return [];
      const ids = filters.flatMap((filter) => filter["#h"] ?? []);
      batches.push(ids);
      // The two window requests in flight are held across the boundary.
      await (ids.length && windows().length <= 2
        ? held.promise
        : fresh.promise);
      return [h.row];
    });
    const repair = h.session.unread.ensure();
    await vi.waitFor(() => expect(windows()).toHaveLength(2));
    if (boundary === "dispose") h.dispose();
    else if (boundary === "clear") await h.clearCache();
    else if (boundary === "join")
      h.receive([roster(h.relay, "new-room", [h.viewer.pubkey], 20)]);
    else h.receive([roster(h.relay, "other", [], 20)]);
    held.release();
    await repair;
    if (boundary === "clear" || boundary === "dispose") {
      expect(windows()).toHaveLength(2);
      expect(h.snapshot().observedCount).toBeNull();
      return;
    }
    // The abandoned read starts over against the current membership.
    await vi.waitFor(() => expect(windows()).toHaveLength(4));
    expect(h.snapshot().observedCount).toBeNull();
    fresh.release();
    await h.session.unread.ensure();
    const reread = windows().slice(2).flat();
    if (boundary === "join") {
      expect(reread).toContain("new-room");
      expect(h.snapshot().observedCount).toBe(1);
    } else {
      expect(reread).toHaveLength(128);
      expect(reread).not.toContain("other");
      expect(h.snapshot().observedCount).toBeNull();
    }
  },
);

it("concurrent ensure callers share the active marker/evidence work", async () => {
  const h = setup();
  const release = h.holdMarker();
  const first = h.session.unread.ensure();
  await vi.waitFor(() =>
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
  );
  let finished = false;
  const second = h.session.unread.ensure().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(finished).toBe(false);
  release();
  await Promise.all([first, second]);
  expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9]);
  expect(h.snapshot().observedCount).toBe(1);
});

it("transient startup failure recovers on live reconnect without an automatic retry loop", async () => {
  const h = setup();
  let fail = true;
  h.query.mockImplementation(async (filters) => {
    if (filters[0]?.kinds?.includes(39002))
      return [
        roster(h.relay, "other", [h.viewer.pubkey], 10),
        metadata(h.relay, "other", "other", 10),
      ];
    if (!filters[0]?.kinds?.includes(9)) return [];
    if (fail) throw new Error("Transient evidence failure");
    return [h.row];
  });
  await h.session.unread.ensure();
  expect(h.snapshot().error).toBe("Transient evidence failure");
  const count = h.query.mock.calls.length;
  await h.session.unread.ensure();
  expect(h.query).toHaveBeenCalledTimes(count);
  fail = false;
  h.reconnect();
  await vi.waitFor(() =>
    expect(h.snapshot()).toMatchObject({
      observedCount: 1,
      freshness: "observed",
    }),
  );
  expect(h.snapshot().error).toBeUndefined();
});

it("a full budget evicts the oldest evidence and the observation still completes", async () => {
  const h = setup(129);
  const oldest = message(h.peer, "other", "x".repeat(450000), 11);
  h.receive([
    oldest,
    ...Array.from({ length: 17 }, (_, i) =>
      message(h.peer, "other", "x".repeat(450000), i + 12),
    ),
  ]);
  expect(h.snapshot().observedCount).toBe(18);
  expect(h.session.unread.attention("other", oldest.id).unread).toBe(true);
  const overflow = message(h.peer, "other", "x".repeat(450000), 40);
  let batches = 0;
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9)) return [];
    batches++;
    return [overflow];
  });
  await h.session.unread.ensure();
  // Every window request still runs.
  expect(batches).toBe(33);
  expect(h.snapshot()).toMatchObject({
    observedCount: 18,
    freshness: "observed",
  });
  expect(h.snapshot().error).toBeUndefined();
  expect(h.session.unread.attention("other", overflow.id).unread).toBe(true);
  expect(h.session.unread.attention("other", oldest.id).unread).toBe(false);
});

it.each(["clear", "dispose", "revoke"])(
  "no evidence dispatch after %s while markers are pending",
  async (boundary) => {
    const h = setup(129);
    const release = h.holdMarker();
    const repair = h.session.unread.ensure();
    await vi.waitFor(() =>
      expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
    );
    if (boundary === "dispose") h.dispose();
    else if (boundary === "clear") await h.clearCache();
    else h.receive([roster(h.relay, "other", [], 20)]);
    release();
    await repair;
    if (boundary !== "revoke") {
      expect(h.trace.map(({ kind }) => kind)).toEqual([30078]);
      return;
    }
    // Only a fresh observation without the revoked channel is dispatched.
    await h.session.unread.ensure();
    const evidence = h.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(9) && filter["#h"]);
    expect(evidence).toHaveLength(128);
    expect(evidence.flatMap((filter) => filter["#h"] ?? [])).not.toContain(
      "other",
    );
  },
);

it("a subscriber clearing cache during progressive publication stops later chunks", async () => {
  const h = setup(129);
  let cleared: Promise<void> | undefined;
  h.session.unread.subscribe({ kind: "channel", channelId: "other" }, () => {
    if (h.snapshot().observedCount === 1) cleared = h.clearCache();
  });
  await h.session.unread.ensure();
  await cleared;
  // The two requests in flight land; nothing further is dispatched.
  expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9, 9]);
  expect(h.snapshot().observedCount).toBeNull();
});

it("explicit refresh bypasses optional profiles for both markers and evidence", async () => {
  const h = setup();
  await h.session.unread.ensure();
  const release = h.holdProfile();
  const profiles = h.session.profiles.ensure([h.peer.pubkey], "background");
  try {
    await h.session.unread.refresh();
    expect(h.profileSignals[0]?.aborted).toBe(false);
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9, 0, 30078, 9]);
  } finally {
    release();
    await profiles;
  }
}, 15000);

it("observes a channel again when the viewer regains access to it", async () => {
  const h = setup();
  await h.session.unread.ensure();
  expect(h.snapshot().observedCount).toBe(1);
  h.receive([roster(h.relay, "other", [], 20)]);
  expect(h.snapshot().observedCount).toBeNull();
  h.receive([roster(h.relay, "other", [h.viewer.pubkey], 30)]);
  await vi.waitFor(() => expect(h.snapshot().observedCount).toBe(1));
});
