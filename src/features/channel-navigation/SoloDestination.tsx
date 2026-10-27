import {
  Children,
  type RefObject,
  type FocusEvent,
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { ChatActionsMenu } from "../../bundled/channels/SoloWorkspaces";
import { SoloChatMenuItems } from "../../bundled/channels/SoloChatMenu";
import { SoloChatName } from "../../bundled/channels/SoloChatName";
import { UnreadBadge } from "../../bundled/channels/UnreadBadge";
import { ChannelMembersDialog } from "../../bundled/channels/ChannelMembersDialog";
import { WorkspaceSettings } from "../solo/WorkspaceSettings";
import { useChannelNavigation } from "./ChannelNavigationState";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuIcon,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { Navigation } from "../navigation/controller";
import type { RelaySession } from "../relay/session";
import { conversationTarget } from "./routes";
import type { SoloRegion } from "./solo-navigation-model";
import type { SoloDestinationProps } from "./solo-navigation-contract";
import {
  CheckCircleIcon,
  WarningCircleIcon,
  ClockIcon,
  CircleNotchIcon,
  XCircleIcon,
} from "../../shared/design-system/icons";
import { SoloDisclosure } from "./SoloDisclosure";
import rowStyles from "../../bundled/channels/SoloWorkspaces.module.css";
import styles from "./SoloDestination.module.css";

export const RegionDestinationContext = createContext<
  | {
      region: SoloRegion;
      session: RelaySession;
      navigator: Navigation;
      scope: string;
      current: string | undefined;
      active(): boolean;
      retryReveal(): void;
    }
  | undefined
>(undefined);

/** Stable component identity: a source update never remounts every destination. */
export function RegionDestination(props: SoloDestinationProps) {
  const context = useContext(RegionDestinationContext);
  const handoff = useChannelNavigation();
  const root = useRef<HTMLDivElement>(null);
  const childrenId = useId();
  const restoreRename = useRef(false);
  const channel = context?.region.channels.find(
    (channel) => channel.id === props.channelId,
  );
  const visible = !!channel && !!context?.region.live.has(channel.id);
  const [dialog, setDialog] = useState<"rename" | "settings" | "share">();
  const [error, setError] = useState<string>();
  const focusProps = useDestinationFocus(root, props.channelId, visible);
  useLayoutEffect(() => {
    if (context?.current === props.channelId) context.retryReveal();
    if (restoreRename.current) {
      restoreRename.current = false;
      root.current
        ?.querySelector<HTMLElement>("[data-solo-destination-id]")
        ?.focus();
    }
  });
  if (!context || !channel || !visible) return null;
  const { session, navigator, scope, current, active } = context;
  const selected = current === channel.id;
  const expanded = !props.indent || selected;
  const StatusIcon =
    props.status === "needs-you"
      ? WarningCircleIcon
      : props.status === "running"
        ? CircleNotchIcon
        : props.status === "failed"
          ? XCircleIcon
          : props.status === "done"
            ? CheckCircleIcon
            : ClockIcon;
  const statusLabel =
    props.status === "needs-you"
      ? "Needs you"
      : props.status === "running"
        ? "Running"
        : props.status === "failed"
          ? "Failed"
          : props.status === "done"
            ? "Done"
            : props.status === "waiting"
              ? "Waiting"
              : "Scheduled";
  const menu = (
    <>
      <SoloChatMenuItems
        session={session}
        channel={channel}
        onShare={() => active() && setDialog("share")}
        onSettings={() => active() && setDialog("settings")}
        onReadResult={setError}
        onLifecycle={
          handoff
            ? (action) => {
                if (active())
                  handoff.openLifecycle(
                    channel,
                    action,
                    root.current?.querySelector<HTMLElement>(
                      "[data-solo-destination-id]",
                    ) ?? undefined,
                  );
              }
            : undefined
        }
      />
      {!!props.menuActions?.length && (
        <>
          <MenuSeparator />
          <MenuGroup>
            {props.menuActions.slice(0, 6).map((action) => (
              <MenuItem
                key={action.id}
                onClick={() => {
                  if (!active()) return;
                  try {
                    void Promise.resolve(action.onSelect()).catch(() => {
                      if (active()) setError("The action could not run.");
                    });
                  } catch {
                    setError("The action could not run.");
                  }
                }}
              >
                <MenuIcon>{action.icon}</MenuIcon>
                {action.label}
              </MenuItem>
            ))}
          </MenuGroup>
        </>
      )}
    </>
  );
  const leadingDisclosure = props.disclosure?.placement === "leading";
  const trailingDisclosure = props.disclosure?.placement === "trailing";
  const rowDisclosure = leadingDisclosure || trailingDisclosure;
  const supporting = props.supporting ?? channel.preview;
  const disclosure = props.disclosure && (
    <SoloDisclosure
      label={props.disclosure.label}
      summary={rowDisclosure ? "" : props.disclosure.summary}
      expanded={props.disclosure.expanded}
      controls={childrenId}
      onToggle={() => {
        if (active()) props.disclosure?.onToggle();
      }}
    />
  );
  const status = props.status && (
    <span
      id={`${childrenId}-status`}
      className={styles.status}
      role="img"
      data-status={props.status}
      title={statusLabel}
      aria-label={statusLabel}
    >
      <StatusIcon size={props.indent ? 12 : 14} />
      {props.indent && selected ? statusLabel : null}
    </span>
  );
  const unread = <UnreadBadge session={session} channelId={channel.id} />;
  const destination = (
    <NavigationItem
      data-solo-destination-id={channel.id}
      aria-describedby={
        trailingDisclosure && status ? `${childrenId}-status` : undefined
      }
      label={
        <span className={styles.label}>
          <span
            className={`${styles.heading} ${props.indent ? "text-caption" : props.cardTone === "inset" ? "text-label" : "text-body-sm"}`}
            data-worker={!!props.indent || undefined}
            data-compact={!expanded || undefined}
          >
            <span className={styles.title}>{props.label ?? channel.name}</span>{" "}
            {!trailingDisclosure && status}
          </span>{" "}
          {!trailingDisclosure && expanded && supporting && (
            <span
              className={`${styles.supporting} ${props.cardTone === "inset" && !props.indent ? "text-body-sm" : "text-caption"} text-metadata`}
            >
              {supporting}
            </span>
          )}
        </span>
      }
      icon={props.leading}
      trailing={
        <>
          {props.trailing}
          {trailingDisclosure ? null : props.indent ? (
            <span className="sr-only">{unread}</span>
          ) : (
            unread
          )}
        </>
      }
      selected={current === channel.id}
      multiline={expanded && (!!props.supporting || props.variant === "card")}
      onDoubleClick={() => {
        if (
          !trailingDisclosure &&
          active() &&
          session.channelDetails.available &&
          !channel.readOnly
        )
          setDialog("rename");
      }}
      onClick={() => {
        if (active())
          void navigator.open(conversationTarget(scope, channel.id));
      }}
    />
  );
  const row = (
    <ChatActionsMenu
      id={channel.id}
      title={channel.name}
      className={`${rowStyles.organizedRow} ${props.variant === "card" ? styles.cardRow : ""} ${trailingDisclosure ? styles.trailingRow : ""}`}
      enabled={!channel.cached}
      content={menu}
    >
      {leadingDisclosure ? (
        <div className={styles.leadingRow}>
          {disclosure}
          {destination}
        </div>
      ) : trailingDisclosure ? (
        <span className={styles.projectHeading}>
          {destination}
          {disclosure}
          <span className={styles.projectIndicators}>
            {status}
            {unread}
          </span>
        </span>
      ) : (
        destination
      )}
      {trailingDisclosure && supporting && (
        <NavigationItem
          data-solo-project-supporting=""
          aria-label={`Open ${props.label ?? channel.name}: ${supporting}`}
          label={
            <span className={`${styles.supporting} text-body-sm text-metadata`}>
              {supporting}
            </span>
          }
          onClick={() => {
            if (active())
              void navigator.open(conversationTarget(scope, channel.id));
          }}
        />
      )}
    </ChatActionsMenu>
  );
  return (
    <div
      ref={root}
      data-solo-destination-root={channel.id}
      {...focusProps}
      className={`${styles.destination} ${rowStyles.sidebarContents}`}
      data-indent={props.indent ?? 0}
    >
      {dialog === "rename" ? (
        <SoloChatName
          session={session}
          id={channel.id}
          title={channel.name}
          close={(restore) => {
            restoreRename.current = restore;
            setDialog(undefined);
          }}
        />
      ) : props.variant === "card" ? (
        <NavigationCard
          tone={props.cardTone ?? "tonal"}
          data-drop-target={props.dropTarget || undefined}
          footer={
            ((expanded && props.details) ||
              props.footer ||
              (props.disclosure && !rowDisclosure)) && (
              <ContextMenuRoot
                onOpenChange={(open, event) => {
                  if (open && channel.cached) event.cancel();
                }}
              >
                <ContextMenuTrigger render={<div />}>
                  {expanded && props.details}
                  {props.footer}
                  {props.disclosure && !rowDisclosure && (
                    <div className={styles.workerHeading}>
                      {disclosure}
                      {!!props.disclosure.avatars?.length && (
                        <span className={styles.workerAvatars}>
                          {Children.map(
                            props.disclosure.avatars.slice(0, 4),
                            (avatar) => (
                              <span>{avatar}</span>
                            ),
                          )}
                          {props.disclosure.avatars.length > 4 && (
                            <span className="text-caption text-metadata">
                              +{props.disclosure.avatars.length - 4}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </ContextMenuTrigger>
                <MenuPopup
                  aria-label={`Actions for ${channel.name}`}
                  finalFocus={() =>
                    root.current?.querySelector<HTMLElement>(
                      "[data-solo-destination-id]",
                    ) ?? false
                  }
                >
                  {menu}
                </MenuPopup>
              </ContextMenuRoot>
            )
          }
          body={
            props.disclosure ? (
              <div
                className={styles.children}
                id={childrenId}
                hidden={!props.children}
              >
                {props.children}
              </div>
            ) : (
              props.children
            )
          }
        >
          {row}
        </NavigationCard>
      ) : (
        <>
          {row}
          {props.details}
          {props.footer}
          {props.children}
        </>
      )}
      {dialog === "settings" && (
        <WorkspaceSettings
          session={session}
          scope={scope}
          target={{ kind: "chat", id: channel.id, name: channel.name }}
          close={() => setDialog(undefined)}
        />
      )}
      {dialog === "share" && (
        <ChannelMembersDialog
          session={session}
          channelId={channel.id}
          trigger={root}
          navigator={navigator}
          close={() => setDialog(undefined)}
        />
      )}
      {error && (
        <ToastNotice title={error} onDismiss={() => setError(undefined)} />
      )}
    </div>
  );
}

/** Recovery rows use the same focus contract without source actions. */
export function RecoveryDestination({ channelId }: { channelId: string }) {
  const context = useContext(RegionDestinationContext);
  const root = useRef<HTMLDivElement>(null);
  const focusProps = useDestinationFocus(root, channelId, true);
  useLayoutEffect(() => {
    if (context?.current === channelId) context.retryReveal();
  });
  const channel = context?.region.channels.find(
    (channel) => channel.id === channelId,
  );
  if (!context || !channel) return null;
  return (
    <div ref={root} data-solo-destination-root={channelId} {...focusProps}>
      <NavigationItem
        data-solo-destination-id={channelId}
        label={channel.name}
        selected={context.current === channelId}
        trailing={
          <UnreadBadge session={context.session} channelId={channelId} />
        }
        onClick={() => {
          void context.navigator.open(
            conversationTarget(context.scope, channelId),
          );
        }}
      />
    </div>
  );
}

function useDestinationFocus(
  root: RefObject<HTMLDivElement | null>,
  channelId: string,
  visible: boolean,
) {
  const focused = useRef(false);
  const neighbors = useRef<string[]>([]);
  useLayoutEffect(() => {
    if (!focused.current) return;
    const region = root.current?.closest("[data-sidebar-section]");
    if (region)
      neighbors.current = [
        ...region.querySelectorAll<HTMLElement>("[data-solo-destination-id]"),
      ].map((row) => row.dataset.soloDestinationId ?? "");
  });
  useLayoutEffect(() => {
    if (!visible) return;
    const node = root.current;
    const region = node?.closest("[data-sidebar-section]");
    return () => {
      const owner = document.activeElement?.closest(
        "[data-solo-destination-root]",
      );
      if (!node || (owner ? owner !== node : !focused.current)) return;
      const rows = neighbors.current;
      const index = rows.indexOf(channelId);
      const ids = [
        channelId,
        ...rows.slice(index + 1),
        ...rows.slice(0, index).reverse(),
      ];
      queueMicrotask(() => {
        if (document.activeElement !== document.body) return;
        const remaining = ids
          .map(
            (id) =>
              id &&
              document.querySelector<HTMLElement>(
                `[data-solo-destination-id="${CSS.escape(id)}"]`,
              ),
          )
          .find(Boolean);
        (
          remaining ||
          document.querySelector<HTMLElement>(
            `[data-sidebar-section="${CSS.escape(region?.getAttribute("data-sidebar-section") ?? "")}"] summary`,
          ) ||
          document.querySelector<HTMLElement>("[data-solo-heading]")
        )?.focus();
      });
    };
  }, [root, channelId, visible]);
  return {
    onFocusCapture() {
      focused.current = true;
      const region = root.current?.closest("[data-sidebar-section]");
      if (region)
        neighbors.current = [
          ...region.querySelectorAll<HTMLElement>("[data-solo-destination-id]"),
        ].map((row) => row.dataset.soloDestinationId ?? "");
    },
    onBlurCapture(event: FocusEvent<HTMLDivElement>) {
      if (
        event.relatedTarget &&
        event.relatedTarget !== document.body &&
        !event.currentTarget.contains(event.relatedTarget as Node)
      )
        focused.current = false;
    },
  };
}
