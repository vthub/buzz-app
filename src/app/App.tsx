// FOUNDATION: Startup, navigation, contributed pages, and built-in Settings.
import { AgentAvatarArtworkProvider } from "../features/agents/AgentAvatarArtworkProvider";
import { Welcome } from "../features/identity/Welcome";
import { NewMenu } from "./shell/NewMenu";
import { PrimarySidebar } from "./shell/PrimarySidebar";
import { ChannelNavigationProvider } from "../features/channel-navigation/ChannelNavigationState";
import { AgentsContext } from "../features/agents/react";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { ModalWindowDragProvider } from "../shared/design-system/ui/ModalWindowDrag";
import { modalWindowDragHandlers } from "./shell/title-bar";
import { isTauri } from "@tauri-apps/api/core";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { UpdateNotice } from "../features/updates/UpdateNotice";
import { CreationReview } from "../bundled/agents/CreationReview";
import { UpdateReview } from "../bundled/agents/UpdateReview";
import { InterruptedNotice } from "../features/agents/InterruptedNotice";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { registerAppShortcuts } from "./shortcuts";
import type { AppServices } from "./services";
import { Settings } from "./Settings";
import { SettingsSidebar } from "./SettingsSidebar";
import { RecoveryScreen } from "./RecoveryScreen";
import { PageView } from "../features/pages/PageView";
import { OwnedContribution } from "../plugins/OwnedContribution";
import { SidebarFrame } from "../features/channel-navigation/SidebarFrame";
import { SidebarList } from "../features/channel-navigation/SidebarList";
import { useAppNavigation, type PendingSettingsDeparture } from "./navigation";
import { NavigationControls } from "./shell/NavigationControls";
import { registerNavigationShortcuts } from "./shortcuts";
import { AppShell } from "./shell/AppShell";
import {
  LaunchWindowControls,
  LoadingWindowHeader,
} from "./shell/LaunchWindowControls";
import { pagePresentation, shellPresentation } from "./shell/presentation";
import { usePanelLauncher } from "./shell/usePanelLauncher";
import { PanelLaunchers } from "./shell/PanelLaunchers";
import { PanelCard } from "../features/panels/PanelCard";
import { communityDestination } from "../features/communities/destination";
import { CommunityLanding } from "../features/communities/CommunityLanding";
import { launchVisible, setLaunchReady, subscribeLaunch } from "./launch";

export function App({ services }: { services: AppServices }) {
  const identity = services.identity;
  useEffect(() => {
    if (!identity) return;
    const update = () => {
      const status = identity.snapshot().status;
      if (status === "missing" || status === "error") setLaunchReady(true);
      else if (status === "loading") setLaunchReady(false);
    };
    update();
    return identity.subscribe(update);
  }, [identity]);
  return (
    <AgentAvatarArtworkProvider>
      <ModalWindowDragProvider
        value={isTauri() ? modalWindowDragHandlers : undefined}
      >
        <LaunchWindowControls />
        {services.identity ? (
          <Welcome
            identity={services.identity}
            communities={services.communities}
            invites={services.invites}
          >
            <ConnectedApp services={services} />
          </Welcome>
        ) : (
          <ConnectedApp services={services} />
        )}
      </ModalWindowDragProvider>
    </AgentAvatarArtworkProvider>
  );
}

