import { expect, it, vi } from "vitest";
import { builderlabProvider, type BuilderlabDecide } from "./decisions";
import type { Credential } from "./oauth/browser";
import { createOAuthSession } from "./oauth/session";

const credential = (value: string): Credential => ({
  value,
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
  },
});
const request = {
  state: "x",
  questions: { a: { type: "yes_no" as const, instructions: "y" } },
  timeoutMs: 30_000,
};
const signal = new AbortController().signal;

it("needs a sign-in, then sends it to native with each call", async () => {
  const session = createOAuthSession(async () => credential("first"));
  const decide = vi.fn<BuilderlabDecide>(async () => ({
    outcome: "answered",
    backend: "builderlab",
    model: "builderlab-1",
    answers: { a: { type: "yes_no", probability: 0.7 } },
  }));
  const provider = builderlabProvider(session, true, decide);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "missing_credentials",
  });
  expect(decide).not.toHaveBeenCalled();
  await session.signIn();
  expect(provider.status()).toBe("ready");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "answered",
    model: "builderlab-1",
    answers: { a: { type: "yes_no", probability: 0.7 } },
  });
  expect(decide).toHaveBeenCalledWith(request, "first");
});

it("signs out only the sign-in Builderlab refused", async () => {
  let next = "first";
  const session = createOAuthSession(async () => credential(next));
  await session.signIn();
  let reply!: (value: unknown) => void;
  const provider = builderlabProvider(
    session,
    true,
    () => new Promise((resolve) => (reply = resolve)),
  );
  const expired = {
    outcome: "failed",
    backend: "builderlab",
    reason: "session_expired",
  };
  // A newer sign-in replaces the refused one while the call is out.
  const refusedOld = provider.decide(request, { signal });
  next = "second";
  session.signOut();
  await session.signIn();
  reply(expired);
  await expect(refusedOld).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(session.snapshot().status).toBe("signed-in");
  const refused = provider.decide(request, { signal });
  reply(expired);
  await expect(refused).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(session.snapshot().status).toBe("signed-out");
  expect(provider.status()).toBe("needs-setup");
});

it("keeps the shared sign-in when only decisions are refused", async () => {
  const session = createOAuthSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, true, async () => ({
    outcome: "failed",
    backend: "builderlab",
    reason: "unauthorized",
  }));
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(session.snapshot().status).toBe("signed-in");
});

it.each([
  ["invalid args `request` for command `decide`", "invalid_request"],
  ["decide not allowed", "service_error"],
])("reports a native rejection (%s) as %s", async (message, reason) => {
  const session = createOAuthSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, true, async () => {
    throw message;
  });
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason,
  });
});

it("is unavailable outside the desktop app", async () => {
  const session = createOAuthSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, false, undefined);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unavailable",
  });
});
