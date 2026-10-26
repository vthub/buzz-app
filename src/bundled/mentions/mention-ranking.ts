import {
  exactName,
  extendsName,
  matchPerson,
  normalizeName,
} from "../../features/search/person-match";
import type { mentionCandidates } from "./mention-candidates";
export type MentionChoice = ReturnType<typeof mentionCandidates>[number] & {
  label: string;
  /** The generated key suffix that ends `label` (`Honey · 4prr`), if any. */
  qualifier?: string | undefined;
};
const normalized = normalizeName;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const nameMatch = (text: string, query: string) =>
  query ? (matchPerson(text, query)?.tier ?? Infinity) : 0;
function baseMatch(choice: MentionChoice, query: string) {
  return Math.min(
    ...choice.aliases.map((name) => nameMatch(name, normalized(query))),
  );
}
export function mentionMatch(choice: MentionChoice, query: string) {
  const needle = normalized(query);
  if (!needle) return 0;
  // No known name means the displayed label is only an identity fallback.
  if (!choice.aliases.length) return Infinity;
  // Rank what the user sees before other real names for the same identity.
  const visible = nameMatch(choice.label, needle);
  if (Number.isFinite(visible)) return visible;
  return 4 + baseMatch(choice, query);
}
/**
 * Sorts by per-choice keys, so the order is transitive for any mix of people
 * and agents. Another community's agents follow everyone here. After match quality, your own agents come first. Agents that
 * share a name form one block at its first visible label; recency, managed,
 * and presence order only that block.
 */
export function rankMentions(
  choices: readonly MentionChoice[],
  query: string,
  history?: ReadonlyMap<string, number>,
  presence: (key: string) => string = () => "unknown",
) {
  const keyed = choices
    .filter((c) => Number.isFinite(mentionMatch(c, query)))
    .map((c) => {
      const tier = [
        c.member ? 0 : 1,
        c.elsewhere ? 1 : 0,
        mentionMatch(c, query),
        baseMatch(c, query),
        c.agent && c.owned ? 0 : 1,
      ];
      return {
        c,
        tier,
        label: normalized(c.label),
        // People never join a block. On an equal label they sort first.
        block: c.agent
          ? `1${JSON.stringify([tier, normalized(c.recipient.name)])}`
          : `0${c.recipient.pubkey}`,
        recent: history?.get(c.recipient.pubkey) ?? 0,
        online: { online: 0, away: 1 }[presence(c.recipient.pubkey)] ?? 2,
      };
    });
  const first = new Map<string, string>();
  for (const k of keyed) {
    const label = first.get(k.block);
    if (label === undefined || k.label < label) first.set(k.block, k.label);
  }
  const blockLabel = (k: (typeof keyed)[number]) => first.get(k.block) ?? "";
  return keyed
    .sort(
      (a, b) =>
        a.tier.reduce((d, value, i) => d || value - (b.tier[i] ?? 0), 0) ||
        compare(blockLabel(a), blockLabel(b)) ||
        compare(a.block, b.block) ||
        b.recent - a.recent ||
        Number(b.c.managed) - Number(a.c.managed) ||
        a.online - b.online ||
        compare(a.label, b.label) ||
        compare(a.c.recipient.pubkey, b.c.recipient.pubkey),
    )
    .map((k) => k.c);
}
const choiceNames = (c: MentionChoice) => [...c.aliases, c.label];
/**
 * A known choice's name continues the query (README section 5), so no exact
 * name can be selected. A key qualifier or generated `(agent)` suffix only
 * tells namesakes apart, so it never continues the name. Nor does a choice's
 * own longer name when that same choice also has the exact name: one identity
 * is not its own namesake. Choices only arrive, never leave, so once this
 * holds over the known set nothing that loads later can lift it: Space is
 * declined, not pending.
 */
export function continuedMention(
  choices: readonly MentionChoice[],
  query: string,
) {
  const needle = normalized(query);
  return choices.some((c) => {
    // `Example Agent` never keeps `example` from selecting the agent that is
    // also named `Example`.
    if (choiceNames(c).some((name) => normalized(name) === needle))
      return false;
    const label =
      c.qualifier && c.label.endsWith(` · ${c.qualifier}`)
        ? c.label.slice(0, -(c.qualifier.length + 3))
        : c.label;
    // Literal names still block through aliases; generated suffixes do not.
    const longer =
      c.agent && c.aliases.some((name) => `${name.trim()} (agent)` === label)
        ? c.aliases
        : [...c.aliases, label];
    return longer.some((name) => extendsName(name, needle));
  });
}
/**
 * Space is intent only for one exact key across the full, uncapped choice set.
 * Every choice can continue the name (`continuedMention`); only choices
 * `among` can equal it.
 */
export const exactMention = (
  choices: readonly MentionChoice[],
  query: string,
  among: (choice: MentionChoice) => boolean = () => true,
) =>
  continuedMention(choices, query)
    ? undefined
    : exactName(
        choices,
        choiceNames,
        query,
        (c) => c.aliases.length > 0 && among(c),
        () => [],
      )?.recipient.pubkey;
