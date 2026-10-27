import { profileDefault } from "./profile-default";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Button } from "../../shared/design-system/ui/Button";
import { ArrowUpRightIcon } from "../../shared/design-system/icons";
import {
  communityRequest,
  inspectProfile,
  publishProfile,
  type CommunityInfo,
} from "./api";
import type { Communities, PersonalProfile } from "./service";
import { canSaveProfile, ProfileFields, profilesEqual } from "./ProfileFields";
import { communityDestination, relayOrigin } from "./destination";
import { nativeIdentityEnabled } from "../identity/service";
import { readErrorKind } from "../relay/errors";
import { createJoinJournal, type PendingJoin } from "./join-journal";
import { CommunitySignIn } from "../federated-identity/CommunitySignIn";
import type { FederatedIdentity } from "../federated-identity/service";
import styles from "./Communities.module.css";

// Exact relay claim refusal codes, forwarded unchanged by the broker.
const CLAIM_REFUSALS = {
  invite_expired: "This invite code has expired — ask for a new one.",
  invite_exhausted:
    "This invite has reached its use limit. Ask for a new invite.",
  invite_invalid: "This invite code is not valid for this community.",
  join_policy_required:
    "This community requires current policy acceptance. Go back and reopen the relay to review it.",
  join_policy_not_accepted:
    "The community policy changed. Go back and reopen the relay to review it.",
};

