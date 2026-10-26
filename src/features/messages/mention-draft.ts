import { canonicalChatCard } from "./chat-cards";
import {
  projectComposerDocument,
  readComposerSnapshot,
} from "./composer-document";

export type MentionRecipient = Readonly<{ pubkey: string; name: string }>;
export type DraftRecipient = MentionRecipient &
  Readonly<{ start: number; end: number }>;
// Serializable draft metadata must not expose editor implementation types to plugins.
export type ComposerSnapshot = { version: 1; content: unknown };
/** A name Space committed before the chooser could decide. The editor resolves
 * it off-screen into a recipient or back into prose; it is never a recipient. */
export type PendingMention = Readonly<{
  id: string;
  name: string;
  start: number;
  end: number;
}>;
export type MentionDraft = {
  text: string;
  /** Chat links staged above the editor; serialized with the caption. */
  chatCards?: readonly string[];
  recipients: readonly DraftRecipient[];
  /** Projection of the live document only; `mentionDraft()` never restores one. */
  pending?: readonly PendingMention[];
  document?: ComposerSnapshot;
};
// The timeline binds a signed name up to the next non-name character, so the
// inline Markdown delimiters *, ~ and ` end a mention here as well: typing a
// closing delimiter after a chip keeps its recipient. An underscore remains a
// name suffix, as it does on the timeline.
export const mentionBoundary = (text: string, end: number) =>
  end === text.length || /[\s.,!?;:()[\]{}*~`]/u.test(text[end] ?? "");
/** Old text-only drafts remain text-only: restoring prose never creates notifications. */
export function mentionDraft(value: unknown): MentionDraft {
  if (typeof value === "string") return { text: value, recipients: [] };
  if (!value || typeof value !== "object") return { text: "", recipients: [] };
  const record = value as Record<string, unknown>;
  const doc = readComposerSnapshot(record.document);
  const { text, recipients, document } = doc
    ? projectComposerDocument(doc).draft
    : record;
  if (typeof text !== "string") return { text: "", recipients: [] };
  const safe = Array.isArray(recipients)
    ? recipients.filter(
        (item): item is DraftRecipient =>
          !!item &&
          typeof item === "object" &&
          typeof item.pubkey === "string" &&
          /^[0-9a-f]{64}$/.test(item.pubkey) &&
          typeof item.name === "string" &&
          !!item.name.trim() &&
          Number.isInteger(item.start) &&
          Number.isInteger(item.end) &&
          item.start >= 0 &&
          item.end <= text.length &&
          text.slice(item.start, item.end) === `@${item.name}` &&
          mentionBoundary(text, item.end),
      )
    : [];
  // Drafts saved before the rename keep their cards under `sessionCards`.
  const cards = Array.isArray(record.chatCards)
    ? record.chatCards
    : record.sessionCards;
  return {
    text,
    ...(Array.isArray(cards) && cards.length
      ? {
          chatCards: cards
            .map(canonicalChatCard)
            .filter((item): item is string => item !== undefined)
            .slice(0, 32),
        }
      : {}),
    ...(doc ? { document: document as ComposerSnapshot } : {}),
    recipients: safe
      .slice(0, 32)
      .map(({ pubkey, name, start, end }) => ({ pubkey, name, start, end })),
  };
}
/** What counts as a draft everywhere: text, an attached chat, or `files`.
 * A typed tag is text the person put there; the composer no longer saves
 * tags of its own, and the ones earlier releases saved are not content. */
export function hasDraftContent(value: MentionDraft, files = 0): boolean {
  return (
    files > 0 ||
    !!value.chatCards?.length ||
    (!!value.text.trim() && !legacyFollowupDraft(value))
  );
}
/** A remembered-agent follow-up that a release through preview.177.1 saved
 * as the draft: selected recipients and nothing else, without the editor
 * snapshot every typed draft carries. Relay history seeds it now. */
export function legacyFollowupDraft(value: MentionDraft): boolean {
  return !value.document && addressingOnly(value);
}
/** Selected recipients and nothing else: no prose outside their spans and no
 * attached chat. */
export function addressingOnly(value: MentionDraft): boolean {
  if (!value.recipients.length || value.chatCards?.length) return false;
  let rest = value.text;
  for (const { start, end } of [...value.recipients].sort(
    (a, b) => b.start - a.start,
  ))
    rest = rest.slice(0, start) + rest.slice(end);
  return !rest.trim();
}
/** Prefill exact, already-selected identities; never infer recipients from prose. */
export function followupDraft(
  recipients: readonly MentionRecipient[],
): MentionDraft {
  const next: MentionDraft = { text: "", recipients: [] };
  const spans: DraftRecipient[] = [];
  const unique = new Map(recipients.map((item) => [item.pubkey, item]));
  for (const { pubkey, name } of [...unique.values()].slice(0, 32)) {
    const start = next.text.length;
    const text = `@${name} `;
    if (start + text.length > 16000) break;
    next.text += text;
    spans.push({ pubkey, name, start, end: next.text.length - 1 });
  }
  return mentionDraft({ text: next.text, recipients: spans });
}
/** Known editor replacement keeps only untouched spans. */
export function replaceMentionDraft(
  value: MentionDraft,
  start: number,
  end: number,
  inserted: string,
): MentionDraft {
  const text = value.text.slice(0, start) + inserted + value.text.slice(end);
  const delta = inserted.length - (end - start);
  return mentionDraft({
    text,
    recipients: value.recipients.flatMap((item) => {
      if (item.end <= start) return [item];
      if (item.start >= end)
        return [{ ...item, start: item.start + delta, end: item.end + delta }];
      return [];
    }),
  });
}
export type MentionEdit = Readonly<{
  text: string;
  start: number;
  end: number;
  inputType: string;
}>;
/** Preserve identity only when the browser supplied the actual replacement range.
 * Matching before/after prose cannot distinguish a paste from untouched text. */
export function editMentionDraft(
  value: MentionDraft,
  text: string,
  edit?: MentionEdit,
): MentionDraft {
  if (
    edit?.text === value.text &&
    Number.isInteger(edit.start) &&
    Number.isInteger(edit.end) &&
    edit.start >= 0 &&
    edit.end >= edit.start &&
    edit.end <= value.text.length
  ) {
    const insertion = [
      "insertText",
      "insertReplacementText",
      "insertFromPaste",
      "insertLineBreak",
    ].includes(edit.inputType);
    const selectionDeletion =
      edit.inputType.startsWith("delete") && edit.end > edit.start;
    // Collapsed word/grapheme deletion, IME and history operations have no reliable
    // textarea target range. They fail closed instead of reconstructing one.
    const length = text.length - (value.text.length - (edit.end - edit.start));
    if (
      (insertion || (selectionDeletion && length === 0)) &&
      length >= 0 &&
      text.slice(0, edit.start) === value.text.slice(0, edit.start) &&
      text.slice(edit.start + length) === value.text.slice(edit.end)
    )
      return replaceMentionDraft(
        value,
        edit.start,
        edit.end,
        text.slice(edit.start, edit.start + length),
      );
  }
  return { text, recipients: [] };
}
