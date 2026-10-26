import { useGifDraftPreview } from "../../bundled/emoji/GifDraftPreview";
import { useMentionArchives } from "./use-mention-archives";
import { useContext, type ReactNode } from "react";
import { DraftMentionRoster } from "./draft-mention-roster";
import { archivedMention } from "./mention-admission";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useIdentityNames } from "../identity-names/react";
import { useListedChannel } from "../relay/listed-channel";
import { InlineChip } from "../../shared/design-system/ui/InlineChip";
import type { ConversationExtensions } from "../conversation/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { ComposerSession } from "./composer-session";
import { profileKey } from "../profiles/target";
import { scanMarkdown } from "../relay/message-content";
import { MessageMarkdown } from "./MessageMarkdown";
import type { MentionDraft } from "./mention-draft";
import { useReferenceDirectory } from "./ReferenceText";
import {
  readComposerSnapshot,
  composerMarkdownContext,
} from "./composer-document";
import { messageLinkParts } from "./message-link-parts";
import { messageReferences } from "./message-references";
import { EditableInput, type EditableInputProps } from "./EditableInput";

/** Decorations never change source text or infer notification recipients from names. */
export function RichComposerInput({
  draft,
  session,
  scope,
  channelId,
  extensions,
  emoji,
  ...input
}: EditableInputProps & {
  draft: MentionDraft;
  session: ComposerSession;
  scope: string;
  channelId: string;
  extensions: ConversationExtensions | undefined;
  emoji: readonly CustomEmoji[];
}) {
  const gifDraftPreview = useGifDraftPreview(extensions?.tools);
  const directory = useReferenceDirectory(session);
  const members = useListedChannel(
    session.channels,
    channelId,
    (channel) => channel?.members,
  );
  useMentionArchives(session);
  const roster = useContext(DraftMentionRoster)?.recipients;
  const profiles = new Map(directory.profiles);
  for (const recipient of draft.recipients)
    profiles.set(recipient.pubkey, {
      ...profiles.get(recipient.pubkey),
      name: recipient.name,
    });
  const resolveName = useIdentityNames(session.names);
  // Chips name selections among the people who read this destination. Draft
  // recipients stay in even when archived, so their chips keep a name.
  const candidates = [
    ...new Set([
      ...(roster?.map((p) => p.pubkey) ?? members ?? []).filter(
        (pubkey) => !archivedMention(session, pubkey),
      ),
      ...draft.recipients.map((p) => p.pubkey),
    ]),
  ];
  const displayFacts = draft.recipients
    .filter((recipient) => !session.names?.lookup(recipient.pubkey, candidates))
    .map((recipient) => ({
      pubkey: recipient.pubkey,
      name: recipient.name,
    }));
  const qualifiers = new Map(
    draft.recipients.map((recipient) => [
      recipient.pubkey,
      session.names?.lookup(recipient.pubkey, candidates, displayFacts)
        ?.qualifier,
    ]),
  );
  const labels = new Map(
    draft.recipients.map((recipient) => [
      recipient.pubkey,
      resolveName(recipient.pubkey, recipient.name, candidates, displayFacts),
    ]),
  );
  const previous = useRef(labels);
  const revealed = useRef(
    new Set([...qualifiers].filter(([, suffix]) => suffix).map(([key]) => key)),
  );
  // Keep the motion decision through editor-driven rerenders of the same
  // draft and labels; a new draft or naming result starts a new decision.
  const labelState = JSON.stringify([...labels]);
  const reveal = useMemo(
    () =>
      new Set(
        (JSON.parse(labelState) as [string, string][])
          .filter(
            ([key, label]) =>
              draft.recipients.some((recipient) => recipient.pubkey === key) &&
              previous.current.has(key) &&
              previous.current.get(key) !== label &&
              !revealed.current.has(key),
          )
          .map(([key]) => key),
      ),
    [draft, labelState],
  );
  useLayoutEffect(() => {
    previous.current = labels;
    if (!draft.text) revealed.current.clear();
    for (const [key, suffix] of qualifiers)
      if (suffix) revealed.current.add(key);
  });
  function decorationsFor(draft: MentionDraft) {
    const doc = readComposerSnapshot(draft.document);
    const context = doc
      ? composerMarkdownContext(doc)
      : { text: draft.text, protected: [] };
    const { tree, links, tooDeep } = scanMarkdown(context.text);
    const literals: { start: number; end: number }[] = [...context.protected];
    const gifPreviews = new Map<number, { end: number; content: ReactNode }>();
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (node.type === "image" && !tooDeep) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const content = gifDraftPreview?.(node.url, node.alt, session.media);
        if (
          content &&
          start !== undefined &&
          end !== undefined &&
          !context.protected.some(
            (range) => start < range.end && end > range.start,
          )
        )
          gifPreviews.set(start, { end, content });
      }
      if (
        [
          "code",
          "inlineCode",
          "image",
          "imageReference",
          "definition",
          "html",
        ].includes(node.type)
      ) {
        const start = node.position?.start.offset,
          end = node.position?.end.offset;
        if (start !== undefined && end !== undefined)
          literals.push({ start, end });
      } else pending.push(...(node.children ?? []));
    }
    const ranges: {
      start: number;
      end: number;
      mention?: string;
      editAsText?: boolean;
    }[] = [];
    const add = (
      start: number,
      end: number,
      mention?: string,
      editAsText = false,
    ) => {
      if (
        // Explicit recipients disclose notification intent even inside Markdown literals.
        (mention ||
          (!tooDeep &&
            !literals.some(
              (range) => start < range.end && end > range.start,
            ))) &&
        !ranges.some((range) => start < range.end && end > range.start)
      )
        ranges.push({
          start,
          end,
          editAsText,
          ...(mention ? { mention } : {}),
        });
    };
    for (const recipient of draft.recipients)
      add(recipient.start, recipient.end, recipient.pubkey);
    // Identity links are display references, not new notification recipients.
    // Keep their exact source token so editing surrounding prose preserves it.
    const profileLinks = new Map<number, { pubkey: string; label: string }>();
    for (const link of links) {
      const pubkey = link.url && profileKey(link.url);
      const start = link.position?.start.offset;
      const end = link.position?.end.offset;
      if (!pubkey || start === undefined || end === undefined) continue;
      let label = "";
      const pending = [...(link.children ?? [])].reverse();
      while (pending.length) {
        const node = pending.pop();
        if (node?.value) label += node.value;
        else pending.push(...(node?.children ?? []).slice().reverse());
      }
      profileLinks.set(start, { pubkey, label: label.replace(/^@/, "") });
      add(start, end, undefined, true);
    }
    messageLinkParts(context.text, undefined, (start, end) =>
      add(start, end, undefined, true),
    );
    for (const reference of messageReferences(
      context.text,
      [],
      profiles,
      directory.named,
      directory.agents,
    ))
      add(reference.start, reference.end, undefined, true);
    const renderableEmoji = emoji.filter((entry) => !!session.media(entry.url));
    const shortcodes = new Set(
      renderableEmoji.map((entry) => entry.shortcode.toLowerCase()),
    );
    for (const match of context.text.matchAll(/:([a-z0-9_-]{1,64}):/gi))
      if (shortcodes.has(match[1]?.toLowerCase() ?? ""))
        add(match.index, match.index + match[0].length);
    for (const [start, { end }] of gifPreviews)
      if (!ranges.some((range) => start < range.end && end > range.start))
        ranges.push({ start, end });
    const decorations = ranges
      .sort((a, b) => a.start - b.start)
      .map(({ start, end, mention, editAsText }) => {
        const preview = gifPreviews.get(start);
        if (preview && preview.end === end && !mention)
          return { start, end, editAsText: false, content: preview.content };
        const profile = mention ? undefined : profileLinks.get(start);
        const identity = mention ?? profile?.pubkey;
        const label = profile?.label ?? draft.text.slice(start + 1, end);
        const resolved = mention ? (labels.get(mention) ?? label) : label;
        const qualifier = mention ? qualifiers.get(mention) : undefined;
        const faceLabel = qualifier
          ? resolved.slice(0, -(qualifier.length + 3))
          : resolved;
        return {
          start,
          end,
          editAsText: !!editAsText,
          content: identity ? (
            <InlineChip
              address={{
                kind:
                  directory.profiles.get(identity)?.isAgent ||
                  directory.agents.some((agent) => agent.pubkey === identity)
                    ? "agent"
                    : "person",
                id: identity,
              }}
              face={{
                label: faceLabel,
                loading: false,
                resolved: true,
              }}
              qualifier={
                qualifier
                  ? {
                      text: `· ${qualifier}`,
                      reveal: !!mention && reveal.has(mention),
                      accessibleLabel: `public key ending ${qualifier.split("").join(" ")}`,
                    }
                  : undefined
              }
              interactive={false}
            />
          ) : (
            <MessageMarkdown
              row={{
                id: "composer",
                authorId: "",
                createdAt: 0,
                channelId,
                content: draft.text.slice(start, end),
                mentions: mention ? [mention] : [],
                emoji: renderableEmoji,
                participants: [],
                attachments: [],
                reactions: [],
                replyCount: 0,
              }}
              directory={directory}
              participantProfiles={profiles}
              session={session}
              scope={scope}
              extensions={extensions}
              media={session.media}
              onOpenLink={() => false}
              interactive={false}
            />
          ),
        };
      });
    return decorations;
  }
  return (
    <EditableInput {...input} draft={draft} decorationsFor={decorationsFor} />
  );
}
