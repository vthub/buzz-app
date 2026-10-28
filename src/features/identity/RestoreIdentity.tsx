import { useState } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { type Identity, type RecoveryState, recoveryOff } from "./service";

/**
 * Recovered backups to restore one from. With `expectedPubkey`, only that key
 * is offered: when no backup holds it, nothing can be restored, and `onImport`
 * offers Enter your private key instead. Try recovery again is offered only
 * where a retry may help.
 */
export function RestoreIdentity({
  identity,
  recovery,
  expectedPubkey,
  onImport,
}: {
  identity: Pick<
    Identity,
    "beginRecovery" | "installRecovery" | "cancelRecovery"
  >;
  recovery: RecoveryState;
  /** The hex key linked to the signed-in account, when only it may be restored. */
  expectedPubkey?: string | undefined;
  /** No backup holds `expectedPubkey`: leave recovery for the import page. */
  onImport?: (() => void) | undefined;
}) {
  const [selected, setSelected] = useState<{
    recovery: RecoveryState;
    handle: string;
  }>();
  const recovered = recovery.status === "choosing" ? recovery.candidates : [];
  const candidates =
    expectedPubkey === undefined
      ? recovered
      : recovered.filter((candidate) => candidate.pubkey === expectedPubkey);
  const labels = publicKeyLabels(
    candidates.map((candidate) => candidate.pubkey),
  );
  const current =
    recovery.status === "choosing"
      ? candidates.find(
          (candidate) => candidate.pubkey === recovery.currentPubkey,
        )
      : undefined;
  const handle =
    selected?.recovery === recovery ? selected.handle : current?.handle;
  const mismatched = recovered.length > 0 && candidates.length === 0;
  return (
    <section className="flex flex-col gap-4" aria-label="Restore from backup">
      {recovery.status === "waiting" ? (
        <p role="status">Sign in in your browser to find your backups…</p>
      ) : recovery.status === "saving" ? (
        <p role="status">Saving your identity securely…</p>
      ) : recovery.status === "canceling" ? (
        <p role="status">Canceling recovery…</p>
      ) : recovery.status === "error" ? (
        <p role="alert">{recovery.error}</p>
      ) : mismatched ? (
        <p role="alert">
          None of your backups holds the key linked to this account, so nothing
          was restored.
        </p>
      ) : candidates.length === 0 ? (
        <p role={recovery.failedCount ? "alert" : "status"}>
          {recovery.failedCount
            ? "Your backups couldn’t be recovered. Try again."
            : "No backups were found for this account."}
        </p>
      ) : (
        <>
          <p>
            {current
              ? "Choose the Buzz identity to restore on this device."
              : recovery.currentPubkey
                ? "Your current identity isn’t in these backups. You can choose a previous identity."
                : "Choose the Buzz identity to restore on this device."}
          </p>
          <p>This won’t change the identity linked to your account.</p>
          {recovery.failedCount > 0 && (
            <p role="status">Some backups couldn’t be recovered.</p>
          )}
          <Field label="Identity to restore" nativeLabel={false}>
            <RadioGroup
              aria-label="Identity to restore"
              value={handle ?? null}
              onValueChange={(value) =>
                value && setSelected({ recovery, handle: value })
              }
            >
              {candidates.map((candidate) => (
                <Radio
                  key={candidate.handle}
                  value={candidate.handle}
                  label={labels.get(candidate.pubkey)}
                  description={
                    <>
                      {candidate.pubkey === current?.pubkey
                        ? "Current identity"
                        : "Previous identity"}
                      <code className="block break-all text-mono">
                        {npubEncode(candidate.pubkey)}
                      </code>
                    </>
                  }
                />
              ))}
            </RadioGroup>
          </Field>
        </>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={
            recovery.status === "saving" || recovery.status === "canceling"
          }
          onClick={() => void identity.cancelRecovery()}
        >
          {recovery.status === "waiting" ? "Cancel" : "Back"}
        </Button>
        {recovery.status === "choosing" && candidates.length > 0 ? (
          <Button
            variant="primary"
            disabled={!handle}
            onClick={() => handle && void identity.installRecovery(handle)}
          >
            Restore this identity
          </Button>
        ) : mismatched && onImport ? (
          <Button variant="prominent" onClick={onImport}>
            Enter your private key
          </Button>
        ) : (recovery.status === "error" && !recoveryOff(recovery)) ||
          (recovery.status === "choosing" && recovered.length === 0) ? (
          <Button
            variant="primary"
            onClick={() => void identity.beginRecovery()}
          >
            Try recovery again
          </Button>
        ) : null}
      </div>
    </section>
  );
}
