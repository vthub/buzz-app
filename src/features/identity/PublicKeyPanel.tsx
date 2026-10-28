import { useState } from "react";
import { CopyIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { WireframePanel } from "./Wireframe";

/**
 * A full npub — never hex or an abbreviation — with Copy and inline copy
 * feedback, for first-run pages that render outside ToastProvider. The
 * Profile panel's public-key recipe.
 */
export function PublicKeyPanel({
  publicKey,
  heading = "Your public key (npub)",
}: {
  publicKey: string;
  heading?: string;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  return (
    <WireframePanel>
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-body text-subtle">{heading}</h2>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Copy npub"
          onClick={() => {
            setCopyStatus("");
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(publicKey))
              .then(
                () => setCopyStatus("Public key copied."),
                () =>
                  setCopyStatus(
                    "Could not copy. Select the key above to copy it.",
                  ),
              );
          }}
        >
          <CopyIcon size={16} aria-hidden="true" />
          Copy
        </Button>
      </div>
      <code className="block select-text break-all font-mono text-mono">
        {publicKey}
      </code>
      <p className="m-0 text-body-sm text-subtle">
        This is your public identity — it’s safe to share.
      </p>
      <span role="status" className="text-body-sm text-subtle">
        {copyStatus}
      </span>
    </WireframePanel>
  );
}
