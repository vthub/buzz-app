import { afterEach, expect, it, vi } from "vitest";
import type { AddedTool } from "../../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../../buzz-mcp/client";
import type { HostResponse, HostRequest } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { applyApps } from "./index";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const json = (body: unknown): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});
const APP = "https://demo--bpsites.apps.builderlabstaging.xyz/";

async function setup(
  url = "https://app.builderlabstaging.xyz",
  canUseRemoteAgents = true,
) {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", url);
  const session = createOAuthSession(async () => ({
    value: "session",
    account: {
      subject: "auth0|owner",
      email: "",
      canUseRemoteAgents,
      canUseBuilderlabDecisions: false,
    },
  }));
  await session.signIn();
  const tools = new Map<string, AddedTool>();
  const responses: HostResponse[] = [];
  const respond = vi.fn(async (request: HostRequest) => {
    if (request.url.endsWith("/contract"))
      return json({
        minimum_client_version: "0.2.0",
        runtime_info: {
          supported_runtime_profiles: [
            { profile: "static" },
            { profile: "fetch-js" },
          ],
        },
        readiness: {
          default_timeout_ms: 120000,
          default_interval_ms: 3000,
          terminal_statuses: ["callback_timeout"],
        },
      });
    const next = responses.shift();
    if (!next) throw new Error("No response left");
    return next;
  });
  const ctx = {
    panels: { register: vi.fn(), requestOpen: vi.fn(() => true) },
    browser: { available: true, View: () => null },
    host: { request: respond, upload: respond },
    agents: { addTool: (tool: AddedTool) => tools.set(tool.name, tool) },
  };
  applyApps(ctx as never, session);
  const call = (name: string, args: Record<string, unknown>, context = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No tool ${name}`);
    return tool.call({} as BuzzClient, context, args);
  };
  return { ctx, tools, responses, respond, call, session };
}

it("preserves an accepted upload after sign-in changes and starts later tools with the new session", async () => {
  const { ctx, call, session, responses, respond } = await setup();
  let accept!: (value: HostResponse) => void;
  const held = new Promise<HostResponse>((done) => {
    accept = done;
  });
  let started!: () => void;
  const uploading = new Promise<void>((done) => {
    started = done;
  });
  ctx.host.upload = vi.fn(() => {
    started();
    return held;
  });
  const pending = call("apps_deploy", {
    app_id: "demo",
    artifact: "/Users/me/artifact.tar.gz",
  });
  await uploading;
  session.signOut();
  await session.signIn();
  accept(json({ version_id: "v1", deployment_id: "d1", external_url: APP }));
  const result = JSON.parse(String(await pending));
  expect(result).toMatchObject({
    app_id: "demo",
    version_id: "v1",
    deployment_id: "d1",
    ready: false,
    readiness_error: expect.stringMatching(/sign-in changed/),
  });
  expect(respond).toHaveBeenCalledTimes(1);
  responses.push(json({ apps: [] }));
  await expect(call("apps_list", {})).resolves.toBe(
    JSON.stringify({ apps: [] }, null, 2),
  );
});

it("adds the app tools only for a tenant with an Apps control plane", async () => {
  expect([...(await setup()).tools.keys()]).toEqual([
    "apps_contract",
    "apps_create",
    "apps_deploy",
    "apps_status",
    "apps_list",
    "apps_share",
    "apps_open",
  ]);
  const other = await setup("https://builderlab.example");
  expect(other.tools.size).toBe(0);
  // The panel opens app links whatever the sign-in.
  expect(other.ctx.panels.register).toHaveBeenCalledWith(
    expect.objectContaining({ id: "app", title: "App" }),
  );
});

it("returns once the deployed version serves", async () => {
  vi.useFakeTimers();
  const { call, responses, respond } = await setup();
  responses.push(
    json({ ok: true, version_id: "ver-1", external_url: APP }),
    json({ ready: false }),
    json({ ready: true }),
  );
  const deployed = call("apps_deploy", {
    app_id: "demo",
    artifact: "/Users/me/demo/artifact.tar.gz",
  });
  await vi.advanceTimersByTimeAsync(3_000);
  await expect(
    deployed.then((text) => JSON.parse(String(text))),
  ).resolves.toEqual({
    app_id: "demo",
    version_id: "ver-1",
    external_url: APP,
    ready: true,
  });
  expect(respond).toHaveBeenCalledTimes(4);
});

it("keeps the accepted deployment IDs after a readiness failure", async () => {
  const { call, responses } = await setup();
  responses.push(
    json({
      version_id: "v1",
      deployment_id: "d1",
      rollout_id: "r1",
      external_url: APP,
    }),
    {
      status: 503,
      headers: {},
      body: JSON.stringify({ error: { message: "temporarily unavailable" } }),
    },
  );
  const result = JSON.parse(
    String(
      await call("apps_deploy", {
        app_id: "demo",
        artifact: "/Users/me/artifact.tar.gz",
      }),
    ),
  );
  expect(result).toMatchObject({
    app_id: "demo",
    version_id: "v1",
    deployment_id: "d1",
    rollout_id: "r1",
    ready: false,
    readiness_error: expect.stringContaining("HTTP 503"),
  });
  responses.push(json({ ready: true }));
  await expect(call("apps_status", result)).resolves.toContain('"ready": true');
});

it("stops polling on a terminal readiness status", async () => {
  const { call, responses, respond } = await setup();
  responses.push(
    json({ version_id: "v1" }),
    json({ ready: false, status: "callback_timeout" }),
  );
  const result = JSON.parse(
    String(
      await call("apps_deploy", {
        app_id: "demo",
        artifact: "/Users/me/artifact.tar.gz",
      }),
    ),
  );
  expect(result).toMatchObject({
    version_id: "v1",
    ready: false,
    readiness: { status: "callback_timeout" },
  });
  expect(respond).toHaveBeenCalledTimes(3);
});

it("uses the tenant readiness deadline instead of giving up after 90 seconds", async () => {
  vi.useFakeTimers();
  const { call, responses, respond } = await setup();
  responses.push(
    json({ version_id: "v1" }),
    ...Array.from({ length: 31 }, () => json({ ready: false })),
    json({ ready: true }),
  );
  const result = call("apps_deploy", {
    app_id: "demo",
    artifact: "/Users/me/artifact.tar.gz",
  });
  await vi.advanceTimersByTimeAsync(93000);
  await expect(result).resolves.toContain('"ready": true');
  expect(respond).toHaveBeenCalledTimes(34);
});

it("returns a complete fetch-js artifact shape for a Public pilot", async () => {
  const { call, responses } = await setup("https://app.builderlab.xyz", false);
  responses.push(
    json({
      app_id: "demo",
      runtime_profile: "fetch-js",
      initialize: { required: true, recommended: true },
    }),
    json({ app_id: "demo" }),
    json({ app_id: "demo", external_url: APP }),
  );
  const result = JSON.parse(
    String(
      await call("apps_create", { name: "Demo", runtime_profile: "fetch-js" }),
    ),
  );
  expect(result.manifest).toMatchObject({
    app: { app_id: "demo" },
    runtime: { profile: "fetch-js", entrypoint: "server/index.mjs" },
    bindings: [
      { name: "ASSETS", permissions: ["read"] },
      { name: "HOTPOD", permissions: ["read"] },
    ],
  });
  expect(result.assets_manifest).toEqual({
    schema: "hotpod.assets.v1",
    assets: [],
  });
});

it("keeps Public workspace authorization failures visible and performs no mutation", async () => {
  const { call, respond } = await setup("https://app.builderlab.xyz");
  respond.mockResolvedValueOnce({
    status: 403,
    headers: {},
    body: JSON.stringify({
      error: {
        code: "builderlab_access_required",
        message: "Workspace preview is not enabled",
      },
    }),
  });
  await expect(
    call("apps_create", { name: "Demo", runtime_profile: "fetch-js" }),
  ).rejects.toThrow(/HTTP 403.*Workspace preview is not enabled/);
  expect(respond).toHaveBeenCalledTimes(1);
});

it.each([APP, "https://tiny-counter--bpsites.apps.builderlab.xyz/"])(
  "opens %s beside the conversation the agent works in",
  async (url) => {
    const { call, ctx } = await setup();
    const panel = ctx.panels.register.mock.calls[0]?.[0];
    expect(panel.matches(url)).toBe(true);
    await expect(
      call("apps_open", { url }, { channel: "c1", root: "r1" }),
    ).resolves.toBe("Opened beside the conversation.");
    expect(ctx.panels.requestOpen).toHaveBeenCalledWith({
      target: url,
      channelId: "c1",
      rootId: "r1",
    });
    ctx.panels.requestOpen.mockReturnValue(false);
    await expect(
      call("apps_open", { url }, { channel: "c1" }),
    ).resolves.toMatch(/^Not opened/);
    await expect(
      call("apps_open", { url: "https://example.org/" }, { channel: "c1" }),
    ).rejects.toThrow(/not a Builderlab app URL/);
  },
);
