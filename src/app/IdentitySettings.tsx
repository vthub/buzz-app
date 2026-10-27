import { useRef, useState, useSyncExternalStore } from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { Identity } from "../features/identity/service";
import type { FederatedIdentity } from "../features/federated-identity/service";
import { recoveryMessage } from "../features/federated-identity/CommunitySignIn";
import { PrivateKey } from "../features/identity/PrivateKey";
import { SignOutDialog } from "../features/identity/SignOut";
import { Header } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Button } from "../shared/design-system/ui/Button";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { CopyIcon } from "../shared/design-system/icons";
import styles from "./IdentitySettings.module.css";

export function IdentitySettings({
  viewer,
  identity,
  federatedIdentity,
}: {
  viewer?: string | undefined;
  identity?: Identity | undefined;
  federatedIdentity?: FederatedIdentity | undefined;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [copyStatus, setCopyStatus] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const copyAttempt = useRef(0);
  const npub = viewer ? npubEncode(viewer) : "";
  async function copyIdentity(value: string, label: string) {
    const attempt = ++copyAttempt.current;
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(value);
      if (attempt === copyAttempt.current)
        setCopyStatus({ message: `${label} copied.`, failed: false });
    } catch {
      if (attempt === copyAttempt.current)
        setCopyStatus({
          message: `Couldn’t copy ${label.toLowerCase()}. Select it and copy manually.`,
          failed: true,
        });
    }
  }
  return (
    <section aria-labelledby="identity-settings-title">
      <Header
        id="identity-settings-title"
        title="Identity"
        subtitle="Your identity is shared across communities. Public keys are safe to share."
      />
      {!viewer && (
        <p>Your identity is unavailable. Connect your identity to manage it.</p>
      )}
      {viewer && (
        <>
          <SettingsGroup>
            {(
              [
                ["Public key (hex)", "Public key", viewer],
                ["Nostr address (npub)", "Nostr address", npub],
              ] as const
            ).map(([label, copyLabel, value]) => (
              <PreferenceRow
                key={label}
                title={label}
                subtitle={
                  <code className={`text-mono ${styles.identityValue}`}>
                    {value}
                  </code>
                }
                trailing={
                  <Tooltip
                    content={`Copy ${copyLabel.toLowerCase()}`}
                    hint="familiar"
                  >
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={`Copy ${copyLabel.toLowerCase()}`}
                      icon={<CopyIcon aria-hidden="true" />}
                      onClick={() => void copyIdentity(value, copyLabel)}
                    />
                  </Tooltip>
                }
              />
            ))}
          </SettingsGroup>
          {federatedIdentity && (
            <OrganizationSignIn identity={federatedIdentity} />
          )}
          {identity && (
            <div className="mt-6">
              <SettingsGroup layout="form">
                {/* One key widget at a time; the dialog brings its own. */}
                {!signingOut && <PrivateKey identity={identity} />}
              </SettingsGroup>
              <SettingsGroup>
                <PreferenceRow
                  title="Sign out of Buzz"
                  subtitle="Remove your private key from this device. Also ends Builderlab and hosted community logins."
                  trailing={
                    <Button type="button" onClick={() => setSigningOut(true)}>
                      Sign out of Buzz
                    </Button>
                  }
                />
              </SettingsGroup>
              {signingOut && (
                <SignOutDialog
                  identity={identity}
                  onClose={() => setSigningOut(false)}
                />
              )}
            </div>
          )}
          {copyStatus && (
            <ToastNotice
              title={
                copyStatus.failed
                  ? "Identity wasn’t copied"
                  : copyStatus.message
              }
              {...(copyStatus.failed
                ? { description: copyStatus.message }
                : {})}
              tone={copyStatus.failed ? "error" : "success"}
              timeout={copyStatus.failed ? 0 : 5000}
              onDismiss={() => setCopyStatus(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

function OrganizationSignIn({ identity }: { identity: FederatedIdentity }) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  if (
    !state.authority ||
    state.status === "unconfigured" ||
    state.status === "unavailable"
  )
    return null;
  const organization = new URL(state.authority.identityOrigin).host;
  const signedIn = state.status === "signed-in";
  const signingIn = state.status === "signing-in";
  function run(operation: () => Promise<unknown>) {
    setFailure("");
    void operation().catch((error: unknown) =>
      setFailure(
        error instanceof Error ? error.message : "Sign-in unavailable",
      ),
    );
  }
  const problem = failure || state.failure;
  return (
    <section className="mt-6" aria-labelledby="organization-sign-in-title">
      <h3 id="organization-sign-in-title" className="text-body-lg">
        Organization sign-in
      </h3>
      <SettingsGroup>
        <PreferenceRow
          title={
            signedIn
              ? `Signed in as ${state.email ?? "your organization account"}`
              : "Not signed in"
          }
          subtitle={`Lets you and your agents into communities that require your ${organization} login. Signing out keeps your Buzz key on this device, but you and your agents can’t connect to those communities again until you sign back in.`}
          trailing={
            <Button
              type="button"
              disabled={state.status === "restoring"}
              onClick={() =>
                run(
                  signedIn
                    ? identity.signOut
                    : signingIn
                      ? identity.cancelSignIn
                      : identity.signIn,
                )
              }
            >
              {signedIn
                ? "Sign out of organization"
                : signingIn
                  ? "Cancel sign-in"
                  : "Sign in"}
            </Button>
          }
        />
        {problem && (
          <p role="alert" className="text-body-sm text-danger">
            {recoveryMessage(problem)}
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}
