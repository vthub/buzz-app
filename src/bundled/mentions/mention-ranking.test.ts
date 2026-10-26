import { expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import {
  continuedMention,
  exactMention,
  rankMentions,
  type MentionChoice,
} from "./mention-ranking";
import { fixtureChoice, mentionConformance } from "./mention-rules.conformance";
import { matchPerson } from "../../features/search/person-match";
const choice = (
  key: string,
  name: string,
  extra: Partial<MentionChoice> = {},
): MentionChoice => ({
  recipient: { pubkey: key.repeat(64), name },
  label: name,
  aliases: [name],
  member: true,
  agent: false,
  managed: false,
  owned: false,
  ...extra,
});
it("breaks visible match ties by base-name quality, then the full displayed label", () => {
  const rows = [
    choice("3", "Fast Fizz", { agent: true }),
    choice("0", "Fizz", { agent: true, label: "baxen’s Fizz · oncp" }),
    choice("4", "Fizz", { agent: true, label: "baxen’s Fizz · s03j" }),
    choice("5", "Fizz", { agent: true, label: "Kenny Lopez’s Fizz" }),
    choice("b", "Fizz", { agent: true, label: "baxen’s Fizz · 4prr" }),
    choice("c", "Fizz", { agent: true, label: "baxen’s Fizz · 06pl" }),
  ];
  const expected = [rows[5], rows[4], rows[1], rows[2], rows[3], rows[0]];
  expect(rankMentions(rows, "fizz")).toEqual(expected);
  expect(rankMentions([...rows].reverse(), "FIZZ")).toEqual(expected);
  const alias = choice("d", "Another name", {
    label: "Other Fizz",
    aliases: ["Another name", "Fizz"],
  });
  expect(rankMentions([choice("3", "Fast Fizz"), alias], "fizz")[0]).toBe(
    alias,
  );
});
it("sorts equal matches by case-insensitive displayed labels and only then keys", () => {
  const a = choice("a", "Hidden A", { label: "Zoe", aliases: ["common"] });
  const b = choice("b", "Hidden B", { label: "amy", aliases: ["common"] });
  const c = choice("c", "Hidden C", { label: "Amy", aliases: ["common"] });
  expect(rankMentions([c, a, b], "common")).toEqual([b, c, a]);
  expect(rankMentions([c, a, b], "")).toEqual([b, c, a]);
});

it("never matches hex or npub keys, including short substrings", () => {
  const key =
    "150b20bdf6130418df9239dd1bd082c71612c8d653b47c277200365b9be215dc";
  const row = choice("a", "Bad Janet", {
    recipient: { pubkey: key, name: "Bad Janet" },
  });
  const npub = npubEncode(key);
  for (const query of [
    "h",
    key,
    key.slice(0, 12),
    key.slice(-8),
    npub,
    npub.slice(0, 15),
    npub.slice(-6),
  ]) {
    expect(rankMentions([row], query), query).toEqual([]);
    expect(exactMention([row], query), query).toBeUndefined();
  }
  expect(rankMentions([row], "jan")).toEqual([row]);
});

it("ranks outside humans and agents in one relevance group", () => {
  const human = choice("a", "Honey", { member: false });
  const agent = choice("b", "Honey Bee", {
    member: false,
    agent: true,
    owned: true,
  });
  const member = choice("c", "A Honey");
  expect(rankMentions([agent, human, member], "honey")).toEqual([
    member,
    human,
    agent,
  ]);
});
const permutations = <T>(items: readonly T[]): T[][] =>
  items.length < 2
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );
it("orders mixed people and agents the same way from every input order", () => {
  // Review case: owned Zed, unowned Alpha, human Mary. A pairwise agent-only
  // ownership rule made Zed < Alpha < Mary < Zed, a cycle.
  const zed = choice("a", "Zed", { agent: true, owned: true });
  const alpha = choice("b", "Alpha", { agent: true });
  const mary = choice("c", "Mary");
  for (const rows of permutations([zed, alpha, mary]))
    expect(rankMentions(rows, "")).toEqual([zed, alpha, mary]);
  // Same-name agents stay one block at its first label. Recency, managed and
  // presence order only that block, never a person or another name between.
  const recent = choice("d", "Honey", { agent: true, label: "Honey · zz" });
  const managed = choice("e", "Honey", {
    agent: true,
    managed: true,
    label: "Wes’s Honey",
  });
  const online = choice("f", "Honey", { agent: true, label: "Honey · aa" });
  const human = choice("1", "Honey · b");
  const other = choice("2", "Honey Bee", { agent: true, label: "Honey · c" });
  const history = new Map([[recent.recipient.pubkey, 2]]);
  const presence = (key: string) =>
    key === online.recipient.pubkey ? "online" : "unknown";
  for (const rows of permutations([recent, managed, online, human, other]))
    expect(rankMentions(rows, "", history, presence)).toEqual([
      recent,
      managed,
      online,
      human,
      other,
    ]);
});

it("a known longer name continues the query, except an identity's own beside its exact name", () => {
  const longer = choice("1", "Mira Example");
  expect(continuedMention([longer], "mira")).toBe(true);
  expect(continuedMention([longer], "Mira Example")).toBe(false);
  // Section 5's exception: `Example Agent` is another name of the `Example`
  // agent, not a namesake, so it neither continues nor blocks `example`.
  const self = choice("2", "Example", {
    agent: true,
    aliases: ["Example Agent", "Example"],
    label: "Example Agent",
  });
  expect(continuedMention([self], "example")).toBe(false);
  expect(exactMention([self], "example")).toBe(self.recipient.pubkey);
  // A key qualifier or generated `(agent)` suffix is not a longer name.
  expect(
    continuedMention(
      [
        choice("3", "Mira", { label: "Mira · 4prr", qualifier: "4prr" }),
        choice("4", "Mira", { agent: true, label: "Mira (agent)" }),
      ],
      "mira",
    ),
  ).toBe(false);
});
it("validates the portable mention fixture version and case lists", () => {
  expect(mentionConformance.version).toBe(2);
  expect(mentionConformance.matching.length).toBeGreaterThan(0);
  expect(mentionConformance.ranking.length).toBeGreaterThan(0);
  expect(mentionConformance.space.length).toBeGreaterThan(0);
});
it.each(mentionConformance.matching)(
  "conforms to the portable matching contract: $name",
  (fixture) => {
    expect(matchPerson(fixture.label, fixture.query)?.tier ?? null).toBe(
      fixture.expected,
    );
  },
);
it.each(mentionConformance.ranking)(
  "conforms to the portable ranking contract: $name",
  (fixture) => {
    const ranked = rankMentions(
      fixture.choices.map(fixtureChoice),
      fixture.query,
      new Map(Object.entries(fixture.history ?? {})),
      (key) => fixture.presence?.[key] ?? "unknown",
    );
    expect(ranked.map((c) => c.recipient.pubkey)).toEqual(fixture.expected);
  },
);
it.each(mentionConformance.space)(
  "conforms to the portable Space contract: $name",
  (fixture) => {
    expect(
      exactMention(fixture.choices.map(fixtureChoice), fixture.query) ?? null,
    ).toBe(fixture.expected);
  },
);
