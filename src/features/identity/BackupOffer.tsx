import { Button } from "../../shared/design-system/ui/Button";

/**
 * Pause after an imported key, on either lane. Importing must never upload
 * silently: the backup is offered, and the key continues either way. The key
 * may be used elsewhere, so the copy discloses that Block can restore it there
 * too; choosing Back it up is the backup consent.
 */
export function BackupOffer({
  onSkip,
  onBackUp,
}: {
  onSkip: () => void;
  onBackUp: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Back up this key?
        </h1>
        <p className="mt-2 text-body text-subtle">
          Buzz can keep an encrypted copy in your account so you can skip this
          step on your next device. Block can use that copy to restore this key,
          including anywhere else you use it.
        </p>
      </div>
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        <Button onClick={onSkip}>Not now</Button>
        <Button variant="prominent" onClick={onBackUp}>
          Back it up
        </Button>
      </div>
    </>
  );
}
