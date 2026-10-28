import { Button } from "../../shared/design-system/ui/Button";
import { PublicKeyPanel } from "./PublicKeyPanel";

/**
 * Pause after the account check found a key already linked to the signed-in
 * Builderlab account. Binding is 1:1, so this lane never creates a key: the
 * user brings the linked one, restores it from a backup, or starts over
 * without it.
 */
export function WelcomeBack({
  npub,
  email,
  onRestore,
  onImport,
  onLost,
  onSwitchAccount,
}: {
  /** The linked key, as the account's npub. */
  npub: string;
  /** The signed-in Builderlab account the key is linked to. */
  email: string | undefined;
  /** Restore the linked key; set only when backup status lists it. */
  onRestore?: (() => void) | undefined;
  /** Open the import page, which accepts only this key. */
  onImport: () => void;
  /** Open the start-over page. */
  onLost: () => void;
  /** Wrong account: sign the session out and return to the landing. */
  onSwitchAccount: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Welcome back
        </h1>
        <p className="mt-2 text-body text-subtle">
          This account is already linked to a Buzz identity — the key you use on
          your other device.
          {onRestore
            ? " Restore it from your backup, or enter that key to continue."
            : " Enter that key to continue."}
        </p>
        {/* Who the linked key belongs to, so a wrong account is visible before anything is imported. */}
        <p className="mt-2 text-body-sm text-subtle">
          {email ? `Signed in as ${email}.` : "Signed in."}
        </p>
      </div>
      <PublicKeyPanel publicKey={npub} heading="Linked public key (npub)" />
      <div className="flex flex-col gap-3">
        {onRestore && (
          <Button
            variant="prominent"
            size="lg"
            data-return-focus="restore"
            onClick={onRestore}
          >
            Restore from backup
          </Button>
        )}
        {/* Secondary choices are deliberately smaller than the primary. */}
        <Button
          variant={onRestore ? "subtle" : "primary"}
          size={onRestore ? "sm" : "lg"}
          data-return-focus="import"
          onClick={onImport}
        >
          Enter your private key
        </Button>
        {/* Future entry for NIP-AB device pairing: the signed-in device hands the key over. */}
        <Button size="sm" disabled>
          Recover from another device — Coming soon
        </Button>
        {/* Quieter than the other choices: starting over loses the old identity. */}
        <Button
          size="sm"
          variant="ghost"
          data-return-focus="lost"
          onClick={onLost}
        >
          I lost this key
        </Button>
        {/* A lane exit, not a key choice, so it comes last. */}
        <Button size="sm" variant="ghost" onClick={onSwitchAccount}>
          Use a different account
        </Button>
      </div>
    </>
  );
}
