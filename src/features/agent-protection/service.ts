// Host-owned protection bindings. Providers are installed plugins; model input
// cannot select an agent, a policy, or the provider that checks its action.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent, RegisteredAgentType } from "../agents/service";
import type { ProcessProtection } from "../host/service";
import {
  reviewPrompt,
  reviewAssessment,
  type ReviewModel,
  type ReviewModelProvider,
} from "./models";

export type ProtectionBinding = Readonly<{ provider: string; policy: unknown }>;
export type ProtectionAction = Readonly<{
  kind: "context" | "tool" | "tool-result";
  session: string;
  content: unknown;
  command?: string;
}>;
export type ProtectionPhases = Readonly<
  Record<ProtectionAction["kind"], boolean>
>;
export const ALL_PHASES: ProtectionPhases = Object.freeze({
  context: true,
  tool: true,
  "tool-result": true,
});
export type ProtectionRequest = ProtectionAction &
  Readonly<{
    agent: Readonly<{ id: string; pubkey: string; name: string }>;
    relay: string;
    runtime: string;
    policy: unknown;
  }>;
export type ProtectionProvider = Readonly<{
  phases?(policy: unknown): ProtectionPhases;
  /** Checks one immutable action. Failure, removal and cancellation deny it. */
  check(request: ProtectionRequest, signal: AbortSignal): Promise<boolean>;
  processProtection: ProcessProtection;
}>;
export type AgentProtection = Readonly<{
  phases?: ProtectionPhases;
  /** Changes when the saved policy or registered provider changes. */
  key: string;
  /** Stable native policy revision, for isolated durable runtime state. */
  stateKey: string;
  processProtection: ProcessProtection;
  assertAvailable(): void;
  check(action: ProtectionAction, signal: AbortSignal): Promise<void>;
}>;
export type ProtectionDefaults = {
  revision: number;
  defaults: ProtectionBinding | null;
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const validBinding = (value: unknown): value is ProtectionBinding => {
  if (!value || typeof value !== "object") return false;
  const { provider, policy } = value as ProtectionBinding;
  return (
    typeof provider === "string" &&
    /^[a-z0-9._-]{1,160}$/.test(provider) &&
    !!policy &&
    typeof policy === "object" &&
    !Array.isArray(policy) &&
    new TextEncoder().encode(JSON.stringify(policy)).length <= 32768
  );
};
const blank = (): ProtectionDefaults => ({ revision: 0, defaults: null });

export class AgentProtectionService extends Service {
  readonly available = true;
  readonly version = 2;
  private providers = new Map<
    string,
    { value: ProtectionProvider; abort: AbortController; epoch: number }
  >();
  private epoch = 0;
  private modelProviders = new Map<string, ReviewModelProvider>();
  constructor(
    ctx: Context,
    private current: () => {
      owner: string | undefined;
      agents: readonly Agent[];
      types?: readonly Pick<
        RegisteredAgentType,
        "key" | "protection" | "protectionUnavailable"
      >[];
    },
    private native: {
      read(owner: string): Promise<ProtectionDefaults>;
      save(
        owner: string,
        revision: number,
        provider: string,
        policy: unknown | null,
      ): Promise<void>;
      update(
        pubkey: string,
        revision: number,
        provider: string,
        policy: unknown | null,
      ): Promise<void>;
    },
  ) {
    super(ctx, "agentProtection");
    ctx.effect(() => () => {
      for (const provider of this.providers.values()) provider.abort.abort();
      this.providers.clear();
    });
  }
  private owner() {
    const owner = this.current().owner;
    if (!owner || !/^[a-f0-9]{64}$/.test(owner))
      throw new Error("Connect to an agent community first");
    return owner;
  }
  private plugin() {
    const id = this.ctx.pluginOwner?.id;
    if (!id) throw new Error("Only an installed plugin configures protection");
    return id;
  }
  /** Each runtime retains credential and provider ownership. */
  registerModels(provider: ReviewModelProvider) {
    const id = this.plugin();
    this.modelProviders.set(id, provider);
    return this.ctx.effect(() => () => {
      if (this.modelProviders.get(id) === provider)
        this.modelProviders.delete(id);
    });
  }
  async modelChoices() {
    const rows = await Promise.all(
      [...this.modelProviders].map(async ([runtime, provider]) => ({
        runtime,
        label: provider.label,
        models: await provider.models().catch(() => []),
      })),
    );
    return rows;
  }
  async evaluate(
    model: ReviewModel,
    action: ProtectionRequest,
    signal: AbortSignal,
  ) {
    this.plugin();
    signal.throwIfAborted();
    if (model.runtime === "agent") {
      const agent = this.current().agents.find(
        (agent) =>
          agent.pubkey === action.agent.pubkey && agent.relay === action.relay,
      );
      if (!agent)
        throw new Error("The requesting agent is no longer available");
      const config = agent.config as { provider?: string; model?: string };
      model = {
        runtime: agent.type.split("/")[0] ?? "",
        provider: config.provider ?? "",
        id: config.model ?? "",
      };
    }
    const provider = this.modelProviders.get(model.runtime);
    if (!provider)
      throw new Error("The selected review model's runtime is unavailable");
    const prompt = reviewPrompt(action);
    if (new TextEncoder().encode(prompt).length > 65536)
      throw new Error("Security review context is too large");
    const result = await provider.complete(model, prompt, signal);
    signal.throwIfAborted();
    if (this.modelProviders.get(model.runtime) !== provider)
      throw new Error("The review model's runtime changed");
    return reviewAssessment(result.text, {
      ...result.model,
      runtime: model.runtime,
    });
  }
  async snapshot() {
    const { owner, agents, types } = this.current();
    const saved = owner ? await this.native.read(owner) : blank();
    return copy({
      revision: saved.revision,
      defaults: saved.defaults,
      agents: [
        ...new Map(agents.map((agent) => [agent.pubkey, agent])).values(),
      ]
        .filter((a) => a.place === "here" && a.owner === owner)
        .map((a) => ({
          id: a.pubkey,
          pubkey: a.pubkey,
          name: a.name,
          type: a.type,
          revision: a.protectionRevision ?? 0,
          binding: a.protection ?? null,
          coverage:
            types?.find((type) => type.key === a.type)?.protection === true
              ? { supported: true }
              : {
                  supported: false,
                  reason:
                    types?.find((type) => type.key === a.type)
                      ?.protectionUnavailable ??
                    "This runtime does not support complete protection checks.",
                },
        })),
    });
  }
  register(value: ProtectionProvider) {
    const id = this.plugin();
    if (
      typeof value.check !== "function" ||
      !value.processProtection ||
      !Array.isArray(value.processProtection.readOnlyPaths) ||
      !Array.isArray(value.processProtection.hiddenPaths)
    )
      throw new Error("A protection provider needs a checker");
    const next = { value, abort: new AbortController(), epoch: ++this.epoch };
    this.providers.get(id)?.abort.abort();
    this.providers.set(id, next);
    const dispose = () => {
      next.abort.abort();
      if (this.providers.get(id) === next) this.providers.delete(id);
    };
    this.ctx.effect(() => dispose);
    return { dispose };
  }
  async saveDefaults(revision: number, policy: unknown | null) {
    const provider = this.plugin();
    if (policy !== null && !validBinding({ provider, policy }))
      throw new Error("Invalid protection policy");
    await this.native.save(this.owner(), revision, provider, copy(policy));
  }
  async saveAgent(pubkey: string, revision: number, policy: unknown | null) {
    const agent = this.current().agents.find(
      (a) => a.pubkey === pubkey && a.place === "here",
    );
    if (!agent || agent.owner !== this.owner())
      throw new Error("No such local agent in this community");
    const provider = this.plugin();
    if (policy !== null && !validBinding({ provider, policy }))
      throw new Error("Invalid protection policy");
    return this.native.update(pubkey, revision, provider, copy(policy));
  }
  bind(
    agent: Pick<
      Agent,
      | "pubkey"
      | "key"
      | "owner"
      | "name"
      | "type"
      | "relay"
      | "protection"
      | "protectionRevision"
    >,
  ): AgentProtection | undefined {
    if (!agent.protection) return;
    const binding = copy(agent.protection);
    const provider = this.providers.get(binding.provider);
    const phases = copy(
      provider?.value.phases?.(copy(binding.policy)) ?? ALL_PHASES,
    );
    if (
      Object.keys(phases).sort().join(",") !== "context,tool,tool-result" ||
      Object.values(phases).some((value) => typeof value !== "boolean")
    )
      throw new Error("Invalid protection phases");
    const membership = agent.key ?? agent.pubkey;
    const key = `${membership}:${binding.provider}:${agent.protectionRevision ?? 0}:${provider?.epoch ?? "missing"}`;
    const assertAvailable = () => {
      if (
        !provider ||
        provider.abort.signal.aborted ||
        this.providers.get(binding.provider) !== provider
      )
        throw new Error("The required protection plugin is unavailable");
    };
    return Object.freeze({
      key,
      phases: Object.freeze(phases),
      stateKey: `${membership}:${binding.provider}:${agent.protectionRevision ?? 0}`,
      assertAvailable,
      processProtection: copy(
        provider?.value.processProtection ?? {
          readOnlyPaths: [],
          hiddenPaths: [],
        },
      ),
      check: async (action: ProtectionAction, stopped: AbortSignal) => {
        stopped.throwIfAborted();
        assertAvailable();
        if (phases[action.kind] === false) return;
        if (!provider)
          throw new Error("The required protection plugin is unavailable");
        const signal = AbortSignal.any([
          stopped,
          provider.abort.signal,
          AbortSignal.timeout(310_000),
        ]);
        const request = copy({
          ...action,
          policy: binding.policy,
          agent: { id: agent.pubkey, pubkey: agent.pubkey, name: agent.name },
          relay: agent.relay,
          runtime: agent.type,
        });
        if (new TextEncoder().encode(JSON.stringify(request)).length > 65536)
          throw new Error("Protected action is too large");
        let stop!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
          stop = () => reject(new Error("Protected action was cancelled"));
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        });
        let allowed = false;
        try {
          allowed = await Promise.race([
            provider.value.check(request, signal),
            cancelled,
          ]);
        } catch {
          /* A failed checker denies. */
        } finally {
          signal.removeEventListener("abort", stop);
        }
        signal.throwIfAborted();
        if (allowed !== true)
          throw new Error("Agent action denied by its protection policy");
      },
    });
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    agentProtection: AgentProtectionService;
  }
}
