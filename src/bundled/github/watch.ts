// Pull request watches for agents: what one GitHub read says about a pull
// request, and whether that is worth waking the agent that asked. Code decides,
// not a model: CI finishing on the head commit, or new feedback.
//
// The wake is the plugin's (`ctx.agents.wake`), not a message: the agent is
// told it is data. So it quotes what GitHub says, check names and comments,
// each line marked as quoted, and the agent need not read them itself.
//
// Agents use the signed-in gh account, as their owner does, so GitHub cannot
// tell the two apart. A comment of that account that starts with 🤖, as an
// agent's do, wakes nobody; the owner's own comments wake the agent.

/** What a watched pull request looked like at one read. */
export type PullSnapshot = Readonly<{
  state: "OPEN" | "MERGED" | "CLOSED";
  /** The signed-in GitHub account, which agents use too. */
  viewer: string;
  head: string;
  /** Whether every check on the head is done, and none is still expected. */
  settled: boolean;
  /** The names of the head's checks that failed. */
  failed: readonly string[];
  /** The feedback listed, by id: what the watch has seen, and new feedback
   * whose text was read. */
  ids: readonly string[];
  /** The text of new feedback, read apart from the listing. */
  feedback: readonly Feedback[];
}>;
export type Feedback = Readonly<{
  id: string;
  author: string;
  /** Whether the author is a GitHub App, whose login GitHub gives without
   * `[bot]`. */
  bot?: true | undefined;
  url: string;
  body: string;
  /** A review's verdict, such as `CHANGES_REQUESTED`. */
  state?: string | undefined;
  /** The file an inline comment is on. */
  path?: string | undefined;
}>;

export type Watch = Readonly<{
  /** The membership key of the agent, in the community, that set it. A watch
   * saved before keys held a pubkey, which is the same agent's home key. */
  agent: string;
  url: string;
  /** Where the agent asked, so it wakes in that conversation. */
  channel: string;
  root?: string | undefined;
  /** Feedback ids already handled; absent until the first read. */
  seen?: readonly string[] | undefined;
  /** The head commit and result the agent was last told, `sha:passed`. */
  reported?: string | undefined;
  /** New feedback not yet sent, while more may follow. */
  pending?: readonly Feedback[] | undefined;
  /** When feedback last arrived, in ms. */
  arrived?: number | undefined;
  wakes: number;
  /** Polls in a row that could not read the pull request or wake the agent. */
  failures?: number | undefined;
}>;

/** New feedback waits this long for more, so a review is one wake. */
export const QUIET_MS = 90_000;
/** A watch ends after waking its agent this many times. */
export const WAKE_LIMIT = 20;
/** Feedback ids kept beyond those a read returns. */
const SEEN_SPARE = 200;
/** New feedback whose text one read asks for; the rest waits for the next. */
export const FEEDBACK_READ = 50;
/** What a wake quotes at most: comments, characters of each, failed checks
 * and characters of each name. The manifest's `pull` command clips each body
 * to one more character than BODY_CHARS. */
const LISTED = 10;
const BODY_CHARS = 1_000;
const CHECKS = 20;
const NAME_CHARS = 100;

/** An agent's own comment: it starts with 🤖, as agents' do. */
const agents = (item: Feedback, viewer: string) =>
  item.author === viewer && /^\s*🤖/u.test(item.body);

export type Step = Readonly<{
  watch: Watch;
  /** What to tell the agent, when there is something. */
  wake?: string | undefined;
  /** Why the watch is over, when it is. */
  ended?: "merged" | "closed" | "limit" | undefined;
}>;

/** The watch after `snapshot` at `now`, and what to tell its agent. */
export function step(watch: Watch, snapshot: PullSnapshot, now: number): Step {
  if (snapshot.state !== "OPEN")
    return {
      watch,
      ended: snapshot.state === "MERGED" ? "merged" : "closed",
    };
  const { ids } = snapshot;
  // The first read only learns what was already there.
  const seen = new Set(watch.seen ?? ids);
  const arrived = snapshot.feedback.filter(
    (item) => !seen.has(item.id) && !agents(item, snapshot.viewer),
  );
  const pending = [...(watch.pending ?? []), ...arrived];
  const next: Watch = {
    ...watch,
    // What this read returned, then the newest of the rest.
    seen: [
      ...ids,
      ...[...seen].filter((id) => !ids.includes(id)).slice(-SEEN_SPARE),
    ],
    pending,
    arrived: arrived.length ? now : watch.arrived,
  };
  // A failed head that turns green after a rerun is news too.
  const result = `${snapshot.head}:${snapshot.failed.length ? "failed" : "passed"}`;
  const ci = snapshot.settled && result !== watch.reported;
  const quiet = pending.length > 0 && now - (next.arrived ?? now) >= QUIET_MS;
  if (!ci && !quiet) return { watch: next };
  const wakes = watch.wakes + 1;
  return {
    watch: {
      ...next,
      pending: [],
      arrived: undefined,
      reported: ci ? result : watch.reported,
      wakes,
    },
    wake: wakeText(watch.url, snapshot, ci, pending),
    ...(wakes >= WAKE_LIMIT ? { ended: "limit" as const } : {}),
  };
}

