// Pi's providers, as Pi itself has them: the ones it offers, their models,
// saving a provider's key, and testing that a model answers. Keys go to Pi's
// own `~/.pi/agent/auth.json`, shared with the `pi` command, never into Buzz.
import type { ModelChoice } from "../../features/agents/ModelPicker";
import type { Pi } from "./pi";
import type { ReviewPrompt } from "../../features/agent-protection/models";

export type Provider = Readonly<{
  id: string;
  name: string;
  /** Takes an API key, saved here. */
  key: boolean;
  /** Signs in through the `pi` command rather than with a key. */
  signsIn: boolean;
  /** Where Pi finds its credentials, when it has them. */
  configured?: string;
}>;

export type Providers = Readonly<{
  providers: readonly Provider[];
  /** What Pi's settings pick when an agent names no provider or model. */
  defaults: Readonly<{ provider?: string; model?: string; thinking?: string }>;
}>;

/** A model, with the thinking levels it supports, lowest first. */
export type PiModel = ModelChoice & Readonly<{ thinking: readonly string[] }>;

export type Tested = Readonly<{ ok: boolean; message: string }>;

/** Pi's own thinking level when its settings name none. */
export const DEFAULT_THINKING = "medium";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** The level a model with `levels` runs at when asked for `level`, as Pi's
 * `clampThinkingLevel` picks it: that one, else the nearest, higher first. */
export function runsAt(levels: readonly string[], level: string) {
  if (levels.includes(level)) return level;
  const at = LEVELS.indexOf(level);
  const has = (item: string) => levels.includes(item);
  return (
    (at < 0
      ? undefined
      : (LEVELS.slice(at).find(has) ??
        LEVELS.slice(0, at).reverse().find(has))) ??
    levels[0] ??
    "off"
  );
}

export class PiSetup {
  private readonly listed = new Map<string, Promise<readonly PiModel[]>>();

  constructor(private readonly pi: Pick<Pi, "request">) {}

  /** Pi's providers and settings as they are now, which the `pi` command
   * changes. */
  providers(): Promise<Providers> {
    return this.pi.request<Providers>("providers");
  }

  /** What Pi's settings pick now, which the `pi` command changes. */
  defaults(): Promise<Providers["defaults"]> {
    return this.pi.request<Providers["defaults"]>("defaults");
  }

  /** A provider's models, from Pi's catalog. */
  models(id: string): Promise<readonly PiModel[]> {
    const listed = this.listed.get(id);
    if (listed) return listed;
    const listing = this.pi
      .request<{ id: string; name: string; thinking: string[] }[]>("models", {
        provider: id,
      })
      .then((models) =>
        models.map((model) => ({
          id: model.id,
          label: model.name || model.id,
          thinking: model.thinking,
        })),
      );
    this.listed.set(id, listing);
    listing.catch(() => {
      if (this.listed.get(id) === listing) this.listed.delete(id);
    });
    return listing;
  }

  /** Saves a provider's API key with Pi's own login. */
  async login(id: string, key: string) {
    await this.pi.request("login", { provider: id, key });
  }

  /** Asks the model for one short reply, without tools. */
  test(choice: Readonly<{ provider: string; model: string }>): Promise<Tested> {
    return this.pi.request<Tested>("test", choice);
  }
  async review(
    choice: { provider?: string; id: string },
    prompt: ReviewPrompt,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const cancel = () => {
      void this.pi.request("cancel-review", { id }).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.pi.request<{
        text: string;
        model: { provider: string; id: string };
      }>("review", { ...choice, model: choice.id, prompt, id });
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
