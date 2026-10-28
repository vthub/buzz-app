import { inspectProfile } from "../communities/api";
import { communityDestination } from "../communities/destination";
import type { Communities } from "../communities/service";
import { readErrorKind } from "../relay/errors";

/**
 * What restoring one saved destination found: the relay admitted the key and
 * the membership is saved (with the read that proved it), refused the key, or
 * could not be read or saved.
 */
export type Restored = Readonly<{
  url: string;
  id: string;
  host: string;
  kind: "admitted" | "denied" | "unavailable";
  read?: Awaited<ReturnType<typeof inspectProfile>>;
}>;

/**
 * Joins each destination saved to the account that admits this key, by the
 * same signed profile read and `communities.joined` the first-run join uses.
 * At most `concurrency` reads run at once, and none starts `startBy` ms after
 * the restore began (each read is itself bounded); one not started is
 * unavailable. Outcomes follow the list order, one per destination. Never
 * throws: every failure is an outcome.
 */
export async function restoreKnown(
  known: readonly string[],
  communities: Pick<Communities, "snapshot" | "joined">,
  { concurrency, startBy }: { concurrency: number; startBy: number },
): Promise<Restored[]> {
  const destinations = new Map<string, Omit<Restored, "kind" | "read">>();
  for (const address of known) {
    try {
      const { id, url, name } = communityDestination(address);
      if (!destinations.has(id)) destinations.set(id, { url, id, host: name });
    } catch {
      // Not a destination this build can open: nothing to restore.
    }
  }
  const pending = [...destinations.values()];
  const deadline = Date.now() + startBy;
  const outcomes: Restored[] = [];
  // One iterator shared by every worker: each destination is taken once.
  const queue = pending.entries();
  const restore = async (destination: (typeof pending)[number]) => {
    let read: Awaited<ReturnType<typeof inspectProfile>>;
    try {
      read = await inspectProfile(destination.id);
    } catch (error) {
      return {
        ...destination,
        kind: readErrorKind(error) === "denied" ? "denied" : "unavailable",
      } as const;
    }
    // A membership saved before the device record hydrates would be lost to it.
    const client = communities.snapshot();
    if (client.status !== "ready")
      return { ...destination, kind: "unavailable" } as const;
    try {
      communities.joined(
        { id: destination.id, name: destination.host },
        read.exists ? read.profile : client.profile,
      );
    } catch {
      return { ...destination, kind: "unavailable" } as const;
    }
    return { ...destination, kind: "admitted", read } as const;
  };
  const worker = async () => {
    for (const [index, destination] of queue)
      outcomes[index] =
        Date.now() >= deadline
          ? { ...destination, kind: "unavailable" }
          : await restore(destination);
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, worker),
  );
  return outcomes;
}
