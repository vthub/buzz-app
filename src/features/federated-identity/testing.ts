import { vi } from "vitest";
import type { FederatedIdentity, SessionSnapshot } from "./service";

/** Consumer fixtures supply public host events; they do not implement credential custody. */
export function federatedFixture(
  revision = "user",
  email: string | null = "a@example.com",
) {
  let state: SessionSnapshot = {
    status: "signed-out",
    authority: {
      id: "test",
      identityOrigin: "https://builderlab.example",
      apiBasePath: "/api/goose/",
    },
    revision: `${revision}:0`,
    email: null,
    failure: null,
  };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<SessionSnapshot>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  let logins = 0;
  const service: FederatedIdentity = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signIn: vi.fn(async () => {
      publish({
        status: "signed-in",
        revision: `${revision}:${++logins}`,
        email,
      });
      return state;
    }),
    cancelSignIn: vi.fn(async () => {
      publish({
        status: "signed-out",
        revision: crypto.randomUUID(),
        email: null,
      });
    }),
    signOut: vi.fn(async () => {
      publish({
        status: "signed-out",
        revision: crypto.randomUUID(),
        email: null,
      });
    }),
  };
  return { service, publish };
}
