import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import {
  enteredRelayOrigin,
  relayAddress,
} from "../communities/destination.ts";
import {
  type BackupFailureKind,
  isBackupFailureKind,
} from "./backup-failure.ts";
import type { OwnedCommunity } from "./builderlab-account.ts";

/**
 * Development stand-in for the first-run Builderlab account, from
 * `BUZZ_DEV_FIRST_RUN_ACCOUNT`: `unlinked`, or
 * `{"npub"?: "npub1…", "communities"?: ["host", …], "known"?: ["host", …],
 * "backups"?: ["npub1…", …], "recovery"?: "nsec1…",
 * "backup"?: "<kind>" | "fail-once", "unlink"?: <HTTP status>}`,
 * where no npub is an unlinked account, `known` the destinations saved to the
 * account, `backups` the keys backup status
 * lists, `recovery` the key every restore recovers (none: recovery is
 * unavailable, as on every tenant today), `backup` names the failure every
 * backup reports (`fail-once`: only the first, which Try again then clears),
 * and `unlink` the 4xx or 5xx every unlink answers. Builds
 * leave the Vite define empty, so the seed can only ever answer a dev server.
 * A leaf module with explicit `.ts` imports: vite.config.ts validates the
 * value through Node's native loader.
 */
export type FirstRunAccountSeed = Readonly<{
  linked: string | null;
  communities: readonly OwnedCommunity[];
  /** Saved destinations as kgoose lists them: `wss://host[:port]`. */
  known?: readonly string[];
  /** Hex keys. */
  backups?: readonly string[];
  /** The nsec as typed, which native import takes, and its hex key. */
  recovery?: Readonly<{ nsec: string; pubkey: string }>;
  backup?: BackupFailureKind | "fail-once";
  unlink?: number;
}>;

/** An `npub1…` as hex; throws for anything else. */
function hex(npub: unknown) {
  const decoded = typeof npub === "string" ? decode(npub) : undefined;
  if (decoded?.type !== "npub") throw new Error();
  return decoded.data;
}

/** An `nsec1…` as typed, with its hex key; throws for anything else. */
function secretKey(nsec: string) {
  const decoded = decode(nsec);
  if (decoded.type !== "nsec") throw new Error();
  return { nsec, pubkey: getPublicKey(decoded.data) };
}

export function parseFirstRunAccountSeed(
  raw = "",
): FirstRunAccountSeed | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value === "unlinked") return { linked: null, communities: [] };
  try {
    const seed: unknown = JSON.parse(value);
    if (!seed || typeof seed !== "object" || Array.isArray(seed))
      throw new Error();
    const {
      npub,
      communities = [],
      known,
      backups,
      recovery,
      backup,
      unlink,
      ...rest
    } = seed as Record<string, unknown>;
    if (
      Object.keys(rest).length > 0 ||
      !Array.isArray(communities) ||
      (known !== undefined && !Array.isArray(known)) ||
      (backups !== undefined && !Array.isArray(backups)) ||
      (recovery !== undefined && typeof recovery !== "string") ||
      (backup !== undefined &&
        backup !== "fail-once" &&
        !isBackupFailureKind(backup)) ||
      (unlink !== undefined &&
        !(
          typeof unlink === "number" &&
          Number.isInteger(unlink) &&
          unlink >= 400 &&
          unlink <= 599
        ))
    )
      throw new Error();
    return {
      linked: npub === undefined ? null : hex(npub),
      communities: communities.map((host: unknown) => {
        if (typeof host !== "string") throw new Error();
        const url = enteredRelayOrigin(host);
        return { host: new URL(url).host, url };
      }),
      // The same spellings as the Community URL field, stored as kgoose lists them.
      ...(known === undefined
        ? {}
        : {
            known: known.map((value: unknown) => {
              if (typeof value !== "string") throw new Error();
              return relayAddress(enteredRelayOrigin(value));
            }),
          }),
      ...(backups === undefined ? {} : { backups: backups.map(hex) }),
      ...(recovery === undefined ? {} : { recovery: secretKey(recovery) }),
      ...(backup === undefined ? {} : { backup }),
      ...(unlink === undefined ? {} : { unlink: unlink as number }),
    };
  } catch {
    // Do not echo malformed input: an environment value might contain credentials.
    throw new Error(
      "BUZZ_DEV_FIRST_RUN_ACCOUNT must be `unlinked` or a JSON object {npub?, communities?: [hostname, …], known?: [hostname, …], backups?: [npub, …], recovery?: nsec, backup?: failure kind or fail-once, unlink?: HTTP status}.",
    );
  }
}
