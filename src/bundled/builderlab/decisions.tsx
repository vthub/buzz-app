// Builderlab as a decision provider: the user's Builderlab sign-in, which
// native code sends with each call. Settings > Decisions API shows the same
// sign-in control as this plugin's card while it is selected.
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  DecisionProvider,
  DecisionProviderStatus,
  DecisionReply,
} from "../../features/decisions/service";
import { Login } from "./login/Login";
import type { OAuthSession } from "./oauth/session";

/** Native `decide` on Builderlab, with the sign-in to send. */
export type BuilderlabDecide = (
  request: unknown,
  session: string,
) => Promise<unknown>;
export const nativeBuilderlabDecide = (): BuilderlabDecide | undefined =>
  isTauri()
    ? (request, session) =>
        invoke("decide", { backend: "builderlab", request, session })
    : undefined;

export function builderlabProvider(
  session: OAuthSession,
  loginAvailable: boolean,
  native: BuilderlabDecide | undefined = nativeBuilderlabDecide(),
): DecisionProvider {
  const signedIn = () =>
    session.snapshot().status === "signed-in"
      ? session.credential()
      : undefined;
  return {
    id: "builderlab",
    label: "Builderlab",
    description: "Use your Builderlab account.",
    // A sign-in in progress cannot answer yet.
    status: (): DecisionProviderStatus =>
      native && signedIn() ? "ready" : "needs-setup",
    subscribe: session.subscribe,
    decide: async (request) => {
      if (!native) return { outcome: "failed", reason: "unavailable" };
      const credential = signedIn();
      if (!credential)
        return { outcome: "failed", reason: "missing_credentials" };
      let reply: unknown;
      try {
        reply = await native(request, credential.value);
      } catch (error) {
        // Tauri rejects arguments that do not deserialize before any call:
        // a malformed request. Any other rejection is the IPC itself failing.
        return {
          outcome: "failed",
          reason: (error instanceof Error
            ? error.message
            : String(error)
          ).startsWith("invalid args")
            ? "invalid_request"
            : "service_error",
        };
      }
      if (!reply || typeof reply !== "object")
        return { outcome: "failed", reason: "invalid_response" };
      const { outcome, reason, model, answers } = reply as Record<
        string,
        unknown
      >;
      // Native reports `session_expired` only for a Builderlab 401. Then
      // only the refused sign-in ends; a newer one stays. A refusal of
      // decisions alone (`unauthorized`) keeps the sign-in that other
      // Builderlab features share.
      if (reason === "session_expired") {
        if (signedIn() === credential) session.signOut();
        return { outcome: "failed", reason: "unauthorized" };
      }
      // The host checks the reply's shape and answers.
      return (
        outcome === "answered"
          ? { outcome, model, answers }
          : { outcome, reason }
      ) as DecisionReply;
    },
    Settings: ({ active }) => (
      <Login
        session={session}
        available={loginAvailable}
        active={active}
        showHeading={false}
      />
    ),
  };
}
