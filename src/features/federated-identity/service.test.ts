import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FederatedIdentityService, type SessionSnapshot } from "./service";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const signedOut: SessionSnapshot = {
  status: "signed-out",
  authority: {
    id: "test",
    identityOrigin: "https://identity.example",
    apiBasePath: "/api/",
  },
  revision: "out",
  email: null,
  failure: null,
};
const signedIn: SessionSnapshot = {
  ...signedOut,
  status: "signed-in",
  revision: "in",
};
const roots: Context[] = [];
let publish: (event: { payload: SessionSnapshot }) => void;
let unlisten: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset().mockResolvedValue(signedOut);
  unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(async (_name, handler) => {
    publish = handler as typeof publish;
    return unlisten;
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllEnvs();
});
function setup() {
  const root = new Context();
  roots.push(root);
  const service = new FederatedIdentityService(root);
  return { root, service };
}
it("keeps a native event newer than an in-flight restore and ignores delivery after disposal", async () => {
  let finish!: (snapshot: SessionSnapshot) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { root, service } = setup();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  try {
    const { snapshot, subscribe } = service;
    const changed = vi.fn();
    const release = subscribe(changed);
    publish({ payload: signedIn });
    expect(snapshot()).toBe(signedIn);
    expect(changed).toHaveBeenCalledOnce();
    release();
  } finally {
    finish(signedOut);
  }
  await vi.waitFor(() => expect(service.snapshot()).toBe(signedIn));
  await root.fiber.dispose();
  publish({ payload: signedOut });
  expect(service.snapshot()).toBe(signedIn);
  expect(unlisten).toHaveBeenCalledOnce();
  await expect(service.signIn()).rejects.toThrow("desktop");
});

it("fails closed when the native session event listener cannot be registered", async () => {
  vi.mocked(listen).mockRejectedValue(new Error("permission denied"));
  const { service } = setup();

  await vi.waitFor(() =>
    expect(service.snapshot()).toMatchObject({
      status: "unavailable",
      authority: null,
      failure: "native-unavailable",
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("federated_identity_snapshot");
});
