// FOUNDATION: Public Solo region contract. Ownership stays label-based and host-enforced.
import type { ComponentType, ReactElement, ReactNode } from "react";
import type { JsonValue } from "../navigation/targets";

export type SoloRegionBinding = Readonly<{
  scope: string;
  viewer: string;
  incarnation: string;
}>;
export type SoloRegionSnapshot = Readonly<{
  status: "loading" | "ready" | "unavailable";
  binding: SoloRegionBinding;
  revision: number;
  model?: unknown;
  notice?: string;
}>;
export type SoloRegionAction = Readonly<{
  id: string;
  label: string;
  icon: ReactElement | "plus" | "view";
  onSelect: () => void | Promise<void>;
  menu?: () => readonly Readonly<{
    id: string;
    label: string;
    checked?: boolean;
    group?: string;
    onSelect: () => void | Promise<void>;
  }>[];
}>;
export type SoloRegionSource = Readonly<{
  id: string;
  title: string;
  icon: ReactNode;
  order?: number;
  bind(binding: SoloRegionBinding, signal: AbortSignal): void;
  subscribe(listener: () => void): () => void;
  read(binding: SoloRegionBinding): SoloRegionSnapshot;
  component: ComponentType<SoloRegionProps>;
  actions?: (binding: SoloRegionBinding) => readonly SoloRegionAction[];
}>;
export type SoloChatInput = Readonly<{
  channelId: string;
  title: string;
  members: readonly string[];
  named?: boolean;
  ttlSeconds?: number;
}>;
export type SoloRegionHandle = Readonly<{
  label: string;
  createChat(binding: SoloRegionBinding, input: SoloChatInput): Promise<void>;
  classify(binding: SoloRegionBinding, channelId: string): Promise<void>;
}>;
export type SoloRegionProps = Readonly<{
  binding: SoloRegionBinding;
  snapshot: SoloRegionSnapshot & Readonly<{ status: "ready" }>;
  live: ReadonlySet<string>;
  current?: string;
  revealRequests: Readonly<{
    subscribe(listener: (channelId: string) => void): () => void;
  }>;
  state: Readonly<{
    get(): JsonValue | undefined;
    set(value: JsonValue): boolean;
  }>;
  ui: Readonly<{
    Conversation: ComponentType<SoloConversationProps>;
    Card: ComponentType<SoloCardProps>;
    Disclosure: ComponentType<SoloDisclosureProps>;
  }>;
}>;
/** Host conversation behavior. The source composes the presentation from its parts. */
export type SoloConversationProps = Readonly<{
  channelId: string;
  menuActions?: readonly SoloRegionAction[];
  /** Not called for a conversation outside this region. Renaming replaces it with the host editor. */
  children(conversation: SoloConversation): ReactNode;
}>;
export type SoloConversation = Readonly<{
  name: string;
  preview?: string;
  selected: boolean;
  /** Bound to this conversation. Put one primary Link and Actions inside Menu. */
  Link: ComponentType<SoloConversationLinkProps>;
  /** Context menu region with the standard chat actions and menuActions. */
  Menu: ComponentType<Readonly<{ children: ReactNode }>>;
  /** The overflow menu button. Pointer devices show it only while the Menu is active. */
  Actions: ComponentType;
  /** Shows content only at rest, or only while the Menu is hovered, focused, or open. Hidden content keeps its space. */
  Reveal: ComponentType<
    Readonly<{ on: "rest" | "active"; children: ReactNode }>
  >;
  Unread: ComponentType;
}>;
export type SoloConversationLinkProps = Readonly<{
  label: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  multiline?: boolean;
  /** Navigates without focus identity, current state or rename. */
  secondary?: boolean;
  /** Double-click renames the primary link unless false. */
  rename?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
}>;
/** The shared navigation card; it owns hover, selection and drag-target paint. */
export type SoloCardProps = Readonly<{
  tone?: "default" | "tonal" | "inset";
  dropTarget?: boolean;
  footer?: ReactNode;
  body?: ReactNode;
  children: ReactNode;
}>;
export type SoloDisclosureProps = Readonly<{
  label: string;
  summary: string;
  expanded: boolean;
  controls: string;
  onToggle(): void;
}>;
export type SoloNavigation = Readonly<{
  version: 2;
  registerSource(source: SoloRegionSource): SoloRegionHandle;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    soloNavigation?: SoloNavigation;
  }
}
