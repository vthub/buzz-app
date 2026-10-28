// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { EventTemplate } from "nostr-tools";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { formatPublicKey } from "../../shared/identity/public-key";
import nsecBackup from "../../../src-tauri/src/nsec_backup.rs?raw";
import {
  createIdentity,
  nativeIdentityEnabled,
  RECOVERY_REFUSED,
  RECOVERY_UNAVAILABLE,
  type Identity,
  type RecoveryResult,
} from "./service";
import { IdentitySetup } from "./IdentitySetup";
import { PrivateKey } from "./PrivateKey";
import { SignOutDialog, WIPE_PHRASE } from "./SignOut";
import { Welcome } from "./Welcome";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import { BackupError, type BackupStatus } from "./backup";
import {
  builderlabAccount,
  type FirstRunAccount,
  type OwnedCommunity,
} from "./builderlab-account";
import type { JoinPolicy } from "../communities/join-policy";
import { createCommunities } from "../communities/service";
import { connectNativeTransport } from "../relay/native";
import { keypair, profile, signed } from "../relay/testing";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));
/** The landing and Connect to {host} primary, as the Buzz mobile client labels it. */
const SIGN_IN = "Sign in with email";
const viewer = "ab".repeat(32);
const key = "nsec-fixture-only";
/** A real key for the import journeys: native import takes the bech32 nsec as typed. */
const owned = keypair();
const ownedNsec = nsecEncode(owned.secret);
const credential: Credential = {
  value: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: false,
  },
};
const welcomeHeading = () => screen.getByRole("heading", { name: "Buzz" });
const connectButton = () => screen.getByRole("button", { name: SIGN_IN });
function titleBar() {
  const header = document.querySelector("header");
  if (!header) throw new Error("Missing native title bar");
  return header;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
/** Welcome reads the Communities service only to join; these screens never get there. */
const noJoin: ComponentProps<typeof Welcome>["communities"] = {
  snapshot() {
    throw new Error("Welcome consulted communities before a join");
  },
  joined() {
    throw new Error("Welcome joined without a join");
  },
  select() {
    throw new Error("Welcome selected a community without a restore");
  },
};
/** The app's invite intent: only a restore that skipped the typed address opens it. */
const invites = { open: vi.fn() };
/** The first-run Join Community join's save to the account; nothing else saves. */
const saveCommunity = vi.fn<FirstRunAccount["saveCommunity"]>(() =>
  Promise.resolve(),
);
type BackupAnswers = Partial<
  Pick<FirstRunAccount, "backUp" | "backupStatus" | "recovery">
>;
const unexpectedRecovery = () => {
  throw new Error("Welcome recovered a key without Restore from backup");
};
/**
 * Every backup succeeding, as on the build's own portal; backup status
 * unavailable, as on most tenants, so nothing is restored.
 */
const backupAnswers = {
  backUp: () => Promise.resolve(),
  backupStatus: () => Promise.resolve("unavailable" as const),
  recovery: {
    subscribe: unexpectedRecovery,
    snapshot: unexpectedRecovery,
    beginRecovery: unexpectedRecovery,
    installRecovery: unexpectedRecovery,
    cancelRecovery: unexpectedRecovery,
  },
} satisfies BackupAnswers;
/** Only Start over unlinks; no other lane may reach kgoose's delete. */
const noUnlink = () =>
  Promise.reject(new Error("Welcome unlinked a key it did not replace"));
/** The signed-in account with no key bound and nothing owned, binding through `bind`. */
const unlinkedWith =
  (
    bind: FirstRunAccount["bind"],
    backup: BackupAnswers = {},
  ): ComponentProps<typeof Welcome>["account"] =>
  () => ({
    linkedKey: () => Promise.resolve(null),
    ownedCommunities: () => Promise.resolve([]),
    knownCommunities: () => Promise.resolve([]),
    saveCommunity,
    bind,
    unbind: noUnlink,
    ...backupAnswers,
    ...backup,
  });
/** Today's every user: nothing bound or owned, and binding the new key succeeds. */
const unlinked = unlinkedWith(() => Promise.resolve());
const roots: Context[] = [];
/** The production shape: the service exists at startup and hydrates once the key is ready. */
function communitiesFor(identity: Identity, openRelay = "") {
  const ctx = new Context();
  roots.push(ctx);
  return createCommunities(
    ctx,
    false,
    undefined,
    openRelay,
    undefined,
    identity.ready,
    connectNativeTransport,
  );
}
afterEach(async () => {
  cleanup();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("keeps native titlebar actions available throughout identity setup without dragging form controls", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const startDragging = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getCurrentWindow).mockReturnValue({
    startDragging,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  const restored = deferred<null>();
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return restored.promise;
    if (command === "nsec_backup_available") return Promise.resolve(false);
    if (command === "identity_legacy_available") return Promise.resolve(false);
    if (command === "identity_import") return imported.promise;
    if (command === "title_bar_double_click") return Promise.resolve();
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <IdentitySetup identity={identity}>
      <p>Signed in</p>
    </IdentitySetup>,
  );
  const drag = () => {
    fireEvent.mouseDown(titleBar(), {
      button: 0,
      detail: 1,
    });
  };
  drag();
  expect(startDragging).toHaveBeenCalledTimes(1);
  await act(async () => restored.resolve(null));
  drag();
  expect(startDragging).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Use an existing key" }));
  await user.type(screen.getByLabelText("Private key (nsec)"), key);
  expect(startDragging).toHaveBeenCalledTimes(2);
  drag();
  expect(startDragging).toHaveBeenCalledTimes(3);
  await user.click(
    screen.getByRole("button", { name: "Import this identity" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Saving your identity");
  drag();
  expect(startDragging).toHaveBeenCalledTimes(4);
  await user.dblClick(titleBar());
  expect(invoke).toHaveBeenCalledWith("title_bar_double_click");
  await act(async () => imported.resolve(viewer));
  expect(document.querySelector("header")).toBeNull();
  expect(screen.getByText("Signed in")).toBeVisible();
  identity.dispose();
});

it.each([
  [false, "Win32"],
  [false, "MacIntel"],
])("does not add a titlebar for native=%s on %s", (native, platform) => {
  vi.mocked(isTauri).mockReturnValue(native);
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
  const identity = createIdentity();
  render(<IdentitySetup identity={identity}>Signed in</IdentitySetup>);
  expect(document.querySelector("header")).toBeNull();
  identity.dispose();
});

it("offers alternatives, passes exactly the imported key, and keeps secrets out of snapshots", async () => {
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "nsec_backup_available") return Promise.resolve(false);
    if (command === "identity_legacy_available") return Promise.resolve(false);
    if (command === "identity_import") return imported.promise;
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <IdentitySetup identity={identity}>
      <p>Signed in</p>
    </IdentitySetup>,
  );
  const useKey = await screen.findByRole("button", {
    name: "Use an existing key",
  });
  await user.click(useKey);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("button", { name: "Use an existing key" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  await user.type(screen.getByLabelText("Private key (nsec)"), key);
  await user.click(
    screen.getByRole("button", { name: "Import this identity" }),
  );
  expect(invoke).toHaveBeenCalledWith("identity_import", { nsec: key });
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Import this identity" }),
  ).toBeDisabled();
  await act(async () => {
    imported.resolve(viewer);
  });
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(await identity.ready).toBe(viewer);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "nsec_backup_available",
    "identity_legacy_available",
    "identity_import",
  ]);
  identity.dispose();
});

it("brings over installed old Buzz's identity only after an explicit click", async () => {
  const imported = deferred<string>();
  const legacy = deferred<boolean>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "nsec_backup_available") return Promise.resolve(false);
    if (command === "identity_legacy_available") return legacy.promise;
    if (command === "identity_import_legacy") return imported.promise;
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <IdentitySetup identity={identity}>
      <p>Signed in</p>
    </IdentitySetup>,
  );
  // A click must not reach Create before migration can be offered first.
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("identity_legacy_available"),
  );
  expect(
    screen.queryByRole("button", { name: "Create a new identity" }),
  ).toBeNull();
  await act(async () => legacy.resolve(true));
  const bringOver = await screen.findByRole("button", {
    name: "Continue with your Buzz identity",
  });
  expect(invoke).not.toHaveBeenCalledWith("identity_import_legacy", {});
  await user.click(bringOver);
  expect(invoke).toHaveBeenCalledWith("identity_import_legacy", {});
  expect(
    screen.getByRole("button", { name: "Create a new identity" }),
  ).toBeDisabled();
  await act(async () => {
    imported.resolve(viewer);
  });
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  identity.dispose();
});

const previousViewer = "cd".repeat(32);
function mountRecovery(
  result: RecoveryResult,
  override?: (command: string) => Promise<unknown> | undefined,
) {
  vi.mocked(invoke).mockImplementation((command) => {
    const overridden = override?.(command);
    if (overridden) return overridden as ReturnType<typeof invoke>;
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "nsec_backup_available") return Promise.resolve(true);
    if (command === "identity_legacy_available") return Promise.resolve(false);
    if (command === "nsec_restore_begin")
      return Promise.resolve({ attempt: "attempt" });
    if (command === "nsec_restore_wait") return Promise.resolve(result);
    if (command === "nsec_restore_cancel") return Promise.resolve();
    if (command === "nsec_restore_install" || command === "identity_create")
      return Promise.resolve(viewer);
    throw new Error("Unexpected fixture command");
  });
  const identity = createIdentity();
  const view = render(
    <IdentitySetup identity={identity}>Restored identity</IdentitySetup>,
  );
  return { identity, ...view };
}
const recovered: RecoveryResult = {
  candidates: [
    { handle: "previous", pubkey: previousViewer },
    { handle: "current", pubkey: viewer },
  ],
  currentPubkey: viewer,
  failedCount: 0,
};

it.each([false, "unavailable"])(
  "hides backup restore when availability is %s",
  async (availability) => {
    const { identity } = mountRecovery(recovered, (command) =>
      command === "nsec_backup_available"
        ? availability === false
          ? Promise.resolve(false)
          : Promise.reject("unavailable")
        : undefined,
    );
    await screen.findByRole("button", { name: "Create a new identity" });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("nsec_backup_available"),
    );
    expect(
      screen.queryByRole("button", { name: "Restore from backup" }),
    ).toBeNull();
    identity.dispose();
  },
);

it.each([
  "Secure storage is locked",
  "Secure storage is unavailable",
  "Saved identity is corrupt",
])("does not offer recovery or inspect availability when %s", async (error) => {
  const { identity } = mountRecovery(recovered, (command) =>
    command === "identity_restore" ? Promise.reject(error) : undefined,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(error);
  expect(
    screen.getByRole("button", { name: "Retry secure storage access" }),
  ).toBeEnabled();
  expect(invoke).toHaveBeenCalledTimes(1);
  identity.dispose();
});

it("prefers the associated identity, waits for explicit consent and persistence before becoming ready", async () => {
  const installed = deferred<string>();
  const { identity } = mountRecovery(recovered, (command) =>
    command === "nsec_restore_install" ? installed.promise : undefined,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  const restore = await screen.findByRole("button", {
    name: "Restore this identity",
  });
  expect(
    screen.getByRole("radio", { name: /^npub…/, checked: true }),
  ).toHaveAccessibleDescription(/Current identity/);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "nsec_restore_install"),
  ).toBe(false);
  try {
    await user.click(restore);
    expect(invoke).toHaveBeenLastCalledWith("nsec_restore_install", {
      attempt: "attempt",
      handle: "current",
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving your identity securely",
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(identity.snapshot().status).toBe("missing");
  } finally {
    await act(async () => installed.resolve(viewer));
  }
  expect(await screen.findByText("Restored identity")).toBeVisible();
  expect(await identity.ready).toBe(viewer);
  identity.dispose();
});

it("describes a previous identity selection accurately when the current identity is also available", async () => {
  const { identity } = mountRecovery(recovered, (command) =>
    command === "nsec_restore_install"
      ? Promise.resolve(previousViewer)
      : undefined,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await user.click(
    await screen.findByRole("radio", {
      name: (label) => label === formatPublicKey(previousViewer),
    }),
  );
  expect(
    screen.getByText("Choose the Buzz identity to restore on this device."),
  ).toBeVisible();
  expect(
    screen.getByText("This won’t change the identity linked to your account."),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Restore this identity" }),
  );
  expect(invoke).toHaveBeenCalledWith("nsec_restore_install", {
    attempt: "attempt",
    handle: "previous",
  });
  expect(await screen.findByText("Restored identity")).toBeVisible();
  identity.dispose();
});

it("requires a historical identity choice when the associated key is absent and reports partial recovery", async () => {
  const { identity } = mountRecovery({
    ...recovered,
    currentPubkey: "ef".repeat(32),
    failedCount: 1,
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  const restore = await screen.findByRole("button", {
    name: "Restore this identity",
  });
  expect(restore).toBeDisabled();
  expect(
    screen.getByText(/Your current identity isn’t in these backups/),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Some backups couldn’t be recovered",
  );
  await user.click(
    screen.getByRole("radio", {
      name: (label) => label === formatPublicKey(viewer),
    }),
  );
  expect(restore).toBeEnabled();
  await user.click(restore);
  expect(await screen.findByText("Restored identity")).toBeVisible();
  expect(invoke).toHaveBeenCalledWith("nsec_restore_install", {
    attempt: "attempt",
    handle: "current",
  });
  identity.dispose();
});

it.each([
  [0, "No backups were found for this account."],
  [2, "Your backups couldn’t be recovered. Try again."],
])(
  "distinguishes an empty recovery from failed backups (%s)",
  async (failedCount, message) => {
    const { identity } = mountRecovery({
      candidates: [],
      currentPubkey: null,
      failedCount,
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Restore from backup" }),
    );
    expect(await screen.findByText(message)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Restore this identity" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Try recovery again" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([command]) => command === "nsec_restore_begin"),
      ).toHaveLength(2),
    );
    identity.dispose();
  },
);

it.each([
  ["nsec_restore_wait", "Could not restore your identity. Try again."],
  ["nsec_restore_wait", "Restore was canceled. Try again."],
  ["nsec_restore_install", "Could not restore your identity. Try again."],
])(
  "keeps %s failures retryable without creating or adopting an identity",
  async (operation, message) => {
    const { identity } = mountRecovery(recovered, (command) =>
      command === operation ? Promise.reject(message) : undefined,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Restore from backup" }),
    );
    if (operation === "nsec_restore_install")
      await user.click(
        await screen.findByRole("button", { name: "Restore this identity" }),
      );
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(
      screen.getByRole("button", { name: "Try recovery again" }),
    ).toBeEnabled();
    expect(identity.snapshot().status).toBe("missing");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("button", { name: "Use an existing key" }),
    ).toBeEnabled();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "identity_create"),
    ).toBe(false);
    identity.dispose();
  },
);

it.each([
  ["nsec_restore_begin", RECOVERY_UNAVAILABLE],
  ["nsec_restore_wait", RECOVERY_UNAVAILABLE],
  ["nsec_restore_wait", RECOVERY_REFUSED],
])(
  "offers no Try recovery again when %s answers %s, which no retry changes",
  async (operation, message) => {
    const { identity } = mountRecovery(recovered, (command) =>
      command === operation ? Promise.reject(message) : undefined,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Restore from backup" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(
      screen.queryByRole("button", { name: "Try recovery again" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("button", { name: "Use an existing key" }),
    ).toBeEnabled();
    identity.dispose();
  },
);

it("matches native recovery's unavailable and refused messages exactly", () => {
  // `recoveryOff` compares strings across IPC, so a reworded native message
  // would quietly bring Try recovery again back.
  expect(nsecBackup).toContain(
    `const UNAVAILABLE: &str = "${RECOVERY_UNAVAILABLE}";`,
  );
  expect(nsecBackup).toContain(`const REFUSED: &str = "${RECOVERY_REFUSED}";`);
});

it("keeps a failed cancellation visible and blocks key changes until Back succeeds", async () => {
  let cancellations = 0;
  const { identity } = mountRecovery(recovered, (command) => {
    if (command === "nsec_restore_cancel" && ++cancellations === 1)
      return Promise.reject(new Error("Synthetic IPC failure"));
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await screen.findByRole("button", { name: "Restore this identity" });
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t cancel recovery. Try Back again.",
  );
  await identity.create();
  await identity.importKey(key);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) =>
          command === "identity_create" || command === "identity_import",
      ),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByRole("button", { name: "Use an existing key" }),
  ).toBeEnabled();
  expect(cancellations).toBe(2);
  identity.dispose();
});

it("retries a recovery error only after the prior attempt is canceled", async () => {
  const canceled = deferred<void>();
  let waits = 0;
  const { identity } = mountRecovery(recovered, (command) => {
    if (command === "nsec_restore_wait" && ++waits === 1)
      return Promise.reject("Could not restore your identity. Try again.");
    if (command === "nsec_restore_cancel") return canceled.promise;
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await screen.findByRole("alert");
  try {
    await user.click(
      screen.getByRole("button", { name: "Try recovery again" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("nsec_restore_cancel", {
        attempt: "attempt",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Canceling recovery");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "nsec_restore_begin"),
    ).toHaveLength(1);
  } finally {
    await act(async () => canceled.resolve());
  }
  expect(
    await screen.findByRole("button", { name: "Restore this identity" }),
  ).toBeEnabled();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "nsec_restore_begin"),
  ).toHaveLength(2);
  identity.dispose();
});

it("rejects an installed viewer that differs from the selected identity", async () => {
  const { identity } = mountRecovery(recovered, (command) =>
    command === "nsec_restore_install"
      ? Promise.resolve(previousViewer)
      : undefined,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Restore this identity" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The restored identity could not be verified. Restart the app.",
  );
  expect(identity.snapshot().status).toBe("missing");
  expect(screen.queryByText("Restored identity")).toBeNull();
  identity.dispose();
});

it("fences late recovery after cancellation before allowing creation", async () => {
  const waiting = deferred<RecoveryResult>();
  const cancelled = deferred<void>();
  const { identity } = mountRecovery(recovered, (command) => {
    if (command === "nsec_restore_wait") return waiting.promise;
    if (command === "nsec_restore_cancel") return cancelled.promise;
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await screen.findByText(/Sign in in your browser/);
  try {
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("nsec_restore_cancel", {
        attempt: "attempt",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Canceling recovery");
    await identity.create();
    await identity.importKey(key);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([command]) =>
            command === "identity_create" || command === "identity_import",
        ),
    ).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Create a new identity" }),
    ).toBeNull();
    await act(async () => waiting.resolve(recovered));
    expect(
      screen.queryByRole("button", { name: "Restore this identity" }),
    ).toBeNull();
  } finally {
    await act(async () => {
      waiting.resolve(recovered);
      cancelled.resolve();
    });
  }
  await user.click(
    await screen.findByRole("button", { name: "Create a new identity" }),
  );
  expect(await screen.findByText("Restored identity")).toBeVisible();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "nsec_restore_install"),
  ).toBe(false);
  identity.dispose();
});

it("retires a browser sign-in that starts after setup is unmounted", async () => {
  const begun = deferred<{ attempt: string }>();
  const { identity, unmount } = mountRecovery(recovered, (command) =>
    command === "nsec_restore_begin" ? begun.promise : undefined,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  unmount();
  await act(async () => begun.resolve({ attempt: "late-attempt" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nsec_restore_cancel", {
      attempt: "late-attempt",
    }),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "nsec_restore_wait"),
  ).toBe(false);
  identity.dispose();
});

it("first launch offers email sign-in and a live community URL field, with QR scanning disabled", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const identity = createIdentity();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={vi.fn()}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  // The loading state is titled "Your Buzz identity"; wait for the missing state.
  expect(await screen.findByRole("button", { name: SIGN_IN })).toBeEnabled();
  expect(welcomeHeading()).toBeVisible();
  // The onboarding tagline breaks its line after the dash.
  expect(
    screen.getByText(
      /^Your people, your agents, your projects —\s*all in one place\.$/,
    ),
  ).toBeVisible();
  const url = screen.getByRole("textbox", { name: "Community URL" });
  expect(url).toBeEnabled();
  expect(url).toHaveValue("");
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Scan a QR code — Coming soon" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: /existing key|new identity/ }),
  ).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

/**
 * A relay that answers the two unauthenticated reads a landing URL triggers,
 * before any key exists. `info` holds the NIP-11 answer so the page can be
 * observed waiting on it; the policy is missing, as on most deployments.
 * `created` holds key creation so "Creating keys…" can be observed.
 */
function landingRelay(
  origin = "https://relay.example.com:8443",
  created: Promise<string> = Promise.resolve(viewer),
) {
  const relayCalls: unknown[] = [];
  const info = deferred<void>();
  const answer = (status: number, body = "") => ({ status, headers: {}, body });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return null;
    if (command === "identity_create") return created;
    if (command === "identity_import") return owned.pubkey;
    if (command === "identity_export") return key;
    if (command !== "relay_http")
      throw new Error(`Unexpected command ${command}`);
    relayCalls.push(args);
    const { path } = args as { path: string };
    if (path !== "/") return answer(404);
    await info.promise;
    return answer(
      200,
      JSON.stringify({
        name: "Buzz Relay",
        icon: "https://cdn.example.com/icon.png",
      }),
    );
  });
  const get = (path: string) => ({
    community: origin,
    path,
    method: "GET",
    body: null,
  });
  return { relayCalls, info, lookup: [get("/"), get("/api/join-policy")] };
}
const urlField = () => screen.getByRole("textbox", { name: "Community URL" });
const urlContinue = () => screen.getByRole("button", { name: "Continue" });
/** The key choice a setup with no backed-up key pauses on; Create links and backs up the key. */
const createMyKey = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: "Create my key" }));
const keySavedNote =
  "Your key is saved on this device, but it isn’t backed up yet.";
