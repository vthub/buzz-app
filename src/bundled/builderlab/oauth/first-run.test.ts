import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { bundledHost, firstRunCredential } from "./first-run";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it("requests under the bundled Builderlab grant without a plugin owner", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: "{}",
  });
  const request = { url: "https://app.builderlab.xyz/api/goose/v1/auth/me" };
  await bundledHost.request(request);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "block.builderlab",
    revision: "bundled",
    request,
  });
  expect(await bundledHost.runCommand("any")).toBeNull();
});

it.each([
  ["the configured build URL", undefined, "https://builderlab.example"],
  ["a tenant origin", "https://tenant.example", "https://tenant.example"],
])(
  "starts the native browser handoff at %s",
  async (_label, origin, expected) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    // A refused listener ends the attempt before any exchange request.
    vi.mocked(invoke).mockRejectedValueOnce("listener unavailable");
    await expect(
      firstRunCredential(new AbortController().signal, origin),
    ).rejects.toThrow("Could not complete");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "oauth_callback_begin",
      expect.objectContaining({
        authorizationUrl: expect.stringMatching(
          new RegExp(`^${expected}/api/goose/v1/auth/login\\?`),
        ),
        useState: true,
      }),
    );
  },
);
