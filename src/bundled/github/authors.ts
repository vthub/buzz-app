// Whose GitHub feedback wakes agents. Agents act on what a wake quotes, so a
// stranger's comment on a public pull request should not reach them. Rules,
// one per line, allow or deny feedback; the first that matches decides, and
// feedback none matches wakes nobody. The defaults admit everyone but agents'
// own comments, as before rules existed. Saved on this device and edited in
// Settings; each poll reads them again, so a change applies to running
// watches.
import type { Feedback } from "./watch";

export type Rule = Readonly<{
  effect: "allow" | "deny";
  /** An exact login, ME, or a pattern, all matched case aside. A bot's login
   * ends in `[bot]`. */
  author?: string | RegExp;
  /** An organization the author is a member of. */
  org?: string;
  /** What the body starts with, leading space aside. */
  prefix?: string;
  body?: RegExp;
}>;

export type AuthorPolicy = Readonly<{
  /** The rules as saved, one per line. */
  text: string;
  rules: readonly Rule[];
}>;

/** The signed-in GitHub account, which agents use too. */
export const ME = "@me";
export const POLICY_KEY = "buzz.github.author-policy.v2";
/** Agents comment as the signed-in account and start with 🤖, so their own
 * comments wake nobody; the owner's other comments wake the agent. */
export const DEFAULT_RULES = `deny author:${ME} prefix:🤖
allow author:${ME}
allow`;
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
// Enterprise Managed Users' logins end in `_shortcode`.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\[bot\])?$/i;
/** A `/pattern/flags` condition value, up to the space after it. */
const PATTERN = /^\/((?:\\.|[^\\/])+)\/([a-z]*)(?=\s|$)/;

