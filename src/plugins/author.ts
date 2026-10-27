// FOUNDATION: Type-only author entry. Runtime capabilities come from injected ctx.
export type { PluginManifest, PluginModule } from "./api";
export type { SettingsCard, SettingsCards } from "../features/settings/service";
export type { Context } from "@deepseek-ai/cordis";
export type { Host, HostRequest, HostResponse } from "../features/host/service";
export type {
  IdentityNames,
  NamingPolicy,
} from "../features/identity-names/service";
export type { NamingIdentity } from "../features/identity-names/policy";
export type { Browser, BrowserViewProps } from "../features/browser/api";
export type { Page, PageSidebarProps, Pages } from "../features/pages/service";
export type {
  SidebarSectionAction,
  SidebarSectionContribution,
  SidebarSectionRow,
  SidebarSections,
} from "../features/channel-navigation/sidebar-sections-service";
export type {
  Panel,
  Panels,
  ChannelPanelContext,
  ChannelLauncherProps,
} from "../features/panels/service";
export type { Conversation } from "../features/conversation/service";
export type {
  ComposerObservation,
  CompletionContext,
  CompletionQuery,
  CompletionEdit,
  CompletionSuggestion,
  CompletionResult,
  ComposerCompletionProps,
  ComposerCompletion,
  ComposerAccessory,
  ComposerAccessoryProps,
  ComposerResource,
  ComposerCaptureProps,
  AttachmentRenderer,
  AttachmentRendererProps,
  ComposerToolProps,
  ComposerTool,
  InlineContent,
  InlineRange,
  InlineRenderer,
  LinkRenderer,
  MessageRenderer,
  MessageAction,
  TargetOpener,
} from "../features/conversation/contracts";
export type { RelayData, RelaySnapshot } from "../features/relay/service";
export type {
  ArtifactSyncFilter,
  ArtifactSyncSnapshot,
  ArtifactSyncStatus,
  ArtifactSyncView,
} from "../features/relay/artifact-sync";

export type {
  Shortcuts,
  Shortcut,
  KeyBinding,
  RegisteredShortcut,
} from "../features/shortcuts/service";

export type {
  UnreadCapability,
  UnreadSnapshot,
  ThreadActivityItem,
  ThreadActivitySnapshot,
  ReadingHandle,
} from "../features/relay/unread";
export type { ReadTarget } from "../features/relay/read-state-model";
export type {
  ReadMutationResult,
  ReadSyncSnapshot,
} from "../features/relay/read-state";

export type {
  Decisions,
  DecisionProvider,
  DecisionProviderStatus,
  DecisionReply,
  DecisionQuestion,
  DecisionRequest,
  DecisionAnswer,
  DecisionFailure,
  DecisionResult,
} from "../features/decisions/service";

export type {
  Navigation,
  NavigationSnapshot,
  OpenResult,
  OpenFailure,
} from "../features/navigation/controller";
export type {
  OpenTarget,
  NavigationScope,
  JsonValue,
} from "../features/navigation/targets";
export type { PageNavigation } from "../features/navigation/service";

export type {
  Notifications,
  NotificationInput,
  NotificationCategoryDescriptor,
} from "../features/notifications/service";

export type { VoiceRecording } from "../features/relay/voice-media";

export type {
  Agents,
  AgentType,
  AgentSession,
  AgentSessions,
} from "../features/agents/service";

export type {
  SoloNavigation,
  SoloRegionBinding,
  SoloRegionSnapshot,
  SoloRegionAction,
  SoloRegionSource,
  SoloChatInput,
  SoloRegionHandle,
  SoloRegionProps,
  SoloConversationProps,
  SoloConversation,
  SoloConversationLinkProps,
  SoloCardProps,
  SoloDisclosureProps,
} from "../features/channel-navigation/solo-navigation-contract";
