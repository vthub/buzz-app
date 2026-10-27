import { useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { OnboardingScreen } from "../identity/OnboardingScreen";
import type { SettingsCards } from "../settings/service";
import { CommunityDialog } from "./CommunityDialog";
import type { FederatedIdentity } from "../federated-identity/service";
import { type InviteLink, parsePastedInvite } from "./invite-link";
import type { Communities } from "./service";

/** First run with no community: joining replaces the empty shell. */
export function CommunityLanding({
  communities,
  federatedIdentity,
  invite,
  onInviteClose,
  settingsCards,
  onJoined,
  onCreate,
}: {
  communities: Communities;
  federatedIdentity?: FederatedIdentity | undefined;
  invite?: (InviteLink & { requestId: number }) | undefined;
  onInviteClose(requestId: number): void;
  settingsCards: Pick<SettingsCards, "subscribe" | "has">;
  onJoined(id: string): void;
  onCreate(): void;
}) {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState<InviteLink>();
  const hostedAvailable = useSyncExternalStore(settingsCards.subscribe, () =>
    settingsCards.has("block.hosted-communities/hosted"),
  );
  const opened = invite ?? joining;
  return (
    <OnboardingScreen
      labelledBy="community-landing-title"
      intro={
        <>
          <h1 id="community-landing-title" className="text-heading">
            Join a community
          </h1>
          <form
            className="mt-4 grid w-full max-w-md gap-4 text-left"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = parsePastedInvite(link);
              if (parsed) setJoining(parsed);
              else setError("Paste an invite link or community URL.");
            }}
          >
            <Field label="Invite link or community URL" error={error}>
              <Input
                autoFocus
                value={link}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://"
                onChange={(event) => {
                  setLink(event.target.value);
                  setError("");
                }}
              />
            </Field>
            <Button
              type="submit"
              size="lg"
              variant="prominent"
              disabled={!link.trim()}
            >
              Join
            </Button>
          </form>
        </>
      }
    >
      {hostedAvailable && (
        <Button size="lg" variant="ghost" onClick={onCreate}>
          Create a community
        </Button>
      )}
      {opened && (
        <CommunityDialog
          key={invite ? invite.requestId : `${opened.community} ${opened.code}`}
          communities={communities}
          federatedIdentity={federatedIdentity}
          mode="join"
          invite={opened}
          onJoined={onJoined}
          close={() => {
            setJoining(undefined);
            if (invite) onInviteClose(invite.requestId);
          }}
        />
      )}
    </OnboardingScreen>
  );
}
