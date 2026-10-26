import {
  readComposerSnapshot,
  composerMarkdownContext,
} from "../messages/composer-document";
import type { ComposerSnapshot } from "../messages/mention-draft";
import { scanMarkdown } from "../relay/message-content";
import type { ComposerInputElement } from "../messages/composer-dom";
import { createPortal } from "react-dom";
import { useCompletionPosition } from "./useCompletionPosition";
import {
  useId,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  CompletionContext,
  CompletionEdit,
  CompletionQuery,
  CompletionResult,
  ComposerObservation,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { completionResult, matchCompletion } from "./completion";
import type { CompletionEditor } from "./useCompletionEditor";
import styles from "./Completions.module.css";

const RETRY = Symbol("retry-completion");

// Channel links belong in prose, not inside existing links or code.
// Run only after a channel trigger matches; ordinary typing does no extra parsing.
function channelCompletionInProse(
  text: string,
  document: ComposerSnapshot | undefined,
  query: CompletionQuery,
) {
  const doc = readComposerSnapshot(document);
  const context = doc ? composerMarkdownContext(doc) : { text, protected: [] };
  const overlaps = (start: number, end: number) =>
    query.start < end && query.end > start;
  if (context.protected.some(({ start, end }) => overlaps(start, end)))
    return false;
  const { tree, tooDeep } = scanMarkdown(context.text);
  if (tooDeep) return false;
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || !overlaps(start, end))
      continue;
    if (
      [
        "code",
        "inlineCode",
        "link",
        "linkReference",
        "image",
        "imageReference",
        "definition",
        "html",
      ].includes(node.type)
    )
      return false;
    pending.push(...(node.children ?? []));
  }
  return true;
}

