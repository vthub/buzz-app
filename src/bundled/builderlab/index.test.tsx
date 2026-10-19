// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KnownCommunities } from "../../features/communities/service";
import { HostService, type HostResponse } from "../../features/host/service";
import { SettingsCardsService } from "../../features/settings/service";
import { PanelsService } from "../../features/panels/service";
import { BrowserService } from "../../features/browser/service";
import type { BrowserPlatform } from "../../features/browser/platform";
import { DecisionsService } from "../../features/decisions/service";
import {
  AgentsService,
  type AgentCommunities,
} from "../../features/agents/service";
import { AgentDefaults } from "../agents/AgentDefaults";
import { AgentsPage } from "../agents/AgentsPage";
import * as builderlab from "./index";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import manifest from "./manifest.json";
import type { OAuthCallback } from "./oauth/browser";
import { deferred } from "./test-helpers";
import { communityFixture } from "./agents/community-testing";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
stubAvatarBrowserApis();
function provideKnownCommunities(root: Context, viewer: string) {
  const knownCommunities: KnownCommunities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
      sync: { known: [], outbox: [] },
      viewer,
      selected: null,
      memberships: [],
    }),
    subscribe: vi.fn(() => vi.fn()),
    pending: () => [],
    apply: vi.fn(async () => {}),
  };
  root.provide("knownCommunities", knownCommunities);
  return knownCommunities;
}
beforeEach(() => {
  // jsdom lacks it; the agent form reveals a failed setup's error with it.
  Element.prototype.scrollIntoView = () => {};
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        work: () => Promise<void>,
      ) => work(),
    },
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  localStorage.clear();
  native.invoke.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** What the plugin's Apps panel needs: panels, and no native browser. */
function provideApps(root: Context) {
  new PanelsService(root);
  new BrowserService(root, { available: false } as BrowserPlatform);
}

function provideAgents(
  root: Context,
  community: ReturnType<typeof communityFixture>,
) {
  const communities = {
    ...community.reader,
    open: () => community.relay,
  } as unknown as AgentCommunities;
  return new AgentsService(root, communities, {
    list: async () => [],
    create: vi.fn(),
    portable: vi.fn(),
    port: vi.fn(),
    rename: vi.fn(),
    beginDelete: vi.fn(),
    setPicture: vi.fn(),
    setType: vi.fn(),
    join: vi.fn(),
    beginLeave: vi.fn(),
    holdRemoval: vi.fn(),
    releaseRemoval: vi.fn(),
    remove: vi.fn(),
    forget: vi.fn(),
    publish: vi.fn(),
    publishProfile: vi.fn(),
    query: vi.fn(),
    searchProfiles: vi.fn(),
    upload: vi.fn(),
    media: vi.fn(),
    gitAuth: vi.fn(),
    remember: vi.fn(),
    claim: async () => true,
    release: vi.fn(),
    keepAwake: vi.fn(async () => {}),
  });
}

it.each([undefined, "", "http://builderlab.example"])(
  "an unavailable desktop build (%s) shows setup guidance without login or an agent type",
  async (url) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", url);
    const root = new Context();
    const runtime = new PluginRuntime(root, async () => builderlab);
    new HostService(root);
    provideApps(root);
    const cards = new SettingsCardsService(root);
    const decisions = new DecisionsService(root, localStorage);
    const community = communityFixture(null);
    root.provide("relay", community.relay as never);
    const knownCommunities = provideKnownCommunities(root, community.viewer);
    const agents = provideAgents(root, community);
    try {
      runtime.reconcile([
        {
          manifest: { ...manifest, apiVersion: 1 },
          source: "bundled",
          revision: "bundled",
          enabled: true,
          previous: null,
          reloadable: false,
          error: null,
        },
      ]);
      await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
      const card = cards.snapshot()[0];
      if (!card) throw new Error("Missing Builderlab card");
      const Card = card.component;
      render(<Card active={() => true} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        /not configured|does not support/,
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      // Agents reads its own classifier key; Builderlab makes no native call.
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command !== "jev_classifier_status",
        ),
      ).toEqual([]);
      expect(agents.types()).toHaveLength(0);
      // No sign-in is possible, so no sync owner runs.
      expect(knownCommunities.subscribe).not.toHaveBeenCalled();
      // Nor a decision provider.
      expect(decisions.providers()).toEqual([]);
      cleanup();
      render(<AgentsPage agents={agents} relay={community.relay} />);
      // With no agent type to create, the empty page's Create tile is off.
      expect(
        await screen.findByRole("button", { name: "Create your first agent" }),
      ).toBeDisabled();
    } finally {
      cleanup();
      await runtime.dispose();
      await root.fiber.dispose();
      await community.dispose();
    }
  },
);

