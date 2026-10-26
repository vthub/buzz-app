import { Service, type Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nativeIdentityEnabled } from "../identity/service";

export type SessionSnapshot = Readonly<{
  status:
    | "unconfigured"
    | "signed-out"
    | "signing-in"
    | "restoring"
    | "signed-in"
    | "reauthentication-required"
    | "unavailable";
  authority: Readonly<{
    id: string;
    identityOrigin: string;
    apiBasePath: string;
  }> | null;
  revision: string;
  email: string | null;
  failure: string | null;
}>;
export interface FederatedIdentity {
  snapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  signIn(): Promise<SessionSnapshot>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    federatedIdentity: FederatedIdentity;
  }
}

export class FederatedIdentityService
  extends Service
  implements FederatedIdentity
{
  private readonly shared = {
    snapshot: Object.freeze({
      status: nativeIdentityEnabled() ? "restoring" : "unavailable",
      authority: null,
      revision: "",
      email: null,
      failure: nativeIdentityEnabled() ? null : "desktop-required",
    }) as SessionSnapshot,
    listeners: new Set<() => void>(),
    epoch: 0,
    closed: false,
  };
  constructor(ctx: Context) {
    super(ctx, "federatedIdentity");
    ctx.effect(() => () => {
      this.shared.closed = true;
      this.shared.listeners.clear();
    });
    ctx.effect(async () => {
      if (!nativeIdentityEnabled())
        return () => {
          this.shared.closed = true;
          this.shared.listeners.clear();
        };
      let unlisten: () => void = () => {};
      try {
        unlisten = await listen<SessionSnapshot>(
          "federated-identity",
          ({ payload }) => this.accept(payload),
        );
      } catch {
        this.accept({
          ...this.shared.snapshot,
          status: "unavailable",
          failure: "native-unavailable",
        });
        return () => {
          this.shared.closed = true;
          this.shared.listeners.clear();
        };
      }
      const epoch = this.shared.epoch;
      try {
        const snapshot = await invoke<SessionSnapshot>(
          "federated_identity_snapshot",
        );
        if (this.shared.epoch === epoch) this.accept(snapshot);
      } catch {
        if (this.shared.epoch === epoch)
          this.accept({
            ...this.shared.snapshot,
            status: "unavailable",
            failure: "native-unavailable",
          });
      }
      return () => {
        this.shared.closed = true;
        unlisten();
        this.shared.listeners.clear();
      };
    });
  }
  private accept(snapshot: SessionSnapshot) {
    if (this.shared.closed) return;
    this.shared.epoch++;
    this.shared.snapshot = Object.freeze(snapshot);
    for (const listener of this.shared.listeners) listener();
  }
  snapshot = () => this.shared.snapshot;
  subscribe = (listener: () => void) => {
    this.shared.listeners.add(listener);
    return () => {
      this.shared.listeners.delete(listener);
    };
  };
  private async operation(command: string) {
    if (!nativeIdentityEnabled() || this.shared.closed)
      throw new Error("Federated identity requires Buzz desktop");
    const epoch = this.shared.epoch;
    try {
      const snapshot = await invoke<SessionSnapshot>(command);
      if (this.shared.epoch === epoch) this.accept(snapshot);
      return this.shared.snapshot;
    } catch (error) {
      throw typeof error === "string" ? new Error(error) : error;
    }
  }
  signIn() {
    return this.operation("federated_identity_sign_in");
  }
  async signOut() {
    await this.operation("federated_identity_sign_out");
  }
  async cancelSignIn() {
    if (!nativeIdentityEnabled() || this.shared.closed)
      throw new Error("Federated identity requires Buzz desktop");
    await invoke("federated_identity_cancel_sign_in");
    await this.operation("federated_identity_snapshot");
  }
}
