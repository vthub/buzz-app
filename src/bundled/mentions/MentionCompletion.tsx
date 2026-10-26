import { TeamMentionAvatars } from "./TeamMentionAvatars";
import { useContext, useEffect, useRef, useState } from "react";
import { useTeamMentions } from "./use-team-mentions";
import { useMentionChoices } from "./use-mention-choices";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import type { ComposerSession } from "../../features/messages/composer-session";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { outsideMentionDetail } from "./mention-candidates";
import { matchesMentionQuery, pendingMentionQuery } from "./mention-query";
import { continuedMention } from "./mention-ranking";
import { resolveSpaceMention } from "./resolve-space-mention";
import { SelectedMentionContext } from "../../features/messages/selected-mention-context";
import { DraftMentionRoster } from "../../features/messages/draft-mention-roster";
import { avatarMedia } from "../../shared/avatar-source";

// Demand bookkeeping only, not another profile cache. Missing names do not issue
// the same network request on every query keystroke; explicit retry remains available.
const demands = new WeakMap<ComposerSession, Set<string>>();
export function MentionCompletion({
  session,
  scope,
  channelId,
  threadRootId,
  inviteAgents,
  query,
  publish,
}: ComposerCompletionProps) {
  // The host remounts this provider on every keystroke. One `@` token in one
  // composer is the chooser lifetime that keeps the last directory page.
  const model = useMentionChoices(
    session,
    channelId,
    inviteAgents,
    query.query,
    JSON.stringify(["inline", scope, channelId, threadRootId, query.start]),
  );
  const { profiles, agents, channel, list, choices } = model;
  const teams = useTeamMentions(
    session,
    channelId,
    inviteAgents,
    query.query,
    model,
  );
  const selected = useContext(SelectedMentionContext);
  const roster = useContext(DraftMentionRoster);
  const draftRoster = roster?.recipients;
  const members = draftRoster?.map((p) => p.pubkey) ?? channel?.members ?? [];
  const memberKey = members.join(":");
  const parentAdmission = !!channel && channel.channelType !== "solo";
  // The shared budget is append-only for this query, including late teams and
  // directory people. Neither source may displace an already displayed choice.
  const shown = useRef<{
    session: ComposerSession;
    key: string;
    ids: string[];
  }>(undefined);
  const [attempt, retry] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (draftRoster) return;
    session.channels.ensureList();
    const requested = demands.get(session) ?? new Set<string>();
    demands.set(session, requested);
    const ids = memberKey
      .split(":")
      .filter((id) => id && (attempt > 0 || !requested.has(id)))
      .slice(0, attempt > 0 ? 1024 : Math.max(0, 1024 - requested.size));
    if (!ids.length) return;
    for (const id of ids) requested.add(id);
    let live = true;
    void session.profiles.ensure(ids, "background").catch(() => {
      if (live) setError(true);
    });
    return () => {
      live = false;
    };
  }, [session, memberKey, attempt, draftRoster]);
  useEffect(() => {
    const members = memberKey ? memberKey.split(":") : [];
    const admitted =
      matchesMentionQuery(
        query.query,
        [...model.candidates, ...choices].flatMap((c) => [
          ...c.aliases,
          c.label,
        ]),
      ) ||
      (teams.names.length > 0 && matchesMentionQuery(query.query, teams.names));
    const matching = admitted ? choices : [];
    const matchingTeams = admitted ? teams.choices : [];
    const membershipMissing =
      !draftRoster && (!inviteAgents || !!channel) && !channel?.members;
    const membershipError = !draftRoster && list.error;
    const missing = !draftRoster && members.some((key) => !profiles.has(key));
    // A multi-word query that continues no known name is prose, not a search.
    if (
      !admitted &&
      !model.pending &&
      !model.directory.loading &&
      !model.directory.error
    ) {
      const withdraw = publish({ items: [] });
      return () => {
        if (withdraw) withdraw();
      };
    }
    const available = [
      ...matching.map(({ recipient, label, elsewhere, disabled }) => ({
        disabled,
        canSelect: (key: string) =>
          (key !== " " || !teams.blocksSpace) &&
          model.canSelect(recipient.pubkey, key === " "),
        id: recipient.pubkey,
        label,
        detail:
          disabled ??
          (members.includes(recipient.pubkey)
            ? recipient.pubkey
            : inviteAgents
              ? `${parentAdmission ? "Adds to channel" : "Adds to chat"} · ${recipient.pubkey}`
              : outsideMentionDetail(channel, elsewhere)),
        preview: (
          <Avatar
            alt=""
            fallback={label}
            src={avatarMedia(
              profiles.get(recipient.pubkey)?.picture ??
                model.directory.people.find(
                  (person) => person.pubkey === recipient.pubkey,
                )?.picture,
              session.media,
            )}
            size="default"
            shape={
              model.candidates.some(
                (c) => c.recipient.pubkey === recipient.pubkey && c.agent,
              )
                ? "squircle"
                : "circle"
            }
          />
        ),
        edit: { mention: recipient },
      })),
      ...matchingTeams.map((team) => ({
        id: team.id,
        label: team.name,
        detail: team.detail,
        disabled: team.disabled,
        canSelect: team.canSelect,
        preview: (
          <TeamMentionAvatars session={session} recipients={team.recipients} />
        ),
        edit: team.disabled
          ? { text: `@${team.name}` }
          : { mentions: team.recipients },
      })),
    ];
    const key = JSON.stringify([
      channelId,
      inviteAgents,
      query.start,
      query.query,
    ]);
    const ids =
      shown.current?.session === session && shown.current.key === key
        ? shown.current.ids
        : [];
    const known = new Set(ids);
    // Reserve space for teams already ready at first publication. Once shown,
    // the budget is append-only, regardless of which source arrives next.
    const additions = ids.length
      ? available.filter((item) => !known.has(item.id))
      : [
          ...available.slice(
            0,
            Math.min(matching.length, 50 - matchingTeams.length),
          ),
          ...available.slice(matching.length),
        ];
    const next = [...ids, ...additions.map((item) => item.id)].slice(0, 50);
    shown.current = { session, key, ids: next };
    const byId = new Map(available.map((item) => [item.id, item]));
    // Space is undecided, not declined, only while evidence is still arriving:
    // members, names or agents loading, or the directory search waiting or
    // running. Then the host may hold the name and let the resolver apply
    // section 5 once the choice set is known. A name already known to continue
    // the query declines Space whatever else arrives: the next word may
    // complete that longer name, so Space stays prose and the query open. The
    // known set is every candidate the chooser has, not only the shown rows:
    // members or roster, offered agents and the directory rows received so
    // far, the same set `spaceId` is decided over. Anything else is prose.
    const undecided =
      admitted &&
      model.spaceId === undefined &&
      !teams.blocksSpace &&
      !continuedMention(model.candidates, query.query) &&
      (model.pending || model.directory.loading) &&
      pendingMentionQuery(query.query);
    const withdraw = publish({
      spaceId: teams.blocksSpace ? undefined : model.spaceId,
      ...(undecided
        ? {
            spacePending: {
              name: query.query,
              resolve: (signal: AbortSignal) =>
                resolveSpaceMention(
                  session,
                  { channelId, inviteAgents, roster, selected },
                  query.query,
                  signal,
                ),
            },
          }
        : {}),
      items: next.flatMap((id) => byId.get(id) ?? []),
      ...(model.pending
        ? { status: "Loading recipients…" }
        : model.directory.error
          ? { status: model.directory.error }
          : !admitted
            ? {}
            : model.archives.status === "error"
              ? { status: "Archive information unavailable. Retry to refresh." }
              : agents.status === "error" || agents.error
                ? { status: "Could not load agents. Retry to refresh." }
                : admitted && membershipMissing
                  ? { status: "Channel membership unavailable." }
                  : admitted && membershipError
                    ? { status: "Could not refresh channel membership." }
                    : error || missing
                      ? {
                          status:
                            "Some names unavailable. Exact public keys still identify recipients.",
                        }
                      : model.directory.loading
                        ? { status: "Searching community…" }
                        : model.directory.more ||
                            model.truncated ||
                            matching.length + matchingTeams.length > 50
                          ? {
                              status: "Narrow your search to see more members.",
                            }
                          : teams.status
                            ? { status: teams.status }
                            : {}),
      ...((admitted && teams.canRetry) ||
      model.directory.error ||
      (admitted &&
        (model.archives.status === "error" ||
          agents.status === "error" ||
          agents.error ||
          membershipMissing ||
          membershipError ||
          error ||
          missing))
        ? {
            retry: () => {
              teams.retry();
              model.directory.retry();
              void session.agentChoices.refresh(
                !!inviteAgents || teams.includeLegacy,
              );
              void session.archives?.refresh();
              setError(false);
              retry((value) => value + 1);
              if (membershipMissing || membershipError)
                session.channels.refreshList?.();
            },
          }
        : {}),
    });
    return () => {
      if (withdraw) withdraw();
    };
  }, [
    session,
    publish,
    query.query,
    query.start,
    channelId,
    memberKey,
    model,
    teams,
    profiles,
    list,
    agents,
    error,
    choices,
    channel,
    draftRoster,
    roster,
    inviteAgents,
    parentAdmission,
    selected,
  ]);
  return null;
}