const keyUnlinkedNote =
  "Your key is saved on this device, but it isn’t linked to your account or backed up yet.";
/** The test table: relay.example.com (any subdomain, default port) signs in at tenant.example. */
const tenants = [
  { relayHost: "relay.example.com", loginOrigin: "https://tenant.example" },
];

it("a landing URL is looked up before sign-in, a tenant's relay signs in at that tenant's portal, setup then lands on Join Community, and Cancel reaches Join a community with the address kept", async () => {
  const relay = landingRelay("https://relay.example.com");
  const released = deferred<Credential>();
  const connect = vi.fn(
    (_signal: AbortSignal, _origin?: string) => released.promise,
  );
  const { backupStatus, release } = gatedStatus();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinkedWith(() => Promise.resolve(), { backupStatus })}
      connect={connect}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), "Design.Relay.Example.com{Enter}");
  // Discovery: the same two unauthenticated GETs the find page sends, with
  // no sign-in and no key yet. The field is gone: the heading takes focus.
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toHaveFocus();
  expect(screen.getByText("design.relay.example.com")).toBeVisible();
  const lookup = relay.lookup.map((call) => ({
    ...call,
    community: "https://design.relay.example.com",
  }));
  expect(relay.relayCalls).toEqual(lookup);
  expect(connect).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await act(async () => relay.info.resolve());
  // Found: the host matches the tenant row as a subdomain, so sign-in starts
  // at once at that tenant's portal; the landing shows it pending with the
  // typed address held in the disabled field.
  expect(connect).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    "https://tenant.example",
  );
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  expect(urlField()).toBeDisabled();
  expect(urlField()).toHaveValue("Design.Relay.Example.com");
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  await act(async () => released.resolve(credential));
  // The account check found no key, so the backed-up-key lookup comes next.
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for a backed-up key…",
    ),
  );
  await release();
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await createMyKey(user);
  // Setup ran (the key exists) and landed on the find page for that URL, not
  // on the choices page.
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(backupStatus).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("identity_create", {});
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  // The account saved no communities: nothing restored, nothing handed off.
  expect(invites.open).not.toHaveBeenCalled();
  expect(relay.relayCalls).toEqual([...lookup, ...lookup]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(urlField()).toHaveValue("Design.Relay.Example.com");
  // Continue from the choices page looks the same address up again.
  await user.click(urlContinue());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(relay.relayCalls).toHaveLength(6);
  identity.dispose();
});

/** The connect choice a found community no tenant hosts pauses on. */
const connectChoiceHeading = () =>
  screen.getByRole("heading", { name: "Connect to your community" });
/** The found host, shown under the title rather than in it. */
const connectChoiceHost = () => screen.getByText("relay.example.com:8443");
/** Type the non-hosted address (the tenant's host on a non-default port) through to the choice. */
async function connectChoicePage(
  user: ReturnType<typeof userEvent.setup>,
  relay: ReturnType<typeof landingRelay>,
) {
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), "relay.example.com:8443{Enter}");
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(relay.relayCalls).toEqual(relay.lookup);
  await act(async () => relay.info.resolve());
  expect(connectChoiceHeading()).toBeVisible();
  expect(connectChoiceHost()).toBeVisible();
}

