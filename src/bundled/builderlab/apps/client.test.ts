import { expect, it, vi } from "vitest";
import type {
  Host,
  HostRequest,
  HostResponse,
  HostUpload,
} from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { createAppsClient } from "./client";
import { controlPlane, isAppUrl } from "./environment";

const BASE = "https://compose-ctrl.builderlabstaging.xyz";
const json = (status: number, body: unknown): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});
const contract = (profiles = ["static", "fetch-js"], minimum = "0.2.0") =>
  json(200, {
    minimum_client_version: minimum,
    runtime_info: {
      supported_runtime_profiles: profiles.map((profile) => ({ profile })),
    },
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["create", "share"] as const)(
  "stops %s after the owner changes during its first request",
  async (operation) => {
    let owner = "A";
    const session = createOAuthSession(async () => ({
      value: owner,
      account: {
        subject: owner,
        email: "",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    }));
    await session.signIn();
    const held = deferred<HostResponse>();
    const request = vi.fn(() => held.promise);
    const client = createAppsClient(
      { request } as unknown as Host,
      session,
      BASE,
    );
    const pending =
      operation === "create"
        ? client.create("Demo")
        : client.share("demo", "team");
    const rejected = expect(pending).rejects.toThrow(/sign-in changed/);
    session.signOut();
    owner = "B";
    await session.signIn();
    held.resolve(
      operation === "create"
        ? contract()
        : json(200, {
            visibility: "restricted",
            lifecycle_id: "life",
            workspace_grant_revision: 1,
          }),
    );
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("preserves the reserved app ID when sign-out interrupts initialization", async () => {
  const session = createOAuthSession(async () => ({
    value: "A",
    account: {
      subject: "A",
      email: "",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  await session.signIn();
  const held = deferred<HostResponse>();
  const started = deferred<void>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(contract())
    .mockResolvedValueOnce(
      json(200, {
        app_id: "demo",
        initialize: { required: true, recommended: true },
      }),
    )
    .mockImplementationOnce(() => {
      started.resolve();
      return held.promise;
    });
  const client = createAppsClient(
    { request } as unknown as Host,
    session,
    BASE,
  );
  const pending = client.create("Demo");
  const rejected = expect(pending).rejects.toThrow(
    /app_id=demo.*not signed in/,
  );
  await started.promise;
  session.signOut();
  held.resolve(json(201, { app_id: "demo" }));
  await rejected;
  expect(request).toHaveBeenCalledTimes(3);
});

async function setup(responses: HostResponse[], signedIn = true) {
  const session = createOAuthSession(async () => ({
    value: "secret-session",
    account: {
      subject: "auth0|owner",
      email: "",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  if (signedIn) await session.signIn();
  const requests: (HostRequest | HostUpload)[] = [];
  const next = async (input: HostRequest | HostUpload) => {
    requests.push(input);
    const response = responses.shift();
    if (!response) throw new Error("No response left");
    return response;
  };
  const host = { request: vi.fn(next), upload: vi.fn(next) } as unknown as Host;
  return { client: createAppsClient(host, session, BASE), requests };
}

it("plans and reserves a static app with the Builderlab session", async () => {
  const { client, requests } = await setup([
    contract(),
    json(200, {
      app_id: "demo-1a2b",
      display_name: "Demo",
      environment: "production",
      initialize: { required: false, recommended: false },
      external_url: "https://demo-1a2b--bpsites.apps.builderlabstaging.xyz/",
    }),
    json(200, { ok: true, app_id: "demo-1a2b" }),
  ]);
  await expect(client.create("Demo")).resolves.toEqual({
    app_id: "demo-1a2b",
    external_url: "https://demo-1a2b--bpsites.apps.builderlabstaging.xyz/",
  });
  expect(requests).toMatchObject([
    { url: `${BASE}/v1/agent/contract`, method: "GET" },
    {
      url: `${BASE}/v1/agent/apps/plan`,
      method: "POST",
      headers: {
        Authorization: "BBIdentity secret-session",
        "X-Hotpod-Agent-Client-Version": "0.2.0",
      },
    },
    { url: `${BASE}/v1/agent/apps/demo-1a2b/reserve`, method: "POST" },
  ]);
  const [, plan, reserve] = requests as HostRequest[];
  expect(JSON.parse(plan?.body ?? "")).toEqual({
    name: "Demo",
    runtime_profile: "static",
    client_version: "0.2.0",
  });
  expect(JSON.parse(reserve?.body ?? "")).toEqual({
    runtime_profile: "static",
    environment: "production",
    name: "Demo",
  });
});

it("keeps permission failures distinct from expired sign-in", async () => {
  const { client } = await setup([
    json(403, {
      error: {
        code: "publisher_not_approved",
        message: "Workspace is not enabled",
      },
      next_action: "Ask an owner",
    }),
  ]);
  await expect(client.list()).rejects.toThrow(
    "Listing apps failed (HTTP 403): publisher_not_approved: Workspace is not enabled: next_action: Ask an owner",
  );
});

it("rejects unsupported runtimes and newer minimum clients before mutations", async () => {
  for (const response of [
    contract(["fetch-js"]),
    contract(["static"], "0.3.0"),
  ]) {
    const { client, requests } = await setup([response]);
    await expect(client.create("Demo")).rejects.toThrow(
      /does not advertise static|requires client 0.3.0/,
    );
    expect(requests).toHaveLength(1);
    expect((requests[0] as HostRequest).method).toBe("GET");
  }
});

it("copies the executable plan into reserve and initialize", async () => {
  const { client, requests } = await setup([
    contract(["fetch-js"]),
    json(200, {
      app_id: "demo",
      runtime_profile: "fetch-js",
      environment: "production",
      initialize: { required: true, recommended: true },
    }),
    json(201, { app_id: "demo" }),
    json(200, { app_id: "demo", external_url: "https://demo.example/" }),
  ]);
  await expect(client.create("Demo", "fetch-js")).resolves.toMatchObject({
    app_id: "demo",
  });
  for (const request of requests.slice(2) as HostRequest[])
    expect(JSON.parse(request.body ?? "")).toMatchObject({
      runtime_profile: "fetch-js",
      environment: "production",
    });
  expect((requests[3] as HostRequest).timeoutMs).toBe(180_000);
  expect((requests[2] as HostRequest).timeoutMs).toBeUndefined();
});

it("refuses incomplete initialization decisions before reserving", async () => {
  const { client, requests } = await setup([
    contract(),
    json(200, { app_id: "demo", initialize: { required: false } }),
  ]);
  await expect(client.create("Demo")).rejects.toThrow(
    /no complete initialization decision/,
  );
  expect(requests).toHaveLength(2);
});

it("preserves the planned app ID when reservation is ambiguous", async () => {
  const { client } = await setup([
    contract(),
    json(200, {
      app_id: "demo",
      initialize: { required: false, recommended: false },
    }),
    json(502, { error: { message: "upstream unavailable" } }),
  ]);
  await expect(client.create("Demo")).rejects.toThrow(
    /during reserve for app_id=demo.*reservation may already exist/,
  );
});

it("preserves the reservation when initialization fails or substitutes an app", async () => {
  for (const response of [
    json(503, { error: { message: "rollout failed" } }),
    json(200, { app_id: "other" }),
  ]) {
    const { client } = await setup([
      contract(),
      json(200, {
        app_id: "demo",
        initialize: { required: true, recommended: false },
      }),
      json(201, { app_id: "demo" }),
      response,
    ]);
    await expect(client.create("Demo")).rejects.toThrow(
      /during initialize for app_id=demo.*inspect or resume/,
    );
  }
});

it("pins readiness to version, deployment and rollout IDs", async () => {
  const { client, requests } = await setup([json(200, { ready: true })]);
  await client.ready("demo", "v1", "d1", "r1");
  expect(requests[0]?.url).toBe(
    `${BASE}/v1/agent/apps/demo/ready?version_id=v1&deployment_id=d1&rollout_id=r1`,
  );
});

it("uploads the artifact to the app's deploy endpoint", async () => {
  const { client, requests } = await setup([
    json(200, { ok: true, version_id: "ver-1" }),
  ]);
  await expect(
    client.deploy("demo", "/Users/me/demo/artifact.tar.gz"),
  ).resolves.toEqual({ ok: true, version_id: "ver-1" });
  expect(requests).toEqual([
    {
      url: `${BASE}/v1/agent/apps/demo/deploy`,
      headers: {
        Accept: "application/json",
        Authorization: "BBIdentity secret-session",
        "X-Hotpod-Agent-Client-Version": "0.2.0",
      },
      file: {
        field: "artifact",
        path: "/Users/me/demo/artifact.tar.gz",
        name: "artifact.tar.gz",
        contentType: "application/gzip",
      },
    },
  ]);
});

it("points the agent at Settings when signed out or refused", async () => {
  const signedOut = await setup([], false);
  await expect(signedOut.client.list()).rejects.toThrow(
    /not signed in.*Settings → Plugins → Builderlab agents/,
  );
  expect(signedOut.requests).toEqual([]);
  const refused = await setup([json(401, {})]);
  await expect(refused.client.list()).rejects.toThrow(
    /refused the sign-in.*HTTP 401.*Settings/,
  );
});

it("reports the server's error without the session", async () => {
  const { client } = await setup([
    json(400, {
      error: {
        code: "artifact_manifest_invalid",
        message: "missing public/ for secret-session",
      },
      next_action: "rebuild",
    }),
  ]);
  const failure = client.deploy("demo", "/Users/me/artifact.tar.gz");
  await expect(failure).rejects.toThrow(
    "Deploying failed (HTTP 400): artifact_manifest_invalid: missing public/ for [redacted]: next_action: rebuild",
  );
});

it("shares only a restricted app, at its current grant revision", async () => {
  const { client, requests } = await setup([
    json(200, {
      visibility: "restricted",
      lifecycle_id: "life-1",
      workspace_grant_revision: 3,
    }),
    json(200, { ok: true }),
  ]);
  await client.share("demo", "team/one");
  expect(requests[1]).toMatchObject({
    url: `${BASE}/v1/agent/apps/demo/sharing/workspaces/team%2Fone`,
    method: "POST",
    body: JSON.stringify({ lifecycle_id: "life-1", expected_revision: 3 }),
  });
  const open = await setup([json(200, { visibility: "organization" })]);
  await expect(open.client.share("demo", "team")).rejects.toThrow(
    /restricted visibility/,
  );
});

it("deploys to the sign-in's own tenant and opens only its app hosts", () => {
  expect(controlPlane("https://app.builderlabstaging.xyz")).toBe(BASE);
  expect(controlPlane("https://block.builderlab.xyz/")).toBe(
    "https://compose-ctrl.block.builderlab.xyz",
  );
  expect(controlPlane("https://app.builderlab.xyz")).toBe(
    "https://compose-ctrl.builderlab.xyz",
  );
  expect(controlPlane("https://builderlab.example")).toBeUndefined();
  expect(controlPlane("")).toBeUndefined();
  for (const url of [
    "https://tiny-counter--bpsites.apps.builderlab.xyz/",
    "https://demo--bpsites.apps.block.builderlab.xyz/",
    "https://demo--bpsites.apps.builderlabstaging.xyz/path?x=1",
  ])
    expect(isAppUrl(url), url).toBe(true);
  for (const url of [
    "http://demo--bpsites.apps.builderlab.xyz/",
    "https://apps.builderlab.xyz/",
    "https://demo--bpsites.apps.builderlab.xyz.example.org/",
    "https://evilapps.builderlab.xyz/",
    "https://user:pass@demo--bpsites.apps.builderlab.xyz/",
    "http://demo.apps.block.builderlab.xyz/",
    "https://apps.block.builderlab.xyz/",
    "https://demo.apps.block.builderlab.xyz.example.org/",
    "https://evilapps.block.builderlab.xyz/",
    "https://user:pass@demo.apps.block.builderlab.xyz/",
    "not a url",
  ])
    expect(isAppUrl(url), url).toBe(false);
});