// Only GitHub's own links pass into a wake as links; anything else stays out.
const LINK = /^https:\/\/github\.com\/[A-Za-z0-9_.\-/]+(?:#[A-Za-z0-9_-]+)?$/;
const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
const clip = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, chars)}…` : text;
/** `text` as quoted lines, so nothing in it reads as the wake's own. */
const quote = (text: string, indent = "") =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => `${indent}> ${line}`)
    .join("\n");

function wakeText(
  url: string,
  snapshot: PullSnapshot,
  ci: boolean,
  feedback: readonly Feedback[],
) {
  const lines: string[] = [];
  if (ci) {
    const sha = /^[0-9a-f]+$/i.test(snapshot.head)
      ? `on ${snapshot.head.slice(0, 9)} `
      : "";
    const { failed } = snapshot;
    if (failed.length) {
      lines.push(
        `CI failed ${sha}for ${url}: ${plural(failed.length, "check", "checks")} failed, as GitHub names them:`,
      );
      for (const name of failed.slice(0, CHECKS))
        lines.push(quote(clip(name.replace(/\s+/g, " "), NAME_CHARS)));
      if (failed.length > CHECKS)
        lines.push(`and ${failed.length - CHECKS} more`);
    } else lines.push(`CI passed ${sha}for ${url}.`);
  }
  if (feedback.length) {
    if (lines.length) lines.push("");
    lines.push(
      `${feedback.length === 1 ? "New feedback" : `${feedback.length} new comments`} on ${url}, quoted from GitHub:`,
    );
    for (const item of feedback.slice(0, LISTED)) {
      const what = [
        item.id.startsWith("review/")
          ? `review${item.state && item.state !== "COMMENTED" ? ` (${item.state.toLowerCase().replaceAll("_", " ")})` : ""}`
          : item.id.startsWith("inline/")
            ? "inline comment"
            : "comment",
        `by ${item.author}`,
        ...(LINK.test(item.url) ? [item.url] : []),
      ].join(" ");
      lines.push(`- ${what}${item.path ? ", on:" : ":"}`);
      if (item.path) lines.push(quote(clip(item.path, NAME_CHARS), "  "));
      if (item.body.trim())
        lines.push(quote(clip(item.body, BODY_CHARS), "  "));
    }
    if (feedback.length > LISTED)
      lines.push(`- and ${feedback.length - LISTED} more, to read with gh`);
  }
  return lines.join("\n");
}

/** owner/name#number from a pull request URL, or undefined. */
export function pullOf(url: string) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      url.trim(),
    );
  if (!match) return undefined;
  const [, owner, name, number] = (match as unknown as string[]).map((part) =>
    part.toLowerCase(),
  ) as [string, string, string, string];
  return {
    owner,
    name,
    number: Number(number),
    url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

// Only ids, so that however long its feedback a busy pull request's answer
// stays under the 1 MiB a host command may return. Every inline comment,
// a reply on an old thread too, comes with a newly submitted review; pending
// ones are not yet sent.
const QUERY = `query($owner:String!,$name:String!,$number:Int!){
viewer{login}
repository(owner:$owner,name:$name){pullRequest(number:$number){
state headRefOid
commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){totalCount nodes{
__typename
... on CheckRun{name status conclusion}
... on StatusContext{context state}}}}}}}
reviews(last:50,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){nodes{id comments(first:100){nodes{id}}}}
comments(last:50){nodes{id}}
}}}`;
// Clipped bodies, FEEDBACK_READ at most, keep this answer under it too.
const FEEDBACK = `query($ids:[ID!]!){nodes(ids:$ids){__typename id
... on PullRequestReview{author{__typename login} state body url}
... on IssueComment{author{__typename login} body url}
... on PullRequestReviewComment{author{__typename login} body path url}}}`;

/** The `gh api graphql --input -` request body that reads `pull`. */
export function pullRequest(pull: NonNullable<ReturnType<typeof pullOf>>) {
  return JSON.stringify({
    query: QUERY,
    variables: { owner: pull.owner, name: pull.name, number: pull.number },
  });
}

/** The request body that reads the text of feedback `ids` from a listing. */
export function feedbackRequest(ids: readonly string[]) {
  return JSON.stringify({
    query: FEEDBACK,
    variables: { ids: ids.map((id) => id.slice(id.indexOf("/") + 1)) },
  });
}

type Node = Record<string, unknown>;
const nodes = (value: unknown): Node[] =>
  Array.isArray((value as { nodes?: unknown })?.nodes)
    ? ((value as { nodes: unknown[] }).nodes.filter(
        (node) => node && typeof node === "object",
      ) as Node[])
    : [];
const str = (value: unknown) => (typeof value === "string" ? value : "");
const login = (node: Node) =>
  str((node.author as { login?: unknown } | null)?.login) || "ghost";
const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

/** The snapshot in a `pullRequest` response, or undefined when it has none. */
export function parsePull(output: string): PullSnapshot | undefined {
  let data: Node;
  try {
    data = (JSON.parse(output) as { data?: Node }).data ?? {};
  } catch {
    return undefined;
  }
  const pull = (data.repository as Node | null)?.pullRequest as
    | Node
    | null
    | undefined;
  const state = str(pull?.state);
  const head = str(pull?.headRefOid);
  if (!pull || !["OPEN", "MERGED", "CLOSED"].includes(state) || !head)
    return undefined;
  const commit = nodes(pull.commits)[0]?.commit as Node | undefined;
  const rollup = commit?.statusCheckRollup as Node | null | undefined;
  const contexts = nodes(rollup?.contexts);
  const checks = contexts.map((node) =>
    node.__typename === "StatusContext"
      ? {
          name: str(node.context),
          done: !["PENDING", "EXPECTED"].includes(str(node.state)),
          failed: FAILED.has(str(node.state)),
        }
      : {
          name: str(node.name),
          done: node.status === "COMPLETED",
          failed: FAILED.has(str(node.conclusion)),
        },
  );
  const settled =
    checks.length > 0 &&
    checks.every((check) => check.done) &&
    // More than one page of checks, or ones still expected, are not all here.
    (rollup?.contexts as { totalCount?: unknown } | undefined)?.totalCount ===
      contexts.length &&
    !["PENDING", "EXPECTED"].includes(str(rollup?.state));
  const ids = [
    ...nodes(pull.reviews).flatMap((review) => [
      `review/${str(review.id)}`,
      ...nodes(review.comments).map((node) => `inline/${str(node.id)}`),
    ]),
    ...nodes(pull.comments).map((node) => `comment/${str(node.id)}`),
  ].filter((id) => !id.endsWith("/"));
  return {
    state: state as PullSnapshot["state"],
    viewer: str((data.viewer as Node | null)?.login),
    head,
    settled,
    failed: checks
      .filter((check) => check.failed)
      .map((check) => check.name || "unnamed check"),
    ids,
    feedback: [],
  };
}

const KINDS: Record<string, string> = {
  PullRequestReview: "review",
  IssueComment: "comment",
  PullRequestReviewComment: "inline",
};

/** The feedback in a `feedbackRequest` response, or undefined when it has
 * none. */
export function parseFeedback(output: string): Feedback[] | undefined {
  let found: unknown;
  try {
    found = (JSON.parse(output) as { data?: { nodes?: unknown } }).data?.nodes;
  } catch {
    return undefined;
  }
  if (!Array.isArray(found)) return undefined;
  return nodes({ nodes: found }).flatMap((node): Feedback[] => {
    const kind = KINDS[str(node.__typename)];
    const body = str(node.body);
    // An empty COMMENTED review is only its inline comments' wrapper.
    if (
      !kind ||
      (kind === "review" && node.state === "COMMENTED" && !body.trim())
    )
      return [];
    return [
      {
        id: `${kind}/${str(node.id)}`,
        author: login(node),
        ...((node.author as { __typename?: unknown } | null)?.__typename ===
        "Bot"
          ? { bot: true as const }
          : {}),
        url: str(node.url),
        body,
        ...(kind === "review" ? { state: str(node.state) } : {}),
        ...(kind === "inline" ? { path: str(node.path) } : {}),
      },
    ];
  });
}