it("a landing URL no tenant hosts pauses on Connect to {host} with no sign-in and no key, and Back keeps the address", async () => {
  const relay = landingRelay();
  const connect = vi.fn();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={connect}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await connectChoicePage(user, relay);
  // Found, but no tenant hosts it: nothing runs until the user says who
  // provides the key. The body is one sentence: why a key is needed at all.
  expect(
    screen.getByText("Buzz relies on a key for your identity."),
  ).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "I already have a key" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(screen.queryByRole("heading", { name: "Setting up Buzz" })).toBeNull();
  expect(connect).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  expect(relay.relayCalls).toEqual(relay.lookup);
  // Back is the landing, with the address editable and not looked up again.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(screen.queryByRole("heading", { name: /^Connect to / })).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(urlField()).toBeEnabled();
  expect(urlField()).toHaveValue("relay.example.com:8443");
  expect(relay.relayCalls).toEqual(relay.lookup);
  expect(identity.snapshot().status).toBe("missing");
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("Sign in with email from the choice signs in at the build portal, runs the Connect lane with its key backup, and lands on Join Community for the address", async () => {
  const relay = landingRelay();
  const released = deferred<Credential>();
  const connect = vi.fn(
    (_signal: AbortSignal, _origin?: string) => released.promise,
  );
  const { backupStatus, release } = gatedStatus();
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const account = vi.fn(
    unlinkedWith(() => Promise.resolve(), { backupStatus, backUp }),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={account}
      connect={connect}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await connectChoicePage(user, relay);
  await user.click(connectButton());
  // The landing's own sign-in, at the build portal (no tenant origin), shown
  // pending on the landing with the address held, as for a tenant.
  expect(connect).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledWith(expect.any(AbortSignal), undefined);
  expect(screen.queryByRole("heading", { name: /^Connect to / })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  expect(urlField()).toBeDisabled();
  expect(urlField()).toHaveValue("relay.example.com:8443");
  expect(relay.relayCalls).toEqual(relay.lookup);
  await act(async () => released.resolve(credential));
  // The reads go to the build portal too, and the lane is Connect's: account
  // check, backed-up-key lookup, then the key choice.
  expect(account).toHaveBeenCalledWith(credential, undefined, identity);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for a backed-up key…",
    ),
  );
  await release();
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await createMyKey(user);
  // Created, linked and backed up at the build portal, then the find page for
  // the address rather than the choices page.
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(backUp.mock.calls).toEqual([[viewer]]);
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  // The account saved no communities: no restore read, no handoff.
  expect(invites.open).not.toHaveBeenCalled();
  expect(relay.relayCalls).toEqual([...relay.lookup, ...relay.lookup]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_create",
    "relay_http",
    "relay_http",
  ]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(urlField()).toHaveValue("relay.example.com:8443");
  identity.dispose();
});

it("Cancel sign-in after Connect from the choice returns to the landing with the address kept and no second lookup", async () => {
  const relay = landingRelay();
  let signal: AbortSignal | undefined;
  const connect = vi.fn(
    (current: AbortSignal, _origin?: string): Promise<Credential> => {
      signal = current;
      return new Promise(() => {});
    },
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={connect}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await connectChoicePage(user, relay);
  await user.click(connectButton());
  await screen.findByRole("button", { name: "Cancel sign-in" });
  expect(connect).toHaveBeenCalledWith(expect.any(AbortSignal), undefined);
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(signal?.aborted).toBe(true);
  // The landing, not the choice: the address is editable again and neither
  // discovery nor the choice page came back on their own.
  expect(welcomeHeading()).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(urlField()).toBeEnabled();
  expect(urlField()).toHaveValue("relay.example.com:8443");
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(screen.queryByRole("heading", { name: /^Connect to / })).toBeNull();
  expect(relay.relayCalls).toEqual(relay.lookup);
  expect(identity.snapshot().status).toBe("missing");
  identity.dispose();
});

it("I already have a key from the choice imports the key with no sign-in, no link and no backup offer, and lands on Join Community for the address", async () => {
  const relay = landingRelay();
  // Hold the import so the progress page can be seen.
  const imported = deferred<string>();
  const relayAnswers = vi.mocked(invoke).getMockImplementation();
  if (!relayAnswers) throw new Error("landingRelay installed no answers");
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "identity_import"
      ? imported.promise
      : relayAnswers(command, args),
  );
  const connect = vi.fn();
  const account = vi.fn(unlinked);
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={account}
      connect={connect}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await connectChoicePage(user, relay);
  await user.click(
    screen.getByRole("button", { name: "I already have a key" }),
  );
  expect(
    screen.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  // No account, so no linked key to expect: any valid nsec is accepted.
  await user.paste(ownedNsec);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(keyField()).toHaveAccessibleDescription(
    `Public identity: ${npubEncode(owned.pubkey)}`,
  );
  expect(continueWithKey()).toBeEnabled();
  // Back is the choice, not Set up your key, and reopening starts clean.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(connectChoiceHeading()).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Set up your key" })).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "I already have a key" }),
  );
  expect(keyField()).toHaveValue("");
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(invoke).toHaveBeenCalledWith("identity_import", { nsec: ownedNsec });
  expect(
    screen.getByRole("heading", { name: "Setting up Buzz" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Importing your key…");
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  expectNoImportActions();
  expect(screen.queryByText("Signed in")).toBeNull();
  await act(async () => imported.resolve(owned.pubkey));
  // The import is the whole setup: nobody's account to link to, nothing to
  // offer a backup for, straight to the find page for the address.
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(
    screen.queryByRole("heading", { name: "Back up this key?" }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(connect).not.toHaveBeenCalled();
  // No account, so no saved communities: nothing is restored or handed off.
  expect(account).not.toHaveBeenCalled();
  expect(invites.open).not.toHaveBeenCalled();
  expect(relay.relayCalls).toEqual([...relay.lookup, ...relay.lookup]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_import",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("a native import refusal from the choice stays under the field, and Back returns to the choice", async () => {
  const relay = landingRelay();
  const relayAnswers = vi.mocked(invoke).getMockImplementation();
  if (!relayAnswers) throw new Error("landingRelay installed no answers");
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "identity_import"
      ? Promise.reject("An identity is already saved; nothing was overwritten")
      : relayAnswers(command, args),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={vi.fn()}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await connectChoicePage(user, relay);
  await user.click(
    screen.getByRole("button", { name: "I already have a key" }),
  );
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "An identity is already saved; nothing was overwritten",
  );
  expect(
    screen.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeNull();
  expect(keyField()).toHaveValue(ownedNsec);
  expect(identity.snapshot().status).toBe("missing");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(connectChoiceHeading()).toBeVisible();
  expect(
    screen.getByRole("button", { name: "I already have a key" }),
  ).toHaveFocus();
  expect(relay.relayCalls).toEqual(relay.lookup);
  identity.dispose();
});

it("a landing URL that cannot be reached fails before sign-in, and Cancel keeps the address", async () => {
  const relayCalls: unknown[] = [];
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "relay_http") {
      relayCalls.push(args);
      return Promise.reject(new Error("connection refused"));
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const connect = vi.fn();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={connect}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), "relay.example.com{Enter}");
  expect(
    await screen.findByRole("heading", { name: "Couldn’t find community" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach the relay. Check your connection and try again.",
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(connect).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(welcomeHeading()).toBeVisible();
  expect(welcomeHeading()).toHaveFocus();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(connectButton()).toBeEnabled();
  expect(urlField()).toHaveValue("relay.example.com");
  expect(relayCalls).toHaveLength(2);
  expect(identity.snapshot().status).toBe("missing");
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("canceling or failing sign-in after a landing URL returns to the landing with the address kept and no second lookup", async () => {
  const relay = landingRelay("https://relay.example.com");
  relay.info.resolve();
  let signal: AbortSignal | undefined;
  const connect = vi
    .fn<(signal: AbortSignal, origin?: string) => Promise<Credential>>()
    .mockImplementationOnce((current) => {
      signal = current;
      return new Promise(() => {});
    })
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockRejectedValueOnce(new Error("Browser could not open."));
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={connect}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), "relay.example.com{Enter}");
  await screen.findByRole("button", { name: "Cancel sign-in" });
  expect(connect).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    "https://tenant.example",
  );
  expect(connect).toHaveBeenCalledTimes(1);
  expect(relay.relayCalls).toEqual(relay.lookup);
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(signal?.aborted).toBe(true);
  // Back on the landing: the typed address is editable again and discovery
  // did not restart on its own.
  expect(welcomeHeading()).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(urlField()).toBeEnabled();
  expect(urlField()).toHaveValue("relay.example.com");
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(relay.relayCalls).toEqual(relay.lookup);
  // Connect without the URL: the tenant origin from the cancelled sign-in
  // must not leak into this one.
  await user.click(connectButton());
  await screen.findByRole("button", { name: "Cancel sign-in" });
  expect(connect).toHaveBeenCalledTimes(2);
  expect(connect).toHaveBeenLastCalledWith(expect.any(AbortSignal), undefined);
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(welcomeHeading()).toBeVisible();
  expect(urlField()).toHaveValue("relay.example.com");
  expect(relay.relayCalls).toEqual(relay.lookup);
  // Continue again: a fresh lookup, then a sign-in that fails; Back behaves the same.
  await user.click(urlContinue());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Browser could not open.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t sign in" }),
  ).toBeVisible();
  expect(connect).toHaveBeenCalledTimes(3);
  expect(relay.relayCalls).toEqual([...relay.lookup, ...relay.lookup]);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(urlField()).toHaveValue("relay.example.com");
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(relay.relayCalls).toHaveLength(4);
  expect(identity.snapshot().status).toBe("missing");
  identity.dispose();
});

/** Backup status that answers only once released, so the lookup step can be seen running. */
function gatedStatus() {
  const answer = deferred<readonly string[] | "unavailable">();
  const backupStatus = vi.fn(() => answer.promise);
  const release = (listed: readonly string[] | "unavailable" = "unavailable") =>
    act(async () => {
      if (!backupStatus.mock.calls.length)
        throw new Error("The backed-up-key lookup never started");
      answer.resolve(listed);
    });
  return { backupStatus, release };
}

it("Sign in with email runs sign-in, creates the key mid-setup, and lands on Join a community", async () => {
  const created = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return created.promise;
    throw new Error("Unexpected command");
  });
  const released = deferred<Credential>();
  const connect = vi.fn((_signal: AbortSignal) => released.promise);
  const { backupStatus, release } = gatedStatus();
  const linked = deferred<string | null>();
  const bound = deferred<void>();
  const bind = vi.fn((_pubkey: string) => bound.promise);
  const backedUp = deferred<void>();
  const backUp = vi.fn((_pubkey: string) => backedUp.promise);
  // The saved-destinations list is read beside the key, and a failed list
  // changes nothing: a portal without the route answers a plain-text 404.
  const knownCommunities = vi.fn(() =>
    Promise.reject(
      new Error("Builderlab known communities failed (HTTP 404: not JSON)."),
    ),
  );
  const account = vi.fn(() => ({
    linkedKey: () => linked.promise,
    ownedCommunities: () => Promise.resolve([]),
    knownCommunities,
    saveCommunity,
    bind,
    unbind: noUnlink,
    ...backupAnswers,
    backUp,
    backupStatus,
  }));
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={account}
      connect={connect}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  expect(connect).toHaveBeenCalledTimes(1);
  // No community URL chose a tenant, so sign-in uses the build's default origin.
  expect(connect).toHaveBeenCalledWith(expect.any(AbortSignal), undefined);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  await act(async () => released.resolve(credential));
  expect(
    screen.getByRole("heading", { name: "Setting up Buzz" }),
  ).toBeVisible();
  // The landing's button is gone with the landing: the new heading has focus.
  expect(
    screen.getByRole("heading", { name: "Setting up Buzz" }),
  ).toHaveFocus();
  // The account check is real and runs first: it decides the lane.
  expect(account).toHaveBeenCalledWith(credential, undefined, identity);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking your account…",
  );
  // Both prelude reads are in flight under that one label.
  expect(knownCommunities).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await act(async () => linked.resolve(null));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking for a backed-up key…",
  );
  await release([]);
  // The lookup found nothing, so setup pauses for the key choice before any
  // key exists.
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toHaveFocus();
  // The lookup's sentence no longer carries the address: the signed-in line
  // does, once, with a way out if it is the wrong account.
  expect(
    screen.getByText(/backed-up key for this account, so let’s make one/),
  ).toBeVisible();
  expect(screen.getByText("Signed in as a@example.com.")).toBeVisible();
  expect(screen.queryByText(/backed-up key for a@example\.com/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Use a different account" }),
  ).toBeEnabled();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  // Creating is the backup consent, so the page says who can restore the key.
  expect(screen.getByText(/Block can use it to restore the key/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "I already have a key" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Create my key" })).toHaveAttribute(
    "data-variant",
    "prominent",
  );
  await createMyKey(user);
  expect(screen.getByRole("status")).toHaveTextContent("Creating keys…");
  expect(invoke).toHaveBeenCalledWith("identity_create", {});
  expect(bind).not.toHaveBeenCalled();
  await act(async () => created.resolve(viewer));
  // The key is now ready, but setup keeps the app behind the onboarding screens.
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(screen.queryByText("Signed in")).toBeNull();
  // The created key is bound to the account before anything is backed up.
  expect(screen.getByRole("status")).toHaveTextContent("Linking your key…");
  expect(bind.mock.calls).toEqual([[viewer]]);
  expect(backUp).not.toHaveBeenCalled();
  await act(async () => bound.resolve());
  // Then backed up, waiting on the native uploader's own answer.
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  expect(backUp.mock.calls).toEqual([[viewer]]);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  await act(async () => backedUp.resolve());
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toHaveFocus();
  expect(screen.queryByText("Signed in")).toBeNull();
  // No invite list yet: nothing serves pending invites, so the URL field is the only entry.
  expect(screen.queryByRole("list")).toBeNull();
  const url = screen.getByRole("textbox", { name: "Community URL" });
  expect(url).toBeEnabled();
  expect(url).toHaveValue("");
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  for (const name of [
    "Scan a QR code — Coming soon",
    "Create a community — Coming soon",
  ]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  expect(backupStatus).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("Use a different account on Set up your key signs the session out, returns to the landing with no key, and the next sign-in rebuilds the account reads", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
  });
  const second: Credential = {
    value: "second-token",
    account: { ...credential.account, email: "b@example.com" },
  };
  const first = deferred<Credential>();
  const again = deferred<Credential>();
  const connect = vi
    .fn((_signal: AbortSignal) => again.promise)
    .mockImplementationOnce((_signal: AbortSignal) => first.promise);
  // One stub per sign-in, each counting its own account read, so the second
  // sign-in is shown to build new reads rather than reuse the first's.
  const linkedKeys = [
    vi.fn(() => Promise.resolve(null)),
    vi.fn(() => Promise.resolve(null)),
  ];
  let signIns = 0;
  const account = vi.fn(
    (_credential: Credential, _origin: string | undefined, _id: Identity) => {
      const linkedKey = linkedKeys[signIns++];
      if (!linkedKey) throw new Error("A third sign-in");
      return {
        linkedKey,
        ownedCommunities: () => Promise.resolve([]),
        knownCommunities: () => Promise.resolve([]),
        saveCommunity,
        bind: () =>
          Promise.reject(new Error("Welcome bound a key it never created")),
        unbind: noUnlink,
        ...backupAnswers,
      };
    },
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={account}
      connect={connect}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await act(async () => first.resolve(credential));
  expect(
    await screen.findByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(screen.getByText("Signed in as a@example.com.")).toBeVisible();
  expect(account).toHaveBeenCalledTimes(1);
  expect(linkedKeys[0]).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("button", { name: "Use a different account" }),
  );
  // Back on the landing, signed out, with no key created or imported.
  expect(welcomeHeading()).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(screen.queryByRole("heading", { name: "Set up your key" })).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(identity.snapshot().status).toBe("missing");
  expect(connect).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  // Signing in again runs a new sign-in and reads the new account, not the old.
  await user.click(connectButton());
  expect(connect).toHaveBeenCalledTimes(2);
  await act(async () => again.resolve(second));
  expect(
    await screen.findByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(account).toHaveBeenCalledTimes(2);
  expect(account).toHaveBeenNthCalledWith(2, second, undefined, identity);
  expect(linkedKeys[0]).toHaveBeenCalledTimes(1);
  expect(linkedKeys[1]).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Signed in as b@example.com.")).toBeVisible();
  expect(screen.queryByText("Signed in as a@example.com.")).toBeNull();
  identity.dispose();
});

it.each([
  // Backups outlive an unlink, so an unlinked account may still list some.
  ["lists a backup", () => Promise.resolve(["ef".repeat(32)])],
  ["is unavailable", () => Promise.resolve("unavailable" as const)],
  ["fails", () => Promise.reject(new BackupError("unreachable"))],
])(
  "the key choice says no backed-up key was found only when the lookup listed none, not when it %s",
  async (_label, backupStatus) => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "identity_restore") return Promise.resolve(null);
      throw new Error(`Unexpected command ${command}`);
    });
    const identity = createIdentity();
    const user = userEvent.setup();
    render(
      <Welcome
        identity={identity}
        communities={noJoin}
        invites={invites}
        account={unlinkedWith(() => Promise.resolve(), { backupStatus })}
        connect={vi.fn().mockResolvedValue(credential)}
      >
        <p>Signed in</p>
      </Welcome>,
    );
    await user.click(await screen.findByRole("button", { name: SIGN_IN }));
    expect(
      await screen.findByRole("heading", { name: "Set up your key" }),
    ).toBeVisible();
    expect(screen.queryByText(/backed-up key/)).toBeNull();
    // Creating is still the backup consent.
    expect(
      screen.getByText(/Block can use it to restore the key/),
    ).toBeVisible();
    // No key is linked, so there is nothing to restore on this lane.
    expect(
      screen.queryByRole("button", { name: "Restore from backup" }),
    ).toBeNull();
    identity.dispose();
  },
);

it("a link that fails after the key is created blocks setup with only Try again, which runs the link again and, once it succeeds, backs the key up and lands on Join a community", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    throw new Error(`Unexpected command ${command}`);
  });
  const bind = vi
    .fn((_pubkey: string) => Promise.resolve())
    .mockRejectedValueOnce(
      new Error(
        "This Builderlab account is connected to another Buzz identity.",
      ),
    );
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinkedWith(bind, { backUp })}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await createMyKey(user);
  expect(
    await screen.findByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This Builderlab account is connected to another Buzz identity.",
  );
  expect(screen.getByText(keyUnlinkedNote)).toBeVisible();
  // The link, not only the backup, is left undone.
  expect(screen.queryByText(keySavedNote)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Continue without backup" }),
  ).toBeNull();
  expect(bind.mock.calls).toEqual([[viewer]]);
  // The key is saved; the backup never ran, and the app stays hidden.
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(backUp).not.toHaveBeenCalled();
  expect(screen.queryByText("Signed in")).toBeNull();
  // Nothing links the key later, so there is no way past a failed link: no
  // Back (which would lift the gate with an unlinked key) and no Continue,
  // only Try again, offered even for a refusal Builderlab may repeat.
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Continue without linking" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toHaveFocus();
  expect(screen.queryByText("Signed in")).toBeNull();
  // The link ran again and, once it held, the backup followed.
  expect(bind.mock.calls).toEqual([[viewer], [viewer]]);
  expect(backUp.mock.calls).toEqual([[viewer]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("a backup that times out after Create my key offers Try again, which re-runs only the backup, and setup lands on Join Community for a landing URL", async () => {
  const relay = landingRelay("https://relay.example.com");
  relay.info.resolve();
  const bind = vi.fn((_pubkey: string) => Promise.resolve());
  const timedOut = deferred<void>();
  const confirmed = deferred<void>();
  const backUp = vi
    .fn<FirstRunAccount["backUp"]>()
    .mockReturnValueOnce(timedOut.promise)
    .mockReturnValueOnce(confirmed.promise);
  const { backupStatus, release } = gatedStatus();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinkedWith(bind, { backUp, backupStatus })}
      connect={vi.fn().mockResolvedValue(credential)}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), "relay.example.com{Enter}");
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Checking for a backed-up key…",
  );
  await release();
  await createMyKey(user);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Backing up your key…",
    ),
  );
  await act(async () => timedOut.reject(new BackupError("timeout")));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Builderlab is taking too long to confirm your backup. Try again.",
  );
  expect(screen.getByText(keySavedNote)).toBeVisible();
  // Try again is the primary action, Continue without backup the secondary.
  expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute(
    "data-variant",
    "prominent",
  );
  expect(
    screen.getByRole("button", { name: "Continue without backup" }),
  ).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  expect(backUp.mock.calls).toEqual([[viewer], [viewer]]);
  expect(bind.mock.calls).toEqual([[viewer]]);
  await act(async () => confirmed.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(backupStatus).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_create",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("Join a community checks the typed URL, opens Finding community, and Cancel keeps the URL", async () => {
  const relayCalls: unknown[] = [];
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    if (command === "relay_http") {
      relayCalls.push(args);
      return new Promise(() => {});
    }
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await createMyKey(user);
  await screen.findByRole("heading", { name: "Join a community" });
  const field = () => screen.getByRole("textbox", { name: "Community URL" });
  // The page remounts after Cancel, so look the button up each time.
  const next = () => screen.getByRole("button", { name: "Continue" });
  // Join stays enabled while empty; clicking it answers with the same error.
  expect(next()).toBeEnabled();
  await user.click(next());
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Please enter a valid community URL",
  );
  expect(relayCalls).toEqual([]);
  await user.type(field(), "not a url{Enter}");
  expect(next()).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Please enter a valid community URL",
  );
  expect(field()).toHaveAccessibleDescription(
    "Please enter a valid community URL",
  );
  expect(relayCalls).toEqual([]);
  await user.clear(field());
  expect(screen.queryByRole("alert")).toBeNull();
  await user.type(field(), "Relay.Example.com:8443");
  expect(next()).toBeEnabled();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(screen.getByText("relay.example.com:8443")).toBeVisible();
  // Both unauthenticated reads go to the canonical origin through relay_http.
  expect(relayCalls).toEqual([
    {
      community: "https://relay.example.com:8443",
      path: "/",
      method: "GET",
      body: null,
    },
    {
      community: "https://relay.example.com:8443",
      path: "/api/join-policy",
      method: "GET",
      body: null,
    },
  ]);
  expect(screen.queryByText("Signed in")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  // Cancel's button is gone with the lookup: the heading takes focus.
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toHaveFocus();
  expect(field()).toHaveValue("Relay.Example.com:8443");
  await user.click(next());
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(relayCalls).toHaveLength(4);
  identity.dispose();
});

