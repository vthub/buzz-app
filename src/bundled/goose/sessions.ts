// One agent's goose sessions, in the `goose-acp` process all goose agents
// share. The sessions themselves live in the shared ACP client.
import {
  AgentSessions as AcpAgentSessions,
  type SessionsOptions as AcpSessionsOptions,
} from "../../features/agent-harness/acp/agent-sessions";
import type { AgentProtection } from "../../features/agent-protection/service";
import { nativeProtectionBridge } from "../../features/agent-protection/native-bridge";
import { GooseProcess, type GooseHost, type ServeMcp } from "./goose";
import type {
  SavedConversation,
  SessionStore,
} from "../../features/agent-harness/acp/agent-sessions";

export {
  abortable,
  absolute,
  IDLE_MS,
  POOL_LIMIT,
  ServerPool,
  type Launch,
  type SavedConversation,
  type SessionStore,
} from "../../features/agent-harness/acp/agent-sessions";

/** The one `goose-acp` every goose agent's sessions open in, started in the
 * home folder when a session first needs it, and again after it exits. One
 * runtime shares one. */
export class SharedProcess {
  private ready: Promise<GooseProcess> | undefined;
  constructor(
    private readonly host: GooseHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
    private readonly protection?: AgentProtection,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call. */
  get(): Promise<GooseProcess> {
    this.protection?.assertAvailable();
    if (this.ready) return this.ready;
    const ready = (async () => {
      const bridge =
        this.protection &&
        (await nativeProtectionBridge(this.serve, this.protection));
      try {
        const goose = await GooseProcess.start(
          (id, options) =>
            this.host.spawn(id, {
              ...options,
              ...(this.protection && {
                protection: this.protection.processProtection,
              }),
            }),
          {
            cwd: await this.host.resolveDirectory("~"),
            serve: this.serve,
            ...(bridge && {
              protected: true,
              env: {
                ...bridge.env,
                BASH_ENV: null,
                ENV: null,
                DYLD_INSERT_LIBRARIES: null,
                DYLD_LIBRARY_PATH: null,
                DYLD_FRAMEWORK_PATH: null,
                LD_PRELOAD: null,
                LD_LIBRARY_PATH: null,
              },
            }),
          },
        );
        void goose.exited.finally(() => bridge?.close());
        return goose;
      } catch (error) {
        await bridge?.close();
        throw error;
      }
    })();
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((goose) => goose.exited.then(forget), forget);
    this.ready = ready;
    return ready;
  }
  /** Stops it, failing every session in it. */
  stop() {
    void this.shutdown().catch(() => undefined);
  }
  async shutdown() {
    const ready = this.ready;
    this.ready = undefined;
    const goose = await ready;
    await goose?.kill();
    await goose?.exited;
  }
}

export type SessionsOptions = Omit<AcpSessionsOptions, "label">;

/** An agent's sessions, in the process all goose agents share. */
export class AgentSessions extends AcpAgentSessions {
  constructor(options: SessionsOptions) {
    super({ ...options, label: "goose" });
  }
}

/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** Conversations saved in local storage, by agent and then conversation. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = "buzz.goose.sessions.v1",
): SessionStore & {
  /** Saved conversations, most recently used first. */
  list(): [string, SavedConversation][];
} {
  const readAll = (): Record<string, Record<string, SavedConversation>> => {
    try {
      const value = JSON.parse(storage.getItem(name) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const list = (saved: Record<string, SavedConversation> = {}) =>
    Object.entries(saved)
      .filter(([, conversation]) => typeof conversation?.at === "number")
      .sort(([, a], [, b]) => b.at - a.at);
  return {
    list: () => list(readAll()[agent]),
    set: (key, saved) => {
      const all = readAll();
      const kept = list({ ...all[agent], [key]: saved }).slice(0, SAVED_LIMIT);
      all[agent] = Object.fromEntries(kept);
      try {
        storage.setItem(name, JSON.stringify(all));
      } catch (error) {
        console.warn("goose sessions were not saved", error);
      }
    },
  };
}