it.each([undefined, false, true])(
  "gates remote agents on the login capability %s and refreshes it on sign-in",
  async (initialCapability) => {
    let capability = initialCapability;
    native.invoke.mockImplementation(async (command, input) => {
      if (command === "oauth_callback_begin")
        return {
          id: "attempt",
          callbackUrl: "http://127.0.0.1:12345/callback",
        };
      if (command === "oauth_callback_wait")
        return { parameters: [["code", "one-time"]] };
      if (command === "oauth_callback_cancel") return;
      if (command !== "plugin_host_request") return;
      const { url } = input.request;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          url.endsWith("/exchange")
            ? { session_credential: "private-token" }
            : url.endsWith("/me")
              ? {
                  subject: "user",
                  capabilities: { can_use_remote_agents: capability },
                }
              : { status: 1, agents: [] },
        ),
      };
    });
    const root = new Context();
    const runtime = new PluginRuntime(root, async () => builderlab);
    new HostService(root);
    provideApps(root);
    const cards = new SettingsCardsService(root);
    new DecisionsService(root, localStorage);
    const community = communityFixture(null);
    root.provide("relay", community.relay as never);
    provideKnownCommunities(root, community.viewer);
    const agents = provideAgents(root, community);
    try {
      runtime.reconcile([
        {
          manifest: { ...manifest, apiVersion: 1 },
          source: "bundled",
          revision: "bundled",
          enabled: true,
          previous: null,
          reloadable: false,
          error: null,
        },
      ]);
      await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
      const card = cards.snapshot()[0];
      if (!card) throw new Error("Missing Builderlab card");
      const Card = card.component;
      render(
        <>
          <Card active={() => true} />
          <AgentDefaults agents={agents} />
        </>,
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "Sign in with Builderlab" }),
      );
      await screen.findByRole("button", { name: "Sign out" });
      const type = agents.types()[0];
      if (!type?.remote) throw new Error("Missing Builderlab agent type");
      if (capability === true) {
        expect(
          await screen.findByText("No remote agents yet."),
        ).toBeInTheDocument();
        expect(type.provider?.snapshot().readiness).toBe("ready");
      } else {
        expect(
          screen.getByRole("heading", { name: "Coming soon" }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Coming soon, attention" }),
        ).toBeEnabled();
        await expect(
          type.remote.provision({
            name: "Helper",
            community: "wss://community.example",
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("coming soon");
        // The known-communities sync follows sign-in, not the remote agents gate.
        expect(
          native.invoke.mock.calls.filter(
            ([command, input]) =>
              command === "plugin_host_request" &&
              !/\/(exchange|me)$/.test(input.request.url) &&
              !input.request.url.includes("/known-communities/"),
          ),
        ).toHaveLength(0);
        expect(localStorage.length).toBe(0);
        await user.click(
          screen.getByRole("button", { name: "Coming soon, attention" }),
        );
        const dialog = screen.getByRole("dialog", { name: "Builderlab" });
        expect(
          within(dialog).getByText(/remote agents are coming soon/),
        ).toBeVisible();
        await user.keyboard("{Escape}");
      }
      capability = capability !== true;
      await user.click(screen.getByRole("button", { name: "Sign out" }));
      await user.click(
        screen.getByRole("button", { name: "Sign in with Builderlab" }),
      );
      await screen.findByRole("button", { name: "Sign out" });
      if (capability) {
        expect(
          await screen.findByText("No remote agents yet."),
        ).toBeInTheDocument();
        expect(type.provider?.snapshot().readiness).toBe("ready");
      } else {
        expect(
          screen.getByRole("heading", { name: "Coming soon" }),
        ).toBeInTheDocument();
        expect(type.provider?.snapshot().readiness).toBe("attention");
      }
    } finally {
      cleanup();
      await runtime.dispose();
      await root.fiber.dispose();
      await community.dispose();
    }
  },
);

it.each([
  ["1", true],
  ["0", true],
  ["0", false],
] as const)(
  "desktop login respects identity ownership in VITE_BUZZ_LIVE=%s with remote agents=%s",
  async (live, canUseRemoteAgents) => {
    vi.stubEnv("VITE_BUZZ_LIVE", live);
    const viewer = "01".repeat(32);
    const linkFinished = deferred<void>();
    native.invoke.mockImplementation(async (command, input) => {
      if (command === "nsec_backup_session" || command === "nsec_backup_retry")
        return;
      if (command === "identity_restore") return viewer;
      if (command === "oauth_callback_begin")
        return {
          id: "synthetic-attempt",
          callbackUrl: "http://127.0.0.1:12345/callback",
        };
      if (command === "oauth_callback_wait")
        return { parameters: [["code", "synthetic-code"]] };
      if (command === "oauth_callback_cancel") return;
      if (command !== "plugin_host_request")
        throw new Error(`Unexpected command ${command}`);
      const { url } = input.request;
      let result: unknown;
      if (url.endsWith("/exchange"))
        result = { session_credential: "synthetic-credential" };
      else if (url.endsWith("/me"))
        result = {
          subject: "synthetic-account",
          capabilities: { can_use_remote_agents: canUseRemoteAgents },
        };
      else if (url.endsWith("/list-agents")) result = { status: 1, agents: [] };
      else if (url.endsWith("/nostr-identities/current")) {
        result = { identity: { pubkey_hex: viewer } };
        linkFinished.resolve();
      } else throw new Error(`Unexpected request ${url}`);
      return { status: 200, headers: {}, body: JSON.stringify(result) };
    });
    const root = new Context();
    const runtime = new PluginRuntime(root, async () => builderlab);
    new HostService(root);
    provideApps(root);
    const cards = new SettingsCardsService(root);
    new DecisionsService(root, localStorage);
    const community = communityFixture(null);
    root.provide("relay", community.relay as never);
    provideKnownCommunities(root, community.viewer);
    provideAgents(root, community);
    const backupCalls = () =>
      native.invoke.mock.calls.filter(([command]) =>
        command.startsWith("nsec_backup_"),
      );
    try {
      runtime.reconcile([
        {
          manifest: { ...manifest, apiVersion: 1 },
          source: "bundled",
          revision: "bundled",
          enabled: true,
          previous: null,
          reloadable: false,
          error: null,
        },
      ]);
      await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
      const card = cards.snapshot()[0];
      if (!card) throw new Error("Missing Builderlab login card");
      const Card = card.component;
      render(<Card active={() => true} />);
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "Sign in with Builderlab" }),
      );
      expect(
        await screen.findByRole("button", { name: "Sign out" }),
      ).toBeEnabled();
      expect(
        await screen.findByText(
          canUseRemoteAgents ? "No remote agents yet." : "Coming soon",
        ),
      ).toBeInTheDocument();
      if (live === "0") {
        await linkFinished.promise;
        await waitFor(() =>
          expect(native.invoke).toHaveBeenCalledWith("nsec_backup_retry", {
            source: "builderlab",
          }),
        );
        expect(native.invoke).toHaveBeenCalledWith("nsec_backup_session", {
          source: "builderlab",
          generation: expect.any(Number),
          credential: "synthetic-credential",
        });
      }
      await user.click(screen.getByRole("button", { name: "Sign out" }));
      expect(
        await screen.findByRole("button", { name: "Sign in with Builderlab" }),
      ).toBeEnabled();
      if (live === "0")
        expect(backupCalls().at(-1)?.[1]).toMatchObject({ credential: null });
      await runtime.dispose();
      if (live === "1") {
        expect(backupCalls()).toEqual([]);
        expect(
          native.invoke.mock.calls.filter(
            ([command]) => command === "identity_restore",
          ),
        ).toEqual([]);
      } else
        expect(backupCalls().at(-1)?.[1]).toMatchObject({ credential: null });
    } finally {
      cleanup();
      await runtime.dispose();
      await root.fiber.dispose();
      await community.dispose();
    }
  },
);

