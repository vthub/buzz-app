import { ChatCircleIcon, CircleNotchIcon, LinkIcon } from "../icons/index";
import { useSyncExternalStore } from "react";

import type { ChipAddress, ChipKind } from "../chips/address";
import {
  CHIP_KIND_TRIGGER,
  type ChipFace,
  chipFaces,
} from "../chips/faceResolver";

import { PreviewCard } from "./PreviewCard";

/**
 * A reference to a person, agent, channel, message, or link, shown inline in a
 * sentence. A resolved chip composes PreviewCard; `onActivate` is reserved for
 * a surface that owns an explicit persistent view.
 */

const KIND_ICON: Partial<Record<ChipKind, typeof LinkIcon>> = {
  message: ChatCircleIcon,
  link: LinkIcon,
};

/** Subscribes to face changes so a rename repaints without a document edit. */
function useChipFace(address: ChipAddress, face?: ChipFace): ChipFace {
  return useSyncExternalStore(
    (listener) => (face ? () => {} : chipFaces.subscribe(listener)),
    () => face ?? chipFaces.get(address),
    () => face ?? chipFaces.get(address),
  );
}

export function InlineChip({
  address,
  face: suppliedFace,
  qualifier,
  interactive = true,
  onActivate,
}: {
  address: ChipAddress;
  /** Scoped display data supplied by a host that already owns identity lookup. */
  face?: ChipFace;
  /** Optional host-owned distinction; never part of the address or authored name. */
  qualifier?:
    | { text: string; accessibleLabel: string; reveal?: boolean }
    | undefined;
  /**
   * An inert rendering for places where even a preview would compete with the
   * surrounding interaction, such as a future editable document boundary.
   */
  interactive?: boolean;
  /** An explicit owner-provided action; previews never imply a deep-open. */
  onActivate?: (address: ChipAddress) => void;
}) {
  const face = useChipFace(address, suppliedFace);
  const Icon = KIND_ICON[address.kind];
  const trigger = CHIP_KIND_TRIGGER[address.kind];
  const kind = accessibleKind(address.kind);

  const content = (
    <>
      {Icon ? <Icon className="inline-chip-icon" aria-hidden="true" /> : null}
      <span className="inline-chip-label">
        {trigger ? (
          // While the face resolves, a spinner borrows the sigil's box: the
          // glyph stays in the flow (painted transparent) so nothing shifts
          // when it returns. A kind without a sigil carries its icon instead.
          <span
            className="inline-chip-trigger"
            data-loading={face.loading || undefined}
          >
            {trigger}
            {face.loading ? (
              <CircleNotchIcon
                className="inline-chip-spinner"
                aria-hidden="true"
              />
            ) : null}
          </span>
        ) : null}
        {face.label}
      </span>
      {qualifier ? (
        <span
          className="inline-chip-qualifier"
          data-reveal={qualifier.reveal || undefined}
        >
          <span>{` ${qualifier.text}`}</span>
        </span>
      ) : null}
    </>
  );

  const accessibleName = face.loading
    ? `Resolving mention ${face.label}`
    : face.resolved
      ? `${kind} ${face.label}${qualifier ? `, ${qualifier.accessibleLabel}` : ""}`
      : `Unresolved ${kind.toLowerCase()}`;
  const state = face.loading
    ? "loading"
    : face.resolved
      ? "resolved"
      : "unresolved";

  // An unresolved or still-resolving reference has nothing truthful to preview
  // or open. A chip that invites an action and does nothing is worse than an
  // inert reference.
  if (!interactive || !face.resolved || face.loading) {
    return (
      <span
        data-buzz-ui=""
        className="inline-chip"
        data-kind={address.kind}
        data-state={state}
        aria-label={accessibleName}
        aria-busy={face.loading || undefined}
        role="img"
      >
        {content}
      </span>
    );
  }

  return (
    <PreviewCard
      trigger={
        <button
          type="button"
          data-buzz-ui=""
          className="inline-chip"
          data-kind={address.kind}
          data-state={state}
          aria-label={accessibleName}
          onClick={() => onActivate?.(address)}
        >
          {content}
        </button>
      }
    >
      <span className="buzz-preview-card-kind text-body-sm text-tertiary">
        {kind}
      </span>
      <span className="buzz-preview-card-name text-body text-primary">
        {face.label}
      </span>
      {face.status ? (
        <span className="text-body-sm text-secondary">{face.status}</span>
      ) : null}
    </PreviewCard>
  );
}

function accessibleKind(kind: ChipKind): string {
  if (kind === "channel") return "Channel";
  if (kind === "agent") return "Agent";
  if (kind === "message") return "Message";
  if (kind === "link") return "Link";
  return "Person";
}
