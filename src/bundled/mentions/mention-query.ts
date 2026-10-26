import { profileKey } from "../../features/profiles/target";
import { foldName, normalizeName } from "../../features/search/person-match";

/** Syntax only. Multi-word queries are admitted separately against current names. */
export function mentionQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(Math.max(0, caret - 160), caret);
  const match = before.match(/(?:^|[\s([{])@([^@\n\r\t]*)$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  // A completed identity link is source markup, not an active name search.
  const completed =
    /\]\((nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]+)\)$/u.exec(query);
  if (text[start - 1] === "[" && completed && profileKey(completed[1] ?? ""))
    return null;
  // A bounded slice beginning in the middle of a word is not a boundary.
  if (start && !/[\s([{]/u.test(text[start - 1] ?? "")) return null;
  return { start, end: caret, query };
}

/** A query Space may hold as a pending mention: a name still being typed.
 * Trailing space or punctuation says the user has moved on to prose. */
export function pendingMentionQuery(query: string) {
  return !!normalizeName(query) && !/[\s.,!?;:)\]}]$/u.test(query);
}

export function matchesMentionQuery(query: string, names: readonly string[]) {
  if (!query.includes(" ")) return true;
  const lower = foldName(query);
  if (
    lower.endsWith(" ") &&
    names.some((name) => normalizeName(name) === lower.trimEnd())
  )
    return false;
  return names.some((name) => normalizeName(name).startsWith(lower));
}