export function ComposerCompletions({
  registry,
  editor,
  input,
  replace,
  resolved,
  ...context
}: CompletionContext & {
  registry: ContributionReader<ComposerCompletion>;
  editor: CompletionEditor;
  input: RefObject<ComposerInputElement | null>;
  /** Chip ranges and the draft text they were measured against. */
  resolved: Readonly<{
    text: string;
    document?: ComposerSnapshot;
    recipients: readonly Readonly<{ start: number; end: number }>[];
    /** Mentions still resolving; their `@` is no more an open query. */
    pending?: readonly Readonly<{ start: number; end: number }>[] | undefined;
  }>;
  replace(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ): boolean;
}) {
  const providers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const observation = editor.observation;
  // Stale chip ranges cannot classify this caret.
  const match =
    observation &&
    resolved.text === observation.text &&
    matchCompletion(providers, observation, context, [
      ...resolved.recipients,
      ...(resolved.pending ?? []),
    ]);
  if (!match || !observation) return null;
  if (
    match.provider.pluginId === "buzz.channels" &&
    !channelCompletionInProse(observation.text, resolved.document, match.query)
  )
    return null;
  return (
    <ContributionBoundary
      key={JSON.stringify([
        contributionKey(match.provider),
        observation.revision,
        match.query.start,
        match.query.end,
        match.query.query,
      ])}
      fallback={
        <span role="status">
          {match.provider.title} suggestions unavailable
        </span>
      }
    >
      <OwnedCompletion
        {...context}
        registry={registry}
        provider={match.provider}
        query={match.query}
        observation={observation}
        editor={editor}
        input={input}
        replace={replace}
      />
    </ContributionBoundary>
  );
}
function OwnedCompletion({
  provider,
  registry,
  query,
  observation,
  editor,
  input,
  replace,
  ...context
}: CompletionContext & {
  provider: Contribution<ComposerCompletion>;
  registry: ContributionReader<ComposerCompletion>;
  query: CompletionQuery;
  observation: ComposerObservation;
  editor: CompletionEditor;
  input: RefObject<ComposerInputElement | null>;
  replace(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ): boolean;
}) {
  const id = useId();
  const compact = provider.pluginId === "buzz.emoji";
  const mention = provider.pluginId === "buzz.mentions";
  const channel = provider.pluginId === "buzz.channels";
  const named = mention || channel;
  // Typing the terminator accepts the provider-verified exact match (spaceId):
  // plain Space after a name, the closing colon after an emoji shortcode.
  const terminator = provider.pluginId === "buzz.emoji" ? ":" : " ";
  const popup = useCompletionPosition(
    input,
    compact ? 0.375 : 1,
    named
      ? { preferAbove: true, gap: 4, maxWidth: channel ? 480 : 380 }
      : undefined,
  );
  const list = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<CompletionResult>();
  const latest = useRef<CompletionResult | undefined>(undefined);
  // Only user navigation pins an ID; automatic selection follows the first result.
  const [selected, setSelected] = useState<string | typeof RETRY>();
  const revealSelection = useRef(false);
  const live = useRef(false);
  const current = useRef({ editor, replace });
  useLayoutEffect(() => {
    current.current = { editor, replace };
  });
  const active = useCallback(
    () =>
      live.current &&
      registry.snapshot().includes(provider) &&
      current.current.editor.valid(observation),
    [provider, registry, observation],
  );
  const [publish, setPublish] = useState<ComposerCompletionProps["publish"]>();
  useLayoutEffect(() => {
    live.current = true;
    let owned = true;
    setPublish(() => (incoming: CompletionResult) => {
      if (!owned || !active()) return false;
      const next = completionResult(incoming);
      latest.current = next;
      revealSelection.current = true;
      setResult(next);
      setSelected((previous) =>
        next.items.some((item) => item.id === previous)
          ? previous
          : previous === RETRY && next.retry
            ? RETRY
            : undefined,
      );
      return () => {
        if (latest.current !== next) return;
        latest.current = undefined;
        if (live.current) setResult(undefined);
      };
    });
    return () => {
      owned = false;
      live.current = false;
      latest.current = undefined;
    };
  }, [active]);
  const items = result?.items ?? [];
  // Matching syntax is not evidence of pending work. Providers publish their
  // own status when needed; an empty/unpublished result must not flash a portal.
  const visible = !!(items.length || result?.status || result?.retry);
  const count = items.length + (result?.retry ? 1 : 0);
  const index =
    selected === RETRY && result?.retry
      ? items.length
      : items.findIndex((item) => item.id === selected);
  const selectedIndex = index < 0 ? 0 : index;
  const status = result?.status;
  function accept(index: number, key = "click") {
    const published = latest.current;
    if (!active() || !published) return false;
    if (index === items.length && result?.retry) {
      if (!published.retry) return false;
      published.retry();
      return true;
    }
    // Publication is synchronous; React may still be displaying the previous
    // result. Keep the user's chosen ID, but use only its current evidence/edit.
    // The terminator names its own item, which that display may not have yet.
    const id = key === terminator ? published.spaceId : items[index]?.id;
    const item = published.items.find((item) => item.id === id);
    if (!item || item.disabled || item.canSelect?.(key) === false) return false;
    const accepted = current.current.replace(
      item.edit,
      query,
      observation,
      key,
    );
    if (accepted) current.current.editor.invalidate();
    return accepted;
  }
  useLayoutEffect(() => {
    const element = input.current;
    // Escape must still dismiss an unpublished provider without advertising a
    // nonexistent listbox. A settled empty result leaves ordinary keys alone;
    // an undecided one still owns the terminator, with nothing to show yet.
    if (!element || (!visible && result && !result.spacePending)) return;
    if (visible) {
      element.setAttribute("aria-autocomplete", "list");
      element.setAttribute("aria-haspopup", "listbox");
      element.setAttribute("aria-controls", id);
      if (count)
        element.setAttribute("aria-activedescendant", `${id}-${selectedIndex}`);
      else element.removeAttribute("aria-activedescendant");
    }
    const handle: NonNullable<CompletionEditor["keys"]["current"]> = (
      event,
    ) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        current.current.editor.invalidate();
        return true;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return false;
      // Shift types ":" on common layouts; other shifted keys keep editing.
      if (event.shiftKey && event.key !== ":") return false;
      if (!active()) {
        // A displayed choice owns plain acceptance even when its final evidence
        // was revoked. Never turn a rejected edit into an unintended send.
        if ((event.key === "Enter" || event.key === "Tab") && count) {
          event.preventDefault();
          event.stopPropagation();
          current.current.editor.invalidate();
          return true;
        }
        return false;
      }
      // A result that has just decided the terminator may not have rendered
      // yet, so both terminator branches read the publication. Space is not
      // redirected away from an exact match the display showed: a publication
      // that moves it to another id leaves Space literal. The displayed row
      // is never accepted on its own; only the publication selects.
      const published = latest.current;
      if (
        event.key === terminator &&
        published?.spaceId &&
        (!result?.spaceId || result.spaceId === published.spaceId)
      ) {
        // Selected by ID, so no displayed row is needed.
        if (accept(-1, terminator)) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        return false;
      }
      // Undecided, not declined: the provider is still gathering evidence, so
      // the host may hold the name as a pending mention and resolve it later.
      // This includes a display whose exact match the publication withdrew
      // as undecided: no other recipient overrules what the user saw, the
      // decision is deferred to the resolver under the full rule.
      if (
        event.key === terminator &&
        published?.spacePending &&
        !published.spaceId &&
        current.current.replace(
          { pending: published.spacePending },
          query,
          observation,
          terminator,
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        current.current.editor.invalidate();
        return true;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
        event.preventDefault();
        event.stopPropagation();
        const next =
          (selectedIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        revealSelection.current = true;
        setSelected(next === items.length ? RETRY : items[next]?.id);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && count) {
        event.preventDefault();
        event.stopPropagation();
        accept(selectedIndex, event.key);
        return true;
      }
      return false;
    };
    editor.keys.current = handle;
    if (revealSelection.current) {
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
      revealSelection.current = false;
    }
    return () => {
      if (editor.keys.current === handle) editor.keys.current = undefined;
      element.removeAttribute("aria-autocomplete");
      element.removeAttribute("aria-haspopup");
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-activedescendant");
    };
  });
  const Provider = provider.component;
  return (
    <>
      {publish && (
        <Provider
          {...context}
          observation={observation}
          query={query}
          publish={publish}
        />
      )}
      {visible &&
        input.current &&
        createPortal(
          <section
            ref={popup}
            className={styles.popup}
            aria-label={`${provider.title} suggestions`}
            data-compact={compact || undefined}
            data-mention={named || undefined}
            data-channel={channel || undefined}
          >
            <div
              id={id}
              role="listbox"
              aria-label={`${provider.title} suggestions`}
              ref={list}
              className={styles.list}
            >
              {items.map((item, i) => (
                // The textarea owns keyboard focus/selection via aria-activedescendant.
                // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
                <div
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === selectedIndex}
                  aria-disabled={!!item.disabled}
                  aria-label={
                    compact && item.detail
                      ? `${item.label} ${item.detail}`
                      : undefined
                  }
                  id={`${id}-${i}`}
                  key={item.id}
                  onPointerDown={(event) => {
                    if (event.button === 0) event.preventDefault();
                  }}
                  onPointerMove={
                    compact || named
                      ? () => {
                          revealSelection.current = false;
                          setSelected(item.id);
                        }
                      : undefined
                  }
                  onClick={() => accept(i)}
                  className={styles.option}
                >
                  {item.preview && (
                    <span aria-hidden="true" className={styles.preview}>
                      {item.preview}
                    </span>
                  )}
                  <span className={styles.label} data-completion-label>
                    {named ? (
                      <span className={styles.name}>{item.label}</span>
                    ) : (
                      item.label
                    )}
                    {item.detail && (
                      <small
                        aria-hidden={compact || undefined}
                        data-recipient-key={
                          (mention && /^[0-9a-f]{64}$/.test(item.detail)) ||
                          undefined
                        }
                        title={mention ? item.detail : undefined}
                      >
                        {item.detail}
                      </small>
                    )}
                  </span>
                  {channel && i === selectedIndex && (
                    <span aria-hidden="true" className={styles.acceptKey}>
                      Enter
                    </span>
                  )}
                </div>
              ))}
              {result?.retry && (
                // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
                <div
                  role="option"
                  tabIndex={-1}
                  id={`${id}-${items.length}`}
                  aria-selected={selectedIndex === items.length}
                  className={styles.option}
                  onPointerDown={(event) => {
                    if (event.button === 0) event.preventDefault();
                  }}
                  onPointerMove={
                    compact || named
                      ? () => {
                          revealSelection.current = false;
                          setSelected(RETRY);
                        }
                      : undefined
                  }
                  onClick={() => accept(items.length)}
                >
                  Retry suggestions
                </div>
              )}
            </div>
            {status && <p role="status">{status}</p>}
          </section>,
          // A body sibling would sit behind a fullscreen modal and outside its
          // accessibility boundary. Ordinary composers keep the body portal.
          input.current.closest('[role="dialog"][aria-modal="true"]') ??
            input.current.ownerDocument.body,
        )}
    </>
  );
}