it.each([
  "shared login and re-enable",
  "creation sign-in recovery",
  "creation setup recovery",
  "instructions and deletion",
])("coordinates hosted agents: %s", async (flow) => {
  const user = userEvent.setup();
  const hostedKey = "de".repeat(32);
  const browserKey = "09".repeat(32);
  let browserCreated = false;
  let browserInstructions = "";
  const creationConfig = {
    instructions: "",
    modelId: "one",
    reasoningEffort: "high",
    subject: "user",
  };
  let instructionsSave: ReturnType<typeof deferred<HostResponse>> | undefined;
  let loginCallback: ReturnType<typeof deferred<OAuthCallback>> | undefined;
  const backupHandoff = deferred<void>();
  const hostRequests = () =>
    native.invoke.mock.calls
      .filter(([command]) => command === "plugin_host_request")
      .map(([, input]) => input);
  const requestsTo = (endpoint: string) =>
    hostRequests().filter((input) =>
      input.request.url.endsWith(`/${endpoint}`),
    );
  const loginWaits = () =>
    native.invoke.mock.calls.filter(
      ([command]) => command === "oauth_callback_wait",
    );
  native.invoke.mockImplementation(async (command, input) => {
    if (command === "nsec_backup_session") return backupHandoff.promise;
    if (command === "nsec_backup_retry") return;
    if (command === "oauth_callback_begin")
      return {
        id: "native-attempt-id",
        callbackUrl: `http://127.0.0.1:12345${input.callbackPath}`,
      };
    if (command === "oauth_callback_wait")
      return loginCallback?.promise ?? { parameters: [["code", "one-time"]] };
    if (command === "oauth_callback_cancel") return;
    if (command === "identity_restore") return community.viewer;
    if (command === "identity_prepare_remote_agent_authorization")
      return ["auth", community.viewer, "", "ef".repeat(64)];
    if (command !== "plugin_host_request")
      throw new Error(`Unexpected command ${command}`);
    const { url, body } = input.request;
    let result: unknown;
    if (url.endsWith("/exchange")) {
      result = { session_credential: "private-token" };
    } else if (url.endsWith("/me")) {
      result = {
        subject: "user",
        email: "a@example.com",
        capabilities: { can_use_remote_agents: true },
      };
    } else if (url.endsWith("/list-agents")) {
      result = {
        status: 1,
        agents: browserCreated
          ? [
              {
                agent_id: "browser",
                agent_name: "Browser",
                agent_pubkey: browserKey,
                status: 2,
                agent_instructions: browserInstructions,
              },
            ]
          : [],
      };
    } else if (url.endsWith("/get-model-catalog")) {
      result = {
        models: [
          {
            id: "one",
            display_name: "Model One",
            supported_reasoning_efforts: ["high"],
          },
        ],
      };
    } else if (url.endsWith("/register-agent")) {
      const name = JSON.parse(body).agent_name;
      const hosted = name === "Hosted";
      if (name === "Browser") browserCreated = true;
      result = {
        status: 1,
        agent_id: hosted ? "hosted" : "browser",
        agent_pubkey: hosted ? hostedKey : browserKey,
      };
    } else if (url.endsWith("/nostr-identities/current")) {
      result = { identity: { pubkey_hex: community.viewer } };
    } else if (url.endsWith("/attest-agent")) {
      result = { status: 1 };
    } else if (url.endsWith("/update-agent")) {
      if (instructionsSave) return instructionsSave.promise;
      const update = JSON.parse(body);
      if (
        update.agent_pubkey === browserKey &&
        update.agent_instructions !== undefined
      )
        browserInstructions = update.agent_instructions;
      result = { status: 1 };
    } else if (url.endsWith("/update-agent-profile")) {
      result = {};
    } else if (url.endsWith("/delete-agent")) {
      result = { status: 1 };
    } else if (url.endsWith("/known-communities/list")) {
      result = { communities: [] };
    } else {
      throw new Error(`Unexpected Builderlab request ${url}`);
    }
    return { status: 200, headers: {}, body: JSON.stringify(result) };
  });
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => builderlab);
  new HostService(root);
  provideApps(root);
  const cards = new SettingsCardsService(root);
  const decisions = new DecisionsService(root, localStorage);
  const community = communityFixture();
  root.provide("relay", community.relay as never);
  const knownCommunities = provideKnownCommunities(root, community.viewer);
  const agents = provideAgents(root, community);
  const plugin: PluginInfo = {
    manifest: { ...manifest, apiVersion: 1 },
    source: "bundled",
    revision: "bundled",
    enabled: true,
    previous: null,
    reloadable: false,
    error: null,
  };
  try {
    runtime.reconcile([plugin]);
    if (flow === "shared login and re-enable") {
      await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
      expect(agents.types()).toMatchObject([
        { key: "block.builderlab/builderlab", title: "Builderlab" },
      ]);
      expect(agents.types()[0]?.defaults()).toEqual({
        config: { instructions: "", modelId: "", reasoningEffort: "" },
      });
      const picker = render(<AgentDefaults agents={agents} />);
      const providerUser = userEvent.setup();
      await providerUser.click(
        await screen.findByRole("button", {
          name: "Log in to Builderlab, attention",
        }),
      );
      const providerDialog = await screen.findByRole("dialog", {
        name: "Builderlab",
      });
      await providerUser.click(
        within(providerDialog).getByRole("button", {
          name: "Sign in with Builderlab",
        }),
      );
      expect(
        await within(providerDialog).findByRole("button", {
          name: "Sign out",
        }),
      ).toBeEnabled();
      expect(native.invoke).toHaveBeenCalledWith("nsec_backup_session", {
        source: "builderlab",
        generation: expect.any(Number),
        credential: "private-token",
      });
      picker.unmount();
      const card = cards.snapshot()[0];
      expect(card?.group).toBe("Plugins");
      if (!card) throw new Error("Missing Builderlab login card");
      const Card = card.component;
      const mounted = render(<Card active={() => true} />);
      expect(
        await screen.findByRole("button", { name: "Sign out" }),
      ).toBeEnabled();
      expect(
        await screen.findByText("No remote agents yet."),
      ).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Signed in as a@example.com.",
      );
      expect(document.body).not.toHaveTextContent("private-token");
      // The sign-in makes Builderlab a ready decision provider, but decisions
      // move to it only when the user chooses it.
      const [provider] = decisions.providers();
      expect(provider?.key).toBe("block.builderlab/builderlab");
      expect(provider?.status()).toBe("ready");
      expect(decisions.backend()).toBeUndefined();
      decisions.setBackend("block.builderlab/builderlab");
      expect(decisions.status()).toBe("ready");
      expect(decisions.backend()).toBe("block.builderlab/builderlab");
      expect(native.invoke).toHaveBeenCalledWith("oauth_callback_wait", {
        id: "native-attempt-id",
      });
      // Sign-in also checks the account's linked Buzz identity, and the
      // account's community list follows through the same wiring: the complete
      // list is read under the session credential.
      await waitFor(() => expect(knownCommunities.apply).toHaveBeenCalled());
      await waitFor(() =>
        expect(
          hostRequests()
            .map((input) => input.request.url.split("/").at(-1))
            .sort(),
        ).toEqual(["current", "exchange", "list", "list-agents", "me"]),
      );
      const requests = hostRequests();
      const [account, sync] = [
        requests.filter((input) => !input.request.url.includes("/v1/buzz/")),
        requests.filter((input) =>
          input.request.url.includes("/v1/buzz/known-communities/"),
        ),
      ];
      expect(account).toHaveLength(3);
      expect(
        requests.every(
          (input) =>
            input.id === "block.builderlab" && input.revision === "bundled",
        ),
      ).toBe(true);
      // Prove the account login supplies this consumer's credential through the real plugin wiring.
      expect(account.at(-1).request.headers["X-BB-Session-Credential"]).toBe(
        "private-token",
      );
      expect(sync.map((input) => input.request.url)).toEqual([
        "https://builderlab.example/api/goose/v1/buzz/known-communities/list",
      ]);
      expect(sync[0].request.headers["X-BB-Session-Credential"]).toBe(
        "private-token",
      );
      expect(sync[0].request.body).toBe("{}");
      // Both writes happen after Beekeeper has returned the identity. Neither
      // failure may turn a retry into a second backend creation.
      for (const failedKey of [
        `buzz.builderlab.adapter-identity.v1:${hostedKey}`,
        "buzz.agents.unfinished.v1",
      ]) {
        const setItem = localStorage.setItem.bind(localStorage);
        const storageFailure = vi
          .spyOn(Storage.prototype, "setItem")
          .mockImplementation((key, value) => {
            if (key === failedKey)
              throw new Error(`Storage full: ${failedKey}`);
            setItem(key, value);
          });
        try {
          await act(async () => {
            await expect(
              agents.create({
                type: "block.builderlab/builderlab",
                name: "Hosted",
                config: creationConfig,
              }),
            ).rejects.toThrow(`Storage full: ${failedKey}`);
          });
          expect(agents.find(hostedKey)).toBeUndefined();
        } finally {
          storageFailure.mockRestore();
        }
      }
      await act(async () => {
        await agents.create({
          type: "block.builderlab/builderlab",
          name: "Hosted",
          config: creationConfig,
        });
      });
      expect(agents.find(hostedKey)).toMatchObject({
        name: "Hosted",
        place: "hosted",
        type: "block.builderlab/builderlab",
      });
      expect(agents.find(hostedKey)?.unfinished).toBeUndefined();
      expect(
        community.events.filter((event) => event.kind === 30177),
      ).toHaveLength(1);
      expect(community.events.at(-1)?.tags).toContainEqual([
        "runtime",
        "block.builderlab/builderlab",
      ]);
      const hostedRequests = hostRequests()
        .filter((input) => /\/(register|attest)-agent$/.test(input.request.url))
        .map((input) => JSON.parse(input.request.body));
      const provisions = hostedRequests.filter(
        (body) => body.agent_name === "Hosted",
      );
      expect(provisions).toHaveLength(3);
      expect(provisions.map((body) => body.idempotency_key)).toEqual([
        provisions[0].idempotency_key,
        provisions[0].idempotency_key,
        provisions[0].idempotency_key,
      ]);
      expect(hostedRequests.at(-1)).toEqual({
        agent_pubkey: hostedKey,
        community_url: "wss://community.example",
        owner_auth_tag_json: JSON.stringify([
          "auth",
          community.viewer,
          "",
          "ef".repeat(64),
        ]),
      });
      await act(async () => {
        await agents.save(hostedKey, { name: "Renamed" });
      });
      expect(
        requestsTo("update-agent-profile").map((input) =>
          JSON.parse(input.request.body),
        ),
      ).toEqual([
        {
          agent_pubkey: hostedKey,
          community_url: "wss://community.example",
          agent_name: "Renamed",
          agent_picture_url: "",
        },
      ]);
      expect(agents.find(hostedKey)).toMatchObject({ name: "Renamed" });
      await act(async () => {
        await agents.remove(hostedKey);
      });
      expect(agents.find(hostedKey)).toBeUndefined();
      expect(community.events.at(-1)?.tags).toContainEqual([
        "a",
        `30177:${community.viewer}:${hostedKey}`,
      ]);
      await act(async () => {
        runtime.reconcile([]);
      });
      expect(cards.snapshot()).toHaveLength(0);
      expect(agents.types()).toHaveLength(0);
      expect(
        screen.getByRole("button", { name: "Sign in with Builderlab" }),
      ).toBeEnabled();
      // The disabled plugin's sync owner stops listening with it.
      expect(
        vi.mocked(knownCommunities.subscribe).mock.results.at(-1)?.value,
      ).toHaveBeenCalled();
      mounted.unmount();
      runtime.reconcile([plugin]);
    }
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    const fresh = cards.snapshot()[0];
    if (!fresh) throw new Error("Missing reactivated Builderlab login card");
    const FreshCard = fresh.component;
    render(<FreshCard active={() => true} />);
    expect(screen.getByRole("status")).toHaveTextContent("Sign in securely");
    if (flow === "shared login and re-enable") return;
    if (flow === "instructions and deletion") {
      await act(async () => {
        await agents.create({
          type: "block.builderlab/builderlab",
          name: "Browser",
          config: { ...creationConfig, instructions: "Be concise." },
        });
      });
    }
    // Creating while signed out starts the same browser login. A failed login
    // preserves the draft and sends no provisioning request; retry completes it.
    render(<AgentsPage agents={agents} relay={community.relay} />);
    if (
      flow === "creation sign-in recovery" ||
      flow === "creation setup recovery"
    ) {
      await user.click(
        screen.getByRole("button", { name: "Create your first agent" }),
      );
      const createDialog = screen.getByRole("dialog", { name: "Create agent" });
      expect(
        within(createDialog).getByRole("combobox", { name: "Harness" }),
      ).toHaveTextContent("Builderlab (hosted)");
      expect(
        within(createDialog).getByRole("textbox", {
          name: "Instructions Optional",
        }),
      ).toBeVisible();
      const name = within(createDialog).getByRole("textbox", { name: "Name" });
      const create = within(createDialog).getByRole("button", {
        name: "Create agent",
      });
      await user.type(name, "Browser");
      if (flow === "creation sign-in recovery") {
        const beforeCreateLogin = loginWaits().length;
        loginCallback = deferred();
        try {
          await user.click(create);
          await waitFor(() =>
            expect(loginWaits()).toHaveLength(beforeCreateLogin + 1),
          );
          expect(create).toBeDisabled();
          expect(name).toHaveValue("Browser");
          loginCallback.reject(new Error("Browser could not open."));
          expect(
            await within(createDialog).findByRole("alert"),
          ).toHaveTextContent("Browser could not open.");
          expect(create).toBeEnabled();
          expect(name).toHaveValue("Browser");
          // The wait itself can be abandoned from the dialog.
          loginCallback = deferred();
          await user.click(create);
          await user.click(
            await within(createDialog).findByRole("button", {
              name: "Cancel sign-in",
            }),
          );
          expect(
            await within(createDialog).findByRole("alert"),
          ).toHaveTextContent("Sign-in canceled.");
          expect(create).toBeEnabled();
          expect(
            within(createDialog).queryByRole("button", {
              name: "Cancel sign-in",
            }),
          ).not.toBeInTheDocument();
          expect(
            requestsTo("register-agent").filter(
              (input) =>
                JSON.parse(input.request.body).agent_name === "Browser",
            ),
          ).toHaveLength(0);
        } finally {
          loginCallback.resolve({ parameters: [["code", "one-time"]] });
          loginCallback = undefined;
        }
        await user.click(create);
        expect(
          await within(createDialog).findByRole("combobox", { name: "Model" }),
        ).toBeEnabled();
        expect(name).toHaveValue("Browser");
        return;
      }
      await user.click(create);
      const model = await within(createDialog).findByRole("combobox", {
        name: "Model",
      });
      await user.click(model);
      await user.click(
        await screen.findByRole("option", { name: "Model One" }),
      );
      await user.click(
        within(createDialog).getByRole("combobox", {
          name: "Reasoning effort",
        }),
      );
      await user.click(await screen.findByRole("option", { name: "high" }));
      await user.type(
        within(createDialog).getByRole("textbox", {
          name: "Instructions Optional",
        }),
        "Be concise.",
      );
      const beforeListing = community.events.filter(
        (event) => event.kind === 30177,
      ).length;
      instructionsSave = deferred();
      try {
        await user.click(create);
        await waitFor(() =>
          expect(
            requestsTo("update-agent").filter(
              (input) =>
                JSON.parse(input.request.body).agent_pubkey === browserKey,
            ),
          ).toHaveLength(1),
        );
        expect(create).toBeDisabled();
        instructionsSave.reject(new Error("offline"));
        expect(
          await within(createDialog).findByRole("alert"),
        ).toHaveTextContent("Could not reach Builderlab");
        expect(agents.find(browserKey)?.unfinished).toBe(true);
        expect(
          community.events.filter((event) => event.kind === 30177),
        ).toHaveLength(beforeListing);
        expect(
          within(createDialog).getByRole("textbox", {
            name: "Instructions Optional",
          }),
        ).toHaveValue("Be concise.");
      } finally {
        instructionsSave.resolve({ status: 200, headers: {}, body: "{}" });
        instructionsSave = undefined;
      }
      await user.click(create);
      await waitFor(() =>
        expect(agents.find(browserKey)).toMatchObject({
          name: "Browser",
          place: "hosted",
        }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Create agent" }),
        ).not.toBeInTheDocument(),
      );
      expect(agents.find(browserKey)?.unfinished).toBeUndefined();
      expect(JSON.stringify(community.events)).not.toContain("Be concise.");
      expect(
        requestsTo("register-agent").filter(
          (input) => JSON.parse(input.request.body).agent_name === "Browser",
        ),
      ).toHaveLength(1);
      expect(
        JSON.parse(requestsTo("update-agent").at(-1).request.body),
      ).toEqual({
        agent_pubkey: browserKey,
        agent_instructions: "Be concise.",
        model_id: "one",
        reasoning_effort: "high",
      });
      expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
      expect(screen.getByRole("tab", { name: "Identity" })).toBeInTheDocument();
      return;
    }
    await user.click(await screen.findByRole("gridcell", { name: /^Browser/ }));
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    const instructions = await screen.findByRole("textbox", {
      name: "Instructions",
    });
    expect(instructions).toHaveValue("Be concise.");
    const save = screen.getByRole("button", { name: "Save instructions" });
    await user.clear(instructions);
    await user.type(instructions, "New direction.");
    instructionsSave = deferred();
    const updatesBeforeEdit = requestsTo("update-agent").length;
    try {
      await user.click(save);
      await waitFor(() =>
        expect(requestsTo("update-agent")).toHaveLength(updatesBeforeEdit + 1),
      );
      expect(save).toHaveAttribute("aria-disabled", "true");
      expect(instructions).toBeDisabled();
      instructionsSave.reject(new Error("offline"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Could not reach Builderlab",
      );
      expect(instructions).toHaveValue("New direction.");
      expect(save).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      instructionsSave.resolve({
        status: 200,
        headers: {},
        body: '{"status":1}',
      });
      instructionsSave = undefined;
    }
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.click(save);
    await waitFor(() => expect(instructions).toBeEnabled());
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(browserInstructions).toBe("New direction.");
    await user.clear(instructions);
    await user.click(save);
    await waitFor(() => expect(instructions).toBeEnabled());
    expect(browserInstructions).toBe("");

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await screen.findByRole("combobox", { name: "Model" });
    // Confirmed deletion waits for login before provider or community removal.
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.click(screen.getByRole("button", { name: "Delete agent" }));
    const deletion = screen.getByRole("dialog", { name: "Delete Browser?" });
    const remove = within(deletion).getByRole("button", { name: "Delete" });
    const beforeDelete = requestsTo("delete-agent").length;
    const beforeDeleteLogin = loginWaits().length;
    loginCallback = deferred();
    try {
      await user.click(remove);
      await waitFor(() =>
        expect(loginWaits()).toHaveLength(beforeDeleteLogin + 1),
      );
      expect(remove).toHaveAttribute("aria-disabled", "true");
      expect(requestsTo("delete-agent")).toHaveLength(beforeDelete);
      expect(agents.find(browserKey)).toBeDefined();
    } finally {
      await act(async () => {
        loginCallback?.resolve({ parameters: [["code", "one-time"]] });
        await loginCallback?.promise;
      });
      loginCallback = undefined;
    }
    await waitFor(() => expect(agents.find(browserKey)).toBeUndefined());
    expect(requestsTo("delete-agent")).toHaveLength(beforeDelete + 1);
  } finally {
    backupHandoff.resolve();
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
    await community.dispose();
  }
});
