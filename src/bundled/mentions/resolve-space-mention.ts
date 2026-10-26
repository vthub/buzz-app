import {
  fullSession,
  type ComposerSession,
} from "../../features/messages/composer-session";
import { allowsOutsideMentions } from "../../features/messages/mention-admission";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import type { MentionRoster } from "../../features/messages/draft-mention-roster";
import { mentionCandidates } from "./mention-candidates";
import { namedCandidates, spaceMention } from "./use-mention-choices";
import { teamBlocksSpace } from "./use-team-mentions";
import {
  fetchMentionDirectoryPage,
  type MentionDirectoryPage,
} from "./useMentionDirectory";

/**
 * How long a pending mention waits for the evidence Space needed: one
 * membership read, one profile batch, one inventory read and one directory
 * page, each a single relay round trip with no typing debounce. Bounds both
 * the chip and a send that waits on it.
 */
export const MENTION_RESOLVE_TIMEOUT_MS = 8000;

/** What the chooser knew about its destination when Space was typed. */
export type SpaceMentionScope = {
  channelId: string;
  inviteAgents?: boolean | undefined;
  roster?: MentionRoster | undefined;
  /** Recipients already in the draft take part in naming. */
  selected: readonly MentionRecipient[];
};

/**
 * The recipient Space would have selected for `name` had the chooser's
 * evidence been complete (README section 5), or null to return it to prose.
 * Headless: the chooser that published it unmounted when the chip replaced
 * the typed text. Any failure, the caller's abort or the timeout is null.
 */
export async function resolveSpaceMention(
  session: ComposerSession,
  scope: SpaceMentionScope,
  name: string,
  signal: AbortSignal,
): Promise<MentionRecipient | null> {
  if (signal.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, MENTION_RESOLVE_TIMEOUT_MS);
  signal.addEventListener("abort", abort, { once: true });
  try {
    // The bound holds even over a read that ignores its signal.
    return await Promise.race([
      resolve(session, scope, name, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(), {
          once: true,
        });
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function resolve(
  session: ComposerSession,
  { channelId, inviteAgents, roster: draft, selected }: SpaceMentionScope,
  name: string,
  signal: AbortSignal,
): Promise<MentionRecipient | null> {
  // A roster's owner says when its agents have loaded, as the inventory
  // wait below does for a channel.
  const roster = draft?.pending ? await draft.pending : draft?.recipients;
  const invite = !roster && !!inviteAgents;
  if (!roster) {
    session.channels.ensureList();
    await settled(
      session.channels.subscribeList,
      session.channels.list,
      (list) => list.status === "ready" || list.status === "error",
      signal,
    );
  }
  const channel = session.channels
    .list()
    .channels.find((c) => c.id === channelId);
  const members = roster?.map((p) => p.pubkey) ?? channel?.members ?? [];
  // A member a completed read finds no profile for is known unnamed; a failed
  // read leaves its name missing, which only keeps the local step off.
  if (!roster && members.length)
    await session.profiles
      .ensure(members.slice(0, 1024), "background")
      .catch(() => {});
  if (invite) {
    const release = session.agentChoices.retain();
    try {
      session.agentChoices.ensure(true);
      await settled(
        session.agentChoices.subscribe,
        session.agentChoices.snapshot,
        (agents) => !agents.pending || agents.status === "ready",
        signal,
      );
    } finally {
      release();
    }
  }
  const kit = fullSession(session)?.channelKit;
  if (kit && teamBlocksSpace(kit.snapshot(), name)) return null;
  const local = new Set(
    mentionCandidates(session, channelId, inviteAgents, roster).map(
      (c) => c.recipient.pubkey,
    ),
  );
  const profiles = session.profiles.snapshot();
  const unnamed = session.profiles.unnamed?.();
  const missingNames = channel?.members?.some(
    (key) => !profiles.has(key) && !unnamed?.has(key),
  );
  const pick = (
    people: MentionDirectoryPage["people"],
    complete: boolean,
  ): MentionRecipient | null => {
    const choices = namedCandidates(
      session,
      channelId,
      inviteAgents,
      roster,
      selected,
      people,
    );
    const pubkey = spaceMention(choices, local, name, {
      pending: false,
      missingNames,
      complete,
    });
    const choice = choices.find((c) => c.recipient.pubkey === pubkey);
    if (!choice) return null;
    // Nobody can be added to a DM, and the chooser row that says "Will not
    // be notified" was never shown: a chip must not promise a notification.
    if (channel?.channelType === "dm" && !members.includes(pubkey ?? ""))
      return null;
    return choice.recipient;
  };
  // Once every member is named, an exact local name selects without the
  // directory, as it does in the chooser.
  const direct = pick([], false);
  if (direct) return direct;
  const outside =
    !roster &&
    !invite &&
    allowsOutsideMentions(channel) &&
    !channel?.archived &&
    !channel?.readOnly;
  if (!outside) return pick([], true);
  const page = await fetchMentionDirectoryPage(session, name, signal);
  // A truncated page may hide a namesake, as it does for Space in the chooser.
  if (signal.aborted || page.more) return null;
  return pick(page.people, true);
}

/** Resolves once `done` holds for the store's snapshot; rejects on abort. */
function settled<T>(
  subscribe: (listener: () => void) => () => void,
  snapshot: () => T,
  done: (value: T) => boolean,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const check = () => {
      if (!done(snapshot())) return;
      stop();
      resolve();
    };
    const abort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const unsubscribe = subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    stop = () => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    if (signal.aborted) abort();
    else check();
  });
}