it("a found community shows Join Community after exactly the two unauthenticated GETs", async () => {
  const origin = "https://relay.example.com:8443";
  const relayCalls: unknown[] = [];
  const answer = (status: number, body = "") =>
    Promise.resolve({ status, headers: {}, body });
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    if (command === "relay_http") {
      relayCalls.push(args);
      const { path } = args as { path: string };
      if (path === "/")
        return answer(
          200,
          JSON.stringify({ name: "Buzz Relay", read_state_snapshot: {} }),
        );
      if (path === "/api/join-policy") return answer(404);
    }
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await createMyKey(user);
  await screen.findByRole("heading", { name: "Join a community" });
  await user.type(
    screen.getByRole("textbox", { name: "Community URL" }),
    "relay.example.com:8443{Enter}",
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(screen.getByText("relay.example.com:8443")).toHaveClass("font-mono");
  expect(screen.queryByText("Signed in")).toBeNull();
  // Nothing is signed with the key setup just created: the two unauthenticated
  // GETs are the only pre-join traffic, with no POST before the user opts in.
  expect(relayCalls).toEqual([
    { community: origin, path: "/", method: "GET", body: null },
    { community: origin, path: "/api/join-policy", method: "GET", body: null },
  ]);
  identity.dispose();
});

/**
 * A native first run against a relay that answers: the key setup creates is the
 * one the host signs with, so `identity_restore` learns it only after
 * `identity_create`. The kind-0 read waits on `query` so the pending join is
 * observable; `admitted` decides whether that read is answered or refused, and
 * `publish` whether a kind 0 posted to `/events` is accepted or fails with 500.
 * `others` answers further origins, each with its own relay key: admitted
 * (with the profile it holds, if any), refused, or `"down"`, whose discovery
 * read fails.
 * `policy` is the join policy (none by default). An invite claim waits on
 * `claim`, then answers `refusal` as the relay's error code, or admits the key.
 */
function nativeRelay(
  member: ReturnType<typeof keypair>,
  others: Record<
    string,
    {
      admitted: boolean | "down";
      profile?: ReturnType<typeof profile>;
      /** Holds the kind-0 read until resolved. */
      query?: Promise<void>;
    }
  > = {},
) {
  const relayKey = keypair();
  const otherKeys = new Map(
    Object.keys(others).map((origin) => [origin, keypair()]),
  );
  const origin = "https://relay.example.com:8443";
  const calls: Array<{
    community: string;
    path: string;
    method: string;
    body: unknown;
  }> = [];
  const relay = {
    origin,
    calls,
    admitted: true,
    publish: true,
    profile: undefined as ReturnType<typeof profile> | undefined,
    query: Promise.resolve(),
    policy: undefined as JoinPolicy | undefined,
    claim: Promise.resolve(),
    refusal: undefined as string | undefined,
    /** The claim admits the key, but its reply is lost on the way back. */
    lostClaim: false,
    /** Another device's newer kind 0, which the relay keeps over an accepted publish. */
    superseded: undefined as ReturnType<typeof profile> | undefined,
  };
  let created = false;
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_os_idle_seconds") return 0;
    if (command === "identity_restore") return created ? member.pubkey : null;
    if (command === "identity_create") {
      created = true;
      return member.pubkey;
    }
    if (command === "identity_export") return key;
    if (command === "relay_sign")
      return signed(member, (args as { event: EventTemplate }).event);
    if (command !== "relay_http")
      throw new Error(`Unexpected command ${command}`);
    const request = args as {
      community: string;
      path: string;
      method: string;
      body: string | null;
    };
    const body: unknown = request.body ? JSON.parse(request.body) : null;
    calls.push({ ...request, body });
    const answer = (status: number, value?: unknown) => ({
      status,
      headers: {},
      body: value === undefined ? "" : JSON.stringify(value),
    });
    const other = others[request.community];
    if (other) {
      if (other.admitted === "down") return answer(503);
      if (request.path === "/")
        return answer(200, { self: otherKeys.get(request.community)?.pubkey });
      if (request.path === "/events") {
        other.profile = body as ReturnType<typeof profile>;
        return answer(200, { accepted: true, event_id: other.profile.id });
      }
      if (request.path !== "/query") return answer(404);
      const filters = body as Array<{ kinds?: number[] }>;
      if (!filters.some((filter) => filter.kinds?.includes(0)))
        return answer(200, []);
      await other.query;
      if (!other.admitted) return answer(403, { error: "membership required" });
      return answer(200, other.profile ? [other.profile] : []);
    }
    if (request.path === "/")
      return answer(200, {
        name: "Buzz Relay",
        self: relayKey.pubkey,
        icon: "https://cdn.example.com/icon.png",
      });
    if (request.path === "/api/join-policy")
      return relay.policy ? answer(200, { policy: relay.policy }) : answer(404);
    if (request.path === "/api/invites/accept-policy")
      return answer(200, { receipt: "policy-receipt" });
    if (request.path === "/api/invites/claim") {
      await relay.claim;
      if (relay.refusal) return answer(403, { error: relay.refusal });
      relay.admitted = true;
      // Native IPC rejects with a plain string.
      if (relay.lostClaim)
        return Promise.reject("Relay response was interrupted");
      return answer(200, { status: "joined" });
    }
    if (request.path === "/query") {
      const filters = body as Array<{ kinds?: number[] }>;
      if (!filters.some((filter) => filter.kinds?.includes(0)))
        return answer(200, []);
      await relay.query;
      if (!relay.admitted) return answer(403, { error: "membership required" });
      return answer(200, relay.profile ? [relay.profile] : []);
    }
    if (request.path === "/events") {
      if (!relay.publish) return answer(500);
      const event = body as ReturnType<typeof profile>;
      relay.profile = relay.superseded ?? event;
      return answer(200, { accepted: true, event_id: event.id });
    }
    return answer(404);
  });
  return relay;
}
async function joinCommunityPage(
  identity: Identity,
  openRelay = "",
  address = "relay.example.com:8443",
  /** `"seed"` leaves `Welcome` its own default: the development seed when set. */
  account: ComponentProps<typeof Welcome>["account"] | "seed" = unlinked,
) {
  const communities = communitiesFor(identity, openRelay);
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={communities}
      invites={invites}
      account={account === "seed" ? undefined : account}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await createMyKey(user);
  await screen.findByRole("heading", { name: "Join a community" });
  await user.type(
    screen.getByRole("textbox", { name: "Community URL" }),
    `${address}{Enter}`,
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
  return { communities, user };
}

const eventsCalls = (relay: ReturnType<typeof nativeRelay>) =>
  relay.calls.filter((call) => call.path === "/events");
const claims = (relay: ReturnType<typeof nativeRelay>) =>
  relay.calls.filter((call) => call.path === "/api/invites/claim");
/** The join owner's recovery record for `member` (`buzz-community-joins.v1`). */
const journalOf = (member: ReturnType<typeof keypair>): unknown =>
  JSON.parse(
    localStorage.getItem(`buzz-community-joins.v1:${member.pubkey}`) ?? "null",
  );
/** The signed profile read of `member` at the relay: NIP-11, then the kind-0 query. */
function readCalls(
  relay: ReturnType<typeof nativeRelay>,
  member: ReturnType<typeof keypair>,
) {
  return restoreRead(relay.origin, member);
}
/** The profile step's Continue through the owner: a fresh read, the kind 0, its readback. */
function publishCalls(
  relay: ReturnType<typeof nativeRelay>,
  member: ReturnType<typeof keypair>,
) {
  return [
    ...readCalls(relay, member),
    {
      community: relay.origin,
      path: "/events",
      method: "POST",
      body: expect.objectContaining({ kind: 0, pubkey: member.pubkey }),
    },
    ...readCalls(relay, member),
  ];
}

it("Join journals the join, proves admission with the signed profile read, and continues to the profile step, whose Continue publishes the kind 0 with a readback and then saves the membership", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  const gate = deferred<void>();
  relay.query = gate.promise;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  expect(relay.calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Join" }));
  // The read is in flight: the page holds still and the app stays hidden.
  expect(screen.getByRole("status")).toHaveTextContent("Joining…");
  expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await waitFor(() => expect(relay.calls).toHaveLength(4));
  expect(relay.calls).toEqual([
    { community: relay.origin, path: "/", method: "GET", body: null },
    {
      community: relay.origin,
      path: "/api/join-policy",
      method: "GET",
      body: null,
    },
    { community: relay.origin, path: "/", method: "GET", body: null },
    {
      community: relay.origin,
      path: "/query",
      method: "POST",
      body: [
        {
          kinds: [0],
          authors: [member.pubkey],
          limit: 5,
          consistency: "strong",
        },
      ],
    },
  ]);
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(communities.snapshot().memberships).toEqual([]);
  // The join was journaled before anything was sent to the relay.
  expect(journalOf(member)).toEqual([
    { id: expect.any(String), community: relay.origin },
  ]);
  await act(async () => gate.resolve());
  // Admitted, the first community continues to the profile step rather than
  // into the app; as in the dialog, the membership waits for the step, and
  // so does the save to the account.
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(saveCommunity).not.toHaveBeenCalled();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(communities.snapshot()).toMatchObject({
    status: "ready",
    viewer: member.pubkey,
    memberships: [],
    selected: null,
  });
  expect(journalOf(member)).toEqual([
    { id: expect.any(String), community: relay.origin },
  ]);
  const membership = {
    id: relay.origin,
    name: "relay.example.com:8443",
    icon: "https://cdn.example.com/icon.png",
  };
  expect(
    screen.getByText(/agent handoffs in relay\.example\.com:8443\./),
  ).toBeVisible();
  // The relay holds no profile for the new key: the Builderlab email's local
  // part is suggested, focused, and Continue needs a name.
  const name = screen.getByRole("textbox", { name: "Display name" });
  expect(name).toHaveValue("a");
  expect(name).toHaveFocus();
  await user.clear(name);
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  await user.type(name, "Ada{Enter}");
  expect(await screen.findByText("Signed in")).toBeVisible();
  // Continue is the dialog's profile step: the profile is read afresh, the
  // kind 0 published, and read back before the membership is saved (after
  // which the service's own session reads NIP-11 again).
  expect(relay.calls.slice(4, 9)).toEqual(publishCalls(relay, member));
  expect(eventsCalls(relay)).toEqual([
    {
      community: relay.origin,
      path: "/events",
      method: "POST",
      body: expect.objectContaining({
        kind: 0,
        pubkey: member.pubkey,
        tags: [],
        content: JSON.stringify({
          name: "Ada",
          display_name: "Ada",
          picture: "",
          about: "",
        }),
      }),
    },
  ]);
  expect(saveCommunity.mock.calls).toEqual([[relay.origin]]);
  expect(journalOf(member)).toEqual([]);
  // The device record the next launch restores carries the published name as
  // the local default for later joins.
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${member.pubkey}`) ?? ""),
  ).toEqual({
    profile: { name: "Ada", picture: "", about: "" },
    memberships: [membership],
    selected: relay.origin,
    // `joined()` also queues the add for the account's known-communities
    // sync, which first run has already posted; the later send is idempotent.
    sync: {
      known: [],
      outbox: [{ url: "wss://relay.example.com:8443", removed: false }],
    },
  });
  expect(communities.snapshot().selected).toBe(relay.origin);
  identity.dispose();
});

it("a relay that already holds the key's profile skips the profile step, enters the app with it as the local default, and publishes nothing", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.profile = profile(member, { name: "Ada", picture: "" });
  const saved = deferred<void>();
  saveCommunity.mockReturnValueOnce(saved.promise);
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  // The join is saved to the account once the signed read has admitted the
  // key, and the app waits for that answer.
  await waitFor(() => expect(saveCommunity).toHaveBeenCalledTimes(1));
  expect(saveCommunity).toHaveBeenCalledWith(relay.origin);
  expect(relay.calls.at(-1)).toMatchObject({ path: "/query", method: "POST" });
  expect(screen.getByRole("status")).toHaveTextContent("Joining…");
  expect(screen.queryByText("Signed in")).toBeNull();
  await act(async () => saved.resolve());
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Set up your profile" }),
  ).toBeNull();
  const membership = {
    id: relay.origin,
    name: "relay.example.com:8443",
    icon: "https://cdn.example.com/icon.png",
  };
  expect(communities.snapshot()).toMatchObject({
    memberships: [membership],
    selected: relay.origin,
  });
  // The relay's existing profile seeds the empty local default; nothing was
  // published to get there.
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${member.pubkey}`) ?? ""),
  ).toEqual({
    profile: { name: "Ada", picture: "", about: "" },
    memberships: [membership],
    selected: relay.origin,
    // `joined()` also queues the add for the account's known-communities
    // sync, which first run has already posted; the later send is idempotent.
    sync: {
      known: [],
      outbox: [{ url: "wss://relay.example.com:8443", removed: false }],
    },
  });
  expect(eventsCalls(relay)).toEqual([]);
  expect(journalOf(member)).toEqual([]);
  identity.dispose();
});

it("an account that refuses to save the join still enters the app on the community", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.profile = profile(member, { name: "Ada", picture: "" });
  saveCommunity.mockRejectedValueOnce(
    new Error("Builderlab community save failed (HTTP 422: not JSON)."),
  );
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(saveCommunity.mock.calls).toEqual([[relay.origin]]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(communities.snapshot()).toMatchObject({
    memberships: [expect.objectContaining({ id: relay.origin })],
    selected: relay.origin,
  });
  identity.dispose();
});

it("a key imported from Connect to {host} joins with no account to save the community to", async () => {
  const relay = nativeRelay(owned);
  relay.profile = profile(owned, { name: "Ada", picture: "" });
  const relayAnswers = vi.mocked(invoke).getMockImplementation();
  if (!relayAnswers) throw new Error("nativeRelay installed no answers");
  let imported = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_import") {
      imported = true;
      return owned.pubkey;
    }
    if (command === "identity_restore" && imported) return owned.pubkey;
    return relayAnswers(command, args);
  });
  const account = vi.fn(unlinked);
  const identity = createIdentity();
  const communities = communitiesFor(identity);
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={communities}
      invites={invites}
      account={account}
      connect={vi.fn()}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), "relay.example.com:8443{Enter}");
  expect(
    await screen.findByRole("heading", {
      name: "Connect to your community",
    }),
  ).toBeVisible();
  expect(connectChoiceHost()).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "I already have a key" }),
  );
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot().selected).toBe(relay.origin);
  expect(account).not.toHaveBeenCalled();
  expect(saveCommunity).not.toHaveBeenCalled();
  identity.dispose();
});

it("the development seed saves a joined community without a request", async () => {
  vi.stubEnv("VITE_BUZZ_FIRST_RUN_ACCOUNT", "unlinked");
  const member = keypair();
  const relay = nativeRelay(member);
  relay.profile = profile(member, { name: "Ada", picture: "" });
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(
    identity,
    "",
    undefined,
    "seed",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot().selected).toBe(relay.origin);
  // The seed answered in place of kgoose (`plugin_host_request`) and of the
  // file's account stubs.
  expect(saveCommunity).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toContain(
    "relay_http",
  );
  expect(
    vi.mocked(invoke).mock.calls.map(([command]) => command),
  ).not.toContain("plugin_host_request");
  identity.dispose();
});

it("a relay that rejects the profile publish keeps the step with the error inline and the membership unsaved, and Skip saves it and enters the app", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.publish = false;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  await screen.findByRole("heading", { name: "Set up your profile" });
  const name = screen.getByRole("textbox", { name: "Display name" });
  await user.clear(name);
  await user.type(name, "Ada");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Community request failed (500)",
  );
  expect(
    screen.getByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(name).toHaveValue("Ada");
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  expect(eventsCalls(relay)).toHaveLength(1);
  // Nothing is saved while the step stands: the membership waits, the
  // rejected name never became the local default, and the journal keeps the
  // draft for a retry.
  expect(communities.snapshot()).toMatchObject({
    memberships: [],
    selected: null,
    profile: { name: "", picture: "", about: "" },
  });
  expect(saveCommunity).not.toHaveBeenCalled();
  expect(journalOf(member)).toEqual([
    {
      id: expect.any(String),
      community: relay.origin,
      profile: { name: "Ada", picture: "", about: "" },
    },
  ]);
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  // Skip saves the membership with the local default and publishes nothing more.
  expect(eventsCalls(relay)).toHaveLength(1);
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relay.origin }],
    selected: relay.origin,
    profile: { name: "", picture: "", about: "" },
  });
  expect(saveCommunity.mock.calls).toEqual([[relay.origin]]);
  expect(journalOf(member)).toEqual([]);
  identity.dispose();
});

it("a key whose device record already holds a community but no profile still gets the profile step, then enters the app on the new one", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  const identity = createIdentity();
  // The development seed: one membership, and no local profile, before this join.
  const { communities, user } = await joinCommunityPage(
    identity,
    "https://other.example.com",
  );
  expect(communities.snapshot().memberships).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Join" }));
  await screen.findByRole("heading", { name: "Set up your profile" });
  // Only the seed is saved until the step ends.
  expect(communities.snapshot().memberships).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: "https://other.example.com" }, { id: relay.origin }],
    selected: relay.origin,
  });
  expect(eventsCalls(relay)).toEqual([]);
  identity.dispose();
});

it("a profile the relay supersedes before the readback keeps the step with the draft and no membership, and Continue succeeds once the relay is current", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  // Another device publishes a newer kind 0 as this one is accepted.
  relay.superseded = profile(member, { name: "Grace", picture: "" });
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  await screen.findByRole("heading", { name: "Set up your profile" });
  const name = screen.getByRole("textbox", { name: "Display name" });
  await user.clear(name);
  await user.type(name, "Ada{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your profile change is not current. Your edits are retained; try again.",
  );
  // The publish was accepted, read back and found superseded: nothing saved.
  expect(relay.calls.slice(4, 9)).toEqual(publishCalls(relay, member));
  expect(communities.snapshot()).toMatchObject({
    memberships: [],
    selected: null,
  });
  expect(saveCommunity).not.toHaveBeenCalled();
  expect(journalOf(member)).toMatchObject([
    {
      community: relay.origin,
      profile: { name: "Ada", picture: "", about: "" },
    },
  ]);
  expect(name).toHaveValue("Ada");
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  // The relay now keeps what it accepts: the fresh read finds the other
  // device's profile, the draft differs, so it is published again and this
  // time reads back.
  relay.superseded = undefined;
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(relay.calls.slice(9, 14)).toEqual(publishCalls(relay, member));
  expect(eventsCalls(relay)).toHaveLength(2);
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relay.origin }],
    selected: relay.origin,
    profile: { name: "Ada", picture: "", about: "" },
  });
  expect(saveCommunity.mock.calls).toEqual([[relay.origin]]);
  expect(journalOf(member)).toEqual([]);
  identity.dispose();
});

it("a claim whose reply is lost is never claimed again: Back and Join read the journaled destination first, and the admitted key continues", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  relay.lostClaim = true;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(
    identity,
    "",
    inviteLink,
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", { name: "Couldn’t join community" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach the relay. Check your connection and try again.",
  );
  // The relay admitted the key on that claim; the journal still holds the join.
  expect(relay.calls.slice(2)).toEqual([
    {
      community: relay.origin,
      path: "/api/invites/claim",
      method: "POST",
      body: { code: inviteCode },
    },
  ]);
  const [entry] = journalOf(member) as unknown[];
  expect(entry).toEqual({ id: expect.any(String), community: relay.origin });
  expect(communities.snapshot().memberships).toEqual([]);
  relay.lostClaim = false;
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Join" }));
  // Read before reclaim: the signed read finds the key admitted, so the code
  // (which the relay would now refuse as used) is not claimed again.
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(relay.calls.slice(3)).toEqual([
    ...lookupCalls(relay),
    ...readCalls(relay, member),
  ]);
  expect(claims(relay)).toHaveLength(1);
  expect(journalOf(member)).toEqual([entry]);
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(claims(relay)).toHaveLength(1);
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relay.origin }],
    selected: relay.origin,
  });
  expect(journalOf(member)).toEqual([]);
  identity.dispose();
});

/** The signed-in account with no key bound and `known` saved to it; binding succeeds. */
const restoringAccount =
  (known: readonly string[]): ComponentProps<typeof Welcome>["account"] =>
  () => ({
    linkedKey: () => Promise.resolve(null),
    ownedCommunities: () => Promise.resolve([]),
    knownCommunities: () => Promise.resolve(known),
    saveCommunity,
    bind: () => Promise.resolve(),
    unbind: noUnlink,
    ...backupAnswers,
  });
