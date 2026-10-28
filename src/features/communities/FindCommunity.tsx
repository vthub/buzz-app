import { useEffect, useEffectEvent, useRef, useState } from "react";
import { CircleNotchIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  FindCommunityError,
  findCommunity,
  nativeRelayFetch,
  type FindFailure,
  type FoundCommunity,
  type RelayFetch,
} from "./find-community";

type State =
  | { status: "finding" }
  | { status: "found"; found: FoundCommunity }
  | { status: "failed"; failure: FindFailure };

/** What the user ticked on Join Community; an invite claim attests `adult`. */
export type JoinConsent = Readonly<{ adult: boolean; agreed: boolean }>;

/** Classified copy; raw transport errors are never shown. */
const FAILURES: Record<FindFailure, { message: string; retry: boolean }> = {
  unreachable: {
    message: "Could not reach the relay. Check your connection and try again.",
    retry: true,
  },
  "not-buzz": { message: "This address isn’t a Buzz community.", retry: false },
  "no-community": {
    message: "No community is set up at this address.",
    retry: false,
  },
};

/**
 * Looks up a community at a canonical secure origin before any identity or
 * session exists. Owns nothing beyond the lookup: the caller decides what Join
 * does, and leaving it out keeps Join a disabled placeholder. While `onJoin` is
 * pending the page holds still; what its failure means is the caller's to show.
 */
export function FindCommunity({
  url,
  onCancel,
  onFound,
  onJoin,
  request = nativeRelayFetch,
  titleId,
}: {
  url: string;
  onCancel: () => void;
  /** Takes over a found community instead of showing Join Community; the lookup page stays until the caller moves on. */
  onFound?: (found: FoundCommunity) => void;
  onJoin?: (
    found: FoundCommunity,
    consent: JoinConsent,
  ) => Promise<void> | void;
  request?: RelayFetch;
  titleId?: string;
}) {
  const host = new URL(url).host;
  const [state, setState] = useState<State>({ status: "finding" });
  const [adult, setAdult] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [joining, setJoining] = useState(false);
  const inFlight = useRef<AbortController>(null);
  const settle = useEffectEvent((found: FoundCommunity) => {
    if (onFound) onFound(found);
    else setState({ status: "found", found });
  });
  useEffect(() => {
    if (state.status !== "finding") return;
    const controller = new AbortController();
    inFlight.current = controller;
    findCommunity(url, request, controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) settle(found);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "failed",
          failure:
            error instanceof FindCommunityError ? error.failure : "unreachable",
        });
      },
    );
    return () => controller.abort();
  }, [url, request, state.status]);
  const cancel = () => {
    // Nothing from this lookup may land after leaving, even if we stay mounted.
    inFlight.current?.abort();
    onCancel();
  };
  const heading = (text: string) => (
    <h1 id={titleId} tabIndex={-1} className="text-heading text-standard">
      {text}
    </h1>
  );
  if (state.status === "finding")
    return (
      <>
        {heading("Finding community")}
        {/* An initial read: its status waits a second, the hostname and Cancel do not. */}
        <LoadingRegion pending label={`Looking up ${host}…`}>
          <div className="flex flex-col gap-6">
            <p className="m-0 font-mono text-body text-subtle">{host}</p>
            <div>
              <Button onClick={cancel}>Cancel</Button>
            </div>
          </div>
        </LoadingRegion>
      </>
    );
  // Action rows follow the design system's footer order: secondary first, primary last.
  if (state.status === "failed") {
    const { message, retry } = FAILURES[state.failure];
    return (
      <>
        {heading("Couldn’t find community")}
        <p role="alert" className="text-body text-danger">
          {message}
        </p>
        <div className="flex gap-3">
          <Button onClick={cancel}>Cancel</Button>
          {retry && (
            <Button
              variant="prominent"
              onClick={() => setState({ status: "finding" })}
            >
              Retry
            </Button>
          )}
        </div>
      </>
    );
  }
  const { found } = state;
  const policy = found.policy;
  const needsAge = policy?.age_attestation_required === true;
  const needsAgreement = Boolean(
    policy?.terms_markdown || policy?.privacy_markdown,
  );
  const consented = (!needsAge || adult) && (!needsAgreement || agreed);
  const join = async () => {
    if (!onJoin) return;
    setJoining(true);
    try {
      await onJoin(found, { adult, agreed });
    } catch {
      // The caller shows what a failed join means; here it only ends the wait.
    } finally {
      setJoining(false);
    }
  };
  return (
    <>
      {heading("Join Community")}
      <div className="flex items-center gap-3">
        <Avatar alt="" fallback={found.host} src={found.icon} />
        <p className="m-0 min-w-0 flex-1 truncate font-mono text-label text-standard">
          {found.host}
        </p>
      </div>
      {(needsAge || needsAgreement) && (
        <div className="flex flex-col gap-3">
          {needsAge && (
            <Checkbox
              checked={adult}
              onCheckedChange={setAdult}
              label="I confirm that I am at least 18 years old."
            />
          )}
          {needsAgreement && (
            <Checkbox
              checked={agreed}
              onCheckedChange={setAgreed}
              label={
                <>
                  I agree to this community’s{" "}
                  {policy?.terms_markdown && (
                    <PolicyLink url={url} document="terms">
                      Terms of Service
                    </PolicyLink>
                  )}
                  {policy?.terms_markdown && policy.privacy_markdown && " and "}
                  {policy?.privacy_markdown && (
                    <PolicyLink url={url} document="privacy">
                      Privacy Notice
                    </PolicyLink>
                  )}
                  .
                </>
              }
            />
          )}
        </div>
      )}
      {joining && (
        <p
          role="status"
          className="flex items-center gap-2 text-body text-subtle"
        >
          <CircleNotchIcon
            size={18}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          Joining…
        </p>
      )}
      <div className="flex gap-3">
        <Button onClick={cancel} disabled={joining}>
          Cancel
        </Button>
        <Button
          variant="prominent"
          disabled={!onJoin || !consented || joining}
          onClick={() => void join()}
        >
          {onJoin ? "Join" : "Join — Coming soon"}
        </Button>
      </div>
    </>
  );
}

/** Relay-hosted document pages open outside the app, as in `CommunityDialog`. */
function PolicyLink({
  url,
  document,
  children,
}: {
  url: string;
  document: "terms" | "privacy";
  children: string;
}) {
  return (
    <a
      href={`${url}/api/join-policy/${document}`}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
