import { ResolvePull } from "./ResolvePull";
import type { PullChecklist as Checklist } from "./pull";
import { Button } from "../../shared/design-system/ui/Button";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowSquareOutIcon,
  GitPullRequestIcon,
  GitHubIssueIcon,
  GitCommitIcon,
  FolderSimpleIcon,
  GithubLogoIcon,
} from "../../shared/design-system/icons/index";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import { parseGitHubReference, type GitHubReference } from "./references";
import { gitHubCli, type GitHubCli } from "./gh";
import { loadGitHubObject, type GitHubObject } from "./object";
import { PublicChecklist, PullChecklist } from "./PullChecklist";
import styles from "./GitHub.module.css";
import inlineStyles from "../../shared/InlineReference.module.css";
import { GitHubBody } from "./GitHubBody";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import type { RelaySession } from "../../features/relay/session";
import { ownSolo } from "../../features/solo/labels";
import { createSoloPulls, writeLink, type SoloPulls } from "./solo-pull";
import {
  SoloPullIcon,
  SoloPullLink,
  SoloPullMenu,
  stateIcons,
} from "./SoloPull";
import { watchPulls } from "./watcher";
import { presentPull } from "./attention";
import { SubmitReview } from "./SubmitReview";
import { AuthorSettings } from "./AuthorSettings";

/** How often an open pull request panel reads GitHub again. */
export const REFRESH_MS = 30_000;

export const inject = ["panels", "host", "conversation", "relay", "agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  const gh = gitHubCli(ctx.host);
  const pulls = new WeakMap<RelaySession, SoloPulls>();
  const pullsFor = (session: RelaySession) => {
    let found = pulls.get(session);
    if (!found) {
      found = createSoloPulls(session, gh);
      pulls.set(session, found);
    }
    return found;
  };
  ctx.panels.register({
    id: "object",
    title: "GitHub",
    matches: (target) => !!parseGitHubReference(target),
    component: (props: PanelProps) => {
      const channelId = props.context?.channelId;
      return (
        <GitHubPanel
          {...props}
          gh={gh}
          {...(channelId && {
            resolveActions: (
              url: string,
              pull: Checklist,
              action: "failures" | "conflicts",
            ) => (
              <ResolvePull
                relay={ctx.relay}
                channelId={channelId}
                rootId={props.context?.rootId}
                url={url}
                pull={pull}
                action={action}
              />
            ),
            chatLink: (url: string) => (
              <SoloPullLink
                relay={ctx.relay}
                pullsFor={pullsFor}
                channelId={channelId}
                url={url}
              />
            ),
          })}
        />
      );
    },
  });
  ctx.conversation.registerChatMenu(({ session, channelId }) => (
    <SoloPullMenu
      session={session}
      pulls={pullsFor(session)}
      channelId={channelId}
    />
  ));
  ctx.conversation.registerChatIcon(({ session, channelId, fallback }) => (
    <SoloPullIcon
      pulls={pullsFor(session)}
      channelId={channelId}
      fallback={fallback}
    />
  ));
  ctx.agents.addTool({
    name: "github_link_pr",
    description:
      "Links a GitHub pull request to this Solo chat, so the owner's sidebar shows its state (draft, checks, merged) in place of the chat's icon. A chat has one; linking another replaces it.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The pull request's https://github.com/… URL",
        },
        unlink: {
          type: "boolean",
          description: "Unlink the chat's pull request instead",
        },
      },
      additionalProperties: false,
    },
    async call(client, context, args) {
      const url =
        args.unlink === true
          ? null
          : typeof args.url === "string"
            ? parseGitHubReference(args.url)
            : undefined;
      if (url !== null && url?.kind !== "pull")
        throw new Error("url must be a GitHub pull request URL");
      const relay = ctx.agents.relay(client.key)?.snapshot();
      const channel = context.channel;
      const session = relay?.status === "ready" ? relay.session : undefined;
      if (!session || !channel)
        throw new Error("github_link_pr needs this conversation's community");
      if (
        !ownSolo(
          session.channels.list().channels.find((item) => item.id === channel),
          session.viewer,
        )
      )
        throw new Error("Only a Solo chat can be linked to a pull request");
      const link = url === null ? null : url.url;
      await writeLink(session, channel, link);
      pullsFor(session).linked(channel, link);
      // The sidebar reads the selected community through its own session.
      const shown = ctx.relay.snapshot();
      if (shown.status === "ready" && shown.scope === relay?.scope)
        pullsFor(shown.session).linked(channel, link);
      return link
        ? `Linked ${link}. The sidebar shows its state for this chat.`
        : "Unlinked this chat's pull request.";
    },
  });
  // Agents can watch pull requests where the app runs them.
  ctx.inject(["agents", "host", "navigation"], (scope) =>
    watchPulls(scope, presentPull(scope.navigation)),
  );
  // Whose comments and reviews wake them.
  ctx.inject(["settingsCards"], (scope) => {
    scope.settingsCards.register({
      id: "authors",
      title: "GitHub comment authors",
      group: "Plugins",
      icon: GithubLogoIcon,
      component: ({ active }) => <AuthorSettings active={active} />,
    });
  });
};
const labels = {
  repository: "Repository",
  pull: "Pull request",
  issue: "Issue",
  commit: "Commit",
};
const icons = {
  repository: FolderSimpleIcon,
  pull: GitPullRequestIcon,
  issue: GitHubIssueIcon,
  commit: GitCommitIcon,
};

