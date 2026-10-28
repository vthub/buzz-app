import { useState } from "react";
import type { inspectProfile } from "../communities/api";
import type { FoundCommunity } from "../communities/find-community";
import { canSaveProfile, ProfileFields } from "../communities/ProfileFields";
import type { PersonalProfile } from "../communities/service";
import { readErrorKind } from "../relay/errors";
import { Button } from "../../shared/design-system/ui/Button";
import { WireframePanel } from "./Wireframe";

/**
 * First-run profile, shown once the relay has admitted the key and before the
 * gate lifts. A pure form: the caller owns what Continue and Skip do with the
 * draft (the join's completion, which publishes the kind 0 through the shared
 * owner and saves the membership after it), and a rejection stays here with
 * the error inline and the draft intact.
 */
export function ProfileStep({
  found,
  read,
  defaultName,
  onContinue,
  onSkip,
}: {
  found: Pick<FoundCommunity, "url" | "host">;
  /** The admission read that joined the community: the prefill. */
  read: Awaited<ReturnType<typeof inspectProfile>>;
  /** Suggested display name when the relay holds no profile for this key. */
  defaultName: string;
  /** Publishes the trimmed draft and finishes the join; a rejection keeps the step. */
  onContinue: (profile: PersonalProfile) => Promise<void>;
  /** Finishes the join without publishing; a rejection keeps the step. */
  onSkip: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<PersonalProfile>(() =>
    read.exists ? read.profile : { name: defaultName, picture: "", about: "" },
  );
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const canContinue = canSaveProfile(draft) && !busy && !uploading;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(publishFailure(found.host, reason));
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (canContinue)
          void run(() =>
            onContinue({
              ...draft,
              name: draft.name.trim(),
              about: draft.about?.trim() ?? "",
            }),
          );
      }}
    >
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Set up your profile
        </h1>
        <p className="mt-2 text-body text-subtle">
          Add a name and avatar. They’ll show up on your messages, reactions,
          and agent handoffs in {found.host}. You can change them any time in
          Settings → Profile.
        </p>
      </div>
      <WireframePanel>
        <ProfileFields
          profile={draft}
          onChange={setDraft}
          disabled={busy}
          community={found.url}
          onBusyChange={setUploading}
          autoFocus
        />
      </WireframePanel>
      {error && (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      )}
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        <Button onClick={() => void run(onSkip)} disabled={busy}>
          Skip for now
        </Button>
        <Button
          type="submit"
          variant="prominent"
          loading={busy}
          disabled={!canContinue}
        >
          Continue
        </Button>
      </div>
    </form>
  );
}

/** Classified like the join's read failure; the owner's own messages (the
 * native route's "Community request failed (500)", an unconfirmed receipt, a
 * readback that is not current, a device record that will not save) are
 * shown as is. */
function publishFailure(host: string, error: unknown) {
  if (readErrorKind(error) === "denied")
    return `${host} no longer admits this key. Skip for now and ask a community administrator.`;
  return error instanceof Error
    ? error.message
    : "Could not reach the relay. Check your connection and try again.";
}