const relayA = "https://relay-a.example";
const relayB = "https://relay-b.example";
/** The kind-0 read restoring `community` sends for `member`. */
const restoreRead = (community: string, member: ReturnType<typeof keypair>) => [
  { community, path: "/", method: "GET", body: null },
  {
    community,
    path: "/query",
    method: "POST",
    body: [
      {
        kinds: [0],
        authors: [member.pubkey],
        limit: 5,
        consistency: "strong",
      },
    ],
  },
];
const callsTo = (relay: ReturnType<typeof nativeRelay>, community: string) =>
  relay.calls.filter((call) => call.community === community);
/**
 * Sign in with email (from the connect choice when `typed` is given, as
 * no tenant hosts it) for an account that saved `known`, then Create my key.
 */
async function restoreLane(
  identity: Identity,
  known: readonly string[],
  typed?: string,
) {
  const communities = communitiesFor(identity);
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={communities}
      invites={invites}
      account={restoringAccount(known)}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  if (typed) {
    await user.type(urlField(), `${typed}{Enter}`);
    await screen.findByRole("heading", { name: /^Connect to / });
  }
  await user.click(connectButton());
  await createMyKey(user);
  return { communities, user };
}

it("a typed address the account's saved communities lack enters the app on the restored one and hands the address to the join dialog", async () => {
  const member = keypair();
  const gate = deferred<void>();
  const relay = nativeRelay(member, {
    [relayA]: {
      admitted: true,
      profile: profile(member, { name: "Ada" }),
      query: gate.promise,
    },
  });
  const identity = createIdentity();
  const { communities } = await restoreLane(
    identity,
    ["wss://relay-a.example"],
    "relay.example.com:8443",
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Restoring your communities…",
    ),
  );
  expect(invites.open).not.toHaveBeenCalled();
  await act(async () => gate.resolve());
  expect(await screen.findByText("Signed in")).toBeVisible();
  // Only the saved destination is read: the typed one is the dialog's to join.
  // The joined community's own session then reads on.
  expect(callsTo(relay, relayA).slice(0, 2)).toEqual(
    restoreRead(relayA, member),
  );
  expect(
    callsTo(relay, relay.origin).filter((call) => call.path === "/query"),
  ).toEqual([]);
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA, name: "relay-a.example" }],
    selected: relayA,
    profile: { name: "Ada" },
  });
  expect(invites.open.mock.calls).toEqual([
    [{ community: relay.origin, code: "" }, member.pubkey],
  ]);
  expect(screen.queryByRole("heading", { name: "Join Community" })).toBeNull();
  identity.dispose();
});

it("an invite link's code is handed to the join dialog with its address, and nothing is claimed first", async () => {
  const member = keypair();
  const relay = nativeRelay(member, {
    [relayA]: { admitted: true, profile: profile(member, { name: "Ada" }) },
  });
  const identity = createIdentity();
  const { communities } = await restoreLane(
    identity,
    ["wss://relay-a.example"],
    "https://relay.example.com:8443/invite/CODE-1",
  );
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA }],
    selected: relayA,
  });
  // The dialog claims the code; first run sends nothing signed to that relay.
  expect(
    callsTo(relay, relay.origin).filter((call) => call.method === "POST"),
  ).toEqual([]);
  expect(invites.open.mock.calls).toEqual([
    [{ community: relay.origin, code: "CODE-1" }, member.pubkey],
  ]);
  identity.dispose();
});

it("a typed address the restore admitted is selected and entered without the join dialog", async () => {
  const member = keypair();
  const relay = nativeRelay(member, {
    [relayA]: { admitted: true, profile: profile(member, { name: "Ada" }) },
  });
  relay.profile = profile(member, { name: "Ada" });
  const identity = createIdentity();
  const { communities } = await restoreLane(
    identity,
    ["wss://relay-a.example", "wss://relay.example.com:8443"],
    "relay.example.com:8443",
  );
  expect(await screen.findByText("Signed in")).toBeVisible();
  // The typed address wins over the first admitted.
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA }, { id: relay.origin }],
    selected: relay.origin,
  });
  expect(invites.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Join Community" })).toBeNull();
  identity.dispose();
});

it("saved communities that all refuse the key or cannot be reached join nothing, and setup lands on Join Community for the typed address", async () => {
  const member = keypair();
  const gate = deferred<void>();
  const relay = nativeRelay(member, {
    [relayA]: { admitted: false, query: gate.promise },
    [relayB]: { admitted: "down" },
  });
  const identity = createIdentity();
  const { communities } = await restoreLane(
    identity,
    ["wss://relay-a.example", "wss://relay-b.example"],
    "relay.example.com:8443",
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Restoring your communities…",
    ),
  );
  await act(async () => gate.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(callsTo(relay, relayA)).toEqual(restoreRead(relayA, member));
  expect(callsTo(relay, relayB)).toEqual([
    { community: relayB, path: "/", method: "GET", body: null },
  ]);
  expect(communities.snapshot().memberships).toEqual([]);
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(invites.open).not.toHaveBeenCalled();
  identity.dispose();
});

it("with no typed address, a saved community that admits the key and holds its profile is entered directly", async () => {
  const member = keypair();
  const relay = nativeRelay(member, {
    [relayA]: { admitted: true, profile: profile(member, { name: "Ada" }) },
    [relayB]: { admitted: false },
  });
  const identity = createIdentity();
  const { communities } = await restoreLane(identity, [
    "wss://relay-b.example",
    "wss://relay-a.example",
  ]);
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Set up your profile" }),
  ).toBeNull();
  expect(callsTo(relay, relayB)).toEqual(restoreRead(relayB, member));
  expect(callsTo(relay, relayA).slice(0, 2)).toEqual(
    restoreRead(relayA, member),
  );
  expect(callsTo(relay, relay.origin)).toEqual([]);
  // The device record the next launch restores holds the one admitted.
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${member.pubkey}`) ?? ""),
  ).toMatchObject({
    profile: { name: "Ada", picture: "", about: "" },
    memberships: [{ id: relayA, name: "relay-a.example" }],
    selected: relayA,
  });
  expect(communities.snapshot().selected).toBe(relayA);
  expect(invites.open).not.toHaveBeenCalled();
  identity.dispose();
});

it("restored communities with no profile anywhere continue to the profile step for the first admitted, and the typed address is handed off only after it", async () => {
  const member = keypair();
  const relay = nativeRelay(member, {
    [relayA]: { admitted: true },
    [relayB]: { admitted: true },
  });
  const identity = createIdentity();
  const { communities, user } = await restoreLane(
    identity,
    ["wss://relay-a.example", "wss://relay-b.example"],
    "relay.example.com:8443",
  );
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(
    screen.getByText(/agent handoffs in relay-a\.example\./),
  ).toBeVisible();
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA }, { id: relayB }],
    selected: relayA,
  });
  expect(invites.open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(
    callsTo(relay, relayA).filter((call) => call.path === "/events"),
  ).toEqual([
    expect.objectContaining({
      body: expect.objectContaining({ kind: 0, pubkey: member.pubkey }),
    }),
  ]);
  expect(
    callsTo(relay, relayB).filter((call) => call.path === "/events"),
  ).toEqual([]);
  expect(communities.snapshot().profile.name).toBe("a");
  expect(invites.open.mock.calls).toEqual([
    [{ community: relay.origin, code: "" }, member.pubkey],
  ]);
  identity.dispose();
});

it("a relay that refuses the read says the community needs an invite, shows the npub to send, and keeps the typed URL", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", {
      name: "This community needs an invite",
    }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "relay.example.com:8443 admits members by invite, and this key has none yet. Enter an invite code, or send your public key to a community administrator so they can add you, then try again.",
  );
  // No code was given, so the field starts empty with nothing refused.
  expect(screen.getByRole("textbox", { name: "Invite code" })).toHaveValue("");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  // The created key, as the full npub an admin pastes; never hex.
  const npub = npubEncode(member.pubkey);
  expect(
    screen.getByRole("heading", { name: "Your public key (npub)" }),
  ).toBeVisible();
  expect(screen.getByText(npub)).toBeVisible();
  expect(screen.queryByText(member.pubkey)).toBeNull();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  expect(write).toHaveBeenCalledWith(npub);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Public key copied."),
  );
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(communities.snapshot().memberships).toEqual([]);
  expect(localStorage.getItem(`buzz-client.v1:${member.pubkey}`)).toBeNull();
  // The journaled join outlives the denial: a later Join reads before it claims.
  expect(journalOf(member)).toEqual([
    { id: expect.any(String), community: relay.origin },
  ]);
  await user.click(screen.getByRole("button", { name: "Back" }));
  // Back lands on the find page, which looks the community up again.
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Community URL" })).toHaveValue(
    "relay.example.com:8443",
  );
  identity.dispose();
});

it("Try again on the invite page repeats the signed read and enters the app once the relay admits the key", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  await screen.findByRole("heading", {
    name: "This community needs an invite",
  });
  expect(relay.calls).toHaveLength(4);
  expect(journalOf(member)).toEqual([
    { id: expect.any(String), community: relay.origin },
  ]);
  // The admin has added the key in the meantime; the read is held to show the
  // page waiting on it. With the join journaled, Try again reads first, and
  // that read is the admission, so nothing else is sent.
  relay.admitted = true;
  const gate = deferred<void>();
  relay.query = gate.promise;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("button", { name: "Trying again…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  await waitFor(() => expect(relay.calls).toHaveLength(6));
  expect(relay.calls.slice(4)).toEqual([
    { community: relay.origin, path: "/", method: "GET", body: null },
    {
      community: relay.origin,
      path: "/query",
      method: "POST",
      body: [
        {
          kinds: [0],
          authors: [member.pubkey],
          limit: 5,
          consistency: "strong",
        },
      ],
    },
  ]);
  expect(screen.queryByText("Signed in")).toBeNull();
  await act(async () => gate.resolve());
  // Admitted on retry: the first community continues to the profile step.
  await user.click(await screen.findByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relay.origin, name: "relay.example.com:8443" }],
    selected: relay.origin,
  });
  expect(journalOf(member)).toEqual([]);
  identity.dispose();
});

/** A code the relay accepts in an invite link, and the policy it gates. */
const inviteCode = "v2.Invite-code_1";
const invitePolicy: JoinPolicy = {
  version: "2026-10",
  age_attestation_required: true,
  terms_markdown: "# Terms",
};
const inviteLink = `https://relay.example.com:8443/invite/${inviteCode}`;
/** The requests a Join with a code sends: the claim (after the policy's acceptance), then the read. */
function claimCalls(
  relay: ReturnType<typeof nativeRelay>,
  member: ReturnType<typeof keypair>,
  code = inviteCode,
) {
  const post = (path: string, body: unknown) => ({
    community: relay.origin,
    path,
    method: "POST",
    body,
  });
  return [
    ...(relay.policy
      ? [
          post("/api/invites/accept-policy", {
            code,
            policy_version: relay.policy.version,
            age_confirmed: true,
          }),
        ]
      : []),
    // No policy, no receipt: the claim carries only the code.
    post(
      "/api/invites/claim",
      relay.policy ? { code, policy_receipt: "policy-receipt" } : { code },
    ),
    { community: relay.origin, path: "/", method: "GET", body: null },
    post("/query", [
      { kinds: [0], authors: [member.pubkey], limit: 5, consistency: "strong" },
    ]),
  ];
}
/** Tick Join Community's consent boxes for `invitePolicy`. */
async function consent(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("checkbox", {
      name: "I confirm that I am at least 18 years old.",
    }),
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: "I agree to this community’s Terms of Service.",
    }),
  );
}
const lookupCalls = (relay: ReturnType<typeof nativeRelay>) => [
  { community: relay.origin, path: "/", method: "GET", body: null },
  {
    community: relay.origin,
    path: "/api/join-policy",
    method: "GET",
    body: null,
  },
];

it("an invite link pasted on the landing is looked up at its origin, kept through sign-in and setup, and Join accepts the policy and claims the code before the signed read", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  relay.policy = invitePolicy;
  const identity = createIdentity();
  const communities = communitiesFor(identity);
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={communities}
      invites={invites}
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), inviteLink);
  expect(urlContinue()).toBeEnabled();
  await user.keyboard("{Enter}");
  // The lookup goes to the community's origin, never to the invite path, and
  // the code is not sent anywhere before Join.
  expect(
    await screen.findByRole("heading", {
      name: "Connect to your community",
    }),
  ).toBeVisible();
  expect(connectChoiceHost()).toBeVisible();
  expect(relay.calls).toEqual(lookupCalls(relay));
  await user.click(connectButton());
  await createMyKey(user);
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
  expect(relay.calls).toEqual([...lookupCalls(relay), ...lookupCalls(relay)]);
  await consent(user);
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(relay.calls.slice(0, 8)).toEqual([
    ...lookupCalls(relay),
    ...lookupCalls(relay),
    ...claimCalls(relay, member),
  ]);
  // The membership waits for the profile step.
  expect(communities.snapshot().memberships).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relay.origin }],
    selected: relay.origin,
  });
  identity.dispose();
});

it("an invite link pasted on Join a community claims its code with no policy to accept, then joins as before", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(
    identity,
    "",
    `${inviteLink}/`,
  );
  expect(relay.calls).toEqual(lookupCalls(relay));
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(relay.calls.slice(0, 5)).toEqual([
    ...lookupCalls(relay),
    ...claimCalls(relay, member),
  ]);
  expect(communities.snapshot().memberships).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot().memberships).toMatchObject([
    { id: relay.origin },
  ]);
  identity.dispose();
});

it("a buzz://join link pasted on Join a community claims its code at the link's relay", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  relay.policy = invitePolicy;
  const identity = createIdentity();
  const { user } = await joinCommunityPage(
    identity,
    "",
    `buzz://join?relay=wss%3A%2F%2Frelay.example.com%3A8443&code=${inviteCode}`,
  );
  expect(relay.calls).toEqual(lookupCalls(relay));
  await consent(user);
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(relay.calls.slice(0, 6)).toEqual([
    ...lookupCalls(relay),
    ...claimCalls(relay, member),
  ]);
  identity.dispose();
});

it("a refused invite link lands on the invite page with the refusal under the code field and no read, and a new code there joins", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  relay.refusal = "invite_expired";
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(
    identity,
    "",
    inviteLink,
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", {
      name: "This community needs an invite",
    }),
  ).toBeVisible();
  const field = screen.getByRole("textbox", { name: "Invite code" });
  expect(field).toHaveAccessibleDescription(
    "This invite code has expired — ask for a new one.",
  );
  expect(field).toHaveValue("");
  // The npub, Back and Try again stay for an admin who adds by key.
  expect(screen.getByText(npubEncode(member.pubkey))).toBeVisible();
  expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  // The refused claim is the last request: no read was signed after it.
  expect(relay.calls.slice(2)).toEqual([
    {
      community: relay.origin,
      path: "/api/invites/claim",
      method: "POST",
      body: { code: inviteCode },
    },
  ]);
  expect(communities.snapshot().memberships).toEqual([]);
  // A new code from the admin: the claim is held to show the page waiting.
  relay.refusal = undefined;
  const gate = deferred<void>();
  relay.claim = gate.promise;
  await user.type(field, "v2.fresh{Enter}");
  expect(screen.getByRole("button", { name: "Joining…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  expect(field).toBeDisabled();
  await act(async () => gate.resolve());
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  // The refused attempt left its journal record, so the relay is read (and
  // still refuses) before the new code is claimed.
  expect(relay.calls.slice(3, 8)).toEqual([
    ...readCalls(relay, member),
    ...claimCalls(relay, member, "v2.fresh"),
  ]);
  expect(communities.snapshot().memberships).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot().memberships).toMatchObject([
    { id: relay.origin },
  ]);
  identity.dispose();
});

it("a code typed on the invite page after a refused read accepts the policy Join consented to, and a refused or malformed code keeps the page with the copy under the field", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  relay.policy = invitePolicy;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await consent(user);
  await user.click(screen.getByRole("button", { name: "Join" }));
  await screen.findByRole("heading", {
    name: "This community needs an invite",
  });
  expect(relay.calls).toHaveLength(4);
  const field = screen.getByRole("textbox", { name: "Invite code" });
  const codeJoin = () => screen.getByRole("button", { name: "Join" });
  expect(codeJoin()).toBeDisabled();
  relay.refusal = "invite_invalid";
  await user.type(field, "  v2.wrong  ");
  await user.click(codeJoin());
  await waitFor(() =>
    expect(field).toHaveAccessibleDescription(
      "This invite code is not valid for this community.",
    ),
  );
  // The refused attempt's journal record has the relay read first; then the
  // code, trimmed, is accepted under the consent the first Join carried.
  expect(relay.calls.slice(4)).toEqual([
    ...readCalls(relay, member),
    {
      community: relay.origin,
      path: "/api/invites/accept-policy",
      method: "POST",
      body: {
        code: "v2.wrong",
        policy_version: "2026-10",
        age_confirmed: true,
      },
    },
    {
      community: relay.origin,
      path: "/api/invites/claim",
      method: "POST",
      body: { code: "v2.wrong", policy_receipt: "policy-receipt" },
    },
  ]);
  expect(
    screen.getByRole("heading", { name: "This community needs an invite" }),
  ).toBeVisible();
  expect(field).toHaveValue("  v2.wrong  ");
  expect(field).toBeEnabled();
  // Editing the code clears the refusal.
  await user.clear(field);
  expect(field).not.toHaveAccessibleDescription();
  // A code the native route refuses to send gets the same copy, with no
  // request for it (only the record's read before it).
  await user.type(field, "not a code{Enter}");
  await waitFor(() =>
    expect(field).toHaveAccessibleDescription(
      "This invite code is not valid for this community.",
    ),
  );
  expect(relay.calls).toHaveLength(10);
  relay.refusal = undefined;
  await user.clear(field);
  await user.type(field, `${inviteCode}{Enter}`);
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(relay.calls.slice(10, 16)).toEqual([
    ...readCalls(relay, member),
    ...claimCalls(relay, member),
  ]);
  expect(communities.snapshot().memberships).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relay.origin }],
    selected: relay.origin,
  });
  identity.dispose();
});

