import { communityDestination, isCommunityAlias } from "./destination";
import type { PersonalProfile } from "./service";

export type PendingJoin = {
  id: string;
  community: string;
  profile?: PersonalProfile;
};

/** The journal's own storage failures: this client's copy, safe to show as is. */
export class JournalError extends Error {}

/** Public progress only: invite codes, policy receipts and keys are never journaled. */
export function createJoinJournal(viewer: string) {
  const key = `buzz-community-joins.v1:${viewer}`;
  function read(): PendingJoin[] {
    try {
      const entries: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (!Array.isArray(entries)) throw new Error();
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry.id !== "string" ||
          typeof entry.community !== "string" ||
          (entry.profile !== undefined &&
            (!entry.profile ||
              typeof entry.profile.name !== "string" ||
              typeof entry.profile.picture !== "string" ||
              (entry.profile.about !== undefined &&
                typeof entry.profile.about !== "string")))
        )
          throw new Error();
        try {
          entry.community = communityDestination(entry.community).url;
        } catch (reason) {
          // Retain legacy aliases until their deployment mapping is restored.
          if (!isCommunityAlias(entry.community)) throw reason;
        }
      }
      return entries;
    } catch {
      throw new JournalError(
        "Could not read unfinished community setup. Restore device storage and try again.",
      );
    }
  }
  function save(entries: PendingJoin[]) {
    try {
      localStorage.setItem(key, JSON.stringify(entries));
    } catch {
      throw new JournalError(
        "Could not save community setup on this device. Free storage and try again.",
      );
    }
  }
  return {
    latest: () =>
      read()
        .filter((entry) => !isCommunityAlias(entry.community))
        .at(-1),
    get(community: string) {
      const origin = communityDestination(community).url;
      return read()
        .filter((entry) => entry.community === origin)
        .at(-1);
    },
    begin(community: string, profile?: PersonalProfile): PendingJoin {
      const entries = read();
      community = communityDestination(community).url;
      const draft =
        profile ??
        entries.filter((item) => item.community === community).at(-1)?.profile;
      const entry = {
        id: crypto.randomUUID(),
        community,
        ...(draft ? { profile: draft } : {}),
      };
      save([
        ...entries.filter((item) => item.community !== entry.community),
        entry,
      ]);
      return entry;
    },
    current: (entry: PendingJoin) =>
      read().some(
        (item) => item.id === entry.id && item.community === entry.community,
      ),
    finish(entry: PendingJoin) {
      save(read().filter((item) => item.id !== entry.id));
    },
  };
}
