import { Button } from "../../shared/design-system/ui/Button";
import styles from "./IdentitySetup.module.css";
import { OnboardingScreen } from "./OnboardingScreen";

/**
 * Pause on an unlinked account: create a key, which is then linked and backed
 * up, or bring an existing one. The copy discloses that Block can restore the
 * key, since choosing to create it is the backup consent.
 */
export function KeyChoice({
  email,
  backups,
  onCreate,
  onImport,
  onSwitchAccount,
}: {
  /** The signed-in Builderlab account the lookup ran for. */
  email: string | undefined;
  /**
   * The keys the backed-up-key lookup listed; `undefined` when it was
   * unavailable or failed. Backups outlive an unlink, so an unlinked account
   * may still list some, and only an empty list says none was found.
   */
  backups: readonly string[] | undefined;
  /** Create the key, link it to the account, then back it up. */
  onCreate: () => void;
  /** The user already has a key: open the import page. */
  onImport: () => void;
  /** Wrong account: sign the session out and return to the landing. */
  onSwitchAccount: () => void;
}) {
  // The welcome screen's create-or-import stack, after sign-in.
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <div className={styles.importContent}>
          <h1
            id="welcome-title"
            tabIndex={-1}
            className="text-heading text-standard"
          >
            Set up your key
          </h1>
          <p className="text-body text-subtle">
            Buzz signs everything you do with a private key kept on this device.
            {backups?.length === 0 &&
              " We didn’t find a backed-up key for this account, so let’s make one."}{" "}
            An encrypted copy is backed up to your account, and Block can use it
            to restore the key on your other devices.
          </p>
          {/* Who the key would belong to, so a wrong account is visible before any key exists. */}
          <p className="text-body-sm text-subtle">
            {email ? `Signed in as ${email}.` : "Signed in."}
          </p>
        </div>
      }
    >
      <Button variant="prominent" size="lg" onClick={onCreate}>
        Create my key
      </Button>
      <Button
        variant="ghost"
        size="lg"
        data-return-focus="import"
        onClick={onImport}
      >
        I already have a key
      </Button>
      <Button variant="ghost" size="lg" onClick={onSwitchAccount}>
        Use a different account
      </Button>
    </OnboardingScreen>
  );
}