export function CommunityDialog({
  communities,
  mode,
  close,
  onJoined,
  invite,
  connectionFrom,
  federatedIdentity,
}: {
  communities: Communities;
  /** Offers protected-community sign-in when admission refuses for it. */
  federatedIdentity?: FederatedIdentity | undefined;
  mode: "join" | "profile";
  close(): void;
  onJoined?: (id: string) => void;
  /** A deliberate connection edit uses the same admission flow, never rekeys existing data. */
  connectionFrom?: string;
  invite?:
    | Readonly<{
        community: string;
        code: string;
      }>
    | undefined;
}) {
  const formId = useId();
  const client = communities.snapshot();
  const unavailable =
    client.status !== "ready" || (mode === "join" && !client.relayAvailable);
  const [journal] = useState(() =>
    mode === "join" && nativeIdentityEnabled() && client.viewer
      ? createJoinJournal(client.viewer)
      : undefined,
  );
  const [recovery] = useState(() => {
    try {
      return { pending: journal?.latest(), error: "" };
    } catch (reason) {
      return { pending: undefined, error: String(reason) };
    }
  });
  const [url, setUrl] = useState(
    connectionFrom ??
      invite?.community ??
      (recovery.pending
        ? communityDestination(recovery.pending.community).url
        : ""),
  );
  const [destination, setDestination] =
    useState<ReturnType<typeof communityDestination>>();
  const id = destination?.id ?? "";
  const [step, setStep] = useState<"destination" | "access" | "profile">(
    mode === "profile" ? "profile" : "destination",
  );
  const [info, setInfo] = useState<CommunityInfo>();
  const [profile, setProfile] = useState<PersonalProfile>(client.profile);
  const [original, setOriginal] =
    useState<Awaited<ReturnType<typeof inspectProfile>>>();
  const [code, setCode] = useState(invite?.code ?? "");
  const [agreed, setAgreed] = useState(false);
  const [adult, setAdult] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(recovery.error);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const policy = info?.policy;
  const allowed =
    (!policy?.age_attestation_required || adult) &&
    (!(policy?.terms_markdown || policy?.privacy_markdown) || agreed);
  const current = (entry?: PendingJoin) =>
    mounted.current && (!entry || journal?.current(entry));
  function showProfile(
    found: Awaited<ReturnType<typeof inspectProfile>>,
    pending?: PendingJoin,
  ) {
    setOriginal(found);
    setProfile(
      pending?.profile ?? (found.exists ? found.profile : client.profile),
    );
    setStep("profile");
  }
  async function submit() {
    if (uploading || unavailable) return;
    if (step === "destination") {
      await work(async () => {
        const next = communityDestination(relayOrigin(url));
        setDestination(next);
        const value = await communityRequest<CommunityInfo>(next.id, "info");
        if (!mounted.current) return;
        const pending = journal?.get(next.id);
        // Restoring an existing admitted profile is not a new join or policy acceptance.
        const found = await inspectProfile(next.id).catch((reason: unknown) => {
          if (pending && readErrorKind(reason) !== "denied") throw reason;
          return undefined;
        });
        if (current(pending)) {
          setInfo(value);
          if (found && (found.exists || pending)) showProfile(found, pending);
          else setStep("access");
        }
      });
    } else if (step === "access") {
      if (!allowed) return;
      await work(async () => {
        const pending = journal?.get(id);
        if (pending) {
          // A lost claim response may already have admitted this identity, even
          // when its invite has since expired. Read before attempting another claim.
          const found = await inspectProfile(id).catch((reason: unknown) => {
            if (readErrorKind(reason) !== "denied") throw reason;
            return undefined;
          });
          if (!current(pending)) return;
          if (found) {
            showProfile(found, pending);
            return;
          }
        }
        const transaction = journal?.begin(id);
        if (code.trim()) {
          const receipt = policy
            ? (
                await communityRequest<{ receipt: string }>(
                  id,
                  "accept-policy",
                  {
                    code: code.trim(),
                    policy_version: policy.version,
                    age_confirmed: adult,
                  },
                )
              ).receipt
            : undefined;
          if (!current(transaction)) return;
          const claim = await communityRequest<{ status: string }>(
            id,
            "claim",
            { code: code.trim(), policy_receipt: receipt },
          ).catch((reason: unknown) => {
            const known =
              reason instanceof Error &&
              Object.hasOwn(CLAIM_REFUSALS, reason.message)
                ? CLAIM_REFUSALS[reason.message as keyof typeof CLAIM_REFUSALS]
                : undefined;
            throw known ? new Error(known) : reason;
          });
          if (!["joined", "already_member"].includes(claim.status))
            throw new Error("Membership was not confirmed");
        }
        if (!current(transaction)) return;
        const found = await inspectProfile(id);
        if (!current(transaction)) return;
        showProfile(found, transaction);
      });
    } else {
      if (!profile.name.trim()) return;
      await work(async () => {
        if (mode === "profile")
          communities.saveProfile({ ...profile, name: profile.name.trim() });
        else {
          if (!destination) throw new Error("Choose a community first");
          const transaction = journal?.begin(id, profile);
          const found = journal ? await inspectProfile(id) : original;
          if (!current(transaction)) return;
          const next =
            found?.exists && profilesEqual(profile, found.profile)
              ? profile
              : {
                  ...profile,
                  name: profile.name.trim(),
                  about: profile.about?.trim() ?? "",
                };
          if (!found?.exists || !profilesEqual(next, found.profile)) {
            await publishProfile(id, next, found?.existing ?? {});
            if (!current(transaction)) return;
            // An accepted replaceable event may already be superseded.
            const confirmed = await inspectProfile(id);
            if (!current(transaction)) return;
            if (!confirmed.exists || !profilesEqual(confirmed.profile, next))
              throw new Error(
                "Your profile change is not current. Your edits are retained; try again.",
              );
          }
          if (!current(transaction)) return;
          communities.joined(
            {
              id,
              name:
                info?.name && info.name !== "Buzz Relay"
                  ? info.name
                  : destination.name,
              ...(info?.icon?.startsWith("https://")
                ? { icon: info.icon }
                : {}),
            },
            profileDefault(next, communities.snapshot().profile, id),
          );
          if (transaction) journal?.finish(transaction);
          onJoined?.(id);
        }
        close();
      });
    }
  }
  // Keeping an existing community profile publishes nothing, so it needs no edit validation.
  const keepsProfile =
    mode === "join" &&
    !!original?.exists &&
    profilesEqual(profile, original.profile);
  return (
    <Dialog
      open
      dismissOnOutsideClick={false}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      preventClose={busy}
      description={
        unavailable
          ? undefined
          : step === "destination"
            ? connectionFrom
              ? "Enter a wss:// or https:// relay address without a path. Changing the connection URL does not rename or move this community."
              : "Use your identity across communities. Your profile and conversations stay separate in each one."
            : step === "access"
              ? `Connect to ${destination?.name} with your Buzz identity.`
              : mode === "profile"
                ? "Your local default. Use it when joining communities; saving here does not publish changes to them."
                : original?.exists
                  ? "Your existing community profile is loaded. Keep it or update it here."
                  : "Start with your local profile, or choose how you appear in this community."
      }
      leadingActions={
        !unavailable && (
          <Button
            type="button"
            disabled={busy || uploading}
            onClick={() => {
              if (step === "destination" || mode === "profile") close();
              else {
                setError("");
                setStep(step === "profile" ? "access" : "destination");
                setAgreed(false);
                setAdult(false);
              }
            }}
          >
            Back
          </Button>
        )
      }
      actions={
        !unavailable && (
          <Button
            variant="prominent"
            type="submit"
            form={formId}
            disabled={
              busy ||
              uploading ||
              (step === "access" && !allowed) ||
              (step === "profile" &&
                (keepsProfile
                  ? !profile.name.trim()
                  : !canSaveProfile(profile)))
            }
          >
            {busy
              ? "Working…"
              : step === "profile"
                ? mode === "profile"
                  ? "Save profile"
                  : keepsProfile
                    ? "Open community"
                    : "Publish profile & open"
                : "Continue"}
          </Button>
        )
      }
      title={
        mode === "profile"
          ? "Your profile"
          : step === "profile"
            ? `Your profile in ${info?.name && info.name !== "Buzz Relay" ? info.name : destination?.name}`
            : connectionFrom
              ? "Edit connection"
              : "Join a community"
      }
    >
      <form
        id={formId}
        noValidate
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "join" && step !== "destination" && destination && (
          <p className={styles.note}>Community URL: {destination.url}</p>
        )}
        {unavailable ? (
          <p>
            {client.status === "loading"
              ? "Opening your local identity…"
              : client.status === "ready"
                ? "Your identity is ready, but connecting to communities is not available in this build yet. You can manage your local profile and identity in Settings."
                : "Live identity access is unavailable. For development, set BUZZ_DEV_VIEWER to your Buzz public key in .env.local, then restart just web or just desktop. See docs/contributing.md for requirements."}
          </p>
        ) : (
          <>
            {step === "destination" && (
              <Field
                label="Community URL"
                error={error || undefined}
                description={
                  connectionFrom
                    ? undefined
                    : "Paste your community link. Continue shares your Buzz identity with the community so you can preview it before joining."
                }
              >
                <Input
                  type="url"
                  required
                  autoComplete="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="wss://community.example.com"
                  maxLength={2048}
                  disabled={busy}
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setDestination(undefined);
                    setCode("");
                    setAgreed(false);
                    setAdult(false);
                    setInfo(undefined);
                    setOriginal(undefined);
                    setProfile(client.profile);
                    setError("");
                  }}
                />
              </Field>
            )}
            {step === "access" && (
              <>
                <Field label="Invite code (if required)">
                  <Input
                    disabled={busy}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Existing members can leave this blank"
                    maxLength={256}
                  />
                </Field>
                {policy && (
                  <div className={styles.policy}>
                    {policy.terms_markdown && (
                      <a
                        className="inline-flex items-center gap-1 self-start"
                        href={`${destination?.url}/api/join-policy/terms`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Terms of Service
                        <ArrowUpRightIcon size={16} aria-hidden="true" />
                      </a>
                    )}
                    {policy.privacy_markdown && (
                      <a
                        className="inline-flex items-center gap-1 self-start"
                        href={`${destination?.url}/api/join-policy/privacy`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Privacy Notice
                        <ArrowUpRightIcon size={16} aria-hidden="true" />
                      </a>
                    )}
                    {(policy.terms_markdown || policy.privacy_markdown) && (
                      <Checkbox
                        checked={agreed}
                        onCheckedChange={setAgreed}
                        label="I agree to this community’s Terms of Service and Privacy Notice."
                      />
                    )}
                    {policy.age_attestation_required && (
                      <Checkbox
                        checked={adult}
                        onCheckedChange={setAdult}
                        label="I confirm that I am at least 18 years old."
                      />
                    )}
                  </div>
                )}
                <p className={styles.note}>
                  If access is denied, ask a community administrator for an
                  invite code.
                </p>
              </>
            )}
            {step === "profile" && (
              <ProfileFields
                community={mode === "profile" ? undefined : id}
                onBusyChange={setUploading}
                profile={profile}
                onChange={setProfile}
                disabled={busy}
              />
            )}
            {error && step !== "destination" && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            {error && (
              <CommunitySignIn
                identity={federatedIdentity}
                error={error}
                // Sign-in only clears the refusal: Continue then runs the current
                // step with current input, never one captured before the login.
                retry={() => setError("")}
              />
            )}
          </>
        )}
      </form>
    </Dialog>
  );
}
