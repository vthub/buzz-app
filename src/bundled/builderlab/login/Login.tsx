import { useEffect, useSyncExternalStore } from "react";
import { Header } from "../../../shared/design-system/ui/Header";
import { Button } from "../../../shared/design-system/ui/Button";
import type { OAuthSession } from "../oauth/session";

export function Login({
  session,
  available,
  active,
  showHeading = true,
  unavailableReason = "Open the Buzz desktop app to sign in with Builderlab.",
}: {
  session: OAuthSession;
  available: boolean;
  active(): boolean;
  showHeading?: boolean;
  unavailableReason?: string;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  useEffect(
    () => () => {
      if (session.snapshot().status === "pending") session.cancel();
    },
    [session],
  );
  const intro =
    state.status === "signed-in"
      ? "Your credential stays in memory until you sign out or close Buzz."
      : "Connect your Builderlab account. Your credential stays in memory until you sign out or close Buzz.";
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      {showHeading ? (
        <Header title="Builderlab" subtitle={intro} />
      ) : (
        <p className="m-0 text-body-sm text-secondary">{intro}</p>
      )}
      {!available ? (
        <p role="status" className="text-body-sm text-secondary">
          {unavailableReason}
        </p>
      ) : (
        <>
          <p role="status" className="text-body-sm text-secondary">
            {state.status === "pending"
              ? "Finish sign-in in your browser, then return to Buzz."
              : state.account
                ? state.account.email
                  ? `Signed in as ${state.account.email}.`
                  : "Signed in to Builderlab."
                : "Sign in securely in your browser."}
          </p>
          {state.error && (
            <p role="alert" className="text-body-sm text-danger">
              {state.error}
            </p>
          )}
          <Button
            variant={state.status === "signed-out" ? "prominent" : "outline"}
            onClick={() => {
              if (!active()) return;
              if (state.status === "pending") session.cancel();
              else if (state.status === "signed-in") session.signOut();
              else void session.signIn();
            }}
          >
            {state.status === "pending"
              ? "Cancel sign-in"
              : state.status === "signed-in"
                ? "Sign out"
                : "Sign in with Builderlab"}
          </Button>
        </>
      )}
    </div>
  );
}
