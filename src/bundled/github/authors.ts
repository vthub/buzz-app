// Whose GitHub feedback wakes agents. Agents act on what a wake quotes, so a
// stranger's comment on a public pull request should not reach them. Until an
// allowlist is saved, every author does, as before it existed. Saved on this
// device and edited in Settings; each poll reads it again, so a change applies
// to running watches.
import type { Feedback } from "./watch";

export type AuthorPolicy = Readonly<{
  version: 1;
  trustedOrganizations: readonly string[];
  /** Exact logins; a bot's ends in `[bot]`. */
  trustedAuthors: readonly string[];
  /** Never wake an agent, even in a trusted organization. */
  ignoredAuthors: readonly string[];
}>;

export const POLICY_KEY = "buzz.github.author-policy.v1";
const EMPTY: AuthorPolicy = {
  version: 1,
  trustedOrganizations: [],
  trustedAuthors: [],
  ignoredAuthors: [],
};
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;

/** `policy`, or why it is not one. */
export function validate(policy: AuthorPolicy): string | undefined {
  const bad = (values: readonly string[], pattern: RegExp) =>
    values.find((value) => !pattern.test(value));
  const organization = bad(policy.trustedOrganizations, ORGANIZATION);
  if (organization !== undefined)
    return `${organization} is not a GitHub organization login`;
  const login = bad(
    [...policy.trustedAuthors, ...policy.ignoredAuthors],
    LOGIN,
  );
  return login === undefined ? undefined : `${login} is not a GitHub login`;
}

export function loadPolicy(): AuthorPolicy {
  try {
    const value = JSON.parse(
      localStorage.getItem(POLICY_KEY) ?? "null",
    ) as AuthorPolicy | null;
    const lists = [
      value?.trustedOrganizations,
      value?.trustedAuthors,
      value?.ignoredAuthors,
    ];
    if (
      value?.version !== 1 ||
      !lists.every(
        (list) =>
          Array.isArray(list) && list.every((item) => typeof item === "string"),
      ) ||
      validate(value)
    )
      return EMPTY;
    return value;
  } catch {
    return EMPTY;
  }
}

export function savePolicy(policy: AuthorPolicy) {
  const error = validate(policy);
  if (error) throw new Error(error);
  localStorage.setItem(POLICY_KEY, JSON.stringify(policy));
}

/** Whether an allowlist limits who wakes agents. */
export const limited = (policy: AuthorPolicy) =>
  policy.trustedOrganizations.length > 0 || policy.trustedAuthors.length > 0;

/** Whether `login` is listed, case aside; a bot is listed with `[bot]`. */
const listed = (list: readonly string[], item: Feedback) => {
  const login = `${item.author}${item.bot ? "[bot]" : ""}`.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === login);
};

/** Whether `admit` needs to know if `item`'s author is in a trusted
 * organization. */
export const needsLookup = (
  item: Feedback,
  policy: AuthorPolicy,
  viewer: string,
) =>
  !item.bot &&
  item.author !== "ghost" &&
  item.author.toLowerCase() !== viewer.toLowerCase() &&
  policy.trustedOrganizations.length > 0 &&
  !listed(policy.ignoredAuthors, item) &&
  !listed(policy.trustedAuthors, item);

/** Whether `item` may wake an agent. `member` says whether its author is in
 * a trusted organization. The signed-in account, which is the owner's too,
 * is always trusted. */
export function admit(
  item: Feedback,
  policy: AuthorPolicy,
  viewer: string,
  member: (login: string) => boolean,
) {
  if (listed(policy.ignoredAuthors, item)) return false;
  if (!limited(policy)) return true;
  if (!item.bot && item.author.toLowerCase() === viewer.toLowerCase())
    return true;
  return (
    listed(policy.trustedAuthors, item) ||
    (needsLookup(item, policy, viewer) && member(item.author))
  );
}

/** The `gh api graphql --input -` body asking which of `organizations` each of
 * `logins` belongs to. Both are validated logins, so they are safe to inline. */
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

/** For each of `logins`, whether a membershipRequest answer puts it in any of
 * the organizations, or undefined when the answer is unreadable. */
export function parseMembership(
  output: string,
  logins: readonly string[],
): Map<string, boolean> | undefined {
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
        !!user && Object.values(user).some((org) => !!org),
      ];
    }),
  );
}
