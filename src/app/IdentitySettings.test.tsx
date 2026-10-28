// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import {
  type BackupStatus,
  createBackupStatus,
} from "../features/identity/backup";
import { BACKUP_FAILURES } from "../features/identity/backup-failure";
import { backupOfferedFor } from "../features/identity/builderlab-account";
import type { Identity } from "../features/identity/service";
import { IdentitySettings } from "./IdentitySettings";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    constructor(public onmessage: (status: unknown) => void) {}
  },
}));

const viewer = "ab".repeat(32);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Send = NonNullable<Parameters<typeof createBackupStatus>[0]>;
type Progress<S = BackupStatus> = S extends unknown
  ? Omit<S, "seq" | "pass" | "builderlab">
  : never;
const at = (seq: number, progress: Progress, builderlab = true) =>
  ({ seq, pass: seq, builderlab, ...progress }) as BackupStatus;

/** The real status store over a native side that answers `initial` and records its watcher. */
function backupHost(initial: BackupStatus) {
  const watchers: { onmessage: (status: BackupStatus) => void }[] = [];
  const send = vi.fn(
    async (
      command: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === "nsec_backup_watch") {
        watchers.push(args?.onEvent as (typeof watchers)[number]);
        return undefined;
      }
      if (command === "nsec_backup_state") return initial;
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  const store = createBackupStatus(send as Send);
  return {
    identity: { exportKey: vi.fn(), backup: store } as unknown as Identity,
    push: (status: BackupStatus) =>
      act(() => watchers.at(-1)?.onmessage(status)),
    /** Settles once the row's own offer check has: it started first on the same store. */
    settled: () => act(() => backupOfferedFor(store)),
  };
}

const renderBackup = (initial: BackupStatus) => {
  const host = backupHost(initial);
  render(<IdentitySettings viewer={viewer} identity={host.identity} />);
  return host;
};
const backupRow = () => screen.queryByText("Key backup");
it("shows exact public identity formats and copies either value", async () => {
  const writeText = vi.fn(async () => {});
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  expect(screen.getByText(viewer, { exact: true })).toHaveTextContent(viewer);
  expect(
    screen.getByText(npubEncode(viewer), { exact: true }),
  ).toHaveTextContent(npubEncode(viewer));

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(writeText).toHaveBeenLastCalledWith(viewer);
  expect(screen.getByText("Public key copied.")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(writeText).toHaveBeenLastCalledWith(npubEncode(viewer));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
});

it("keeps copy feedback bound to the latest identity action", async () => {
  let finishPublicKey: (() => void) | undefined;
  const publicKeyWrite = new Promise<void>((resolve) => {
    finishPublicKey = resolve;
  });
  const writeText = vi
    .fn()
    .mockReturnValueOnce(publicKeyWrite)
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();

  finishPublicKey?.();
  await publicKeyWrite;
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
  expect(screen.queryByText("Public key copied.")).not.toBeInTheDocument();
});

it("keeps the identity selectable and explains manual recovery when copy fails", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => Promise.reject(new Error("denied"))),
    },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  const publicKey = screen.getByText(viewer, { exact: true });
  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(screen.getByText(/Select it and copy manually\./)).toBeVisible();

  // Native text selection is exercised in both browser engines.
  expect(publicKey.tagName).toBe("CODE");
  expect(publicKey).toHaveTextContent(viewer);
  expect(
    screen.queryByRole("textbox", { name: "Public key (hex)" }),
  ).toBeNull();
});

it("clears a revealed key when leaving identity settings and starts masked on return", async () => {
  const exportKey = vi.fn().mockResolvedValue("nsec-public-test-fixture");
  const identity = {
    exportKey,
    backup: backupHost(at(1, { status: "idle" })).identity.backup,
  } as unknown as Identity;
  const user = userEvent.setup();
  const view = render(<IdentitySettings viewer={viewer} identity={identity} />);
  expect(exportKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "nsec-public-test-fixture",
  );
  view.rerender(<div />);
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  view.rerender(<IdentitySettings viewer={viewer} identity={identity} />);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  expect(exportKey).toHaveBeenCalledTimes(1);
});

it.each([
  [{ status: "complete" }, "Your key is backed up to Builderlab."],
  [{ status: "running" }, "Backing up your key…"],
  [
    { status: "waiting", reason: "no_session" },
    "Sign in to Builderlab to back up your key.",
  ],
  [
    { status: "waiting", reason: "not_linked" },
    BACKUP_FAILURES.not_linked.message,
  ],
  // First run offers no Try again for it, but a new sign-in clears it.
  [
    { status: "failed", kind: "signed_out" },
    "Your Builderlab sign-in is no longer valid, so your key wasn’t backed up. Buzz tries again when you next sign in to Builderlab.",
  ],
  // Settings has no Try again, so a retryable failure names what will retry.
  ...(["busy", "unreachable", "unconfirmed", "storage"] as const).map(
    (kind) =>
      [
        { status: "failed", kind },
        `${BACKUP_FAILURES[kind].cause} Buzz tries again when you next sign in to Builderlab.`,
      ] as const,
  ),
] as const)(
  "reads the uploader's %o status as one sentence",
  async (progress, sentence) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    await renderBackup(at(1, progress)).settled();
    expect(backupRow()).toBeVisible();
    expect(screen.getByRole("status").textContent).toBe(sentence);
  },
);

it("hides the backup row wherever first run would not offer backup", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  // This build's uploader has no Builderlab source.
  await renderBackup(at(1, { status: "complete" }, false)).settled();
  expect(backupRow()).toBeNull();
  cleanup();
  // A build with no portal of its own never hands a credential over.
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
  await renderBackup(at(1, { status: "complete" })).settled();
  expect(backupRow()).toBeNull();
  // The public identity is unaffected.
  expect(screen.getByText(viewer, { exact: true })).toBeVisible();
});

it("follows the status store as it publishes a higher seq", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = renderBackup(at(1, { status: "idle" }));
  await host.settled();
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent(
    "Buzz hasn’t checked your key’s backup since it opened.",
  );
  host.push(at(2, { status: "running" }));
  expect(status).toHaveTextContent("Backing up your key…");
  host.push(at(3, { status: "failed", kind: "busy" }));
  const busy = /^Another backup of this key is in progress\. Buzz tries/;
  expect(status).toHaveTextContent(busy);
  // A late, lower seq is not newer news.
  host.push(at(2, { status: "complete" }));
  expect(status).toHaveTextContent(busy);
  host.push(at(4, { status: "complete" }));
  expect(status).toHaveTextContent("Your key is backed up to Builderlab.");
  // Read-only: no consent, retry or other control beside the status.
  const row = status.closest(".buzz-preference-row") as HTMLElement;
  expect(within(row).queryByRole("button")).toBeNull();
  expect(within(row).queryByRole("switch")).toBeNull();
});
