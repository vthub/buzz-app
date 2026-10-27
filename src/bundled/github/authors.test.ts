// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  admit,
  loadPolicy,
  membershipRequest,
  parseMembership,
  POLICY_KEY,
  savePolicy,
  type AuthorPolicy,
} from "./authors";
import type { Feedback } from "./watch";

const policy = (lists: Partial<AuthorPolicy> = {}): AuthorPolicy => ({
  version: 1,
  trustedOrganizations: [],
  trustedAuthors: [],
  ignoredAuthors: [],
  ...lists,
});
const by = (author: string, bot = false): Feedback => ({
  id: "comment/1",
  author,
  url: "",
  body: "",
  ...(bot ? { bot: true as const } : {}),
});
const nobody = () => false;

afterEach(() => localStorage.clear());

describe("GitHub author policy", () => {
  it("admits anyone but the ignored until an allowlist is set", () => {
    const open = policy({ ignoredAuthors: ["Spammer"] });
    expect(admit(by("stranger"), open, "john", nobody)).toBe(true);
    expect(admit(by("spammer"), open, "john", nobody)).toBe(false);
  });

  it("then admits trusted logins, members and the signed-in account", () => {
    const set = policy({
      trustedOrganizations: ["block"],
      trustedAuthors: ["Wes", "copilot-pull-request-reviewer[bot]"],
      ignoredAuthors: ["noisy"],
    });
    const member = (login: string) => login === "alice" || login === "noisy";
    expect(admit(by("wes"), set, "john", member)).toBe(true);
    expect(admit(by("alice"), set, "john", member)).toBe(true);
    expect(admit(by("John"), set, "john", member)).toBe(true);
    expect(admit(by("stranger"), set, "john", member)).toBe(false);
    // Ignored wins over membership.
    expect(admit(by("noisy"), set, "john", member)).toBe(false);
    // A bot is listed with [bot], and never by membership.
    expect(
      admit(by("copilot-pull-request-reviewer", true), set, "john", member),
    ).toBe(true);
    expect(admit(by("alice", true), set, "john", member)).toBe(false);
    expect(admit(by("wes[bot]"), set, "john", member)).toBe(false);
  });

  it("saves only valid logins and reads anything else as no policy", () => {
    expect(() => savePolicy(policy({ trustedAuthors: ["two words"] }))).toThrow(
      "two words is not a GitHub login",
    );
    expect(() =>
      savePolicy(policy({ trustedOrganizations: ["bot[bot]"] })),
    ).toThrow("not a GitHub organization login");
    const saved = policy({
      trustedAuthors: ["wes", "ada_block", "Dependabot[BOT]"],
    });
    savePolicy(saved);
    expect(loadPolicy()).toEqual(saved);
    expect(admit(by("dependabot", true), saved, "john", nobody)).toBe(true);
    localStorage.setItem(POLICY_KEY, '{"version":1,"trustedAuthors":"wes"}');
    expect(loadPolicy()).toEqual(policy());
  });

  it("asks which organizations each author is in, and reads the answer", () => {
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
    expect(parseMembership(answer, ["Alice", "bob"])).toEqual(
      new Map([
        ["alice", true],
        ["bob", false],
      ]),
    );
    expect(parseMembership("not json", ["alice"])).toBeUndefined();
  });
});
