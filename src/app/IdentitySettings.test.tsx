// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import type { Identity } from "../features/identity/service";
import { IdentitySettings } from "./IdentitySettings";
import { federatedFixture } from "../features/federated-identity/testing";
const viewer = "ab".repeat(32);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
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
  const identity = { exportKey } as unknown as Identity;
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

it("shows the organization account and signs out of it once", async () => {
  const h = federatedFixture();
  h.publish({ status: "signed-in", email: "a@example.com" });
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  expect(screen.getByText("Signed in as a@example.com")).toBeVisible();
  expect(screen.getByText(/builderlab\.example login/)).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Sign out of organization" }),
  );
  expect(h.service.signOut).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
});

it("signs in to the organization once when signed out", async () => {
  const h = federatedFixture();
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(h.service.signIn).toHaveBeenCalledTimes(1);
});

it("hides organization sign-in without an authority", () => {
  const h = federatedFixture();
  h.publish({ status: "unconfigured", authority: null });
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  expect(screen.queryByText("Organization sign-in")).not.toBeInTheDocument();
});
