import { invoke } from "@tauri-apps/api/core";
import type { Host } from "../../../features/host/service";
import manifest from "../manifest.json";
import { browserCredential, type Credential, nativeBridge } from "./browser";

/**
 * First launch runs before this plugin can share its Settings session, so the
 * welcome screen signs in through the same OAuth client under the bundled
 * plugin's own native network grant. Native code grants that origin at build
 * time; it does not depend on the plugin's JavaScript having started.
 */
export const bundledHost: Host = {
  runCommand: () => Promise.resolve(null),
  request: (request) =>
    invoke("plugin_host_request", {
      id: manifest.id,
      revision: "bundled",
      request,
    }),
};

/** `origin`: a tenant's portal chosen from the community URL; default otherwise. */
export const firstRunCredential = (
  signal: AbortSignal,
  origin?: string,
): Promise<Credential> =>
  browserCredential(bundledHost, signal, nativeBridge, origin);