it("a device that will not keep the join's record names the storage failure before anything is sent, and leaves nothing joined", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", { name: "Couldn’t join community" }),
  ).toBeVisible();
  // The journal's record comes before any remote effect, so a device that
  // cannot keep it sends nothing: the lookup's two GETs are all the relay saw.
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not save community setup on this device. Free storage and try again.",
  );
  expect(relay.calls).toHaveLength(2);
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(communities.snapshot()).toMatchObject({
    memberships: [],
    selected: null,
  });
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  identity.dispose();
});

it("a key creation failure stops setup and Back returns to the first-launch screen", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce("Keychain refused to save the key");
  const connect = vi.fn().mockResolvedValue(credential);
  const { backupStatus, release } = gatedStatus();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinkedWith(() => Promise.resolve(), { backupStatus })}
      connect={connect}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for a backed-up key…",
    ),
  );
  await release();
  await createMyKey(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keychain refused to save the key",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  // Nothing runs after the failure, and no key is saved to say so of.
  expect(backupStatus).toHaveBeenCalledTimes(1);
  expect(identity.snapshot().status).toBe("missing");
  expect(screen.queryByText(keySavedNote)).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(connectButton()).toBeEnabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

const keyField = () => screen.getByLabelText("Private key (nsec)");
const continueWithKey = () =>
  screen.getByRole("button", { name: "Continue with this key" });
/** While an import runs, neither Back nor Continue may leave or resubmit it. */
const expectNoImportActions = () => {
  for (const name of ["Back", "Continue with this key"])
    expect(screen.queryByRole("button", { name })).toBeNull();
};
const invalidKeyCopy =
  "That doesn’t look like a valid nsec. Paste an nsec1 key.";
/** Connect, then open the import page from the choice. */
async function keyImportPage(
  user: ReturnType<typeof userEvent.setup>,
  identity: Identity,
  account = unlinked,
) {
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={account}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await user.click(
    await screen.findByRole("button", { name: "I already have a key" }),
  );
  expect(
    screen.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
}

it("I already have a key opens Enter your private key, classifies what is pasted, and Back returns to the choice with nothing created", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(user, identity);
  expect(
    screen.getByText(/Paste your private key to sign in to Buzz\./),
  ).toBeVisible();
  // Masked, sensitive and focused on arrival; nothing to continue with yet.
  expect(keyField()).toHaveFocus();
  expect(keyField()).toHaveAttribute("type", "password");
  expect(keyField()).toHaveAttribute("autocomplete", "off");
  expect(keyField()).toHaveAttribute("spellcheck", "false");
  expect(continueWithKey()).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Reveal private key" }),
  ).toBeDisabled();
  expect(screen.queryByRole("alert")).toBeNull();
  await user.paste("hello");
  expect(screen.getByRole("alert")).toHaveTextContent(invalidKeyCopy);
  expect(keyField()).toHaveAccessibleDescription(invalidKeyCopy);
  expect(continueWithKey()).toBeDisabled();
  await user.clear(keyField());
  expect(screen.queryByRole("alert")).toBeNull();
  await user.paste(
    "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Password-protected backups aren’t supported here yet.",
  );
  expect(continueWithKey()).toBeDisabled();
  await user.clear(keyField());
  await user.paste(ownedNsec);
  // A valid key previews its public identity as an npub, never hex, and
  // unlocks Continue; Reveal shows the typed key and Hide masks it again.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(keyField()).toHaveAccessibleDescription(
    `Public identity: ${npubEncode(owned.pubkey)}`,
  );
  expect(screen.queryByText(owned.pubkey)).toBeNull();
  expect(continueWithKey()).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(keyField()).toHaveAttribute("type", "text");
  expect(keyField()).toHaveValue(ownedNsec);
  await user.click(screen.getByRole("button", { name: "Hide private key" }));
  expect(keyField()).toHaveAttribute("type", "password");
  // Back discards the typed key and offers every choice again; no key was made.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  for (const name of ["Create my key", "I already have a key"])
    expect(screen.getByRole("button", { name })).toBeEnabled();
  // Focus returns to the choice that opened the page, not to the heading.
  expect(
    screen.getByRole("button", { name: "I already have a key" }),
  ).toHaveFocus();
  await user.click(
    screen.getByRole("button", { name: "I already have a key" }),
  );
  expect(keyField()).toHaveValue("");
  expect(continueWithKey()).toBeDisabled();
  expect(identity.snapshot().status).toBe("missing");
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("Continue with this key imports the pasted nsec behind Importing your key, links it to the new account, then asks Back up this key?, and Not now lands on Join a community with nothing backed up", async () => {
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return imported.promise;
    throw new Error(`Unexpected command ${command}`);
  });
  const bound = deferred<void>();
  const bind = vi.fn((_pubkey: string) => bound.promise);
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(user, identity, unlinkedWith(bind, { backUp }));
  await user.paste(ownedNsec);
  // Enter in the field submits, like the Continue button.
  await user.keyboard("{Enter}");
  expect(invoke).toHaveBeenCalledWith("identity_import", { nsec: ownedNsec });
  expect(
    screen.getByRole("heading", { name: "Setting up Buzz" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Importing your key…");
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  expectNoImportActions();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(bind).not.toHaveBeenCalled();
  await act(async () => imported.resolve(owned.pubkey));
  // The account has no key, so the imported one is bound to it like a created one.
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Linking your key…"),
  );
  expect(bind.mock.calls).toEqual([[owned.pubkey]]);
  expect(screen.queryByText("Signed in")).toBeNull();
  await act(async () => bound.resolve());
  // Importing never uploads silently: the backup is offered, disclosing that
  // Block can restore the key wherever else it is used.
  expect(
    await screen.findByRole("heading", { name: "Back up this key?" }),
  ).toBeVisible();
  expect(
    screen.getByText(/restore this key, including anywhere else you use it/),
  ).toBeVisible();
  expect(backUp).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(backUp).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("a link that keeps failing after a key is imported for a new account stays on the failed page: Try again runs the link again, and nothing offers a way past it", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const bind = vi.fn((_pubkey: string) =>
    Promise.reject(
      new Error(
        "This Builderlab account is connected to another Buzz identity.",
      ),
    ),
  );
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(user, identity, unlinkedWith(bind, { backUp }));
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This Builderlab account is connected to another Buzz identity.",
  );
  expect(screen.getByText(keyUnlinkedNote)).toBeVisible();
  expect(bind.mock.calls).toEqual([[owned.pubkey]]);
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Continue without linking" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(bind).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This Builderlab account is connected to another Buzz identity.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Continue without linking" }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Back up this key?" }),
  ).toBeNull();
  expect(backUp).not.toHaveBeenCalled();
  expect(screen.queryByText("Signed in")).toBeNull();
  identity.dispose();
});

