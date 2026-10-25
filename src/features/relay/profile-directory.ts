import { attestedOwner } from "../agents/owner-attestation";
import { hasEventProof } from "./events";
import type { Outbox } from "./outbox";
import { ByteLru } from "./budget";
import type { Profile } from "./contracts";
import type { RelayEvent } from "./events";
import { newer } from "./events";
import { foldProfiles } from "./profiles";
import type { Priority, RelayReader } from "./reader";

/** Shared profile reads for any feature, independent of channel history. */
export interface ProfileQueries {
  snapshot(): ReadonlyMap<string, Profile>;
  subscribe(listener: () => void): () => void;
  /** Fetch missing profiles; optional enrichment can yield to conversation reads. */
  ensure(ids: readonly string[], priority?: Priority): Promise<void>;
  /** The winning signed kind 0 retained for one identity, for provenance checks. */
  event?(pubkey: string): RelayEvent | undefined;
  /** Identities a completed read found no profile for, until one arrives. */
  unnamed?(): ReadonlySet<string>;
  /** Cryptographically verified owner of the retained signed profile head. */
  owner?(pubkey: string): string | undefined;
}

/** One bounded source of signed profile events. Display values are derived from it. */
export function createProfileDirectory(
  reader: RelayReader,
  local?: Pick<Outbox, "snapshot" | "subscribe">,
  notify = (listener: () => void) => listener(),
) {
  const events = new ByteLru<RelayEvent>(1024, 2 * 1024 * 1024);
  const owners = new WeakMap<RelayEvent, string>();
  const pending = new Map<
    string,
    { work: Promise<void>; authors: string[]; priority: Priority }
  >();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, Profile> = new Map();
  // Replaced, never mutated, so stores can compare it like `snapshot`.
  let unnamed: ReadonlySet<string> = new Set();
  let controller = new AbortController();
  let closed = false;
  function accept(incoming: readonly RelayEvent[]) {
    if (closed) return;
    let changed = false;
    const attested: Promise<boolean>[] = [];
    for (const event of incoming) {
      if (event.kind !== 0) continue;
      const previous = events.peek(event.pubkey);
      if (newer(previous, event) === previous) continue;
      events.set(event.pubkey, event);
      if (hasEventProof(event))
        attested.push(
          attestedOwner(event).then((owner) => {
            if (closed || events.peek(event.pubkey) !== event || !owner)
              return false;
            owners.set(event, owner);
            return true;
          }),
        );
      changed = true;
    }
    if (changed) publish(true);
    // One notification per batch: every publish refolds all profiles, and
    // listeners refold every cached channel.
    if (attested.length)
      void Promise.all(attested).then((settled) => {
        if (!closed && settled.some(Boolean)) publish(true);
      });
  }
  /** Notifies on display changes, and on winning-event changes for `event()` readers. */
  function publish(headChanged = false) {
    const next = foldProfiles([
      ...events.keys().flatMap((id) => {
        const event = events.peek(id);
        return event ? [event] : [];
      }),
      ...((closed ? undefined : local)
        ?.snapshot()
        .filter((item) => item.event.kind === 0 && item.delivery !== "failed")
        .map((item) => item.event) ?? []),
    ]);
    for (const [id, value] of next) {
      const old = snapshot.get(id);
      if (
        old?.name === value.name &&
        old?.nameIsFallback === value.nameIsFallback &&
        old?.username === value.username &&
        old?.picture === value.picture &&
        old?.about === value.about &&
        old?.nip05 === value.nip05 &&
        old?.isAgent === value.isAgent &&
        old?.ownerPubkey === value.ownerPubkey
      )
        next.set(id, old);
    }
    if (
      next.size !== snapshot.size ||
      [...next].some(([id, value]) => snapshot.get(id) !== value)
    ) {
      snapshot = next;
      if ([...unnamed].some((id) => next.has(id)))
        unnamed = new Set([...unnamed].filter((id) => !next.has(id)));
    } else if (!headChanged) return;
    for (const listener of listeners) notify(listener);
  }
  /** A completed read that returned no kind 0 is evidence too: the identity is known unnamed. */
  function missed(ids: readonly string[]) {
    const fresh = ids.filter((id) => !snapshot.has(id) && !unnamed.has(id));
    if (!fresh.length) return;
    unnamed = new Set([...unnamed, ...fresh].slice(-1024));
    for (const listener of listeners) notify(listener);
  }
  async function ensure(
    ids: readonly string[],
    priority: Priority = "foreground",
    refresh = false,
  ) {
    if (closed) throw new DOMException("Session closed", "AbortError");
    const unique = [...new Set(ids)];
    if (!refresh && unique.length > 1024)
      throw new Error("Profile request exceeds the directory budget");
    const signal = controller.signal;
    const waiting = new Set<Promise<void>>();
    const missing = unique.filter((id) => {
      const batch = pending.get(id);
      if (batch) {
        // Rejoin the equal read so the reader promotes it if still queued;
        // waiting on the old promise alone would leave it behind background work.
        if (priority === "foreground" && batch.priority === "background") {
          batch.priority = priority;
          void reader
            .read([{ kinds: [0], authors: batch.authors, limit: 500 }], {
              signal,
              priority,
            })
            .catch(() => {});
        }
        waiting.add(batch.work);
      }
      return !batch && (refresh || !snapshot.has(id));
    });
    for (let offset = 0; offset < missing.length; offset += 500) {
      const authors = missing.slice(offset, offset + 500);
      const batch = {
        authors,
        priority,
        work: reader
          .read([{ kinds: [0], authors, limit: 500 }], { signal, priority })
          .then((result) => {
            if (signal.aborted) return;
            accept(result.filter((event) => authors.includes(event.pubkey)));
            missed(authors);
          })
          .finally(() => {
            for (const id of authors)
              if (pending.get(id) === batch) pending.delete(id);
          }),
      };
      for (const id of authors) pending.set(id, batch);
      waiting.add(batch.work);
    }
    await Promise.all(waiting);
  }
  function clear() {
    controller.abort();
    controller = new AbortController();
    pending.clear();
    events.clear();
    const forgot = unnamed.size > 0;
    unnamed = new Set();
    publish(forgot);
  }
  const queries: ProfileQueries = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
    event: (pubkey: string) => events.peek(pubkey),
    unnamed: () => unnamed,
    owner: (pubkey: string) => {
      const event = events.peek(pubkey);
      return event ? owners.get(event) : undefined;
    },
  });
  let localProfiles = "";
  const unsubscribeLocal = local?.subscribe(() => {
    const signature = local
      .snapshot()
      .filter((item) => item.event.kind === 0 && item.delivery !== "failed")
      .map((item) => item.event.id)
      .join(":");
    if (signature === localProfiles) return;
    localProfiles = signature;
    publish();
  });
  publish();
  return {
    queries,
    ensure,
    accept,
    clear,
    reconnect() {
      // Keep winning signed heads: a lagging or failed read must not roll them back.
      const ids = [...new Set([...events.keys(), ...pending.keys()])];
      controller.abort();
      controller = new AbortController();
      pending.clear();
      return ensure(ids, "background", true);
    },
    event: (id: string) => events.peek(id),
    stats: () => events.stats(),
    dispose() {
      closed = true;
      unsubscribeLocal?.();
      clear();
      listeners.clear();
    },
  };
}
export type ProfileDirectory = ReturnType<typeof createProfileDirectory>;