export function GitHubPanel({
  target,
  gh,
  chatLink,
  resolveActions,
}: PanelProps & {
  resolveActions?:
    | ((
        url: string,
        pull: Checklist,
        action: "failures" | "conflicts",
      ) => ReactNode)
    | undefined;
  /** The person's `gh`, where the app can run it. */
  gh?: GitHubCli | undefined;
  /** Links a pull request to the chat the panel was opened from. */
  chatLink?: ((url: string) => ReactNode) | undefined;
}) {
  const [attempt, retry] = useState(0);
  const reference = useMemo(() => parseGitHubReference(target), [target]);
  return reference ? (
    <ObjectPanel
      key={`${reference.url}:${attempt}`}
      reference={reference}
      gh={gh}
      chatLink={chatLink}
      resolveActions={resolveActions}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p className="notice">Unsupported GitHub link.</p>
  );
}

function ObjectPanel({
  reference,
  gh,
  chatLink,
  resolveActions,
  retry,
}: {
  reference: GitHubReference;
  gh: GitHubCli | undefined;
  chatLink: ((url: string) => ReactNode) | undefined;
  resolveActions:
    | ((
        url: string,
        pull: Checklist,
        action: "failures" | "conflicts",
      ) => ReactNode)
    | undefined;
  retry(): void;
}) {
  const [loaded, setLoaded] = useState<GitHubObject | string>();
  const link = reference.url;
  const live = useRef<AbortController>(undefined);
  /** Reads it again. A failed refresh keeps what is shown; only the first
   * read shows an error. */
  const load = useCallback(async () => {
    live.current?.abort();
    const controller = new AbortController();
    live.current = controller;
    try {
      const next = await loadGitHubObject(
        reference,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        gh,
      );
      if (!controller.signal.aborted) setLoaded(next);
    } catch (error) {
      if (!controller.signal.aborted)
        setLoaded((current) =>
          typeof current === "object"
            ? current
            : error instanceof Error
              ? error.message
              : String(error),
        );
    }
  }, [reference, gh]);
  useEffect(() => {
    void load();
    return () => live.current?.abort();
  }, [load]);
  // Merged and closed pull requests don't change, so only these are read again.
  const watching =
    typeof loaded === "object" &&
    (loaded.checklist?.state === "open" || loaded.checklist?.state === "draft");
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [watching, load]);
  const result = typeof loaded === "object" ? loaded.details : loaded;
  const Icon = icons[reference.kind];
  const state = typeof result === "object" ? result.state.toLowerCase() : "";
  const StateIcon =
    reference.kind === "pull" && Object.hasOwn(stateIcons, state)
      ? stateIcons[state as keyof typeof stateIcons]
      : undefined;
  const [owner, repositoryName] = reference.repository.split("/");
  const title = (
    <h2 className={reference.kind === "pull" ? styles.pullTitle : undefined}>
      {reference.kind === "pull" ? (
        <a
          className={`${inlineStyles.link} ${styles.titleLink}`}
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          {typeof result === "object" ? result.title : labels.pull}{" "}
          <span className={styles.titleNumber}>{reference.label}</span>
        </a>
      ) : (
        typeof result === "object" && result.title
      )}
    </h2>
  );
  return (
    <div className={styles.root}>
      <div className={styles.identity}>
        <span className={styles.icon}>
          <Icon size={22} aria-hidden="true" />
        </span>
        <div>
          {reference.kind === "pull" ? (
            <>
              <div className={styles.repository}>
                <a
                  className={inlineStyles.link}
                  href={`https://github.com/${owner}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {owner}
                </a>
                <span className={styles.repositorySeparator}> / </span>
                <a
                  className={inlineStyles.link}
                  href={`https://github.com/${reference.repository}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {repositoryName}
                </a>
              </div>
              <small>{labels[reference.kind]}</small>
            </>
          ) : (
            <>
              <small>{reference.repository}</small>
              <strong>
                {labels[reference.kind]} {reference.label}
              </strong>
            </>
          )}
        </div>
        {/* Pull requests someone else opened take reviews. */}
        {gh &&
          typeof loaded === "object" &&
          loaded.checklist &&
          !loaded.checklist.authored && (
            <span className={styles.identityAction}>
              <SubmitReview pull={loaded.checklist} gh={gh} refresh={load} />
            </span>
          )}
      </div>
      {reference.kind !== "pull" && (
        <a
          className={styles.external}
          href={reference.url}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub <ArrowSquareOutIcon size={14} />
        </a>
      )}
      {reference.kind === "pull" && typeof result !== "object" && title}
      {result === undefined ? (
        <p role="status">Loading from GitHub…</p>
      ) : typeof result === "string" ? (
        <div role="alert">
          <p>{result}</p>
          <div className={styles.errorActions}>
            <Button
              variant="prominent"
              nativeButton={false}
              role="link"
              render={
                <a
                  className={styles.errorExternal}
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <span className={styles.errorActionLabel}>Open on Github</span>
            </Button>
            <Button type="button" onClick={retry}>
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <>
          {reference.kind === "pull" && title}
          <div className={styles.byline}>
            {result.state && (
              <span
                className={styles.state}
                data-pr-state={
                  reference.kind === "pull"
                    ? result.state.toLowerCase()
                    : undefined
                }
              >
                {StateIcon && <StateIcon size={12} aria-hidden="true" />}
                {result.state}
              </span>
            )}
            {result.author && (
              <span>
                by{" "}
                {result.authorUrl ? (
                  <a
                    className={inlineStyles.link}
                    href={result.authorUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {result.author}
                  </a>
                ) : (
                  result.author
                )}
              </span>
            )}
          </div>
          {reference.kind !== "pull" && title}
          {(!!result.facts.length || reference.kind === "pull") && (
            <dl className={styles.facts}>
              {result.facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {typeof value !== "object" ? (
                      value
                    ) : "head" in value ? (
                      <>
                        {value.head.url ? (
                          <a
                            className={styles.branch}
                            href={value.head.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {value.head.label}
                          </a>
                        ) : (
                          <span className={styles.branchLabel}>
                            {value.head.label}
                          </span>
                        )}
                        {" → "}
                        {value.base.url ? (
                          <a
                            className={styles.branch}
                            href={value.base.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {value.base.label}
                          </a>
                        ) : (
                          <span className={styles.branchLabel}>
                            {value.base.label}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className={styles.additions}>
                          +{value.additions}
                        </span>
                        {" / "}
                        <span className={styles.deletions}>
                          −{value.deletions}
                        </span>
                      </>
                    )}
                  </dd>
                </div>
              ))}
              {reference.kind === "pull" && (
                <div>
                  <dt>Last updated</dt>
                  <dd>
                    {result.updatedAt ? (
                      <time
                        dateTime={result.updatedAt}
                        title={new Date(result.updatedAt).toLocaleString()}
                      >
                        {relativeTimestamp(Date.parse(result.updatedAt) / 1000)}
                      </time>
                    ) : (
                      "Unavailable"
                    )}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {reference.kind === "pull" ? (
            <>
              {typeof loaded === "object" && loaded.checklist && gh ? (
                <PullChecklist
                  url={reference.url}
                  details={result}
                  checklist={loaded.checklist}
                  gh={gh}
                  refresh={load}
                  resolveAction={(action) =>
                    loaded.checklist
                      ? resolveActions?.(
                          reference.url,
                          loaded.checklist,
                          action,
                        )
                      : undefined
                  }
                />
              ) : (
                <PublicChecklist
                  url={reference.url}
                  repository={reference.repository}
                  sha={result.headSha}
                />
              )}
              {chatLink?.(reference.url)}
              {result.body && (
                <div className={styles.description}>
                  <GitHubBody
                    body={result.body}
                    bodyHtml={result.bodyHtml}
                    url={reference.url}
                  />
                </div>
              )}
            </>
          ) : (
            result.body && (
              <GitHubBody
                body={result.body}
                bodyHtml={result.bodyHtml}
                url={reference.url}
              />
            )
          )}
        </>
      )}
      {typeof loaded === "object" && (
        <p className={styles.note}>
          {loaded.signedIn
            ? "Read with your gh sign-in."
            : "Public GitHub data · Sign in to the gh CLI to see private repositories and merge from here."}
        </p>
      )}
    </div>
  );
}