it("a native import refusal stays on the import page with the key kept, and Back still returns to the choice", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import")
      return Promise.reject(
        "An identity is already saved; nothing was overwritten",
      );
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(user, identity);
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "An identity is already saved; nothing was overwritten",
  );
  expect(
    screen.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeNull();
  expect(keyField()).toHaveValue(ownedNsec);
  expect(continueWithKey()).toBeEnabled();
  expect(identity.snapshot().status).toBe("missing");
  // Editing the key replaces the refusal with the live classification.
  await user.type(keyField(), "x");
  expect(screen.getByRole("alert")).toHaveTextContent(invalidKeyCopy);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("a dropped or chosen key file fills the field from its first line, and an oversize file is refused", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(user, identity);
  const form = screen
    .getByRole("heading", { name: "Enter your private key" })
    .closest("form");
  if (!form) throw new Error("The import page is not a form");
  const dropped = new File(
    [`\n  ${ownedNsec}  \nnot the key\n`],
    "buzz-key.txt",
    { type: "text/plain" },
  );
  fireEvent(
    form,
    createEvent.drop(form, {
      dataTransfer: { types: ["Files"], files: [dropped] },
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitFor(() => expect(keyField()).toHaveValue(ownedNsec));
  expect(keyField()).toHaveAttribute("type", "password");
  expect(keyField()).toHaveAccessibleDescription(
    `Public identity: ${npubEncode(owned.pubkey)}`,
  );
  expect(continueWithKey()).toBeEnabled();
  const picker = screen.getByLabelText("Key file");
  await user.upload(
    picker,
    new File([new Uint8Array(1025)], "big.txt", { type: "text/plain" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That file is too large to be a private key.",
  );
  expect(keyField()).toHaveValue(ownedNsec);
  await user.upload(
    picker,
    new File(["hello\n"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(keyField()).toHaveValue("hello"));
  expect(screen.getByRole("alert")).toHaveTextContent(invalidKeyCopy);
  expect(continueWithKey()).toBeDisabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("an imported key on the tenant path is offered a backup, and Not now lands on Join Community for the landing URL", async () => {
  const relay = landingRelay("https://relay.example.com");
  relay.info.resolve();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), "relay.example.com{Enter}");
  await user.click(
    await screen.findByRole("button", { name: "I already have a key" }),
  );
  await user.click(keyField());
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  await user.click(await screen.findByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_import",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

/** A real second key that is not the linked one, for the mismatch refusal. */
const stranger = keypair();
/** The signed-in account's reads once a key is bound to it. */
const linkedTo =
  (
    pubkey: string,
    communities: readonly OwnedCommunity[] = [],
    backup: BackupAnswers = {},
  ): ComponentProps<typeof Welcome>["account"] =>
  () => ({
    linkedKey: () => Promise.resolve(pubkey),
    ownedCommunities: () => Promise.resolve(communities),
    knownCommunities: () => Promise.resolve([]),
    saveCommunity,
    // The import accepts only the linked key: there is nothing to bind.
    bind: () => Promise.reject(new Error("Welcome bound the linked key again")),
    unbind: noUnlink,
    ...backupAnswers,
    ...backup,
  });
const linkedNpub = npubEncode(owned.pubkey);
/**
 * Connect as a linked account: the backed-up-key lookup still runs, and setup
 * pauses on Welcome back instead of the choice.
 */
async function welcomeBackPage(
  user: ReturnType<typeof userEvent.setup>,
  identity: Identity,
  account: ComponentProps<typeof Welcome>["account"],
) {
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      connect={vi.fn().mockResolvedValue(credential)}
      account={account}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "Welcome back" })).toHaveFocus();
}
/** Enter your private key with the linked key, through to the backup offer. */
async function importLinkedKey(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(
    await screen.findByRole("heading", { name: "Back up this key?" }),
  ).toBeVisible();
}

it("a linked account is welcomed back with its npub, accepts only the linked key, offers a backup after the import, and Not now lands on Join a community", async () => {
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return imported.promise;
    throw new Error(`Unexpected command ${command}`);
  });
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, linkedTo(owned.pubkey));
  expect(screen.getByText(/already linked to a Buzz identity/)).toBeVisible();
  // The linked key in full, as an npub, never hex; no lane here creates a key.
  expect(screen.getByText(linkedNpub)).toHaveClass("font-mono");
  expect(screen.queryByText(owned.pubkey)).toBeNull();
  for (const name of ["Create my key", "I already have a key"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(
    screen.getByRole("button", {
      name: "Recover from another device — Coming soon",
    }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "I lost this key" })).toBeEnabled();
  // Who the linked key belongs to, with a way out if it is the wrong account.
  expect(screen.getByText("Signed in as a@example.com.")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Use a different account" }),
  ).toBeEnabled();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  expect(write).toHaveBeenCalledWith(linkedNpub);
  expect(screen.getByRole("status")).toHaveTextContent("Public key copied.");
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  expect(
    screen.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  // Back returns to Welcome back on this lane, not to the key choice, with
  // focus on the choice that opened the import page.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Enter your private key" }),
  ).toHaveFocus();
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  // A valid key that is not the linked one is refused, naming the expected npub.
  await user.paste(nsecEncode(stranger.secret));
  expect(screen.getByRole("alert")).toHaveTextContent(
    `That isn’t the key linked to this account. It expects ${linkedNpub} (the key on your other device).`,
  );
  expect(continueWithKey()).toBeDisabled();
  await user.keyboard("{Enter}");
  expect(invoke).not.toHaveBeenCalledWith("identity_import", expect.anything());
  await user.clear(keyField());
  await user.paste(ownedNsec);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(continueWithKey()).toBeEnabled();
  await user.click(continueWithKey());
  expect(invoke).toHaveBeenCalledWith("identity_import", { nsec: ownedNsec });
  expect(screen.getByRole("status")).toHaveTextContent("Importing your key…");
  await act(async () => imported.resolve(owned.pubkey));
  // Importing never uploads on its own: the backup is offered, with the app
  // still behind the pause.
  expect(
    await screen.findByRole("heading", { name: "Back up this key?" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(screen.queryByText("Signed in")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.queryByRole("list")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("Use a different account on Welcome back returns to the landing without touching the key, and the linked key is read again only at the next sign-in", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
  });
  const linkedKey = vi.fn(() => Promise.resolve(owned.pubkey));
  const account: ComponentProps<typeof Welcome>["account"] = () => ({
    linkedKey,
    ownedCommunities: () => Promise.resolve([]),
    knownCommunities: () => Promise.resolve([]),
    saveCommunity,
    bind: () => Promise.reject(new Error("Welcome bound the linked key again")),
    unbind: noUnlink,
    ...backupAnswers,
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, account);
  expect(linkedKey).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Signed in as a@example.com.")).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Use a different account" }),
  );
  // Back on the landing, signed out; the linked key was never imported or
  // replaced, and its npub is gone with the page.
  expect(welcomeHeading()).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Welcome back" })).toBeNull();
  expect(screen.queryByText(linkedNpub)).toBeNull();
  expect(identity.snapshot().status).toBe("missing");
  expect(linkedKey).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  // The next sign-in reads the account again rather than reusing the answer.
  await user.click(connectButton());
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect(linkedKey).toHaveBeenCalledTimes(2);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("Back it up on the backup offer backs the linked key up before Join a community", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const backedUp = deferred<void>();
  const backUp = vi.fn((_pubkey: string) => backedUp.promise);
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, linkedTo(owned.pubkey, [], { backUp }));
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Back it up" }));
  // The linked key only needs the backup: no binding step.
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  expect(backUp.mock.calls).toEqual([[owned.pubkey]]);
  await act(async () => backedUp.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  identity.dispose();
});

it("a backup that fails twice after the key is imported offers Try again each time, and Continue without backup still lists the owned communities on Join a community", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const backUp = vi.fn((_pubkey: string) =>
    Promise.reject(new BackupError("unreachable")),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    linkedTo(
      owned.pubkey,
      [{ host: "design.example.com", url: "https://design.example.com" }],
      { backUp },
    ),
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Back it up" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t reach Builderlab to back up your key.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  expect(screen.getByText(keySavedNote)).toBeVisible();
  // The key is on the device, so the gate must not lift into an app with no
  // community: the page never offers the landing.
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(backUp).toHaveBeenCalledTimes(2));
  expect(
    await screen.findByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  await user.click(
    screen.getByRole("button", { name: "Continue without backup" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(backUp.mock.calls).toEqual([[owned.pubkey], [owned.pubkey]]);
  expect(
    within(screen.getByRole("list", { name: "Communities you own" })).getByText(
      "design.example.com",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Buzz" })).toBeNull();
  identity.dispose();
});

it("Back it up with the real account waits on the native uploader's pass for its own handoff, past a stale failure, then hands the credential back", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const channels: { onmessage: (status: BackupStatus) => void }[] = [];
  const at = (seq: number, pass: number, settled: object) =>
    ({ seq, pass, builderlab: true, ...settled }) as BackupStatus;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return null;
    if (command === "identity_import") return owned.pubkey;
    if (command === "nsec_backup_watch") {
      channels.push((args as { onEvent: (typeof channels)[number] }).onEvent);
      return undefined;
    }
    // The last pass, before this sign-in, could not reach Builderlab.
    if (command === "nsec_backup_state")
      return at(1, 3, { status: "failed", kind: "unreachable" });
    if (command === "nsec_backup_set_choice")
      return { available: true, pubkey: owned.pubkey, automatic: true };
    if (command === "nsec_backup_session")
      return (args as { credential: string | null }).credential ? 4 : null;
    throw new Error(`Unexpected command ${command}`);
  });
  const answer = (body: object) => ({
    status: 200,
    headers: {},
    body: JSON.stringify(body),
  });
  const request = vi.fn(async ({ url }: { url: string }) =>
    url.endsWith("/nostr-identities/current")
      ? answer({
          identity: { npub: linkedNpub, pubkey_hex: owned.pubkey },
          correlation_id: "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
        })
      : url.endsWith("/nsec-backups/status")
        ? answer({
            current_nostr_pubkey: owned.pubkey,
            backup_nostr_pubkeys: [],
          })
        : answer({ communities: [] }),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, (credential, origin, identity) =>
    builderlabAccount(credential, origin, request, identity),
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Back it up" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "nsec_backup_session",
      expect.objectContaining({ credential: "private-token" }),
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  await act(async () =>
    channels[0]?.onmessage(at(2, 4, { status: "running" })),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  await act(async () =>
    channels[0]?.onmessage(at(3, 4, { status: "complete" })),
  );
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command.startsWith("nsec_backup_"))
      .map(([command, args]) =>
        args === undefined || command === "nsec_backup_watch"
          ? [command]
          : [command, args],
      ),
  ).toEqual([
    ["nsec_backup_watch"],
    ["nsec_backup_state"],
    ["nsec_backup_set_choice", { pubkey: owned.pubkey, automatic: true }],
    [
      "nsec_backup_session",
      {
        source: "builderlab",
        generation: expect.any(Number),
        credential: "private-token",
      },
    ],
    [
      "nsec_backup_session",
      {
        source: "builderlab",
        generation: expect.any(Number),
        credential: null,
      },
    ],
  ]);
  identity.dispose();
});

it.each([
  ["lists the linked key", [owned.pubkey], true],
  ["lists only another key", [stranger.pubkey], false],
  ["lists nothing", [], false],
  ["is unavailable", "unavailable", false],
] as const)(
  "Welcome back offers Restore from backup only where backup status lists the linked key: status %s",
  async (_label, listed, restore) => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    const identity = createIdentity();
    const user = userEvent.setup();
    await welcomeBackPage(
      user,
      identity,
      linkedTo(owned.pubkey, [], {
        backupStatus: () => Promise.resolve(listed),
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Restore from backup" }) !== null,
    ).toBe(restore);
    expect(
      screen.getByRole("button", { name: "Enter your private key" }),
    ).toBeEnabled();
    identity.dispose();
  },
);

it("a backup status lookup that fails hides Restore from backup, and Enter your private key still reaches the backup offer", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const backupStatus = vi.fn(() =>
    Promise.reject(new BackupError("unreachable")),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    linkedTo(owned.pubkey, [], { backupStatus }),
  );
  expect(backupStatus).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "Restore from backup" }),
  ).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  await importLinkedKey(user);
  identity.dispose();
});

it("importing a linked key backup status already lists skips the backup offer", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    linkedTo(owned.pubkey, [], {
      backupStatus: () => Promise.resolve([owned.pubkey]),
      backUp,
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Back up this key?" }),
  ).toBeNull();
  expect(backUp).not.toHaveBeenCalled();
  identity.dispose();
});

/**
 * The real account on the build's own portal, where backup runs, with kgoose
 * listing the linked key as backed up; native recovery answers from `native`.
 */
function backedUpAccount(
  native: Record<string, (args: unknown) => unknown>,
): ComponentProps<typeof Welcome>["account"] {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return null;
    if (command === "nsec_backup_watch") return undefined;
    if (command === "nsec_backup_state")
      return { seq: 1, pass: 0, builderlab: true, status: "idle" };
    const answer = native[command];
    if (!answer) throw new Error(`Unexpected command ${command}`);
    return answer(args);
  });
  const request = vi.fn(async ({ url }: { url: string }) => ({
    status: 200,
    headers: {},
    body: JSON.stringify(
      url.endsWith("/nostr-identities/current")
        ? {
            identity: { npub: linkedNpub, pubkey_hex: owned.pubkey },
            correlation_id: "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
          }
        : url.endsWith("/nsec-backups/status")
          ? {
              current_nostr_pubkey: owned.pubkey,
              backup_nostr_pubkeys: [owned.pubkey],
            }
          : { communities: [] },
    ),
  }));
  return (credential, origin, identity) =>
    builderlabAccount(credential, origin, request, identity);
}
/** Native recovery's answer, holding a backup of each key. */
const backupsOf = (...pubkeys: string[]): RecoveryResult => ({
  candidates: pubkeys.map((pubkey, index) => ({
    handle: `backup-${index}`,
    pubkey,
  })),
  currentPubkey: owned.pubkey,
  failedCount: 0,
});
/** The restore page's line, true only while a restore may still install the key. */
const storedSecurely = () =>
  screen.queryByText("Your key is stored securely on this device.");
/** Native commands in order, without the backup status store's own reads. */
const recoveryCalls = () =>
  vi
    .mocked(invoke)
    .mock.calls.map(([command]) => command)
    .filter((command) => !/^nsec_backup_(watch|state)$/.test(command));

it("Restore from backup recovers through its own browser sign-in, offers only the linked key, and lands on Join a community without a backup offer", async () => {
  const begun = deferred<{ attempt: string }>();
  const account = backedUpAccount({
    nsec_restore_begin: () => begun.promise,
    nsec_restore_wait: () => backupsOf(stranger.pubkey, owned.pubkey),
    nsec_restore_install: () => owned.pubkey,
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, account);
  expect(screen.getByText(/Restore it from your backup/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Enter your private key" }),
  ).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Restore from backup" }));
  expect(
    screen.getByRole("heading", { name: "Restore from backup" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Sign in in your browser to find your backups…",
  );
  expect(storedSecurely()).toBeVisible();
  await act(async () => begun.resolve({ attempt: "attempt-1" }));
  // The account holds another key's backup too; only the linked one is offered.
  expect(await screen.findByRole("radio", { checked: true })).toBeVisible();
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  expect(storedSecurely()).toBeVisible();
  expect(screen.getByText(linkedNpub)).toBeVisible();
  expect(screen.queryByText(npubEncode(stranger.pubkey))).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Restore this identity" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("nsec_restore_install", {
    attempt: "attempt-1",
    handle: "backup-1",
  });
  // A restored key is already backed up: no offer, no uploader handoff.
  expect(recoveryCalls()).toEqual([
    "identity_restore",
    "nsec_restore_begin",
    "nsec_restore_wait",
    "nsec_restore_install",
  ]);
  identity.dispose();
});

it.each([
  ["unavailable", RECOVERY_UNAVAILABLE],
  ["refused", RECOVERY_REFUSED],
])(
  "a restore recovery answers as %s offers Enter your private key instead of Try again, and the import skips the backup offer",
  async (_label, refusal) => {
    const account = backedUpAccount({
      nsec_restore_begin: () => ({ attempt: "attempt-1" }),
      nsec_restore_wait: () => Promise.reject(refusal),
      nsec_restore_cancel: () => undefined,
      identity_import: () => owned.pubkey,
    });
    const identity = createIdentity();
    const user = userEvent.setup();
    await welcomeBackPage(user, identity, account);
    await user.click(
      screen.getByRole("button", { name: "Restore from backup" }),
    );
    expect(
      await screen.findByText(
        "Backup restore isn’t available for this account. Enter your private key to continue.",
      ),
    ).toBeVisible();
    // The unavailable copy replaces the line rather than following it.
    expect(storedSecurely()).toBeNull();
    expect(screen.queryByText(refusal)).toBeNull();
    expect(screen.queryByRole("button", { name: /Try/ })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Enter your private key" }),
    );
    // Recovery is canceled first: until then the identity refuses an import.
    expect(
      await screen.findByRole("heading", { name: "Enter your private key" }),
    ).toBeVisible();
    expect(invoke).toHaveBeenCalledWith("nsec_restore_cancel", {
      attempt: "attempt-1",
    });
    await user.paste(ownedNsec);
    await user.click(continueWithKey());
    expect(
      await screen.findByRole("heading", { name: "Join a community" }),
    ).toBeVisible();
    expect(identity.snapshot()).toEqual({
      status: "ready",
      viewer: owned.pubkey,
    });
    expect(recoveryCalls()).toEqual([
      "identity_restore",
      "nsec_restore_begin",
      "nsec_restore_wait",
      "nsec_restore_cancel",
      "identity_import",
    ]);
    identity.dispose();
  },
);

it("a restore that fails for a reason a retry may clear offers Try recovery again, and Back returns to Welcome back", async () => {
  const wait = vi
    .fn()
    .mockRejectedValueOnce("Could not restore your identity. Try again.")
    .mockResolvedValueOnce(backupsOf(owned.pubkey));
  const account = backedUpAccount({
    nsec_restore_begin: () => ({ attempt: "attempt-1" }),
    nsec_restore_wait: wait,
    nsec_restore_cancel: () => undefined,
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, account);
  await user.click(screen.getByRole("button", { name: "Restore from backup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not restore your identity. Try again.",
  );
  expect(storedSecurely()).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Enter your private key" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Try recovery again" }));
  expect(await screen.findByRole("radio", { checked: true })).toBeVisible();
  expect(storedSecurely()).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  // Back returns focus to the choice that opened the restore page.
  expect(
    screen.getByRole("button", { name: "Restore from backup" }),
  ).toHaveFocus();
  expect(identity.snapshot().status).toBe("missing");
  expect(recoveryCalls()).toEqual([
    "identity_restore",
    "nsec_restore_begin",
    "nsec_restore_wait",
    "nsec_restore_cancel",
    "nsec_restore_begin",
    "nsec_restore_wait",
    "nsec_restore_cancel",
  ]);
  identity.dispose();
});

it("a restore whose backups do not hold the linked key installs nothing, and Back returns to Welcome back", async () => {
  const account = backedUpAccount({
    nsec_restore_begin: () => ({ attempt: "attempt-1" }),
    nsec_restore_wait: () => backupsOf(stranger.pubkey),
    nsec_restore_cancel: () => undefined,
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, account);
  await user.click(screen.getByRole("button", { name: "Restore from backup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "None of your backups holds the key linked to this account, so nothing was restored.",
  );
  expect(storedSecurely()).toBeNull();
  expect(screen.queryByRole("radio")).toBeNull();
  for (const name of ["Restore this identity", "Try recovery again"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect(identity.snapshot().status).toBe("missing");
  expect(recoveryCalls()).toEqual([
    "identity_restore",
    "nsec_restore_begin",
    "nsec_restore_wait",
    "nsec_restore_cancel",
  ]);
  identity.dispose();
});

it.each([
  [0, "No backups were found for this account."],
  [2, "Your backups couldn’t be recovered. Try again."],
])(
  "a restore that recovers no backup (%s failed) says so without claiming the key is stored on this device",
  async (failedCount, message) => {
    const account = backedUpAccount({
      nsec_restore_begin: () => ({ attempt: "attempt-1" }),
      nsec_restore_wait: () => ({
        candidates: [],
        currentPubkey: null,
        failedCount,
      }),
      nsec_restore_cancel: () => undefined,
    });
    const identity = createIdentity();
    const user = userEvent.setup();
    await welcomeBackPage(user, identity, account);
    await user.click(
      screen.getByRole("button", { name: "Restore from backup" }),
    );
    expect(await screen.findByText(message)).toBeVisible();
    expect(storedSecurely()).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try recovery again" }),
    ).toBeEnabled();
    expect(identity.snapshot().status).toBe("missing");
    identity.dispose();
  },
);

it("a restore whose backups do not hold the linked key offers Enter your private key, which cancels recovery before the import page", async () => {
  const account = backedUpAccount({
    nsec_restore_begin: () => ({ attempt: "attempt-1" }),
    nsec_restore_wait: () => backupsOf(stranger.pubkey),
    nsec_restore_cancel: () => undefined,
    identity_import: () => owned.pubkey,
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, account);
  await user.click(screen.getByRole("button", { name: "Restore from backup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "None of your backups holds the key linked to this account",
  );
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(recoveryCalls()).toEqual([
    "identity_restore",
    "nsec_restore_begin",
    "nsec_restore_wait",
    "nsec_restore_cancel",
    "identity_import",
  ]);
  identity.dispose();
});

/**
 * The linked account a user starts over on. `unbind` and `bind` stand in for
 * kgoose: they decide the outcome, whatever the account last reported.
 */
const replacedBy =
  (
    unbind: FirstRunAccount["unbind"],
    bind: FirstRunAccount["bind"],
    communities: () => Promise<readonly OwnedCommunity[]> = () =>
      Promise.resolve([]),
    backup: BackupAnswers = {},
  ): ComponentProps<typeof Welcome>["account"] =>
  () => ({
    linkedKey: () => Promise.resolve(owned.pubkey),
    ownedCommunities: communities,
    knownCommunities: () => Promise.resolve([]),
    saveCommunity,
    unbind,
    bind,
    ...backupAnswers,
    ...backup,
  });
/** Welcome back → I lost this key → Start over, which creates the new key at once. */
async function startOver(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "I lost this key" }));
  await user.click(
    await screen.findByRole("button", { name: "Start over with a new key" }),
  );
}
/** A failure kgoose may clear, as a transport error or a 5xx is. */
const transientError = (message: string) =>
  Object.assign(new Error(message), { retryable: true });
/**
 * Native commands and account calls in the order they ran. `created` holds key
 * creation so "Creating keys…" can be observed.
 */
function callLog(created: Promise<string> = Promise.resolve(viewer)) {
  const calls: string[] = [];
  vi.mocked(invoke).mockImplementation((command) => {
    calls.push(command);
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return created;
    throw new Error(`Unexpected command ${command}`);
  });
  /** Answers each call with the next scripted answer, then succeeds. */
  const step =
    (name: string, answers: Array<() => Promise<void>> = []) =>
    (pubkey: string) => {
      calls.push(`${name} ${pubkey}`);
      return (answers.shift() ?? (() => Promise.resolve()))();
    };
  return { calls, step };
}

it("I lost this key lists the communities the old key owns, Back returns to Welcome back, and Start over creates the new key before unlinking the old one, then links the new key and backs it up", async () => {
  const created = deferred<string>();
  const { calls, step } = callLog(created.promise);
  const found = deferred<readonly OwnedCommunity[]>();
  const unlinked = deferred<void>();
  const bound = deferred<void>();
  const backedUp = deferred<void>();
  const unbind = vi.fn(step("unbind", [() => unlinked.promise]));
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    replacedBy(
      unbind,
      step("bind", [() => bound.promise]),
      () => found.promise,
      { backUp: step("backUp", [() => backedUp.promise]) },
    ),
  );
  await user.click(screen.getByRole("button", { name: "I lost this key" }));
  // The owned list is real and read for this page.
  expect(screen.getByRole("status")).toHaveTextContent("Finding communities…");
  await act(async () =>
    found.resolve([
      { host: "design.example.com", url: "https://design.example.com" },
      { host: "buzz.example.org", url: "https://buzz.example.org" },
    ]),
  );
  expect(
    await screen.findByRole("heading", { name: "Start over with a new key" }),
  ).toBeVisible();
  expect(
    within(screen.getByRole("list", { name: "Communities you own" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["design.example.com", "buzz.example.org"]);
  expect(
    screen.getByText(/Memberships in other people’s communities/),
  ).toBeVisible();
  // Starting over is the new key's backup consent, so the page says so.
  expect(
    screen.getByText(/encrypted copy that Block can use to restore it/),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect(screen.getByRole("button", { name: "I lost this key" })).toHaveFocus();
  await startOver(user);
  // No key choice: the new key is created at once, and nothing is unlinked
  // before it exists, so the account is never left without a key.
  expect(screen.getByRole("status")).toHaveTextContent("Creating keys…");
  expect(screen.queryByRole("heading", { name: "Set up your key" })).toBeNull();
  expect(unbind).not.toHaveBeenCalled();
  await act(async () => created.resolve(viewer));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Unlinking your old key…",
    ),
  );
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  await act(async () => unlinked.resolve());
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Linking your key…"),
  );
  await act(async () => bound.resolve());
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Backing up your key…",
    ),
  );
  await act(async () => backedUp.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  // The new key replaces the old one: created, the old binding released
  // (for the new key, which the account may then hold), the new key linked,
  // then backed up.
  expect(unbind.mock.calls).toEqual([[owned.pubkey, viewer]]);
  expect(calls).toEqual([
    "identity_restore",
    "identity_create",
    `unbind ${owned.pubkey}`,
    `bind ${viewer}`,
    `backUp ${viewer}`,
  ]);
  // The old key's communities are not offered to the new one.
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  identity.dispose();
});

it("a transient unlink failure after Start over keeps the new key, and Try again re-runs only the unlink before linking and backing up", async () => {
  const { calls, step } = callLog();
  const failed = deferred<void>();
  const retried = deferred<void>();
  const unbind = vi.fn(
    step("unbind", [() => failed.promise, () => retried.promise]),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    replacedBy(unbind, step("bind"), undefined, { backUp: step("backUp") }),
  );
  await startOver(user);
  await waitFor(() => expect(unbind).toHaveBeenCalledTimes(1));
  await act(async () =>
    failed.reject(
      transientError("Builderlab account unlink failed (HTTP 503)."),
    ),
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Builderlab account unlink failed (HTTP 503).",
  );
  expect(screen.getByText(keyUnlinkedNote)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Continue without linking" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Unlinking your old key…",
  );
  await act(async () => retried.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(calls).toEqual([
    "identity_restore",
    "identity_create",
    `unbind ${owned.pubkey}`,
    `unbind ${owned.pubkey}`,
    `bind ${viewer}`,
    `backUp ${viewer}`,
  ]);
  identity.dispose();
});

it("an unlink refused after Start over offers only Try again, which runs the unlink again and, once it succeeds, links and backs up the new key", async () => {
  const { calls, step } = callLog();
  const unbind = vi.fn(
    step("unbind", [
      () =>
        Promise.reject(
          new Error(
            "This Builderlab account can't manage Buzz identities right now. Try signing in again.",
          ),
        ),
    ]),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    replacedBy(unbind, step("bind"), undefined, { backUp: step("backUp") }),
  );
  await startOver(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "can't manage Buzz identities right now",
  );
  expect(screen.getByText(keyUnlinkedNote)).toBeVisible();
  // A refusal is not one Try again is promised to clear, but with nothing to
  // link the key later the page offers nothing else.
  expect(
    screen.queryByRole("button", { name: "Continue without linking" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  // The unlink ran again from the failed step; binding never overwrites, so
  // the link waited for it, then the backup followed.
  expect(calls).toEqual([
    "identity_restore",
    "identity_create",
    `unbind ${owned.pubkey}`,
    `unbind ${owned.pubkey}`,
    `bind ${viewer}`,
    `backUp ${viewer}`,
  ]);
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  identity.dispose();
});

it("a transient link failure after a successful unlink retries only the link, never unlinking again", async () => {
  const { calls, step } = callLog();
  const unbind = vi.fn(step("unbind"));
  const bind = vi.fn(
    step("bind", [
      () =>
        Promise.reject(
          transientError(
            "Builderlab account link failed (HTTP 502: not JSON).",
          ),
        ),
    ]),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    replacedBy(unbind, bind, undefined, { backUp: step("backUp") }),
  );
  await startOver(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab account link failed (HTTP 502: not JSON).",
  );
  expect(screen.getByText(keyUnlinkedNote)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Continue without linking" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(unbind).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([
    "identity_restore",
    "identity_create",
    `unbind ${owned.pubkey}`,
    `bind ${viewer}`,
    `bind ${viewer}`,
    `backUp ${viewer}`,
  ]);
  identity.dispose();
});

it("a linked account's owned communities are offered on Join a community, and a row's Join looks that community up", async () => {
  const relay = landingRelay("https://design.example.com");
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    linkedTo(owned.pubkey, [
      { host: "design.example.com", url: "https://design.example.com" },
    ]),
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  const rows = screen.getByRole("list", { name: "Communities you own" });
  expect(within(rows).getAllByRole("listitem")).toHaveLength(1);
  // Distinct accessible names: a screen reader hears "Join design.example.com"
  // and "Continue", not two "Join" buttons.
  expect(
    within(rows).getByRole("button", { name: "Join design.example.com" }),
  ).toHaveAccessibleName("Join design.example.com");
  expect(urlContinue()).toHaveAccessibleName("Continue");
  expect(within(rows).getByText("design.example.com")).toBeVisible();
  expect(urlField()).toHaveValue("");
  expect(relay.relayCalls).toEqual([]);
  // The row's Join, named for its host, is the typed-URL path: the same lookup.
  await user.click(
    within(rows).getByRole("button", { name: "Join design.example.com" }),
  );
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(screen.getByText("design.example.com")).toBeVisible();
  expect(relay.relayCalls).toEqual(relay.lookup);
  await act(async () => relay.info.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.getByRole("list", { name: "Communities you own" }),
  ).toBeVisible();
  expect(urlField()).toHaveValue("");
  identity.dispose();
});

it("a linked account on the tenant path is welcomed back and its imported key lands on Join Community for the landing URL", async () => {
  const relay = landingRelay("https://relay.example.com");
  relay.info.resolve();
  const account = vi.fn(linkedTo(owned.pubkey));
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      connect={vi.fn().mockResolvedValue(credential)}
      account={account}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: SIGN_IN });
  await user.type(urlField(), "relay.example.com{Enter}");
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  // The reads go to the tenant that signed the user in.
  expect(account).toHaveBeenCalledWith(
    credential,
    "https://tenant.example",
    identity,
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_import",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("Connect from the choice as a linked account is welcomed back at the build portal, and its imported key lands on Join Community for the address", async () => {
  const relay = landingRelay();
  const account = vi.fn(linkedTo(owned.pubkey));
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      connect={vi.fn().mockResolvedValue(credential)}
      account={account}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await connectChoicePage(user, relay);
  await user.click(connectButton());
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  // The reads go to the build portal, as Connect without a URL sends them.
  expect(account).toHaveBeenCalledWith(credential, undefined, identity);
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Not now" }));
  // The returning-user lane needs no branching of its own: it rests at done,
  // and the kept address picks the find page.
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(relay.relayCalls).toEqual([...relay.lookup, ...relay.lookup]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_import",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("an account check that fails stops setup, and Back returns to the first-launch screen", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const backupStatus = vi.fn<FirstRunAccount["backupStatus"]>();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      connect={vi.fn().mockResolvedValue(credential)}
      account={() => ({
        linkedKey: () =>
          Promise.reject(
            new Error("Builderlab account check failed (HTTP 503: not JSON)."),
          ),
        ownedCommunities: () => Promise.resolve([]),
        knownCommunities: () => Promise.resolve([]),
        saveCommunity,
        bind: () => Promise.resolve(),
        unbind: noUnlink,
        ...backupAnswers,
        backupStatus,
      })}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab account check failed (HTTP 503: not JSON).",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  // Nothing after the check ran, and no key was made.
  expect(backupStatus).not.toHaveBeenCalled();
  expect(identity.snapshot().status).toBe("missing");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("the development seed answers the account reads in place of kgoose", async () => {
  vi.stubEnv(
    "VITE_BUZZ_FIRST_RUN_ACCOUNT",
    JSON.stringify({ npub: linkedNpub, communities: ["design.example.com"] }),
  );
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect(screen.getByText(linkedNpub)).toBeVisible();
  // No host request went anywhere: the seed replaced both reads.
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("the development seed links and backs up a created key without a request, a native signature or a native backup command", async () => {
  vi.stubEnv("VITE_BUZZ_FIRST_RUN_ACCOUNT", "unlinked");
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await createMyKey(user);
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  // Neither kgoose (`plugin_host_request`), the binding signer nor the native
  // backup uploader (`nsec_backup_*`) was reached.
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("a development seed's backup kind fails the backup with that kind's page, still without a native backup command", async () => {
  vi.stubEnv("VITE_BUZZ_FIRST_RUN_ACCOUNT", '{"backup":"unreachable"}');
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await createMyKey(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t reach Builderlab to back up your key. Check your connection and try again.",
  );
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Continue without backup" }),
  ).toBeEnabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("a development seed's fail-once backup fails only the first backup, and Try again lands on Join a community, still without a native backup command", async () => {
  vi.stubEnv("VITE_BUZZ_FIRST_RUN_ACCOUNT", '{"backup":"fail-once"}');
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      connect={vi.fn().mockResolvedValue(credential)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  await createMyKey(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab didn’t confirm your backup. Try again.",
  );
  expect(screen.getByText(keySavedNote)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("a development seed's unlink status fails Start over's unlink as kgoose would, still without a request", async () => {
  vi.stubEnv(
    "VITE_BUZZ_FIRST_RUN_ACCOUNT",
    JSON.stringify({ npub: linkedNpub, unlink: 503 }),
  );
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, undefined);
  await startOver(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab account unlink failed (HTTP 503).",
  );
  // The failed unlink blocks: Try again is the only action, and the seed
  // fails it again.
  expect(
    screen.queryByRole("button", { name: "Continue without linking" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab account unlink failed (HTTP 503).",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("the development seed restores its seeded key without a browser sign-in or a native recovery command", async () => {
  vi.stubEnv(
    "VITE_BUZZ_FIRST_RUN_ACCOUNT",
    JSON.stringify({
      npub: linkedNpub,
      backups: [linkedNpub],
      recovery: ownedNsec,
    }),
  );
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, undefined);
  await user.click(screen.getByRole("button", { name: "Restore from backup" }));
  expect(screen.getByRole("radio", { checked: true })).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Restore this identity" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["identity_restore", {}],
    ["identity_import", { nsec: ownedNsec }],
  ]);
  identity.dispose();
});

it("a failed or canceled sign-in returns to the first-launch screen", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const released = deferred<Credential>();
  let signal: AbortSignal | undefined;
  const connect = vi
    .fn()
    .mockRejectedValueOnce(new Error("Browser could not open."))
    .mockImplementationOnce((current: AbortSignal) => {
      signal = current;
      return released.promise;
    });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={connect}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(await screen.findByRole("button", { name: SIGN_IN }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Browser could not open.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t sign in" }),
  ).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Buzz" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(connectButton());
  try {
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(signal?.aborted).toBe(true);
    expect(connectButton()).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    await act(async () => released.resolve(credential));
  }
  // A canceled attempt's late credential never signs the user in.
  expect(welcomeHeading()).toBeVisible();
  expect(connect).toHaveBeenCalledTimes(2);
  identity.dispose();
});

it("restore denial does not become first run or generate a replacement", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const startDragging = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getCurrentWindow).mockReturnValue({
    startDragging,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  vi.mocked(invoke)
    .mockRejectedValueOnce("Keychain access was denied")
    .mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      invites={invites}
      account={unlinked}
      connect={vi.fn()}
    >
      <p>Restored</p>
    </Welcome>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keychain access was denied",
  );
  expect(
    screen.getByRole("heading", { name: "Your Buzz identity" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: SIGN_IN })).toBeNull();
  fireEvent.mouseDown(titleBar(), {
    button: 0,
    detail: 1,
  });
  expect(startDragging).toHaveBeenCalledOnce();
  await user.click(
    screen.getByRole("button", { name: "Retry secure storage access" }),
  );
  expect(await screen.findByText("Restored")).toBeVisible();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_restore",
  ]);
  identity.dispose();
});

it("import failure keeps setup open without falling through to creation", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce("Invalid nsec");
  const identity = createIdentity();
  await waitFor(() => expect(identity.snapshot().status).toBe("missing"));
  await identity.importKey(key);
  expect(identity.snapshot()).toEqual({
    status: "missing",
    busy: false,
    error: "Invalid nsec",
  });
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("coalesces pending creation and only creates on explicit request", async () => {
  const created = deferred<string>();
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => created.promise);
  const identity = createIdentity();
  await waitFor(() => expect(identity.snapshot().status).toBe("missing"));
  expect(invoke).toHaveBeenCalledTimes(1);
  const first = identity.create();
  await identity.create();
  expect(invoke).toHaveBeenCalledTimes(2);
  created.resolve(viewer);
  await first;
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  identity.dispose();
});

it("fetches a private key only on interaction, masks by absence, and cancels a late reveal", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const exported = deferred<string>();
  vi.mocked(invoke).mockImplementationOnce(() => exported.promise);
  const user = userEvent.setup();
  const view = render(<PrivateKey identity={identity} />);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {
    exported.resolve(key);
  });
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(key);
  view.unmount();
  render(<PrivateKey identity={identity} />);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  identity.dispose();
});

it("copies without revealing and cancels a pending export on blur before clipboard access", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  vi.mocked(invoke).mockResolvedValueOnce(key);
  render(<PrivateKey identity={identity} />);
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  expect(write).toHaveBeenCalledWith(key);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  const exported = deferred<string>();
  vi.mocked(invoke).mockImplementationOnce(() => exported.promise);
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  fireEvent(window, new Event("blur"));
  await act(async () => {
    exported.resolve(key);
  });
  expect(write).toHaveBeenCalledTimes(1);
  identity.dispose();
});

it("enables packaged identity on desktop platforms but never in the live broker or browser", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    expect(nativeIdentityEnabled()).toBe(true);
  }
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  expect(nativeIdentityEnabled()).toBe(false);
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  vi.mocked(isTauri).mockReturnValue(false);
  expect(nativeIdentityEnabled()).toBe(false);
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("iPhone");
  expect(nativeIdentityEnabled()).toBe(false);
});

it.each(["Linux x86_64", "Win32"])(
  "keeps %s window controls available before identity restoration completes",
  (platform) => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    const identity = createIdentity();
    render(
      <Welcome
        identity={identity}
        communities={noJoin}
        invites={invites}
        account={unlinked}
        connect={vi.fn()}
      >
        Signed in
      </Welcome>,
    );
    expect(
      screen.getByRole("heading", { name: "Your Buzz identity" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Opening your saved identity…",
    );
    expect(titleBar()).toHaveAttribute("data-tauri-drag-region", "true");
    expect(screen.getByRole("button", { name: "Close window" })).toBeEnabled();
    identity.dispose();
  },
);

it("unlocks Sign out only after a reveal or copy, the key box, and the wipe phrase when wiping", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  vi.mocked(invoke).mockResolvedValueOnce(null);
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  const confirm = () => screen.getByRole("button", { name: /^Sign out/ });
  const haveKey = screen.getByRole("checkbox", { name: "I have my key" });
  expect(haveKey).toHaveAttribute("aria-disabled", "true");
  expect(confirm()).toBeDisabled();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  expect(confirm()).toBeDisabled();
  await user.click(haveKey);
  expect(confirm()).toBeEnabled();
  await user.click(
    screen.getByRole("checkbox", {
      name: "Also erase everything else Buzz stores on this device",
    }),
  );
  expect(confirm()).toBeDisabled();
  expect(screen.queryByText(/Erasing is unavailable/)).toBeNull();
  await user.click(
    screen.getByRole("checkbox", { name: "Also remove my agents" }),
  );
  await user.type(screen.getByLabelText(/to confirm/), WIPE_PHRASE);
  expect(confirm()).toBeEnabled();
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await user.click(confirm());
  expect(invoke).toHaveBeenLastCalledWith("sign_out", {
    wipe: true,
    removeAgents: true,
  });
  identity.dispose();
});

it("disables wipe with the native reason when the build can't wipe", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  vi.mocked(invoke).mockResolvedValueOnce(
    "Erasing is unavailable in development builds because they share agent keys with the installed Buzz",
  );
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  expect(
    await screen.findByText(/Erasing is unavailable in development builds/),
  ).toBeVisible();
  expect(invoke).toHaveBeenLastCalledWith("sign_out_wipe_refusal");
  expect(
    screen.getByRole("checkbox", {
      name: "Also erase everything else Buzz stores on this device",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  identity.dispose();
});

it("keeps wipe disabled while the native answer is pending", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const answer = deferred<string | null>();
  vi.mocked(invoke).mockReturnValueOnce(answer.promise);
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  const wipe = screen.getByRole("checkbox", {
    name: "Also erase everything else Buzz stores on this device",
  });
  try {
    expect(invoke).toHaveBeenLastCalledWith("sign_out_wipe_refusal");
    expect(wipe).toHaveAttribute("aria-disabled", "true");
  } finally {
    answer.resolve(null);
  }
  await waitFor(() =>
    expect(wipe).not.toHaveAttribute("aria-disabled", "true"),
  );
  identity.dispose();
});

it("keeps wipe disabled when the native check fails", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  vi.mocked(invoke).mockRejectedValueOnce(new Error("ipc failed"));
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  expect(
    await screen.findByText(/Couldn’t check whether erasing is available/),
  ).toBeVisible();
  expect(
    screen.getByRole("checkbox", {
      name: "Also erase everything else Buzz stores on this device",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  identity.dispose();
});

it("keeps the dialog open and shows the error when native sign out refuses", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  vi.mocked(invoke).mockResolvedValueOnce(null);
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  await user.click(screen.getByRole("checkbox", { name: "I have my key" }));
  vi.mocked(invoke).mockRejectedValueOnce("Agents didn't stop");
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Agents didn't stop",
  );
  expect(invoke).toHaveBeenLastCalledWith("sign_out", {
    wipe: false,
    removeAgents: false,
  });
  identity.dispose();
});

it("shows a native refusal's message and offers a retry", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  vi.mocked(invoke).mockResolvedValueOnce(null);
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  await user.click(screen.getByRole("checkbox", { name: "I have my key" }));
  vi.mocked(invoke).mockRejectedValueOnce({
    message: "Quit every other Buzz window using this sign-in.",
  });
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Quit every other Buzz window using this sign-in.",
  );
  expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  identity.dispose();
});
