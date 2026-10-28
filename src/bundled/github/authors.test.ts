// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  admit,
  DEFAULT_RULES,
  loadPolicy,
  membershipRequest,
  open,
  organizations,
  parse,
  parseMembership,
  POLICY_KEY,
  savePolicy,
  type AuthorPolicy,
} from "./authors";
import type { Feedback } from "./watch";

const rules = (text: string) => parse(text) as AuthorPolicy;
const by = (author: string, body = "", bot = false): Feedback => ({
  id: "comment/1",
  author,
  url: "",
  body,
  ...(bot ? { bot: true as const } : {}),
});
const nobody = () => false;

afterEach(() => localStorage.clear());

describe("GitHub author rules", () => {
  it("by default admit everyone but the viewer's 🤖 comments", () => {
    const policy = loadPolicy();
    expect(policy.text).toBe(DEFAULT_RULES);
    expect(open(policy)).toBe(true);
    expect(organizations(policy)).toEqual([]);
    expect(admit(by("stranger", "hi"), policy, "john", nobody)).toBe(true);
    expect(admit(by("John", "please fix"), policy, "john", nobody)).toBe(true);
    expect(admit(by("John", "  🤖 Fixed"), policy, "john", nobody)).toBe(false);
    // Only the viewer's own 🤖 comments are agents'.
    expect(admit(by("stranger", "🤖 hi"), policy, "john", nobody)).toBe(true);
    // A bot named like the viewer is not the viewer.
    expect(admit(by("john", "🤖", true), policy, "john", nobody)).toBe(true);
  });

  it("let the first matching rule decide, and deny what none match", () => {
    const policy = rules(`deny author:Noisy
allow org:block
allow author:Wes
allow author:copilot-pull-request-reviewer[bot]`);
    expect(open(policy)).toBe(false);
    expect(organizations(policy)).toEqual(["block"]);
    const member = (login: string, org: string) =>
      org === "block" && (login === "alice" || login === "noisy");
    expect(admit(by("wes"), policy, "john", member)).toBe(true);
    expect(admit(by("alice"), policy, "john", member)).toBe(true);
    expect(admit(by("noisy"), policy, "john", member)).toBe(false);
    expect(admit(by("stranger"), policy, "john", member)).toBe(false);
    expect(admit(by("john"), policy, "john", member)).toBe(false);
    // A bot's login ends in [bot], and it is in no organization.
    expect(
      admit(
        by("copilot-pull-request-reviewer", "", true),
        policy,
        "john",
        member,
      ),
    ).toBe(true);
    expect(admit(by("alice", "", true), policy, "john", member)).toBe(false);
    expect(admit(by("ghost"), policy, "john", () => true)).toBe(false);
    // Membership not yet known holds the verdict, unless an earlier rule decides.
    expect(admit(by("bob"), policy, "john", () => undefined)).toBeUndefined();
    expect(
      admit(
        by("wes"),
        rules("allow author:wes\nallow org:block"),
        "john",
        () => undefined,
      ),
    ).toBe(true);
  });

  it("match authors and bodies by pattern, logins case aside", () => {
    const policy = rules(`deny body:/^\\s*LGTM\\b/i
allow author:/^(copilot|dependabot)\\b/
allow author:/^ADA_/ prefix:Review: please
deny body:/a b\\/c/
allow org:Block body:/bug/s`);
    expect(admit(by("Copilot-x", "", true), policy, "j", nobody)).toBe(true);
    expect(admit(by("dependabot", "", true), policy, "j", nobody)).toBe(true);
    expect(
      admit(by("ada_block", "Review: please look"), policy, "j", nobody),
    ).toBe(true);
    expect(admit(by("ada_block", "Review: later"), policy, "j", nobody)).toBe(
      false,
    );
    expect(admit(by("copilot", " lgtm"), policy, "j", nobody)).toBe(false);
    expect(admit(by("eve", "a b/c bug"), policy, "j", () => true)).toBe(false);
    const member = (_: string, org: string) => org === "block";
    expect(admit(by("eve", "a\nbug"), policy, "j", member)).toBe(true);
    expect(admit(by("eve", "fine"), policy, "j", member)).toBe(false);
    expect(organizations(policy)).toEqual(["block"]);
  });

  it("name the line that is not a rule", () => {
    const errors = {
      "allow\nwho knows": "Line 2: it must start with allow or deny",
      "allow\n\n  allow login:wes":
        "Line 3: login:wes is not author:, org:, prefix: or body:",
      "allow author:two words":
        "Line 1: words is not author:, org:, prefix: or body:",
      "deny author:a author:b": "Line 1: it has two author: conditions",
      "allow org:bot[bot]":
        "Line 1: bot[bot] is not a GitHub organization login",
      "allow org:/block/": "Line 1: org: takes an organization's exact name",
      "allow author:wes!":
        "Line 1: wes! is not a GitHub login, @me or /pattern/",
      "allow author:/(/": "Line 1: Invalid regular expression",
      "allow author:/a/g": "Line 1: /a/g may only use the flags i, m, s and u",
      "allow body:/a/ii": "Line 1: /a/ii may only use the flags i, m, s and u",
      "allow body:/unclosed": "Line 1: body: needs a /pattern/",
      "allow body:text": "Line 1: body: needs a /pattern/",
      "allow prefix:": "Line 1: prefix: needs text",
    };
    for (const [text, error] of Object.entries(errors)) {
      expect(parse(text)).toContain(error);
      expect(() => savePolicy(text)).toThrow(error);
    }
    expect(localStorage.getItem(POLICY_KEY)).toBeNull();
  });

  it("save and load rules, reading anything unreadable as the defaults", () => {
    const saved = savePolicy(
      "  allow author:Dependabot[BOT]\n\n allow org:block  ",
    );
    expect(saved.text).toBe("allow author:Dependabot[BOT]\nallow org:block");
    expect(loadPolicy()).toEqual(saved);
    expect(admit(by("dependabot", "", true), loadPolicy(), "j", nobody)).toBe(
      true,
    );
    localStorage.setItem(POLICY_KEY, '{"version":2,"text":"maybe"}');
    expect(loadPolicy().text).toBe(DEFAULT_RULES);
    localStorage.setItem(POLICY_KEY, "{");
    expect(loadPolicy().text).toBe(DEFAULT_RULES);
  });

  it("ask which organizations each author is in, and read the answer", () => {
    const body = JSON.parse(
      membershipRequest(["alice", "bob"], ["block", "squareup"]),
    ) as { query: string };
    expect(body.query).toContain(
      'u1:user(login:"bob"){o0:organization(login:"block"){id} o1:organization(login:"squareup"){id}}',
    );
    const answer = JSON.stringify({
      data: {
        u0: { o0: null, o1: { id: "O" } },
        u1: { o0: null, o1: null },
      },
    });
    expect(
      parseMembership(answer, ["Alice", "bob"], ["block", "SquareUp"]),
    ).toEqual(
      new Map([
        ["alice", new Set(["squareup"])],
        ["bob", new Set()],
      ]),
    );
    expect(parseMembership("not json", ["alice"], ["block"])).toBeUndefined();
  });
});
