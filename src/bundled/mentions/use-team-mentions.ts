import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  fullSession,
  type ComposerSession,
} from "../../features/messages/composer-session";
import type { useMentionChoices } from "./use-mention-choices";
import { mentionCandidates } from "./mention-candidates";
import { extendsName, normalizeName } from "../../features/search/person-match";
import type { RelaySession } from "../../features/relay/session";
import { mentionMatch } from "./mention-ranking";

const empty = { status: "unavailable", entries: [] } as const;
type Catalog = Pick<
  ReturnType<NonNullable<RelaySession["channelKit"]>["snapshot"]>,
  "entries"
>;
/** A saved team with the same or a longer name must not auto-select a person on Space. */
export function teamBlocksSpace(catalog: Catalog, query: string) {
  const needle = normalizeName(query);
  return catalog.entries.some(
    (entry) =>
      !entry.record.deleted &&
      entry.record.value.type === "team" &&
      (normalizeName(entry.record.value.name) === needle ||
        extendsName(entry.record.value.name, needle)),
  );
}
const subscribeNone = () => () => {};
const snapshotNone = () => empty;

/** Saved teams are shortcuts to exact individual recipients, never new identities. */
export function useTeamMentions(
  session: ComposerSession,
  channelId: string,
  inviteAgents: boolean | undefined,
  query: string,
  model: ReturnType<typeof useMentionChoices>,
  open = true,
) {
  const roster = model.roster;
  const kit = fullSession(session)?.channelKit;
  const catalog = useSyncExternalStore(
    kit?.subscribe ?? subscribeNone,
    kit?.snapshot ?? snapshotNone,
  );
  useEffect(() => {
    if (open) kit?.ensure();
  }, [kit, open]);
  const teams = useMemo(
    () =>
      catalog.entries.flatMap((entry) =>
        !entry.record.deleted && entry.record.value.type === "team"
          ? [{ value: entry.record.value, eventId: entry.eventId }]
          : [],
      ),
    [catalog],
  );
  const hasTeams = open && teams.length > 0;
  useEffect(() => {
    if (!hasTeams) return;
    const release = session.agentChoices.retain();
    session.agentChoices.ensure(true);
    return release;
  }, [session, hasTeams]);
  const key = JSON.stringify([channelId, inviteAgents, query, open, !!roster]);
  const [installed, install] = useState<{
    session: ComposerSession;
    key: string;
    teams: ((typeof teams)[number] & { members: readonly string[] })[];
  }>();
  let rows =
    installed?.session === session && installed.key === key
      ? installed.teams
      : undefined;
  if (installed && !rows) install(undefined);
  if (open && !rows && !model.pending && catalog.status === "ready") {
    const members = new Set(
      roster?.map((person) => person.pubkey) ?? model.channel?.members ?? [],
    );
    rows = teams
      .filter(({ value }) =>
        Number.isFinite(
          mentionMatch(
            {
              label: value.name,
              aliases: [value.name],
              recipient: { pubkey: value.id, name: value.name },
              member: false,
              agent: true,
              owned: true,
              managed: false,
            },
            query,
          ),
        ),
      )
      .sort(
        (a, b) =>
          a.value.name.localeCompare(b.value.name) ||
          a.value.id.localeCompare(b.value.id),
      )
      .slice(0, 20)
      .map((team) => ({
        ...team,
        members: team.value.agents.filter((key) => members.has(key)),
      }));
    install({ session, key, teams: rows });
  }
  return useMemo(() => {
    void model; // Source revisions invalidate eligibility, not the installed row order.
    // Parent chooser subscribes to roster, profiles, agent choices and archives.
    // Read those same owners again at acceptance; saved keys grant no eligibility.
    const candidates = () =>
      mentionCandidates(
        session,
        channelId,
        inviteAgents,
        roster,
        session.agentChoices.snapshot().identities,
      );
    const current = candidates();
    const eligible = new Map(current.map((c) => [c.recipient.pubkey, c]));
    const choices = (open ? (rows ?? []) : []).map(
      ({ value, eventId, members }) => {
        const latest = teams.find((team) => team.value.id === value.id);
        const recipients = value.agents.flatMap((key) => {
          const person = eligible.get(key)?.recipient;
          return person ? [{ pubkey: person.pubkey, name: person.name }] : [];
        });
        const disabled =
          catalog.status !== "ready" || latest?.eventId !== eventId
            ? "Team changed or unavailable. Reopen to refresh."
            : members.some((key) => !eligible.get(key)?.member)
              ? "Channel membership changed. Reopen to review adding this team."
              : !value.agents.length
                ? "This team has no agents."
                : value.agents.length > 32
                  ? "Teams can mention at most 32 agents."
                  : recipients.length !== value.agents.length
                    ? "A team member is unavailable. Edit the team or refresh choices."
                    : undefined;
        const outside = recipients.filter(
          (person) => !eligible.get(person.pubkey)?.member,
        ).length;
        const channel = session.channels
          .list()
          .channels.find((channel) => channel.id === channelId);
        const consequence = !outside
          ? ""
          : channel?.channelType === "dm"
            ? `${outside} not in DM · Will not be notified`
            : inviteAgents
              ? `Adds ${outside} to ${channel && channel.channelType !== "solo" ? "channel" : "chat"} when you send`
              : `${outside} not in channel · Choose whether to add when you send`;
        return {
          id: `team:${value.id}`,
          name: value.name,
          recipients,
          disabled,
          detail:
            disabled ??
            [`Saved team · ${recipients.length} agents`, consequence]
              .filter(Boolean)
              .join(" · "),
          canSelect: () => {
            const fresh = kit?.snapshot();
            const entry = fresh?.entries.find(
              (entry) =>
                !entry.record.deleted &&
                entry.record.value.type === "team" &&
                entry.record.value.id === value.id,
            );
            if (
              disabled ||
              fresh?.status !== "ready" ||
              entry?.eventId !== eventId
            )
              return false;
            const now = new Map(
              candidates().map((c) => [c.recipient.pubkey, c]),
            );
            return recipients.every((person) => {
              const choice = now.get(person.pubkey);
              return (
                choice?.recipient.name === person.name &&
                (!members.includes(person.pubkey) || choice.member)
              );
            });
          },
        };
      },
    );
    const names = teams.map(({ value }) => value.name);
    return {
      choices,
      includeLegacy: hasTeams,
      names,
      blocksSpace: teamBlocksSpace(catalog, query),
      status:
        open && (catalog.status === "idle" || catalog.status === "loading")
          ? "Loading saved teams…"
          : open && catalog.status === "error"
            ? "Could not load saved teams. Retry to refresh."
            : undefined,
      canRetry: open && catalog.status === "error",
      retry: () => void kit?.refresh(),
    };
  }, [
    session,
    channelId,
    inviteAgents,
    roster,
    model,
    catalog,
    teams,
    rows,
    open,
    query,
    kit,
    hasTeams,
  ]);
}