function ConnectedApp({ services }: { services: AppServices }) {
  const { plugins } = services;
  const [workspaceElement, setWorkspaceElement] =
    useState<HTMLDivElement | null>(null);
  const startup = useSyncExternalStore(plugins.subscribe, plugins.startup);
  const launching = useSyncExternalStore(subscribeLaunch, launchVisible);
  // Unsaved Profile edits turn a Settings dismissal into a discard prompt.
  const [settingsUnsaved, setSettingsUnsaved] = useState(false);
  const [confirmSettingsDiscard, setConfirmSettingsDiscard] = useState(false);
  const [departure, setDeparture] = useState<PendingSettingsDeparture | null>(
    null,
  );
  const route = useAppNavigation(services, departure);
  const launcher = usePanelLauncher(services.panels, startup === "ready");
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const invite = useSyncExternalStore(
    services.invites.subscribe,
    services.invites.snapshot,
  );
  // A queued link cannot be presented under a different identity.
  useEffect(() => {
    if (invite && client.viewer && invite.viewer !== client.viewer)
      services.invites.clear();
  }, [invite, client.viewer, services.invites]);
  const connection = useSyncExternalStore(
    services.relay.subscribe,
    services.relay.snapshot,
  );
  const restoring = client.status === "loading" || !!connection.restoring;
  const settings = route.target.kind === "settings";
  // Someone without a community starts by joining one. Having had one this
  // run keeps the shell; Personal space with memberships is unchanged.
  const [hadCommunity, setHadCommunity] = useState(false);
  if (!hadCommunity && client.memberships.length > 0) setHadCommunity(true);
  const firstRun =
    !settings &&
    !hadCommunity &&
    startup !== "recovery" &&
    client.status === "ready" &&
    client.relayAvailable &&
    client.memberships.length === 0;
  // The prompt is stale once Settings ends another way or nothing is left to
  // discard, such as when a pending save is sent behind it.
  if (confirmSettingsDiscard && (!settings || !settingsUnsaved))
    setConfirmSettingsDiscard(false);
  const settingsFocus = useRef<HTMLElement | null>(null);
  const wasSettings = useRef(false);
  const workspaceEntry = useRef<string | undefined>(undefined);
  const settingsReturnEntry = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!settings) workspaceEntry.current = route.state.entry.id;
    else if (!wasSettings.current)
      settingsReturnEntry.current = workspaceEntry.current;
    wasSettings.current = settings;
  }, [settings, route.state.entry.id]);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (
        !wasSettings.current &&
        event.target instanceof HTMLElement &&
        !event.target.closest('[role="menu"], [role="dialog"]')
      )
        settingsFocus.current = event.target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);
  const retryFocus = useRef<string | undefined>(undefined);
  // A passive effect runs after the destination's own mount focus, so this
  // only fills in when focus would otherwise be left on the body.
  useEffect(() => {
    if (!retryFocus.current) return;
    if (retryFocus.current === route.state.attempt.id && !settings && restoring)
      return;
    if (
      retryFocus.current === route.state.attempt.id &&
      document.activeElement === document.body
    )
      document
        .getElementById(settings ? "settings-content" : "main-content")
        ?.focus({ preventScroll: true });
    retryFocus.current = undefined;
  }, [restoring, settings, route.state.attempt]);
  useEffect(() => {
    if (
      departure &&
      (departure.attempt !== route.state.attempt ||
        departure.viewer !== client.viewer ||
        (client.selected !== null && client.selected !== departure.communityId))
    )
      setDeparture(null);
  }, [client.selected, client.viewer, departure, route.state.attempt]);
  const terminal =
    startup === "recovery" ||
    route.state.status === "failed" ||
    (!route.state.ingress && !!route.failure);
  const launchReady =
    settings ||
    terminal ||
    firstRun ||
    (!restoring && startup !== "loading" && !route.waiting);
  useEffect(
    () => setLaunchReady(launchReady, terminal),
    [launchReady, terminal],
  );
  const select = route.select;
  useEffect(
    () =>
      registerAppShortcuts(
        services.shortcuts,
        services.appearance,
        () => {
          void services.navigation.open({ version: 1, kind: "settings" });
        },
        true,
      ),
    [services],
  );
  useEffect(
    () => registerNavigationShortcuts(services.shortcuts, services.navigation),
    [services],
  );
  const workspace = route.workspace;
  const presentation = workspace.page
    ? pagePresentation(workspace.page)
    : shellPresentation.settings;
  const selectedPanel = launcher.selected;
  const companion = selectedPanel && (
    <PanelCard
      key={launcher.openingId}
      ref={launcher.panelRef}
      panel={selectedPanel}
      target={launcher.target ?? ""}
      close={launcher.close}
    />
  );
  const pageOwnsCompanion =
    !!workspace.page?.companion &&
    (settings
      ? !!workspace.request
      : !route.failure && !route.waiting && route.state.status !== "failed");
  // A registration lookup does not admit the target's parameters and scope.
  const pageSidebarReady =
    startup === "ready" &&
    (settings
      ? !!workspace.request
      : !route.failure && !route.waiting && route.state.status !== "failed");
  // Keep the parser launch surface through local bootstrap, not network refresh.
  if (!settings && restoring)
    return document.getElementById("buzz-launch") ? null : (
      <div className="buzz-launch" role="status" aria-label="Opening Buzz">
        <LoadingWindowHeader />
        <picture>
          <source
            media="(prefers-reduced-motion: reduce)"
            srcSet="/buzz-mark.svg"
          />
          <img src="/buzz-loading-mark.svg" alt="Buzz" width="72" height="72" />
        </picture>
      </div>
    );
  const selectCommunity = (id: string | null) => {
    const recovering =
      services.navigation.snapshot().ingress &&
      services.navigation.snapshot().retryable;
    services.communities.select(id);
    if (!recovering) select("buzz.channels/channels");
  };
  if (firstRun)
    return (
      <CommunityLanding
        communities={services.communities}
        invite={invite?.viewer === client.viewer ? invite : undefined}
        onInviteClose={services.invites.clear}
        settingsCards={services.settingsCards}
        onJoined={selectCommunity}
        onCreate={() =>
          void services.navigation.open({
            version: 1,
            kind: "settings",
            section: "block.hosted-communities/hosted",
          })
        }
      />
    );
  const openSettingsSection = (section: string) => {
    const client = services.communities.snapshot();
    void services.navigation.open({
      version: 1,
      kind: "settings",
      section,
      ...(client.viewer && client.selected
        ? {
            scope: {
              viewer: client.viewer,
              communityOrigin: communityDestination(client.selected).url,
            },
          }
        : { scope: null }),
    });
  };
  const destinationFailure = (
    <div role="alert" className="notice">
      <h1>This destination couldn’t open</h1>
      <p>
        {(route.state.reason ?? route.failure) === "denied"
          ? "This target needs its original account and an already joined community."
          : route.state.ingress && !route.state.retryable
            ? "This link is invalid or unsupported."
            : "The destination is unavailable or isn’t supported yet. Your target has been kept for retry."}
      </p>
      {(!route.state.ingress || route.state.retryable) && (
        <Button
          type="button"
          onClick={(event) => {
            const focused = event.currentTarget === document.activeElement;
            const before = services.navigation.snapshot().attempt.id;
            route.retry();
            // Retry can remove this control and briefly unmount the
            // shell; hand focus to main only once it has fallen away.
            const after = services.navigation.snapshot().attempt.id;
            retryFocus.current =
              focused && after !== before ? after : undefined;
          }}
        >
          Retry navigation
        </Button>
      )}
      {!settings && (
        <Button type="button" onClick={() => select("settings")}>
          Open Settings
        </Button>
      )}
    </div>
  );
  return (
    <ToastProvider
      portalContainer={document.getElementById("buzz-toast-root") ?? undefined}
    >
      <ChannelNavigationProvider relay={services.relay}>
        <AgentsContext.Provider value={services.agents}>
          <AppShell
            creationAction={
              <NewMenu
                relay={services.relay}
                navigator={services.navigation}
                agents={services.agents}
              />
            }
            workspaceRef={setWorkspaceElement}
            sidebar={(pageNavigation) =>
              workspace.page?.sidebar && pageSidebarReady ? (
                <OwnedContribution
                  entry={workspace.page}
                  registry={services.pages}
                  resetIdentity={workspace.request}
                  fallback={
                    <div className="shell-sidebar-default">
                      <SidebarFrame label={`${workspace.page.title} sidebar`}>
                        <SidebarList>
                          <p role="alert">
                            This page’s sidebar is unavailable.
                          </p>
                          {pageNavigation}
                        </SidebarList>
                      </SidebarFrame>
                    </div>
                  }
                >
                  {(entry) => {
                    const Sidebar = entry.sidebar;
                    return Sidebar ? (
                      <Sidebar target={workspace.target}>
                        {pageNavigation}
                      </Sidebar>
                    ) : null;
                  }}
                </OwnedContribution>
              ) : workspace.page?.sidebar ? (
                <div className="shell-sidebar-default">
                  <SidebarFrame label="Page navigation">
                    <SidebarList>{pageNavigation}</SidebarList>
                  </SidebarFrame>
                </div>
              ) : (
                <PrimarySidebar
                  relay={services.relay}
                  navigator={services.navigation}
                  agents={services.agents}
                  chatIcons={services.conversation.chatIcons}
                  chatMenus={services.conversation.chatMenus}
                  target={workspace.target}
                >
                  {pageNavigation}
                </PrimarySidebar>
              )
            }
            navigationControls={
              <NavigationControls navigation={services.navigation} />
            }
            onCommunitySelect={selectCommunity}
            // A scoped Settings target selects its community on the way.
            onOpenTarget={(target) => void services.navigation.open(target)}
            communities={services.communities}
            invite={invite?.viewer === client.viewer ? invite : undefined}
            onInviteClose={services.invites.clear}
            settingsCards={services.settingsCards}
            accountActions={services.accountActions}
            appearance={services.appearance}
            searchServices={services}
            launchers={
              <PanelLaunchers
                panels={launcher.available}
                selected={selectedPanel}
                launch={launcher.launch}
              />
            }
            companion={pageOwnsCompanion ? undefined : companion}
            pages={startup === "ready" ? route.pages : []}
            selected={workspace.selected}
            navigationAttempt={workspace.attempt}
            onSelect={select}
            tone={presentation.tone}
            workspace={
              startup === "ready" && workspace.page?.layout === "workspace"
            }
          >
            <UpdateNotice updates={services.updates} />
            <InterruptedNotice agents={services.agents} />
            <CreationReview agents={services.agents} />
            <UpdateReview agents={services.agents} />
            {!settings && startup === "recovery" ? (
              <RecoveryScreen plugins={plugins} />
            ) : !settings &&
              ((!route.state.ingress && route.failure) ||
                route.state.status === "failed") ? (
              destinationFailure
            ) : !settings && route.waiting ? (
              <p role="status">Opening destination…</p>
            ) : startup === "loading" || restoring ? (
              settings ? null : (
                <p role="status">Opening destination…</p>
              )
            ) : workspace.page ? (
              <PageView
                page={workspace.page}
                navigation={workspace.request}
                companion={pageOwnsCompanion ? companion : undefined}
                companionOpening={
                  pageOwnsCompanion ? launcher.opening : undefined
                }
              />
            ) : null}
          </AppShell>
          <Dialog
            // The inert launch surface would swallow the modal's initial focus.
            open={settings && !launching}
            title="Settings"
            closeLabel="Close Settings"
            size="expanded"
            container={workspaceElement}
            navigation={{
              label: "Settings sections",
              content: (
                <SettingsSidebar
                  cards={services.settingsCards}
                  communities={services.communities}
                  {...(route.target.kind === "settings" && route.target.section
                    ? { selected: route.target.section }
                    : {})}
                  onSection={openSettingsSection}
                />
              ),
            }}
            onOpenChange={(open) => {
              if (open) return;
              if (settingsUnsaved) setConfirmSettingsDiscard(true);
              else route.leaveSettings();
            }}
            initialFocus={() => {
              // A destination that already focused a setting keeps it.
              const active = document.activeElement;
              return active instanceof HTMLElement &&
                document.getElementById("settings-content")?.contains(active)
                ? active
                : true;
            }}
            finalFocus={() => {
              // Only a return to the visit Settings covered restores the prior
              // focus; a destination opened from Settings starts at main.
              const returning =
                services.navigation.snapshot().entry.id ===
                settingsReturnEntry.current;
              return returning &&
                settingsFocus.current?.isConnected &&
                settingsFocus.current !== document.body
                ? settingsFocus.current
                : (document.getElementById("main-content") ?? false);
            }}
          >
            <div id="settings-content" className="h-full" tabIndex={-1}>
              {(!route.state.ingress && route.failure) ||
              route.state.status === "failed" ? (
                destinationFailure
              ) : route.waiting ? (
                <p role="status">Opening destination…</p>
              ) : (
                <Settings
                  agents={services.agents}
                  decisions={services.decisions}
                  plugins={plugins}
                  cards={services.settingsCards}
                  adminAccess={services.adminAccess}
                  communities={services.communities}
                  identity={services.identity}
                  appearance={services.appearance}
                  shortcuts={services.shortcuts}
                  shortcutBindings={services.shortcutBindings}
                  notifications={services.notifications}
                  updates={services.updates}
                  navigation={route.request}
                  navigationPane
                  onDeparturePending={(pending) => {
                    const client = services.communities.snapshot();
                    const attempt = route.state.attempt;
                    if (pending && client.viewer && client.selected)
                      setDeparture({
                        attempt,
                        viewer: client.viewer,
                        communityId: client.selected,
                      });
                    else if (!pending)
                      setDeparture((current) =>
                        current?.attempt === attempt ? null : current,
                      );
                  }}
                  onSection={openSettingsSection}
                  onUnsavedChange={setSettingsUnsaved}
                />
              )}
            </div>
            {confirmSettingsDiscard && settings && settingsUnsaved && (
              <AlertDialog
                title="Discard changes?"
                description="Your profile has unsaved changes."
                onClose={() => setConfirmSettingsDiscard(false)}
                actions={
                  <>
                    <Button onClick={() => setConfirmSettingsDiscard(false)}>
                      Keep editing
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        setConfirmSettingsDiscard(false);
                        route.leaveSettings();
                      }}
                    >
                      Discard changes
                    </Button>
                  </>
                }
              />
            )}
          </Dialog>
        </AgentsContext.Provider>
      </ChannelNavigationProvider>
    </ToastProvider>
  );
}
