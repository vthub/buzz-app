import { Button } from "../../shared/design-system/ui/Button";
import type { OwnedCommunity } from "./builderlab-account";
import { WireframePanel } from "./Wireframe";

/**
 * Pause for a linked key the user no longer has. Starting over creates a new
 * key, unlinks this one, links the new one in its place and backs it up, with
 * no key choice between; the page spells out what the old key keeps and, as
 * Set up your key does, that Block can restore the new one.
 */
export function KeyLost({
  owned,
  onBack,
  onStartOver,
}: {
  /** The communities the old key owns; `undefined` when the list could not be loaded. */
  owned: readonly OwnedCommunity[] | undefined;
  onBack: () => void;
  onStartOver: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Start over with a new key
        </h1>
        <p className="mt-2 text-body text-subtle">
          A new key is a new identity. Everything the old key could reach stays
          with it: its profile, its messages and the communities it belongs to.
          Starting over unlinks the old key, then creates a new key, links it to
          this account and keeps an encrypted copy that Block can use to restore
          it.
        </p>
      </div>
      <WireframePanel>
        <h2 className="m-0 text-body text-subtle">Communities you own</h2>
        {owned === undefined ? (
          <p className="m-0 text-body text-standard">
            Couldn’t load the communities this account owns.
          </p>
        ) : owned.length === 0 ? (
          <p className="m-0 text-body text-standard">None</p>
        ) : (
          <ul
            aria-label="Communities you own"
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {owned.map(({ host, url }) => (
              <li key={url} className="truncate text-label text-standard">
                {host}
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-body-sm text-subtle">
          Memberships in other people’s communities can’t be listed here and
          will also be lost.
        </p>
      </WireframePanel>
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        <Button onClick={onBack}>Back</Button>
        <Button variant="destructive" onClick={onStartOver}>
          Start over with a new key
        </Button>
      </div>
    </>
  );
}
