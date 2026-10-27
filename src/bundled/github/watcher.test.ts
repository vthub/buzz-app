// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import {
  AttentionSources,
  type AttentionSource,
} from "../../features/agents/attention-sources";
import type { Agent, AgentAttention } from "../../features/agents/service";
import type { AttentionValue } from "../../features/agents/attention";
import { POLL_MS, watchPulls } from "./watcher";
import { pullOf, pullRequest, QUIET_MS, WAKE_LIMIT } from "./watch";
import { POLICY_KEY } from "./authors";

const agent = "a".repeat(64);
const root = "f".repeat(64);
const url = "https://github.com/block/buzz-app/pull/7";

type Comment = { id: string; login: string; body: string };
type Pull = ReturnType<typeof answer>;
/** A pull request as GitHub holds it. */
const answer = ({
  head = "1111111111",
  checks = [] as { name: string; conclusion: string | null }[],
  comments = [] as Comment[],
  reviews = [] as (Comment & { inline: (Comment & { path: string })[] })[],
  state = "OPEN",
} = {}) => ({ head, checks, comments, reviews, state });

/** What gh answers for `input`, a listing or a text read of `pull`. */
function respond(pull: Pull, input: string) {
  const { variables } = JSON.parse(input) as {
    variables: { ids?: string[] };
  };
  if (variables.ids) {
    const all = [
      ...pull.comments.map((item) => ({ ...item, __typename: "IssueComment" })),
      ...pull.reviews.flatMap(({ inline, ...review }) => [
        { ...review, __typename: "PullRequestReview", state: "COMMENTED" },
        ...inline.map((item) => ({
          ...item,
          __typename: "PullRequestReviewComment",
        })),
      ]),
    ];
    return JSON.stringify({
      data: {
        nodes: variables.ids.map((id) => {
          const found = all.find((item) => item.id === id);
          if (!found) return null;
          const { login, ...node } = found;
          return { ...node, author: { login }, url: `${url}#${id}` };
        }),
      },
    });
  }
  const { checks } = pull;
  return JSON.stringify({
    data: {
      viewer: { login: "baxen" },
      repository: {
        pullRequest: {
          state: pull.state,
          headRefOid: pull.head,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: checks.some((check) => !check.conclusion)
                      ? "PENDING"
                      : "SUCCESS",
                    contexts: {
                      totalCount: checks.length,
                      nodes: checks.map(({ name, conclusion }) => ({
                        __typename: "CheckRun",
                        name,
                        status: conclusion ? "COMPLETED" : "IN_PROGRESS",
                        conclusion,
                      })),
                    },
                  },
                },
              },
            ],
          },
          reviews: {
            nodes: pull.reviews.map((review) => ({
              id: review.id,
              comments: { nodes: review.inline.map(({ id }) => ({ id })) },
            })),
          },
          comments: { nodes: pull.comments.map(({ id }) => ({ id })) },
        },
      },
    },
  });
}