/** One line's rule, or why it is not one. */
function rule(line: string): Rule | string {
  const effect = /^(allow|deny)(?=\s|$)/.exec(line)?.[1];
  if (effect !== "allow" && effect !== "deny")
    return "it must start with allow or deny";
  const conditions: {
    author?: string | RegExp;
    org?: string;
    prefix?: string;
    body?: RegExp;
  } = {};
  let rest = line.slice(effect.length).trimStart();
  while (rest) {
    const key = /^(author|org|prefix|body):/.exec(rest)?.[1];
    if (key !== "author" && key !== "org" && key !== "prefix" && key !== "body")
      return `${rest.split(/\s/)[0]} is not author:, org:, prefix: or body:`;
    if (key in conditions) return `it has two ${key}: conditions`;
    rest = rest.slice(key.length + 1);
    // The prefix runs to the end of the line, spaces and all.
    if (key === "prefix") {
      if (!rest) return "prefix: needs text";
      conditions.prefix = rest;
      break;
    }
    if (key === "org" && rest.startsWith("/"))
      return "org: takes an organization's exact name, not a /pattern/";
    const pattern = PATTERN.exec(rest);
    if ((key === "author" || key === "body") && pattern) {
      const [whole, source = "", flags = ""] = pattern;
      if (!/^(?!.*(.).*\1)[imsu]*$/.test(flags))
        return `${whole} may only use the flags i, m, s and u`;
      try {
        conditions[key] = new RegExp(
          source,
          key === "author" && !flags.includes("i") ? `${flags}i` : flags,
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      rest = rest.slice(whole.length).trimStart();
      continue;
    }
    if (key === "body" || rest.startsWith("/"))
      return `${key}: needs a /pattern/ that ends with / and a space or the line's end`;
    const value = /^\S*/.exec(rest)?.[0] ?? "";
    rest = rest.slice(value.length).trimStart();
    if (key === "org") {
      if (!ORGANIZATION.test(value))
        return `${value || "org:"} is not a GitHub organization login`;
      conditions.org = value;
    } else {
      if (value !== ME && !LOGIN.test(value))
        return `${value || "author:"} is not a GitHub login, ${ME} or /pattern/`;
      conditions.author = value;
    }
  }
  return { effect, ...conditions };
}

/** The policy `text` holds, or why it is not one, naming the line. */
export function parse(text: string): AuthorPolicy | string {
  const lines: string[] = [];
  const rules: Rule[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = rule(trimmed);
    if (typeof parsed === "string") return `Line ${index + 1}: ${parsed}`;
    lines.push(trimmed);
    rules.push(parsed);
  }
  return { text: lines.join("\n"), rules };
}

const DEFAULT = parse(DEFAULT_RULES) as AuthorPolicy;

export function loadPolicy(): AuthorPolicy {
  try {
    const saved = JSON.parse(localStorage.getItem(POLICY_KEY) ?? "null") as {
      version?: unknown;
      text?: unknown;
    } | null;
    const policy =
      saved?.version === 2 && typeof saved.text === "string"
        ? parse(saved.text)
        : DEFAULT;
    return typeof policy === "string" ? DEFAULT : policy;
  } catch {
    return DEFAULT;
  }
}

/** Saves `text`'s rules, or throws why they are not rules. */
export function savePolicy(text: string) {
  const policy = parse(text);
  if (typeof policy === "string") throw new Error(policy);
  localStorage.setItem(
    POLICY_KEY,
    JSON.stringify({ version: 2, text: policy.text }),
  );
  return policy;
}

/** Whether a rule lets anyone it has not denied wake agents. */
export const open = (policy: AuthorPolicy) =>
  policy.rules.some(
    (rule) =>
      rule.effect === "allow" &&
      rule.author === undefined &&
      rule.org === undefined &&
      rule.prefix === undefined &&
      rule.body === undefined,
  );

/** The organizations rules name, whose membership GitHub is asked for. */
export const organizations = (policy: AuthorPolicy) => [
  ...new Set(
    policy.rules.flatMap((rule) => (rule.org ? [rule.org.toLowerCase()] : [])),
  ),
];

/** Whether `item` may wake an agent, or undefined until whether its author is
 * in an organization a rule needs is known. `member` says, or is undefined
 * while it does not know. Bots and deleted accounts are in no organization. */
export function admit(
  item: Feedback,
  policy: AuthorPolicy,
  viewer: string,
  member: (login: string, org: string) => boolean | undefined,
) {
  const login = `${item.author}${item.bot ? "[bot]" : ""}`;
  for (const rule of policy.rules) {
    const { author } = rule;
    if (
      author !== undefined &&
      !(author instanceof RegExp
        ? author.test(login)
        : author === ME
          ? !item.bot && item.author.toLowerCase() === viewer.toLowerCase()
          : author.toLowerCase() === login.toLowerCase())
    )
      continue;
    if (
      rule.prefix !== undefined &&
      !item.body.trimStart().startsWith(rule.prefix)
    )
      continue;
    if (rule.body && !rule.body.test(item.body)) continue;
    if (rule.org !== undefined) {
      if (item.bot || item.author === "ghost") continue;
      const known = member(item.author, rule.org.toLowerCase());
      if (known === undefined) return undefined;
      if (!known) continue;
    }
    return rule.effect === "allow";
  }
  return false;
}

/** The `gh api graphql --input -` body asking which of `organizations` each of
 * `logins` belongs to. Each is inlined as a JSON string, so it stays a
 * string; organizations are validated logins, commenters' come from GitHub. */
export function membershipRequest(
  logins: readonly string[],
  organizations: readonly string[],
) {
  const fields = organizations
    .map(
      (org, index) =>
        `o${index}:organization(login:${JSON.stringify(org)}){id}`,
    )
    .join(" ");
  const users = logins
    .map(
      (login, index) =>
        `u${index}:user(login:${JSON.stringify(login)}){${fields}}`,
    )
    .join("\n");
  return JSON.stringify({ query: `query{\n${users}\n}` });
}

/** For each of `logins`, which of `organizations` a membershipRequest answer
 * puts it in, case aside, or undefined when the answer is unreadable. */
export function parseMembership(
  output: string,
  logins: readonly string[],
  organizations: readonly string[],
): Map<string, ReadonlySet<string>> | undefined {
  let data: Record<string, Record<string, unknown> | null> | undefined;
  try {
    data = (JSON.parse(output) as { data?: typeof data }).data;
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  return new Map(
    logins.map((login, index) => {
      const user = data[`u${index}`];
      return [
        login.toLowerCase(),
        new Set(
          organizations
            .filter((_, org) => !!user?.[`o${org}`])
            .map((org) => org.toLowerCase()),
        ),
      ];
    }),
  );
}