/** What gh answers a membership read, when `members` are in the org. */
function membership(members: readonly string[], input: string) {
  const { query } = JSON.parse(input) as { query: string };
  const users = [...query.matchAll(/(u\d+):user\(login:"([^"]+)"\)/g)];
  // GitHub has no user for a mannequin, which fails the whole read.
  if (users.some(([, , login]) => login === "mannequin")) return null;
  return JSON.stringify({
    data: Object.fromEntries(
      users.map(([, alias, login]) => [
        alias,
        { o0: members.includes(login as string) ? { id: "O" } : null },
      ]),
    ),
  });
}

function setup(initial: Pull | null = answer()) {
  let gh = initial;
  let texts = true;
  let members: readonly string[] | null = [];
  const runCommand = vi.fn(async (_id: string, input: string) => {
    if (!("variables" in JSON.parse(input)))
      return members && membership(members, input);
    return !gh || (!texts && "ids" in JSON.parse(input).variables)
      ? null
      : respond(gh, input);
  });
  const woke = vi.fn();
  const records: Record<string, Record<string, AttentionValue>> = JSON.parse(
    localStorage.getItem("test.attention") ?? "{}",
  );
  const completed = new Set<string>();
  const listeners: (() => void)[] = [];
  let source: AttentionSource;
  let enabled = true;
  const objects = (key: string) =>
    Object.fromEntries(
      Object.entries(records[key] ?? {}).map(([slug, value]) => [
        slug,
        { slug, value },
      ]),
    );
  const snapshot = () =>
    Object.keys(records).map(
      (key) =>
        ({ key, attentionEnabled: enabled, attention: objects(key) }) as Agent,
    );
  const lifecycle = new AttentionSources({
    emit(key, object, text) {
      if (!runs) throw new Error("Delivery unavailable");
      const value = object.value;
      woke(key, {
        channel: value.channel,
        ...(value.root ? { root: value.root } : {}),
        text,
      });
    },
    completed: (key, object) => completed.has(`${key}/${object.slug}`),
    async finish(key, object) {
      completed.add(`${key}/${object.slug}`);
    },
  });
  const reconcile = () => {
    if (source) lifecycle.reconcile("attention/github-pr", source, snapshot());
  };
  const save = async (
    key: string,
    change: { attention: Record<string, AttentionValue | null> },
  ) => {
    records[key] ??= {};
    const record = records[key];
    for (const [slug, value] of Object.entries(change.attention)) {
      if (value) record[slug] = value;
      else delete record[slug];
      completed.delete(`${key}/${slug}`);
    }
    localStorage.setItem("test.attention", JSON.stringify(records));
    reconcile();
    for (const listener of listeners) listener();
  };
  const attention = (key: string) =>
    ({
      enabled: () => enabled,
      async show(slug: string) {
        const object = records[key]?.[slug];
        return {
          result: object ? "found" : "not-found",
          object: object
            ? {
                ...object,
                id: slug.split("/")[1],
                status: completed.has(`${key}/${slug}`)
                  ? "completed"
                  : "enabled",
              }
            : null,
          expected_state: JSON.stringify(object) ?? "absent",
        };
      },
      async write(
        slug: string,
        value: AttentionValue | null,
        options: { expected: string },
      ) {
        expect(options.expected).toBe(
          JSON.stringify(records[key]?.[slug]) ?? "absent",
        );
        await save(key, { attention: { [slug]: value } });
      },
    }) as unknown as AgentAttention;
  const addAttentionSource = vi.fn((value: AttentionSource) => {
    source = value;
    reconcile();
  });
  let runs = true;
  const tools: AddedTool[] = [];
  const disposers: (() => void)[] = [];
  const ctx = {
    host: { runCommand },
    agents: {
      addAttentionSource,
      snapshot: () => ({ running: snapshot() }),
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
      save,
      addTool: (tool: AddedTool) => tools.push(tool),
      wake: (key: string, wake: unknown) => {
        if (!runs) throw new Error("This copy of Buzz does not run that agent");
        woke(key, wake);
      },
    },
    effect: (fn: () => () => void) => disposers.push(fn()),
  } as unknown as Context;
  watchPulls(ctx);
  const tool = tools[0] as AddedTool;
  const call = (args: Record<string, unknown>, topLevel = false, key = agent) =>
    tool.call(
      { key, pubkey: agent, attention: attention(key) } as BuzzClient,
      topLevel ? { channel: "c", topLevel } : { channel: "c", root },
      args,
    );
  return {
    call,
    records,
    save,
    attention: attention(agent),
    completed,
    attentionEnabled(value: boolean) {
      enabled = value;
      reconcile();
    },
    addAttentionSource,
    tool,
    woke,
    /** The text of each wake, in order. */
    texts: () =>
      woke.mock.calls.map(([, wake]) => (wake as { text: string }).text),
    runCommand,
    gh: (value: Pull | null) => {
      gh = value;
    },
    /** Who is in the trusted organization, or null when that cannot be read. */
    members: (value: readonly string[] | null) => {
      members = value;
    },
    /** Whether reads of feedback text succeed, as a too-long answer cannot. */
    readsText: (value: boolean) => {
      texts = value;
    },
    runs: (value: boolean) => {
      runs = value;
    },
    dispose: () => {
      lifecycle.stop();
      for (const dispose of disposers) dispose();
    },
  };
}

describe("github_watch_pr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("registers PR watching as an Attention source", () => {
    const app = setup();
    expect(app.addAttentionSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: "github-pr", run: expect.any(Function) }),
    );
    app.dispose();
  });

  it("keeps generic subscriptions for the same PR independent", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "First" },
        "interest/second": { type: "interest", instructions: "Second" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(1);
    await app.save(agent, {
      attention: { "watch/second": { ...source, interest_id: "second", root } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("starts fresh when a generic subscription is deleted and recreated", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "Follow" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(1);
    await app.save(agent, { attention: { "watch/first": null } });
    await app.save(agent, { attention: { "watch/first": source } });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("starts fresh when a subscription is edited to another PR", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "Follow" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const next = "https://github.com/block/buzz-app/pull/8";
    app.gh(
      answer({
        head: "2222222222",
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
      }),
    );
    await app.save(agent, {
      attention: { "watch/first": { ...source, config: { pr: next } } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.texts().at(-1)).toBe(`CI passed on 222222222 for ${next}.`);
    app.dispose();
  });

  it("pauses polling with Attention and catches up when resumed", async () => {
    const app = setup();
    await app.call({ url });
    app.attentionEnabled(false);
    await vi.advanceTimersByTimeAsync(0);
    const count = app.runCommand.mock.calls.length;
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(app.runCommand).toHaveBeenCalledTimes(count);
    expect(app.woke).not.toHaveBeenCalled();
    await expect(app.call({ url })).rejects.toThrow(/Turn on Attention/);
    app.attentionEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    app.dispose();
  });

  it("imports saved watches once with their cursor and conversation", async () => {
    localStorage.setItem("test.attention", JSON.stringify({ [agent]: {} }));
    localStorage.setItem(
      "buzz.github.pull-watches.v1",
      JSON.stringify([
        {
          agent,
          url,
          channel: "c",
          root,
          wakes: 2,
          seen: [],
          reported: "1111111111:passed",
        },
      ]),
    );
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(Object.values(app.records[agent] ?? {})).toContainEqual(
        expect.objectContaining({
          type: "source",
          provider: "attention/github-pr",
          channel: "c",
          root,
          config: expect.objectContaining({
            initial: expect.objectContaining({ wakes: 2 }),
          }),
        }),
      ),
    );
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? "[]"),
    ).toEqual([]);
    expect(app.woke).not.toHaveBeenCalled();
    await app.call({ url, stop: true });
    app.dispose();
    const next = setup();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(
      Object.values(next.records[agent] ?? {}).filter(
        (value) => value.type === "source",
      ),
    ).toEqual([]);
    expect(next.runCommand).not.toHaveBeenCalled();
    next.dispose();
  });

  it("starts fresh after the owner deletes a watch outside the tool", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const id = Object.keys(app.records[agent] ?? {}).find((id) =>
      id.startsWith("watch/"),
    );
    if (!id) throw new Error("Missing watch");
    await app.save(agent, { attention: { [id]: null } });
    const reply = await app.call({ url }, true);
    expect(reply).not.toContain("no longer in the conversation");
    const record = app.records[agent]?.[id];
    if (record?.type !== "source") throw new Error("Missing source");
    expect((record.config.initial as { wakes: number }).wakes).toBe(0);
    app.dispose();
  });

  it("finishes at the wake limit and a new call starts a fresh watch", async () => {
    const app = setup();
    await app.call({ url });
    for (let index = 0; index < WAKE_LIMIT; index++) {
      app.gh(
        answer({
          head: index.toString(16).padStart(10, "0"),
          checks: [{ name: "unit", conclusion: "SUCCESS" }],
        }),
      );
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    expect(app.texts()).toHaveLength(WAKE_LIMIT);
    expect(app.texts().at(-1)).toContain("this watch has ended");
    expect(app.completed.size).toBe(1);
    await app.call({ url });
    app.gh(
      answer({
        head: "abcdef0123",
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toHaveLength(WAKE_LIMIT + 1);
    expect(app.texts().at(-1)).not.toContain("this watch has ended");
    app.dispose();
  });

  it("wakes the agent in its thread when CI finishes, naming the failed checks", async () => {
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    expect(await app.call({ url })).toMatch(/^Watching https:/);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke.mock.calls).toEqual([
      [
        agent,
        {
          channel: "c",
          root,
          text: `CI failed on 111111111 for ${url}: 1 check failed, as GitHub names them:\n> unit`,
        },
      ],
    ]);
    // Reported once per head commit.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).toHaveBeenCalledTimes(1);
    app.dispose();
  });

  it("wakes the community whose membership set the watch, apart from the agent's other one", async () => {
    const other = `${agent}@other.example`;
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    await app.call({ url });
    await app.call({ url }, false, other);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke.mock.calls.map(([key]) => key).sort()).toEqual(
      [agent, other].sort(),
    );
    // Stopping one leaves the other's.
    await app.call({ url, stop: true }, false, other);
    expect(
      JSON.parse(
        localStorage.getItem("buzz.github.attention-cursors.v1") ?? "[]",
      ).map((watch: { agent: string }) => watch.agent),
    ).toEqual([agent]);
    app.dispose();
  });

  it("answers what is already there instead of waking, and wakes a Solo chat with what is new", async () => {
    const app = setup();
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "wes", body: "body-old" }],
      }),
    );
    expect(await app.call({ url }, true)).toContain(
      "Already there:\nCI passed on 111111111",
    );
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [
          { id: "I1", login: "wes", body: "body-old" },
          { id: "I2", login: "wes", body: "body-new" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIET_MS + POLL_MS);
    expect(app.woke.mock.calls).toEqual([
      [
        agent,
        {
          channel: "c",
          text: `New feedback on ${url}, quoted from GitHub:\n- comment by wes ${url}#I2:\n  > body-new`,
        },
      ],
    ]);
    app.dispose();
  });

  it("keeps news it could not send, and survives a restart", async () => {
    const app = setup();
    await app.call({ url });
    app.runs(false);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    app.dispose();
    // The restarted app reads at once.
    const next = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(next.woke).toHaveBeenCalledTimes(1);
    next.dispose();
  });

  it("stops on request, when merged, and refuses unreadable pull requests", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url, stop: true })).toBe(
      `Stopped watching ${url}.`,
    );
    app.gh(null);
    await expect(app.call({ url })).rejects.toThrow(/gh/);
    await expect(app.call({ url: "https://example.com/x" })).rejects.toThrow(
      /pull request URL/,
    );
    app.gh(answer());
    await app.call({ url });
    app.gh(answer({ state: "MERGED" }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect([...app.completed]).toHaveLength(1);
    expect(app.woke).not.toHaveBeenCalled();
    app.dispose();
  });

  it("ends a watch it cannot read for half an hour, telling the agent", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    // A good read in between starts the count again.
    app.gh(answer());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([
      expect.stringContaining(`Stopped watching ${url}`),
    ]);
    expect([...app.completed]).toHaveLength(1);
    app.dispose();
  });

  it("lets a read still in flight when the plugin stops do nothing", async () => {
    const old = setup();
    await old.call({ url });
    let finish: (value: string) => void = () => {};
    old.runCommand.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    old.dispose();
    // Its replacement takes over the saved watch, then the agent stops it.
    const next = setup();
    await vi.advanceTimersByTimeAsync(0);
    await next.call({ url, stop: true });
    finish(
      respond(
        answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
        pullRequest(pullOf(url) as NonNullable<ReturnType<typeof pullOf>>),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(old.woke).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        localStorage.getItem("buzz.github.attention-cursors.v1") ?? "",
      ),
    ).toEqual([]);
    next.dispose();
  });

  it("still reports CI while feedback text cannot be read, and tells the feedback once it can", async () => {
    const app = setup();
    await app.call({ url });
    app.readsText(false);
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "wes", body: "x".repeat(22_000) }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    app.readsText(true);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS + QUIET_MS);
    expect(app.texts()).toHaveLength(2);
    expect(app.texts()[1]).toMatch(
      new RegExp(`^New feedback on .+\\n- comment by wes ${url}#I1:`),
    );
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("wakes for a reply on an older thread, which comes with its own review", async () => {
    const old = Array.from({ length: 40 }, (_, i) => ({
      id: `R${i}`,
      login: "wes",
      body: "",
      inline: [
        { id: `C${i}`, login: "wes", body: `old ${i}`, path: "src/a.ts" },
      ],
    }));
    const app = setup(answer({ reviews: old }));
    await app.call({ url });
    app.gh(
      answer({
        reviews: [
          ...old,
          {
            id: "R40",
            login: "wes",
            body: "",
            inline: [
              {
                id: "C40",
                login: "wes",
                body: "Still broken",
                path: "src/a.ts",
              },
            ],
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(2 * POLL_MS + QUIET_MS);
    expect(app.texts()).toEqual([
      [
        `New feedback on ${url}, quoted from GitHub:`,
        `- inline comment by wes ${url}#C40, on:`,
        "  > src/a.ts",
        "  > Still broken",
      ].join("\n"),
    ]);
    // Only the new review and its comment were read in full.
    expect(
      app.runCommand.mock.calls
        .map(([, input]) => JSON.parse(input).variables.ids)
        .filter(Boolean),
    ).toEqual([["R40", "C40"]]);
    app.dispose();
  });

  it("tells only feedback from trusted authors, once their organization is known", async () => {
    localStorage.setItem(
      POLICY_KEY,
      JSON.stringify({
        version: 1,
        trustedOrganizations: ["block"],
        trustedAuthors: ["wes"],
        ignoredAuthors: [],
      }),
    );
    const app = setup();
    await app.call({ url });
    app.members(null);
    app.gh(
      answer({
        comments: [
          { id: "I1", login: "wes", body: "body-wes" },
          { id: "I2", login: "stranger", body: "body-stranger" },
          { id: "I3", login: "alice", body: "body-alice" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    expect(app.texts()[0]).toContain("body-wes");
    expect(app.texts()[0]).not.toContain("body-alice");
    // Membership read once it can be; strangers are never told.
    app.members(["alice"]);
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(2);
    expect(app.texts()[1]).toContain("body-alice");
    expect(app.texts().join("\n")).not.toContain("body-stranger");
    app.dispose();
  });

  it("keeps membership reads under the command's input limit", async () => {
    const organizations = Array.from(
      { length: 8 },
      (_, index) => `organization-${index}-with-a-long-name`,
    );
    const logins = Array.from(
      { length: 30 },
      (_, index) => `commenter-${index}-with-a-long-login`,
    );
    localStorage.setItem(
      POLICY_KEY,
      JSON.stringify({
        version: 1,
        trustedOrganizations: organizations,
        trustedAuthors: [],
        ignoredAuthors: [],
      }),
    );
    const app = setup();
    await app.call({ url });
    app.members(logins);
    app.gh(
      answer({
        comments: logins.map((login, index) => ({
          id: `I${index}`,
          login,
          body: `body-${index}`,
        })),
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    const reads = app.runCommand.mock.calls
      .map(([, input]) => input as string)
      .filter((input) => !("variables" in JSON.parse(input)));
    expect(reads.length).toBeGreaterThan(1);
    for (const input of reads)
      expect(new TextEncoder().encode(input).length).toBeLessThanOrEqual(4096);
    expect(app.texts()[0]).toContain("30 new comments");
    app.dispose();
  });

  it("asks alone after a login fails its batch, and gives up on that login", async () => {
    localStorage.setItem(
      POLICY_KEY,
      JSON.stringify({
        version: 1,
        trustedOrganizations: ["block"],
        trustedAuthors: [],
        ignoredAuthors: [],
      }),
    );
    const app = setup();
    await app.call({ url });
    app.members(["alice"]);
    app.gh(
      answer({
        comments: [
          { id: "I1", login: "mannequin", body: "body-mannequin" },
          { id: "I2", login: "alice", body: "body-alice" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    expect(app.texts()[0]).toContain("body-alice");
    // After ten polls it is taken to be in no organization, and is seen.
    const asked = () =>
      app.runCommand.mock.calls.filter(([, input]) =>
        (input as string).includes('"mannequin"'),
      ).length;
    await vi.advanceTimersByTimeAsync(12 * POLL_MS);
    const settled = asked();
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(asked()).toBe(settled);
    expect(app.texts().join("\n")).not.toContain("body-mannequin");
    app.dispose();
  });

  it("needs a thread or a Solo chat to wake in", async () => {
    const app = setup();
    await expect(
      app.tool.call(
        { key: agent, pubkey: agent, attention: app.attention } as BuzzClient,
        { channel: "c" },
        { url },
      ),
    ).rejects.toThrow(/thread or a Solo chat/);
    app.dispose();
  });

  it("says when a watch moves to another conversation", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url }, true)).toContain(
      "no longer in the conversation that asked before",
    );
    app.dispose();
  });
});
